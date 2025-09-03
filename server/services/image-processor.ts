import sharp from 'sharp';
import * as path from 'path';
// Import the Object Storage utilities instead of directly using the client
import * as objectStorage from './object-storage';

/**
 * Adds a white border to an image (watermark temporarily disabled)
 * @param imageUrl URL of the image to process
 * @returns URL of the processed image
 */
export async function addBorderAndWatermark(imageUrl: string): Promise<string> {
  try {
    // Parse the image URL to extract user info and file name
    // Expected format: /api/storage-image/users/user@email.com/generated/file.png
    const urlMatch = imageUrl.match(/\/api\/storage-image\/users\/([^\/]+)\/generated\/([^?]+)/);
    if (!urlMatch) {
      throw new Error("Invalid image URL format");
    }
    
    const userEmail = decodeURIComponent(urlMatch[1]);
    const imageFileName = urlMatch[2];
    
    // Download the original image from Object Storage
    const objectStoragePath = `users/${userEmail}/generated/${imageFileName}`;
    console.log(`Fetching from Object Storage: ${objectStoragePath}`);
    
    let imageBuffer;
    try {
      // Use existing downloadImage utility function from object-storage.ts
      imageBuffer = await objectStorage.downloadImage(objectStoragePath);
    } catch (error) {
      console.error("Error fetching image from Object Storage:", error);
      throw new Error("Could not download the original image");
    }
    
    // Get image dimensions
    const imageMetadata = await sharp(imageBuffer).metadata();
    const imageWidth = imageMetadata.width || 800;
    const imageHeight = imageMetadata.height || 1132; // Approximating A3 ratio 1:√2 
    
    // Calculate border width (58 pixels)
    const borderWidth = 58;
    
    // Calculate the new dimensions with border
    const finalWidth = imageWidth + borderWidth * 2;
    const finalHeight = imageHeight + borderWidth * 2;

    // Create a white background with border - NO WATERMARK FOR NOW
    const compositeImage = await sharp({
      create: {
        width: finalWidth,
        height: finalHeight,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 }
      }
    })
      .composite([
        {
          input: imageBuffer,
          top: borderWidth,
          left: borderWidth
        }
      ])
      .png()
      .withMetadata({ density: 72 }) // Explicitly set 72 DPI
      .toBuffer();
    
    // Images are now processed on-the-fly and returned directly to the client
    // without storing separate copies in a 'shareable' path
    
    // Set appropriate headers for the image response including a suggested filename
    // The buffer is returned directly from the route handler
    
    // Create a temporary filename for client-side download that includes "poster" in the name
    const downloadFileName = imageFileName.replace(/\.[^.]+$/, '')+'-poster.png';
    
    // Return a specially formatted response that will be handled by the route handler
    return JSON.stringify({
      buffer: compositeImage,
      fileName: downloadFileName,
      contentType: 'image/png'
    });
    
  } catch (error) {
    console.error("Error processing image for download:", error);
    throw error;
  }
}

/**
 * Creates a share-ready image with white border using 419×610px canvas
 * @param imageUrl URL of the image to process for sharing (supports both thumbnail and generated URLs)
 * @returns Buffer of the processed image with white border
 */
export async function createShareImageWithBorder(imageUrl: string): Promise<Buffer> {
  try {
    let objectStoragePath: string;
    
    // Check if URL is already a thumbnail URL
    const isThumbnailUrl = imageUrl.includes('/thumbnails/');
    
    if (isThumbnailUrl) {
      // Extract path directly from thumbnail URL
      const thumbnailMatch = imageUrl.match(/\/api\/storage-image\/(.+)/);
      if (!thumbnailMatch) {
        throw new Error("Invalid thumbnail URL format");
      }
      objectStoragePath = thumbnailMatch[1];
    } else {
      // Handle generated image URL - convert to thumbnail path
      const urlMatch = imageUrl.match(/\/api\/storage-image\/users\/([^\/]+)\/generated\/([^?]+)/);
      if (!urlMatch) {
        throw new Error("Invalid image URL format");
      }
      
      const userEmail = decodeURIComponent(urlMatch[1]);
      const imageFileName = urlMatch[2];
      
      // Use thumbnail only for sharing (no fallback)
      const thumbnailPath = imageFileName.replace(/\.[^.]+$/, '.jpg'); // Thumbnails are JPG
      objectStoragePath = `users/${userEmail}/thumbnails/${thumbnailPath}`;
    }
    
    // Download thumbnail image only - no fallback
    const thumbnailBuffer = await objectStorage.downloadImage(objectStoragePath);
    
    // Create 419×610px white canvas with centered thumbnail (21px left/right, 22px top/bottom borders)
    const shareImage = await sharp({
      create: {
        width: 419,
        height: 610,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 }
      }
    })
      .composite([
        {
          input: thumbnailBuffer,
          top: 22,
          left: 21
        }
      ])
      .png()
      .toBuffer();
    
    return shareImage;
    
  } catch (error) {
    console.error("Error creating share image with border:", error);
    throw error;
  }
}