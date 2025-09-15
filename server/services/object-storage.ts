import { supabase, STORAGE_BUCKET } from '../config/supabase';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db';
import { generatedImages } from '@shared/schema';
import { eq, gt } from 'drizzle-orm';
import * as fs from 'fs';
import * as path from 'path';

// Initialize Supabase Storage client
console.log('Initializing Supabase Storage client with bucket:', STORAGE_BUCKET);

// Helper function to generate a unique ID
function generateUniqueId(): string {
  return uuidv4();
}

// Upload original user image
export async function uploadOriginalImage(userId: string, imageBuffer: Buffer, extension: string): Promise<string> {
  const uuid = generateUniqueId();
  const filePath = `users/${userId}/originals/${uuid}.${extension}`;
  
  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(filePath, imageBuffer, {
      contentType: extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : `image/${extension}`,
      upsert: false
    });
  
  if (error) {
    throw new Error(`Failed to upload original image: ${error.message}`);
  }
  
  console.log(`Uploaded original image to Supabase Storage: ${filePath}`);
  return filePath;
}

// Upload AI-generated image
export async function uploadGeneratedImage(
  userId: string, 
  imageBuffer: Buffer, 
  style: string, 
  originalPath: string, 
  extension: string = 'png',
  videoData?: {
    originalVideoPath?: string;
    videoFrameTimestamp?: number;
  }
): Promise<string> {
  const uuid = originalPath.split('/').pop()?.split('.')[0] || generateUniqueId();
  const filePath = `users/${userId}/generated/${uuid}-${style}.${extension}`;
  
  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(filePath, imageBuffer, {
      contentType: extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : `image/${extension}`,
      upsert: false
    });
  
  if (error) {
    throw new Error(`Failed to upload generated image: ${error.message}`);
  }
  
  // Record in database with video data if available
  const dbRecord: any = {
    userId,
    originalPath,
    generatedPath: filePath,
    style,
    isPublic: false
  };

  // Add video-related fields if provided
  if (videoData) {
    console.log('📹 Video data received in uploadGeneratedImage:', {
      originalVideoPath: videoData.originalVideoPath,
      videoFrameTimestamp: videoData.videoFrameTimestamp
    });
    
    if (videoData.originalVideoPath) {
      dbRecord.originalVideoPath = videoData.originalVideoPath;
    }
    if (videoData.videoFrameTimestamp !== undefined) {
      dbRecord.videoFrameTimestamp = videoData.videoFrameTimestamp;
    }
    dbRecord.videoProcessingStatus = 'pending';
  } else {
    console.log('📹 No video data provided to uploadGeneratedImage');
  }

  const [insertedRecord] = await db.insert(generatedImages).values(dbRecord).returning();
  
  console.log(`Uploaded generated image to Supabase Storage: ${filePath}`);
  
  // Trigger automatic thumbnail generation immediately after database record creation
  if (insertedRecord) {
    import('./thumbnail-generator').then(({ generateThumbnail }) => {
      generateThumbnail(filePath, userId, insertedRecord.id)
        .then(() => {
          console.log(`✅ Automatic thumbnail generated for ${insertedRecord.id}`);
        })
        .catch(error => {
          console.error('❌ Automatic thumbnail generation failed:', error);
        });
    });
    
    // Trigger video compression if video data is provided
    if (videoData?.originalVideoPath) {
      const videoPath = videoData.originalVideoPath;
      import('./video-compressor').then(({ compressVideo }) => {
        compressVideo(videoPath, userId, insertedRecord.id)
          .then(() => {
            console.log(`✅ Automatic video compression started for ${insertedRecord.id}`);
          })
          .catch(error => {
            console.error('❌ Automatic video compression failed:', error);
          });
      });
    }
  }
  
  return filePath;
}

// This function has been removed as part of code cleanup
// Processing of images for download is now done on-the-fly without storing 
// a separate copy in the 'shareable' path

