import express from 'express';
import * as objectStorage from './services/object-storage';

const router = express.Router();

/**
 * API routes for serving images from Replit Object Storage
 */

// Get an image or video from object storage by path
router.get('/storage-image/:path(*)', async (req, res) => {
  try {
    const imagePath = req.params.path;
    
    // Check if the image exists
    const exists = await objectStorage.imageExists(imagePath);
    if (!exists) {
      return res.status(404).json({ error: 'Image not found' });
    }
    
    // Download the image directly
    try {
      const imageBuffer = await objectStorage.downloadImage(imagePath);
      
      // Set content type based on file extension
      const extension = imagePath.split('.').pop()?.toLowerCase() || 'png';
      let contentType: string;
      
      if (extension === 'jpg' || extension === 'jpeg') {
        contentType = 'image/jpeg';
      } else if (extension === 'png') {
        contentType = 'image/png';
      } else if (extension === 'mp4') {
        contentType = 'video/mp4';
      } else if (extension === 'mov') {
        contentType = 'video/quicktime';
      } else if (extension === 'avi') {
        contentType = 'video/x-msvideo';
      } else if (extension === 'webm') {
        contentType = 'video/webm';
      } else {
        contentType = 'application/octet-stream';
      }
      
      // Send the file directly in the response
      res.set('Content-Type', contentType);
      res.set('Cache-Control', 'public, max-age=86400'); // Cache for 24 hours
      return res.send(imageBuffer);
    } catch (downloadError) {
      console.error('Error downloading image from Object Storage:', downloadError);
      
      // Fallback to URL redirection if direct download fails
      const imageUrl = await objectStorage.getImageUrl(imagePath, 3600);
      res.redirect(imageUrl);
    }
  } catch (error) {
    console.error('Error getting image from Object Storage:', error);
    res.status(500).json({ error: 'Error retrieving image' });
  }
});

// Get video file from object storage by path
router.get('/storage/:path(*)', async (req, res) => {
  try {
    const filePath = req.params.path;
    
    // Check if the file exists
    const exists = await objectStorage.imageExists(filePath); // reuse exists check
    if (!exists) {
      return res.status(404).json({ error: 'File not found' });
    }
    
    // Download the file directly
    const fileBuffer = await objectStorage.downloadImage(filePath); // reuse download method
    
    // Set content type based on file extension
    const extension = filePath.split('.').pop()?.toLowerCase() || 'mp4';
    const contentType = extension === 'mp4' 
      ? 'video/mp4' 
      : extension === 'webm' 
      ? 'video/webm' 
      : extension === 'png' 
      ? 'image/png' 
      : extension === 'jpg' || extension === 'jpeg'
      ? 'image/jpeg'
      : 'application/octet-stream';
    
    // Send the file directly in the response
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour
    return res.send(fileBuffer);
  } catch (error) {
    console.error('Error getting file from Object Storage:', error);
    res.status(500).json({ error: 'Error retrieving file' });
  }
});

// Get style image 
router.get('/styles/:styleId', async (req, res) => {
  try {
    const { styleId } = req.params;
    const styleUrl = await objectStorage.getStyleImageUrl(styleId);
    
    // Redirect to the URL
    res.redirect(styleUrl);
  } catch (error) {
    console.error('Error getting style image from Object Storage:', error);
    res.status(500).json({ error: 'Error retrieving style image' });
  }
});

// Get style thumbnail
router.get('/styles/thumbnails/:styleId', async (req, res) => {
  try {
    const { styleId } = req.params;
    const thumbnailUrl = await objectStorage.getStyleThumbnailUrl(styleId);
    
    // Redirect to the URL
    res.redirect(thumbnailUrl);
  } catch (error) {
    console.error('Error getting style thumbnail from Object Storage:', error);
    res.status(500).json({ error: 'Error retrieving style thumbnail' });
  }
});

// List user images
router.get('/user-images/:userId/:type?', async (req, res) => {
  try {
    const { userId } = req.params;
    const type = req.params.type || 'generated';
    
    if (!['originals', 'generated'].includes(type)) {
      return res.status(400).json({ error: 'Invalid image type' });
    }
    
    const images = await objectStorage.listUserImages(userId, type as any);
    res.json({ images });
  } catch (error) {
    console.error('Error listing user images from Object Storage:', error);
    res.status(500).json({ error: 'Error listing images' });
  }
});

// Cleanup old images (admin only)
router.post('/cleanup-images', async (req, res) => {
  try {
    // Check if user is admin (would need to implement proper auth)
    
    const { days = 30 } = req.body;
    const daysNumber = parseInt(days, 10);
    
    if (isNaN(daysNumber) || daysNumber < 1 || daysNumber > 365) {
      return res.status(400).json({ error: 'Invalid days parameter (must be 1-365)' });
    }
    
    const deletedCount = await objectStorage.cleanupOldImages(daysNumber);
    res.json({ 
      message: `Cleaned up ${deletedCount} images older than ${daysNumber} days`,
      deletedCount
    });
  } catch (error) {
    console.error('Error cleaning up images from Object Storage:', error);
    res.status(500).json({ error: 'Error cleaning up images' });
  }
});

export default router;