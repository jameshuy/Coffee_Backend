import { Client } from '@replit/object-storage';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db';
import { generatedImages } from '@shared/schema';
import { eq, gt } from 'drizzle-orm';
import * as fs from 'fs';
import * as path from 'path';

// Initialize Object Storage with proper configuration for both development and production
// The Client automatically uses Replit credentials within the Replit environment
let client: Client;

try {
  // Check if we have Replit Object Storage credentials in the environment
  if (process.env.REPLIT_DB_URL || process.env.REPL_ID) {
    console.log('Initializing Object Storage with Replit credentials');
    client = new Client();
  } else {
    // Fallback configuration for non-Replit environments
    console.log('Initializing Object Storage with fallback configuration');
    client = {
      get: async (key: string) => null,
      set: async (key: string, value: any) => {},
      delete: async (key: string) => {},
      list: async () => [],
    } as unknown as Client;
    // This should never happen in deployment, but provides better error handling
    throw new Error('Object Storage is required and no Replit environment was detected');
  }
} catch (error) {
  console.error('Failed to initialize Object Storage client:', error);
  // Create a dummy client that will throw appropriate errors if used
  // This prevents the application from crashing at startup
  client = new Client();
}

// Helper function to generate a unique ID
function generateUniqueId(): string {
  return uuidv4();
}