// Upload style reference image
export async function uploadStyleImage(styleId: string, imageBuffer: Buffer, extension: string = 'png'): Promise<string> {
  const filePath = `styles/full/${styleId}.${extension}`;
  
  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(filePath, imageBuffer, {
      contentType: extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : `image/${extension}`,
      upsert: true
    });
  
  if (error) {
    throw new Error(`Failed to upload style image: ${error.message}`);
  }
  
  console.log(`Uploaded style image to Supabase Storage: ${filePath}`);
  return filePath;
}

// Function for migration script to upload style images with a custom path
export async function uploadStyleImageWithPath(fileBuffer: Buffer, customPath: string): Promise<string> {
  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(customPath, fileBuffer, {
      contentType: 'image/png', // Default to PNG for style images
      upsert: true
    });
  
  if (error) {
    throw new Error(`Failed to upload style image to custom path: ${error.message}`);
  }
  
  console.log(`Uploaded style image to Supabase Storage custom path: ${customPath}`);
  return customPath;
}

// Upload style thumbnail
export async function uploadStyleThumbnail(styleId: string, thumbnailBuffer: Buffer, extension: string): Promise<string> {
  const filePath = `styles/thumbnails/${styleId}_thumbnail.${extension}`;
  
  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(filePath, thumbnailBuffer, {
      contentType: extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : `image/${extension}`,
      upsert: true
    });
  
  if (error) {
    throw new Error(`Failed to upload style thumbnail: ${error.message}`);
  }
  
  console.log(`Uploaded style thumbnail to Supabase Storage: ${filePath}`);
  return filePath;
}

// Upload generated poster thumbnail
export async function uploadThumbnailToStorage(thumbnailBuffer: Buffer, thumbnailPath: string): Promise<string> {
  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(thumbnailPath, thumbnailBuffer, {
      contentType: 'image/png',
      upsert: true
    });
  
  if (error) {
    throw new Error(`Failed to upload thumbnail: ${error.message}`);
  }
  
  console.log(`Uploaded thumbnail to Supabase Storage: ${thumbnailPath}`);
  return thumbnailPath;
}

// Upload compressed video
export async function uploadCompressedVideoToStorage(videoBuffer: Buffer, videoPath: string): Promise<string> {
  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(videoPath, videoBuffer, {
      contentType: 'video/mp4',
      upsert: true
    });
  
  if (error) {
    throw new Error(`Failed to upload compressed video: ${error.message}`);
  }
  
  console.log(`Uploaded compressed video to Supabase Storage: ${videoPath}`);
  return videoPath;
}

// Get URL for the image that can be used for download or display
export async function getImageUrl(filePath: string, expiresIn: number = 3600): Promise<string> {
  // const { data } = await supabase.storage
  //   .from(STORAGE_BUCKET)
  //   .createSignedUrl(filePath, expiresIn);
  
  // if (data?.signedUrl) {
  //   return data.signedUrl;
  // }
  
  // Fallback to API path if signed URL generation fails
  return `/api/storage-image/${filePath}`;
}

// Get style image URL
export async function getStyleImageUrl(styleId: string, extension: string = 'png'): Promise<string> {
  const imagePath = `styles/full/${styleId}.${extension}`;
  return await getImageUrl(imagePath);
}

// Get style thumbnail URL
export async function getStyleThumbnailUrl(styleId: string, extension: string = 'png'): Promise<string> {
  // Ensure consistent naming standard in Supabase Storage (all use styleId_thumbnail.png format)
  const thumbnailPath = `styles/thumbnails/${styleId}_thumbnail.${extension}`;
  return await getImageUrl(thumbnailPath);
}

// Delete a specific image
export async function deleteImage(filePath: string): Promise<void> {
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .remove([filePath]);
  
  if (error) {
    throw new Error(`Failed to delete image: ${error.message}`);
  }
  console.log(`Deleted image from Supabase Storage: ${filePath}`);
}

// List all images for a user
export async function listUserImages(userId: string, type: 'originals' | 'generated' = 'generated'): Promise<string[]> {
  const prefix = `users/${userId}/${type}/`;
  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .list(prefix.split('/').slice(0, -1).join('/'), {
      limit: 1000,
      search: prefix.split('/').pop()
    });
  
  if (error) {
    throw new Error(`Failed to list user images: ${error.message}`);
  }
  
  return data?.map(item => `${prefix}${item.name}`) || [];
}

