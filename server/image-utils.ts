import sharp from "sharp";

/**
 * Normalize image orientation using EXIF data
 * 
 * This function:
 * 1. Applies the EXIF orientation tag to correctly rotate the image ONCE
 * 2. Sets orientation to 1 (normal) in the metadata
 * 3. Strips EXIF data to prevent subsequent processing from re-rotating
 * 
 * @param buf Image buffer to normalize
 * @returns Normalized image buffer with orientation 1 and no EXIF data
 */
export async function normaliseOrientation(buf: Buffer): Promise<Buffer> {
  // Log original orientation for debugging
  const originalMetadata = await sharp(buf).metadata();
  console.log('EXIF before fix:', originalMetadata.orientation, 
    `(Dimensions: ${originalMetadata.width}x${originalMetadata.height})`);
  
  // Apply rotation based on EXIF data, then remove EXIF
  const normalizedBuffer = await sharp(buf)  // decode
    .rotate()                                // apply EXIF orientation exactly once
    .withMetadata({                          // write out orientation=1 only
      orientation: 1,
      exif: undefined
    })
    .toBuffer();
  
  // Verify orientation was normalized
  const newMetadata = await sharp(normalizedBuffer).metadata();
  console.log('EXIF after fix:', newMetadata.orientation || 1,
    `(Dimensions: ${newMetadata.width}x${newMetadata.height})`);
    
  return normalizedBuffer;
}