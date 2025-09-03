import * as objectStorage from './object-storage';
import { db } from '../db';
import { generatedImages } from '@shared/schema';
import { normaliseOrientation } from '../image-utils';
import { eq } from 'drizzle-orm';
import * as fs from 'fs';
import * as path from 'path';

/**
 * This adapter provides functions that can be used to replace file system operations
 * in the routes with Object Storage operations
 */

/**
 * Saves a base64 image to Object Storage
 * Replacement for the saveBase64Image function in routes.ts
 */
export async function saveBase64ImageToStorage(base64Data: string, confirmationId: string, email: string = 'anonymous'): Promise<string> {
  console.log("IMAGE UPLOAD STARTED (Storage) - Confirmation ID:", confirmationId);
  
  try {
    // Extract the base64 content and type
    const matches = base64Data.match(/^data:image\/([A-Za-z-+\/]+);base64,(.+)$/);
    
    if (!matches || matches.length !== 3) {
      console.error("Invalid base64 image data format");
      throw new Error('Invalid image data format');
    }
    
    // Get image type and data
    const imageType = matches[1];
    const imageData = matches[2];
    
    console.log("IMAGE DATA INFO (Storage):", {
      imageType,
      dataLength: imageData.length,
      confirmationId
    });
    
    // Convert base64 to raw buffer
    const rawBuffer = Buffer.from(imageData, 'base64');
    
    // CRITICAL FIX: Normalize orientation ONCE at the beginning of the pipeline
    console.log("⚠️ APPLYING EXIF ORIENTATION CORRECTION");
    const normalizedBuffer = await normaliseOrientation(rawBuffer);
    console.log("✅ ORIENTATION NORMALIZED");
    
    // Get file extension
    const extension = imageType === 'jpeg' ? 'jpg' : imageType;
    
    // Upload to Object Storage
    const path = await objectStorage.uploadOriginalImage(email, normalizedBuffer, extension);
    
    // Generate the URL that should be returned to the client
    // Using a path format that can be easily translated later
    return `/api/storage-image/${path}`;
  } catch (error) {
    console.error("Error saving image to Object Storage:", error);
    throw error;
  }
}

/**
 * Fetches an image from a URL and saves it to Object Storage
 * Replacement for the fetchImageAndSave function in routes.ts
 */
export async function fetchImageAndSaveToStorage(
  imageUrl: string, 
  email: string, 
  style: string, 
  originalPath: string,
  videoData?: {
    originalVideoPath?: string;
    videoFrameTimestamp?: number;
  }
): Promise<string> {
  console.log(`Fetching image from URL: ${imageUrl}`);
  
  try {
    const response = await fetch(imageUrl);
    
    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
    }
    
    // Convert response to ArrayBuffer, then to Buffer
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    
    // Log video data being passed
    console.log('📹 Video data being passed to uploadGeneratedImage:', videoData);
    
    // Upload to Object Storage
    const path = await objectStorage.uploadGeneratedImage(email, buffer, style, originalPath, 'png', videoData);
    
    // Generate the URL that should be returned to the client
    return `/api/storage-image/${path}`;
  } catch (error) {
    console.error("Error fetching and saving image to Object Storage:", error);
    throw error;
  }
}

/**
 * Copies a file from a local path to Object Storage
 * Replacement for the copyFile function in routes.ts
 * 
 * Now also supports direct paths from Object Storage - returns the path directly
 * without copying the file if it's already in Object Storage
 */
export async function copyFileToStorage(
  sourcePath: string, 
  destFolder: string, 
  newFilename: string,
  email: string
): Promise<string> {
  console.log(`COPY FILE TO OBJECT STORAGE: 
    Source: ${sourcePath}
    Destination Folder: ${destFolder}
    New Filename: ${newFilename}
    Email: ${email}`);
  
  // Check if this is already an Object Storage path
  if (sourcePath.startsWith('/api/storage-image/')) {
    console.log('Object Storage path detected, using direct URL instead of copying');
    return sourcePath; // Return the path directly without copying
  }
  
  try {
    // Get absolute path to source
    const fullSourcePath = path.join(
      process.cwd(), 
      'public',
      sourcePath.startsWith('/') ? sourcePath.substring(1) : sourcePath
    );
    
    // Read the file
    const fileBuffer = fs.readFileSync(fullSourcePath);
    
    // Determine the extension
    const extension = path.extname(newFilename).substring(1);
    
    // Extract style from the filename if it's a poster
    let style = 'unknown';
    if (newFilename.startsWith('POSTER-')) {
      const styleMatch = sourcePath.match(/([a-z]+)\.png$/);
      if (styleMatch) {
        style = styleMatch[1];
      }
    }
    
    // Upload to the appropriate location (only originals supported now)
    let storagePath: string;
    
    // Original images are the only type directly uploaded now
    // Order images are references to existing images in the database
    storagePath = await objectStorage.uploadOriginalImage(email, fileBuffer, extension);
    
    // Return the public URL for the stored object
    return `/api/storage-image/${storagePath}`;
  } catch (error) {
    console.error("Error copying file to Object Storage:", error);
    throw error;
  }
}

/**
 * This function has been removed as part of code cleanup.
 * Shareable images are now processed on-the-fly without storing in Object Storage.
 * See the addBorderAndWatermark function in image-processor.ts for the current implementation.
 */