/**
 * Thumbnail generation service for optimizing catalogue performance
 * Generates compressed 400x566 JPEG thumbnails from full-resolution images
 */

import sharp from 'sharp';
import { db } from '../db';
import { generatedImages } from '@shared/schema';
import { eq, isNull } from 'drizzle-orm';
import { downloadImage } from './object-storage';

/**
 * Generate thumbnail for a generated poster image
 * @param generatedPath Path to the full-resolution image in Object Storage
 * @param userEmail User's email for directory structure
 * @param imageId Database ID of the generated image
 */
export async function generateThumbnail(
  generatedPath: string,
  userEmail: string,
  imageId: string
): Promise<void> {
  try {
    console.log(`Starting thumbnail generation for image ${imageId}`);
    
    // Download the full-resolution image from Object Storage
    const fullImageBuffer = await downloadImage(generatedPath);
    
    if (!fullImageBuffer) {
      console.error(`Failed to download full image from: ${generatedPath}`);
      return;
    }

    console.log(`Downloaded image buffer size: ${fullImageBuffer.length} bytes`);

    // Generate thumbnail using Sharp - simplified approach
    console.log(`Processing image with Sharp...`);
    
    const thumbnailBuffer = await sharp(fullImageBuffer)
      .resize(400, 566, { 
        fit: 'inside',
        withoutEnlargement: false 
      })
      .jpeg({ quality: 85 })
      .toBuffer();
    
    console.log(`✅ Sharp processing complete. Thumbnail size: ${thumbnailBuffer.length} bytes`);
    
    if (thumbnailBuffer.length < 1000) {
      throw new Error(`Generated thumbnail is too small: ${thumbnailBuffer.length} bytes - likely corrupted`);
    }

    // Create thumbnail path: users/{userId}/thumbnails/uuid-style.jpg (user-scoped directory)
    const originalFileName = generatedPath.split('/').pop() || '';
    const fileNameWithoutExt = originalFileName.replace(/\.[^/.]+$/, '');
    const thumbnailFileName = `${fileNameWithoutExt}.jpg`;
    const thumbnailPath = `users/${userEmail}/thumbnails/${thumbnailFileName}`;

    // Upload thumbnail to Object Storage using the shared client
    const { uploadThumbnailToStorage } = await import('./object-storage');
    
    console.log(`Uploading thumbnail to path: ${thumbnailPath}`);
    console.log(`Buffer to upload size: ${thumbnailBuffer.length} bytes`);
    
    // Use the shared Object Storage function that works for all other uploads
    const uploadedPath = await uploadThumbnailToStorage(thumbnailBuffer, thumbnailPath);
    console.log(`✅ Successfully uploaded thumbnail using shared storage client`);
    
    // Verify upload by checking the returned path
    if (uploadedPath !== thumbnailPath) {
      throw new Error(`Upload path mismatch: expected ${thumbnailPath}, got ${uploadedPath}`);
    }

    // Update database with thumbnail path
    await db
      .update(generatedImages)
      .set({ thumbnailPath })
      .where(eq(generatedImages.id, imageId));

    const thumbnailSizeKB = Math.round(thumbnailBuffer.length / 1024);
    console.log(`✅ Thumbnail generated successfully for ${imageId}: ${thumbnailSizeKB}KB`);

  } catch (error) {
    console.error(`❌ Failed to generate thumbnail for ${imageId}:`, error);
    // Don't throw - this is background processing, we don't want to break the main flow
  }
}

/**
 * Generate thumbnails for existing images (migration utility)
 * @param limit Maximum number of images to process in one batch
 */
export async function generateThumbnailsForExistingImages(limit: number = 50): Promise<number> {
  try {
    console.log(`Starting batch thumbnail generation for up to ${limit} existing images...`);

    // Find images without thumbnails
    const imagesWithoutThumbnails = await db
      .select({
        id: generatedImages.id,
        userId: generatedImages.userId,
        generatedPath: generatedImages.generatedPath,
      })
      .from(generatedImages)
      .where(isNull(generatedImages.thumbnailPath))
      .limit(limit);

    if (imagesWithoutThumbnails.length === 0) {
      console.log('✅ All existing images already have thumbnails');
      return 0;
    }

    console.log(`Found ${imagesWithoutThumbnails.length} images needing thumbnails`);

    // Process images in parallel (but limit concurrency to avoid overwhelming Object Storage)
    const promises = imagesWithoutThumbnails.map(async (image) => {
      await generateThumbnail(image.generatedPath, image.userId, image.id);
    });

    await Promise.all(promises);

    console.log(`✅ Batch thumbnail generation completed for ${imagesWithoutThumbnails.length} images`);
    return imagesWithoutThumbnails.length;

  } catch (error) {
    console.error('❌ Batch thumbnail generation failed:', error);
    throw error;
  }
}