// Upload original user image
export async function uploadOriginalImage(userId: string, imageBuffer: Buffer, extension: string): Promise<string> {
  const uuid = generateUniqueId();
  const path = `users/${userId}/originals/${uuid}.${extension}`;
  
  const result = await client.uploadFromBytes(path, imageBuffer);
  if (!result.ok) {
    throw new Error(`Failed to upload original image: ${result.error.message}`);
  }
  
  console.log(`Uploaded original image to Object Storage: ${path}`);
  return path;
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
  const path = `users/${userId}/generated/${uuid}-${style}.${extension}`;
  
  const result = await client.uploadFromBytes(path, imageBuffer);
  if (!result.ok) {
    throw new Error(`Failed to upload generated image: ${result.error.message}`);
  }
  
  // Record in database with video data if available
  const dbRecord: any = {
    userId,
    originalPath,
    generatedPath: path,
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
  
  console.log(`Uploaded generated image to Object Storage: ${path}`);
  
  // Trigger automatic thumbnail generation immediately after database record creation
  if (insertedRecord) {
    import('./thumbnail-generator').then(({ generateThumbnail }) => {
      generateThumbnail(path, userId, insertedRecord.id)
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
  
  return path;
}

// This function has been removed as part of code cleanup
// Processing of images for download is now done on-the-fly without storing 
// a separate copy in the 'shareable' path

// Upload style reference image
export async function uploadStyleImage(styleId: string, imageBuffer: Buffer, extension: string = 'png'): Promise<string> {
  const path = `styles/full/${styleId}.${extension}`;
  
  const result = await client.uploadFromBytes(path, imageBuffer);
  if (!result.ok) {
    throw new Error(`Failed to upload style image: ${result.error.message}`);
  }
  
  console.log(`Uploaded style image to Object Storage: ${path}`);
  return path;
}

// Function for migration script to upload style images with a custom path
export async function uploadStyleImageWithPath(fileBuffer: Buffer, customPath: string): Promise<string> {
  const result = await client.uploadFromBytes(customPath, fileBuffer);
  if (!result.ok) {
    throw new Error(`Failed to upload style image to custom path: ${result.error.message}`);
  }
  
  console.log(`Uploaded style image to Object Storage custom path: ${customPath}`);
  return customPath;
}

// Upload style thumbnail
export async function uploadStyleThumbnail(styleId: string, thumbnailBuffer: Buffer, extension: string): Promise<string> {
  const path = `styles/thumbnails/${styleId}_thumbnail.${extension}`;
  
  const result = await client.uploadFromBytes(path, thumbnailBuffer);
  if (!result.ok) {
    throw new Error(`Failed to upload style thumbnail: ${result.error.message}`);
  }
  
  console.log(`Uploaded style thumbnail to Object Storage: ${path}`);
  return path;
}

// Upload generated poster thumbnail
export async function uploadThumbnailToStorage(thumbnailBuffer: Buffer, thumbnailPath: string): Promise<string> {
  const result = await client.uploadFromBytes(thumbnailPath, thumbnailBuffer);
  if (!result.ok) {
    throw new Error(`Failed to upload thumbnail: ${result.error.message}`);
  }
  
  console.log(`Uploaded thumbnail to Object Storage: ${thumbnailPath}`);
  return thumbnailPath;
}

// Upload compressed video
export async function uploadCompressedVideoToStorage(videoBuffer: Buffer, videoPath: string): Promise<string> {
  const result = await client.uploadFromBytes(videoPath, videoBuffer);
  if (!result.ok) {
    throw new Error(`Failed to upload compressed video: ${result.error.message}`);
  }
  
  console.log(`Uploaded compressed video to Object Storage: ${videoPath}`);
  return videoPath;
}

// Get URL for the image that can be used for download or display
// Note: The client doesn't have a getDownloadUrl method, we need to generate URLs differently
export async function getImageUrl(path: string, expiresIn: number = 3600): Promise<string> {
  // This is a placeholder since getDownloadUrl isn't in the docs
  // In a real implementation, we would need to generate a pre-signed URL or serve through API
  
  // For now, we'll return the API path that would redirect to the object
  return `/api/storage-image/${path}`;
}

// Get style image URL
export async function getStyleImageUrl(styleId: string, extension: string = 'png'): Promise<string> {
  const imagePath = `styles/images/${styleId}.${extension}`;
  return `/api/storage-image/${imagePath}`;
}

// Get style thumbnail URL
export async function getStyleThumbnailUrl(styleId: string, extension: string = 'png'): Promise<string> {
  // Ensure consistent naming standard in Object Storage (all use styleId_thumbnail.png format)
  const thumbnailPath = `styles/thumbnails/${styleId}_thumbnail.${extension}`;
  return `/api/storage-image/${thumbnailPath}`;
}

// Delete a specific image
export async function deleteImage(path: string): Promise<void> {
  const result = await client.delete(path);
  if (!result.ok) {
    throw new Error(`Failed to delete image: ${result.error.message}`);
  }
  console.log(`Deleted image from Object Storage: ${path}`);
}

// List all images for a user
export async function listUserImages(userId: string, type: 'originals' | 'generated' = 'generated'): Promise<string[]> {
  const prefix = `users/${userId}/${type}/`;
  const result = await client.list({ prefix });
  
  if (!result.ok) {
    throw new Error(`Failed to list user images: ${result.error.message}`);
  }
  
  return result.value.map(item => item.name);
}

// Check if an image exists
export async function imageExists(path: string): Promise<boolean> {
  const result = await client.exists(path);
  return result.ok ? result.value : false;
}

// Download an image as bytes
export async function downloadImage(path: string): Promise<Buffer> {
  // Use the download to file approach and then read the file
  // Make sure the temp directory exists
  const tempDir = 'temp';
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  const tempFilePath = `${tempDir}/${path.split('/').pop()}-${Date.now()}`;
  const fileResult = await client.downloadToFilename(path, tempFilePath);
  
  if (!fileResult.ok) {
    throw new Error(`Failed to download image: ${fileResult.error.message}`);
  }
  
  // Read the file into a buffer
  const buffer = fs.readFileSync(tempFilePath);
  
  // Clean up the temp file
  try {
    fs.unlinkSync(tempFilePath);
  } catch (err) {
    console.warn(`Failed to delete temp file ${tempFilePath}:`, err);
  }
  
  return buffer;
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
  
  // Get all user images
  const listResult = await client.list({ prefix: 'users/' });
  if (!listResult.ok) {
    throw new Error(`Failed to list images for cleanup: ${listResult.error.message}`);
  }
  
  // Delete images not in the keep set
  let deletedCount = 0;
  for (const image of listResult.value) {
    const key = image.name; // Use name property from StorageObject
    if (key && !pathsToKeep.has(key)) {
      const deleteResult = await client.delete(key);
      if (deleteResult.ok) {
        deletedCount++;
      } else {
        console.error(`Failed to delete image during cleanup: ${deleteResult.error.message}`);
      }
    }
  }
  
  console.log(`Cleaned up ${deletedCount} old images from Object Storage`);
  return deletedCount;
}

// Upload buffer with custom content type
export async function uploadBuffer(path: string, buffer: Buffer, contentType: string): Promise<string> {
  const result = await client.uploadFromBytes(path, buffer);
  if (!result.ok) {
    throw new Error(`Failed to upload buffer: ${result.error.message}`);
  }
  
  console.log(`Uploaded buffer to Object Storage: ${path}`);
  return path;
}

// Generate pre-signed URL for file access
export async function getPreSignedUrl(path: string, expiresIn: number = 3600): Promise<string> {
  // For Replit Object Storage, we can directly access files via the storage URL
  // In production, this would be replaced with proper pre-signed URL generation
  return `/api/storage/${path}`;
}