// Check if an image exists
export async function imageExists(filePath: string): Promise<boolean> {
  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .list(filePath.split('/').slice(0, -1).join('/'), {
      search: filePath.split('/').pop()
    });
  
  if (error) {
    console.error('Error checking if image exists:', error);
    return false;
  }
  
  return data && data.length > 0;
}

// Download an image as bytes
export async function downloadImage(filePath: string): Promise<Buffer> {
  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .download(filePath);
  
  if (error) {
    throw new Error(`Failed to download image: ${error.message}`);
  }
  
  if (!data) {
    throw new Error('No data received from download');
  }
  
  // Convert Blob to Buffer
  const arrayBuffer = await data.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// These functions have been removed as part of code cleanup
// Orders now store references to existing images in the database
// rather than creating duplicate copies in separate 'orders' paths

// Clean up old images
export async function cleanupOldImages(ageInDays: number = 30): Promise<number> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - ageInDays);
  
  // Query database for images to keep
  const imagesToKeep = await db.select({
    generatedPath: generatedImages.generatedPath,
    originalPath: generatedImages.originalPath,
  })
  .from(generatedImages)
  .where(
    // Filter by date using condition instead of gt method
    // This matches any images that are recent
    gt(generatedImages.createdAt, cutoffDate)
  );
  
  // Create sets of paths to keep for efficient lookups
  const pathsToKeep = new Set([
    ...imagesToKeep.map(img => img.originalPath),
    ...imagesToKeep.map(img => img.generatedPath)
  ]);
  
  // Get all user images from Supabase Storage
  const { data: allFiles, error: listError } = await supabase.storage
    .from(STORAGE_BUCKET)
    .list('users', {
      limit: 1000,
      sortBy: { column: 'created_at', order: 'desc' }
    });
  
  if (listError) {
    throw new Error(`Failed to list images for cleanup: ${listError.message}`);
  }
  
  // Delete images not in the keep set
  let deletedCount = 0;
  const filesToDelete: string[] = [];
  
  // Recursively collect files to delete
  const collectFilesToDelete = async (folderPath: string) => {
    const { data: folderFiles, error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .list(folderPath, { limit: 1000 });
    
    if (error) {
      console.error(`Error listing folder ${folderPath}:`, error);
      return;
    }
    
    for (const file of folderFiles || []) {
      const fullPath = `${folderPath}/${file.name}`;
      if (file.metadata?.mimetype) {
        // It's a file
        if (!pathsToKeep.has(fullPath)) {
          filesToDelete.push(fullPath);
        }
      } else {
        // It's a folder, recurse
        await collectFilesToDelete(fullPath);
      }
    }
  };
  
  // Start collecting files to delete
  for (const userFolder of allFiles || []) {
    if (!userFolder.metadata?.mimetype) {
      // It's a folder, recurse into it
      await collectFilesToDelete(`users/${userFolder.name}`);
    }
  }
  
  // Delete files in batches
  if (filesToDelete.length > 0) {
    const { error: deleteError } = await supabase.storage
      .from(STORAGE_BUCKET)
      .remove(filesToDelete);
    
    if (deleteError) {
      console.error('Error deleting files during cleanup:', deleteError);
    } else {
      deletedCount = filesToDelete.length;
    }
  }
  
  console.log(`Cleaned up ${deletedCount} old images from Supabase Storage`);
  return deletedCount;
}

// Upload buffer with custom content type
export async function uploadBuffer(filePath: string, buffer: Buffer, contentType: string): Promise<string> {
  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(filePath, buffer, {
      contentType,
      upsert: true
    });
  
  if (error) {
    throw new Error(`Failed to upload buffer: ${error.message}`);
  }
  
  console.log(`Uploaded buffer to Supabase Storage: ${filePath}`);
  return filePath;
}

// Generate pre-signed URL for file access
export async function getPreSignedUrl(path: string, expiresIn: number = 3600): Promise<string> {
  // For Replit Object Storage, we can directly access files via the storage URL
  // In production, this would be replaced with proper pre-signed URL generation
  return `/api/storage/${path}`;
}