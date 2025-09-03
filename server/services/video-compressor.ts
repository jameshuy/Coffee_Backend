import { exec } from 'child_process';
import { promisify } from 'util';
import { db } from '../db';
import { generatedImages } from '../../shared/schema';
import { eq, isNull, and, isNotNull } from 'drizzle-orm';
import * as objectStorage from './object-storage';
import * as fs from 'fs/promises';
import * as path from 'path';

const execAsync = promisify(exec);

/**
 * Compress a video for faster loading using FFmpeg
 * @param originalVideoPath Path to original video in Object Storage
 * @param userEmail User's email for path construction
 * @param imageId Generated image ID to update in database
 */
export async function compressVideo(
  originalVideoPath: string,
  userEmail: string,
  imageId: string
): Promise<void> {
  const tempDir = '/tmp/video-compression';
  let tempInputPath = '';
  let tempOutputPath = '';
  
  try {
    console.log(`Starting video compression for image ${imageId}`);
    
    // Create temp directory
    await fs.mkdir(tempDir, { recursive: true });
    
    // Download original video to temp file
    console.log(`Downloading video from Object Storage: ${originalVideoPath}`);
    const videoBuffer = await objectStorage.downloadImage(originalVideoPath);
    
    if (!videoBuffer || videoBuffer.length === 0) {
      throw new Error(`Failed to download video from: ${originalVideoPath}`);
    }
    
    console.log(`Downloaded video size: ${Math.round(videoBuffer.length / 1024 / 1024)}MB`);
    
    // Save to temp file
    const videoId = path.basename(originalVideoPath, path.extname(originalVideoPath));
    tempInputPath = path.join(tempDir, `${videoId}-input.mov`);
    tempOutputPath = path.join(tempDir, `${videoId}-compressed.mp4`);
    
    await fs.writeFile(tempInputPath, videoBuffer);
    
    // Compress video using FFmpeg
    // - H.264 codec for wide compatibility
    // - 720p max resolution
    // - 1000k bitrate for good quality/size balance
    // - Remove audio to save space (videos are muted in feed anyway)
    // FFmpeg command with automatic rotation handling and proper scaling
    const ffmpegCommand = `ffmpeg -i "${tempInputPath}" -c:v libx264 -preset fast -crf 28 -vf "scale=w='if(gte(iw,ih),min(1280,iw),-2)':h='if(gte(iw,ih),-2,min(720,ih))':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2" -an -movflags +faststart -map_metadata 0 "${tempOutputPath}" -y`;
    
    console.log('Running FFmpeg compression...');
    const { stdout, stderr } = await execAsync(ffmpegCommand);
    
    if (stderr && !stderr.includes('frame=')) {
      console.error('FFmpeg stderr:', stderr);
    }
    
    // Check if output file was created
    const stats = await fs.stat(tempOutputPath);
    const compressedSize = stats.size;
    console.log(`✅ Compression complete. Size: ${Math.round(compressedSize / 1024 / 1024)}MB (${Math.round((1 - compressedSize / videoBuffer.length) * 100)}% reduction)`);
    
    // Read compressed video
    const compressedBuffer = await fs.readFile(tempOutputPath);
    
    // Create compressed video path
    const originalFileName = path.basename(originalVideoPath);
    const compressedFileName = originalFileName.replace(/\.(mov|mp4|avi|mkv)$/i, '-compressed.mp4');
    const compressedVideoPath = `users/${userEmail}/videos/compressed/${compressedFileName}`;
    
    // Upload to Object Storage
    console.log(`Uploading compressed video to: ${compressedVideoPath}`);
    await objectStorage.uploadCompressedVideoToStorage(compressedBuffer, compressedVideoPath);
    console.log(`✅ Uploaded compressed video to Object Storage`);
    
    // Update database with compressed video path
    await db
      .update(generatedImages)
      .set({ compressedVideoPath })
      .where(eq(generatedImages.id, imageId));
    
    console.log(`✅ Video compression completed for ${imageId}`);
    
  } catch (error) {
    console.error(`❌ Failed to compress video for ${imageId}:`, error);
    throw error;
  } finally {
    // Cleanup temp files
    try {
      if (tempInputPath) await fs.unlink(tempInputPath).catch(() => {});
      if (tempOutputPath) await fs.unlink(tempOutputPath).catch(() => {});
    } catch (cleanupError) {
      console.error('Error cleaning up temp files:', cleanupError);
    }
  }
}

/**
 * Compress videos for existing posts (migration utility)
 * @param limit Maximum number of videos to process in one batch
 */
export async function compressExistingVideos(limit: number = 5): Promise<number> {
  try {
    console.log(`Starting batch video compression for up to ${limit} existing videos...`);
    
    // Find videos without compressed versions
    const videosToCompress = await db
      .select({
        id: generatedImages.id,
        userId: generatedImages.userId,
        originalVideoPath: generatedImages.originalVideoPath,
      })
      .from(generatedImages)
      .where(
        and(
          eq(generatedImages.isPublic, true),
          isNull(generatedImages.compressedVideoPath),
          isNotNull(generatedImages.originalVideoPath)
        )
      )
      .limit(limit);
    
    if (videosToCompress.length === 0) {
      console.log('✅ All existing videos already have compressed versions');
      return 0;
    }
    
    console.log(`Found ${videosToCompress.length} videos needing compression`);
    
    // Process videos sequentially to avoid overloading the system
    let processedCount = 0;
    for (const video of videosToCompress) {
      if (video.originalVideoPath) {
        try {
          await compressVideo(video.originalVideoPath, video.userId, video.id);
          processedCount++;
        } catch (error) {
          console.error(`Failed to compress video ${video.id}:`, error);
        }
      }
    }
    
    console.log(`✅ Batch video compression completed for ${processedCount} videos`);
    return processedCount;
    
  } catch (error) {
    console.error('❌ Batch video compression failed:', error);
    throw error;
  }
}