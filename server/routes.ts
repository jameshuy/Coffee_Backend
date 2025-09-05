import type { Express } from "express";
import express from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { 
  insertOrderSchema, 
  generatedImages, 
  type InsertOrder, 
  insertCatalogueOrderSchema, 
  insertCatalogueOrderItemSchema, 
  type InsertCatalogueOrder, 
  type InsertCatalogueOrderItem,
  betaReleaseStats,
  users
} from "@shared/schema";
import { desc, eq, sql, and } from "drizzle-orm";
import { sendOrderConfirmationEmail, sendVerificationEmail, sendNewOrderNotificationEmail, sendPartnerInquiryEmail } from "./email-service";
import Stripe from "stripe";
import { z } from "zod";
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import sharp from 'sharp';
import cookieParser from 'cookie-parser';
import adminRouter from './admin-routes';


// Import for image normalization
import { normaliseOrientation } from "./image-utils";

// Import for Object Storage integration
import * as objectStorage from './services/object-storage';
import * as storageAdapter from './services/routes-adapter';
import { addBorderAndWatermark, createShareImageWithBorder } from './services/image-processor';
import { generateThumbnail } from './services/thumbnail-generator';
import { db } from './db';
import { verifyToken } from './auth-service';




// Authentication middleware
async function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  try {
    const token = req.cookies?.auth_token;
    
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const decoded = verifyToken(token);
    
    if (!decoded) {
      return res.status(401).json({ error: 'Invalid authentication token' });
    }
    
    // Get user from storage
    const user = await storage.getUserByEmail(decoded.email);
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }
    
    // Set user info for the route handlers
    (req as any).user = user;
    
    next();
  } catch (error) {
    console.error('Authentication error:', error);
    return res.status(401).json({ error: 'Authentication failed' });
  }
}

// Helper function to get current timestamp in Zurich, Switzerland time zone (UTC+2)
function getZurichTimestamp(): string {
  // Create a date object with the current time
  const now = new Date();
  
  // Calculate Zurich time by adding the timezone offset for Zurich (UTC+2)
  // Summer time (DST) is UTC+2, winter time is UTC+1
  // Get the current UTC time
  const utcTime = now.getTime() + (now.getTimezoneOffset() * 60000);
  
  // Convert to Zurich time (UTC+2)
  const zurichTime = new Date(utcTime + (3600000 * 2)); // +2 hours
  
  // Format as ISO string and remove the 'Z' at the end to make it a local timestamp
  const isoString = zurichTime.toISOString().replace('Z', '');
  
  return isoString;
}

// Global declarations for session variables
declare global {
  var lastUploadedImagePath: string;
}



// Import image public endpoint router


// Import Replicate for GPT Image generation
import Replicate from "replicate";

// Initialize Replicate client
if (!process.env.REPLICATE_API_KEY) {
  throw new Error('Missing required Replicate API key: REPLICATE_API_KEY');
}
const replicate = new Replicate({
  auth: process.env.REPLICATE_API_KEY,
});

// Initialize Stripe with the secret key
if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error('Missing required Stripe key: STRIPE_SECRET_KEY');
}
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Price of a poster in cents (for Stripe) - FORCED TO 60 CENTS
const POSTER_PRICE = 2995; // CHF 29.95 (in cents for Stripe)
const SHIPPING_PRICE = 0; // CHF 0.00 shipping fee (free shipping)

// Enhanced validation schema for the shipping data during checkout preparation
const checkoutShippingSchema = z.object({
  firstName: z.string()
    .min(2, "First name must be at least 2 characters")
    .max(50, "First name must be less than 50 characters")
    .regex(/^[a-zA-ZÀ-ÿ\s'-]+$/, "First name contains invalid characters"),
  lastName: z.string()
    .min(2, "Last name must be at least 2 characters")
    .max(50, "Last name must be less than 50 characters")
    .regex(/^[a-zA-ZÀ-ÿ\s'-]+$/, "Last name contains invalid characters"),
  email: z.string().email("Invalid email address"),
  address: z.string()
    .min(10, "Address must be at least 10 characters")
    .max(200, "Address must be less than 200 characters")
    .regex(/^[a-zA-Z0-9\s,.'#-]+$/, "Address contains invalid characters"),
  city: z.string()
    .min(2, "City must be at least 2 characters")
    .max(100, "City must be less than 100 characters")
    .regex(/^[a-zA-ZÀ-ÿ\s'-]+$/, "City contains invalid characters"),
  state: z.string()
    .min(2, "State/Province must be at least 2 characters")
    .max(100, "State/Province must be less than 100 characters")
    .regex(/^[a-zA-ZÀ-ÿ\s'-]+$/, "State/Province contains invalid characters"),
  zipCode: z.string()
    .min(3, "Zip/Postal code must be at least 3 characters")
    .max(12, "Zip/Postal code must be less than 12 characters")
    .regex(/^[a-zA-Z0-9\s-]+$/, "Zip/Postal code format is invalid"),
  country: z.string().min(2, "Country is required"),
  // Add quantity field (optional, defaults to 1 if not provided)
  quantity: z.number().int().positive().optional().default(1),
  // originalImageUrl is not required during checkout preparation
});

// Validation schema for the complete order (including image)
const completeOrderSchema = z.object({
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  email: z.string().email("Invalid email address"),
  address: z.string().min(1, "Address is required"),
  city: z.string().min(1, "City is required"),
  state: z.string().min(1, "State/Province is required"),
  zipCode: z.string().min(1, "Zip/Postal code is required"),
  country: z.string().min(1, "Country is required"),
  originalImageUrl: z.string().min(1, "Image URL is required"),
  // Add quantity field (optional, defaults to 1 if not provided)
  quantity: z.number().int().positive().optional().default(1),
});

// Simple helper function to ensure directories exist if needed
// Only used for backward compatibility - warning instead of error for non-existent directories
const ensureDir = (dirPath: string): string => {
  if (fs.existsSync(dirPath)) {
    return dirPath;
  }
  
  // For Object Storage, we don't need to create directories
  // But we'll create them anyway to avoid errors during transition
  console.warn(`Directory ${dirPath} doesn't exist but is no longer needed with Object Storage`);
  
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch (error) {
    console.warn(`Failed to create directory ${dirPath}, but continuing since we're using Object Storage`);
  }
  
  return dirPath;
};

// Define virtual paths for Object Storage - no filesystem directories needed
const defineStoragePaths = () => {
  // Virtual path structure for Object Storage
  const baseDir = 'users';
  const tempDir = 'temp';
  const generatedDir = 'generated';
  const ordersDir = 'orders';
  const originalsDir = 'orders/originals';
  const shareableDir = 'shareable';
  
  return {
    baseDir,
    tempDir,
    generatedDir,
    ordersDir,
    shareableDir,
    originalsDir
  };
};

/**
 * Save base64 encoded image to Object Storage
 * Applies EXIF rotation once at the beginning, then strips orientation metadata
 */
const saveBase64Image = async (base64Data: string, confirmationId: string, email: string): Promise<string> => {
  console.log("IMAGE UPLOAD STARTED (Server) - Confirmation ID:", confirmationId);
  
  try {
    if (!email) {
      throw new Error('Email is required for saving images to Object Storage');
    }
    
    // Save to Object Storage directly
    return await storageAdapter.saveBase64ImageToStorage(base64Data, confirmationId, email);
  } catch (error) {
    console.error("❌ ERROR SAVING IMAGE TO OBJECT STORAGE:", error);
    throw error; // Re-throw to handle properly in the route handler
  }
};

/**
 * IMPROVED FILE COPY FUNCTION
 * Copies files with byte-for-byte accuracy and careful error handling
 * Preserves all file information including orientation
 */
const copyFile = (sourcePath: string, destFolder: string, newFilename?: string): string => {
  console.log(`COPY FILE OPERATION: 
    Source: ${sourcePath}
    Destination Folder: ${destFolder}
    New Filename: ${newFilename || 'Using original name'}`);
  
  try {
    // Get absolute path to source
    const fullSourcePath = path.join(
      process.cwd(), 
      'public',
      sourcePath.startsWith('/') ? sourcePath.substring(1) : sourcePath
    );
    
    // Ensure destination directory exists
    const publicDestFolder = path.join(process.cwd(), 'public', destFolder);
    ensureDir(publicDestFolder);
    
    // Get original file extension
    const sourceExtension = path.extname(fullSourcePath);
    console.log(`Source file extension: ${sourceExtension}`);
    
    // If new filename is provided but doesn't include extension, add it
    let targetFilename = newFilename;
    if (targetFilename && !path.extname(targetFilename)) {
      targetFilename = `${targetFilename}${sourceExtension}`;
      console.log(`Added extension to target filename: ${targetFilename}`);
    } else if (!targetFilename) {
      // Otherwise use original filename
      targetFilename = path.basename(fullSourcePath);
    }
    
    // Create full destination path
    const fullDestPath = path.join(publicDestFolder, targetFilename);
    
    console.log(`COPY FILE DETAILS:
      From: ${fullSourcePath}
      To: ${fullDestPath}
      Source exists: ${fs.existsSync(fullSourcePath)}`);
    
    // Source file doesn't exist at the expected path
    if (!fs.existsSync(fullSourcePath)) {
      console.error(`⚠️ Source file not found at primary path: ${fullSourcePath}`);
      
      // Try alternative paths in case of path resolution issues
      const alternatives = [
        // Without public prefix
        path.join(process.cwd(), sourcePath.startsWith('/') ? sourcePath.substring(1) : sourcePath),
        // Inside uploads folder with basename
        path.join(process.cwd(), 'public/uploads', path.basename(sourcePath)),
        // Direct path with basename
        path.join(process.cwd(), sourcePath)
      ];
      
      // Log alternative paths
      console.log("Searching alternative paths:");
      alternatives.forEach((altPath, index) => {
        console.log(`Alt ${index+1}: ${altPath} (exists: ${fs.existsSync(altPath)})`);
      });
      
      // Try each alternative
      for (let i = 0; i < alternatives.length; i++) {
        if (fs.existsSync(alternatives[i])) {
          console.log(`✅ Using alternative path ${i+1}: ${alternatives[i]}`);
          // Use readFile/writeFile instead of copyFile for better control
          const fileBuffer = fs.readFileSync(alternatives[i]);
          fs.writeFileSync(fullDestPath, fileBuffer);
          console.log(`✓ File copied successfully (${fileBuffer.length} bytes)`);
          return `/${destFolder}/${targetFilename}`;
        }
      }
      
      // All alternatives failed
      throw new Error(`Source file not found at any path: ${sourcePath}`);
    }
    
    // Source file exists at the expected path - use readFile/writeFile to ensure byte-for-byte copy
    const fileBuffer = fs.readFileSync(fullSourcePath);
    fs.writeFileSync(fullDestPath, fileBuffer);
    
    console.log(`✅ File copied successfully - ${fileBuffer.length} bytes`);
    
    // Return the new relative path
    return `/${destFolder}/${targetFilename}`;
  } catch (err) {
    console.error("❌ ERROR COPYING FILE:", err);
    throw err; // Re-throw for proper error handling
  }
};

// Function to fetch an image from a URL and save it to Object Storage only
async function fetchImageAndSave(imageUrl: string, dir: string, filename: string, userEmail: string, videoData?: {originalVideoPath?: string; videoFrameTimestamp?: number}): Promise<string> {
  console.log(`Fetching image from URL: ${imageUrl}`);
  
  if (!userEmail) {
    throw new Error('Email is required for saving images to Object Storage');
  }
  
  try {
    // Extract style from the filename
    const filenameMatch = filename.match(/gpt-image-([a-z]+)-\d+\.png/) || filename.match(/([a-z]+)\.png/);
    const style = filenameMatch ? filenameMatch[1] : 'unknown';
    
    // Get the original image path from the session variable or fallback
    const originalPath = global.lastUploadedImagePath || '';
    
    // Save to Object Storage - no fallback
    return await storageAdapter.fetchImageAndSaveToStorage(
      imageUrl,
      userEmail,
      style,
      originalPath,
      videoData
    );
  } catch (error) {
    console.error("❌ Error fetching and saving image to Object Storage:", error);
    throw error;
  }
}

// Function to determine MIME type based on file extension
function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.ogg': 'video/ogg',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml'
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

export async function registerRoutes(app: Express): Promise<Server> {
  


  // Beta survey endpoint (easily removable)
  app.post('/api/beta-survey', async (req, res) => {
    try {
      const { sex, ageBracket, city } = req.body;
      
      // Validate required fields
      if (!sex || !ageBracket || !city) {
        return res.status(400).json({ 
          success: false, 
          error: "All fields are required" 
        });
      }

      // Validate sex values
      const validSexValues = ['male', 'female', 'prefer_not_to_say', 'skip'];
      if (!validSexValues.includes(sex)) {
        return res.status(400).json({ 
          success: false, 
          error: "Invalid sex value" 
        });
      }

      // Validate age bracket values
      const validAgeBrackets = ['10-19', '20-29', '30-39', '40-49', '50-59', '60+', 'skip'];
      if (!validAgeBrackets.includes(ageBracket)) {
        return res.status(400).json({ 
          success: false, 
          error: "Invalid age bracket" 
        });
      }

      // Insert into database
      const [result] = await db.insert(betaReleaseStats).values({
        sex,
        ageBracket,
        city: city.trim()
      }).returning();

      console.log('Beta survey response saved:', { sex, ageBracket, city });

      return res.json({ 
        success: true, 
        message: 'Survey response saved successfully' 
      });

    } catch (error) {
      console.error('Error saving beta survey:', error);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to save survey response' 
      });
    }
  });
  
  // Catalogue order endpoints
  app.post('/api/catalogue-order', async (req, res) => {
    try {
      const { orderData, items } = req.body;
      
      // Validate the order data
      const validatedOrder = insertCatalogueOrderSchema.safeParse(orderData);
      if (!validatedOrder.success) {
        return res.status(400).json({ 
          success: false, 
          error: "Invalid order data", 
          details: validatedOrder.error 
        });
      }
      
      // Validate each item
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ 
          success: false, 
          error: "Order must contain at least one item" 
        });
      }
      
      const validatedItems: InsertCatalogueOrderItem[] = [];
      for (const item of items) {
        const validatedItem = insertCatalogueOrderItemSchema.safeParse(item);
        if (!validatedItem.success) {
          return res.status(400).json({ 
            success: false, 
            error: "Invalid item data", 
            details: validatedItem.error 
          });
        }
        validatedItems.push(validatedItem.data);
      }
      
      // Generate confirmation ID
      const confirmationId = storage.generateCatalogueConfirmationId();
      const orderWithConfirmation: InsertCatalogueOrder = {
        ...validatedOrder.data,
        confirmationId,
        status: 'paid'
      };
      
      // Store order in database
      const order = await storage.createCatalogueOrder(orderWithConfirmation, validatedItems);
      
      // Send confirmation email
      try {
        await sendOrderConfirmationEmail(orderWithConfirmation.email, confirmationId, validatedItems.length);
        console.log(`Catalogue order confirmation email sent to ${orderWithConfirmation.email}`);
      } catch (emailError) {
        console.error('Error sending catalogue order confirmation email:', emailError);
        // Don't fail the order if email fails
      }
      
      return res.json({
        success: true,
        message: "Catalogue order completed successfully",
        order,
        confirmationId
      });
    } catch (error) {
      console.error('Error creating catalogue order:', error);
      return res.status(500).json({ 
        success: false, 
        error: "Failed to create catalogue order" 
      });
    }
  });
  
  // Get all catalogue orders (admin only)
  app.get('/api/catalogue-orders', async (req, res) => {
    try {
      const orders = await storage.getCatalogueOrders();
      return res.json({ success: true, orders });
    } catch (error) {
      console.error('Error fetching catalogue orders:', error);
      return res.status(500).json({ 
        success: false, 
        error: "Failed to fetch catalogue orders" 
      });
    }
  });
  
  // Get a specific catalogue order with its items
  app.get('/api/catalogue-orders/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) {
        return res.status(400).json({ 
          success: false, 
          error: "Invalid order ID" 
        });
      }
      
      const orderWithItems = await storage.getCatalogueOrderById(id);
      if (!orderWithItems) {
        return res.status(404).json({ 
          success: false, 
          error: "Order not found" 
        });
      }
      
      return res.json({ 
        success: true, 
        order: orderWithItems.order, 
        items: orderWithItems.items 
      });
    } catch (error) {
      console.error(`Error fetching catalogue order ${req.params.id}:`, error);
      return res.status(500).json({ 
        success: false, 
        error: "Failed to fetch catalogue order" 
      });
    }
  });
  
  // Update catalogue order status (admin only)
  app.patch('/api/catalogue-orders/:id/status', async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) {
        return res.status(400).json({ 
          success: false, 
          error: "Invalid order ID" 
        });
      }
      
      const { status } = req.body;
      if (!status || typeof status !== 'string') {
        return res.status(400).json({ 
          success: false, 
          error: "Invalid status value" 
        });
      }
      
      const updated = await storage.updateCatalogueOrderStatus(id, status);
      if (!updated) {
        return res.status(404).json({ 
          success: false, 
          error: "Order not found" 
        });
      }
      
      return res.json({ 
        success: true, 
        message: "Order status updated" 
      });
    } catch (error) {
      console.error(`Error updating catalogue order ${req.params.id}:`, error);
      return res.status(500).json({ 
        success: false, 
        error: "Failed to update catalogue order status" 
      });
    }
  });
  // Setup cookie parser for admin authentication
  app.use(cookieParser());
  
  // Register admin routes
  app.use('/api/admin', adminRouter);
  
  // Register image public endpoint

  
  // Process and directly serve the image for download
  app.get('/api/download-image', async (req, res) => {
    try {
      const { imageUrl } = req.query;
      
      if (!imageUrl || typeof imageUrl !== 'string') {
        return res.status(400).send('Image URL is required');
      }
      
      console.log(`Processing image for direct download: ${imageUrl}`);
      
      // Parse the image URL to extract filename pattern needed for database lookup
      // Expected format: /api/storage-image/users/user@email.com/generated/file-style.png
      const urlMatch = imageUrl.match(/\/api\/storage-image\/users\/([^\/]+)\/generated\/([^?]+)/);
      if (!urlMatch) {
        return res.status(400).send('Invalid image URL format');
      }
      
      const userEmail = decodeURIComponent(urlMatch[1]);
      const imageFileName = urlMatch[2];
      const generatedPath = `users/${userEmail}/generated/${imageFileName}`;
      
      // Track in database that this image was saved
      try {
        await db.update(generatedImages)
          .set({ isSaved: true })
          .where(eq(generatedImages.generatedPath, generatedPath));
        
        console.log(`Marked image as saved in database: ${generatedPath}`);
      } catch (dbError) {
        console.error('Error updating image saved status:', dbError);
        // Continue with the download even if tracking fails
      }
      
      // Download the original image from Object Storage
      console.log(`Fetching from Object Storage: ${generatedPath}`);
      
      let imageBuffer;
      try {
        imageBuffer = await objectStorage.downloadImage(generatedPath);
      } catch (error) {
        console.error("Error fetching image from Object Storage:", error);
        return res.status(500).send('Could not download the original image');
      }
      
      // Process the image with white border (no watermark)
      // Get image dimensions
      const imageMetadata = await sharp(imageBuffer).metadata();
      const imageWidth = imageMetadata.width || 800;
      const imageHeight = imageMetadata.height || 1132;
      
      // Calculate border width (58 pixels)
      const borderWidth = 58;
      
      // Calculate the new dimensions with border
      const finalWidth = imageWidth + borderWidth * 2;
      const finalHeight = imageHeight + borderWidth * 2;
      
      // Create a white background with border
      const processedImage = await sharp({
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
      
      // Set headers for direct download
      res.setHeader('Content-Disposition', `attachment; filename="poster-the-moment-${Date.now()}.png"`);
      res.setHeader('Content-Type', 'image/png');
      
      // Send the processed image directly to the client
      res.send(processedImage);
      
    } catch (error) {
      console.error('Error serving download:', error);
      res.status(500).send('Error processing image');
    }
  });
  
  // EMAIL VERIFICATION ENDPOINTS
  
  // Send email verification code
  app.post('/api/send-verification', async (req, res) => {
    try {
      const { email } = req.body;
      
      if (!email || typeof email !== 'string') {
        return res.status(400).json({ message: 'Email is required' });
      }
      
      // Check if this email already has credits
      console.log("received email", email)
      const existingCredits = await storage.getGenerationCreditsByEmail(email);
      if (existingCredits) {
        return res.status(200).json({ 
          message: 'Email already verified',
          verified: true 
        });
      }
      
      // Generate a 6-digit verification code
      const verificationCode = storage.generateVerificationCode();
      
      // Store the verification code (create a new credits record with 0 credits and pending status)
      await storage.createGenerationCredits({
        email,
        freeCreditsTotal: 2, // 2 free credits for new users
        freeCreditsUsed: 0,
        paidCredits: 0,
        verificationCode,
        verified: false
      });
      
      // Send verification email
      await sendVerificationEmail(email, verificationCode);
      
      res.status(200).json({ message: 'Verification code sent' });
    } catch (error) {
      console.error('Error sending verification code:', error);
      res.status(500).json({ message: 'Failed to send verification code' });
    }
  });
  
  // Verify email with code
  app.post('/api/verify-email', async (req, res) => {
    try {
      const { email, code } = req.body;
      
      if (!email || !code) {
        return res.status(400).json({ message: 'Email and verification code are required' });
      }
      
      // Verify the code against stored code
      const verified = await storage.verifyEmail(email, code);
      
      if (!verified) {
        return res.status(400).json({ message: 'Invalid verification code' });
      }
      
      res.status(200).json({ message: 'Email verified successfully' });
    } catch (error) {
      console.error('Error verifying email:', error);
      res.status(500).json({ message: 'Failed to verify email' });
    }
  });
  
  // Partner inquiry endpoint
  app.post('/api/partner-inquiry', async (req, res) => {
    try {
      const { name, cafeName, email, location, address } = req.body;
      
      if (!name || !cafeName || !email || !location || !address) {
        return res.status(400).json({ message: 'All fields are required' });
      }
      
      // Send partner inquiry email to admin
      await sendPartnerInquiryEmail(name, cafeName, email, location, address);
      
      res.status(200).json({ message: 'Partner inquiry sent successfully' });
    } catch (error) {
      console.error('Error sending partner inquiry:', error);
      res.status(500).json({ message: 'Failed to send partner inquiry' });
    }
  });

  // CREDIT MANAGEMENT ENDPOINTS
  
  // Get generation credits for an email - FREE FOR ALL (as of July 9, 2025)
  app.get('/api/generation-credits', async (req, res) => {
    try {
      const { email } = req.query;
      
      if (!email || typeof email !== 'string') {
        return res.status(400).json({ message: 'Email parameter is required' });
      }
      
      // Check if user is authenticated
      const user = await storage.getUserByEmail(email);
      
      if (!user) {
        return res.status(404).json({ 
          message: 'User not found',
          freeCreditsRemaining: 999,
          paidCredits: 999,
          totalCreditsRemaining: 999,
          isSubscribed: true
        });
      }
      
      // As of July 9, 2025: All verified users have unlimited free generations
      // Return 999 to represent unlimited credits
      res.status(200).json({
        freeCreditsRemaining: 999,
        paidCredits: 999,
        totalCreditsRemaining: 999,
        isSubscribed: true, // All users treated as subscribed
        subscriptionStatus: 'active',
        userType: user.userType || 'artistic_collective'
      });
    } catch (error) {
      console.error('Error getting generation credits:', error);
      res.status(500).json({ message: 'Failed to get generation credits' });
    }
  });
  
  // Use a generation credit (subscription-based)
  app.post('/api/use-generation-credit', async (req, res) => {
    try {
      const { email } = req.body;
      
      if (!email) {
        return res.status(400).json({ message: 'Email is required' });
      }
      
      // Get user and subscription status
      const user = await storage.getUserByEmail(email);
      
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }
      
      // Get legacy credits for free credits check
      const credits = await storage.getGenerationCreditsByEmail(email);
      
      if (!credits) {
        return res.status(404).json({ message: 'No credits found for this email' });
      }
      
      // CRITICAL SECURITY CHECK: Verify email is verified before allowing credit usage
      if (!credits.verified) {
        return res.status(403).json({ 
          message: 'Email must be verified before using credits',
          verified: false 
        });
      }
      
      // All users have unlimited access now
      res.status(200).json({ message: 'Credit used successfully' });
      
    } catch (error) {
      console.error('Error using generation credit:', error);
      res.status(500).json({ message: 'Failed to use generation credit' });
    }
  });
  
  // Create subscription for artistic collective membership
  app.post('/api/create-subscription', async (req, res) => {
    try {
      const { email, promoCode, discountAmount } = req.body;
      
      if (!email) {
        return res.status(400).json({ message: 'Email is required' });
      }
      
      // Get user
      const user = await storage.getUserByEmail(email);
      
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }
      
      // Check if user already has an active subscription
      if (user.subscriptionStatus === 'active' && user.subscriptionEndDate && new Date(user.subscriptionEndDate) > new Date()) {
        return res.status(400).json({ message: 'User already has an active subscription' });
      }
      
      let customer;
      
      // Create or retrieve Stripe customer
      if (user.stripeCustomerId) {
        customer = await stripe.customers.retrieve(user.stripeCustomerId);
      } else {
        customer = await stripe.customers.create({
          email: user.email,
          name: user.username,
          metadata: {
            userId: user.id.toString()
          }
        });
        
        // Save customer ID to user record
        await storage.updateUser(user.id, { stripeCustomerId: customer.id });
      }
      
      // Store promo code info in metadata for later use
      const setupIntentMetadata: any = {
        userId: user.id.toString(),
        email: user.email,
        type: 'subscription_setup'
      };
      
      // Add promo code info if provided
      if (promoCode && discountAmount) {
        setupIntentMetadata.promoCode = promoCode;
        setupIntentMetadata.discountAmount = discountAmount.toString();
      }

      // Create setup intent for collecting payment method
      const setupIntent = await stripe.setupIntents.create({
        customer: customer.id,
        payment_method_types: ['card'],
        usage: 'off_session',
        metadata: setupIntentMetadata
      });
      
      console.log('Setup intent created:', {
        setupIntentId: setupIntent.id,
        clientSecret: setupIntent.client_secret ? 'present' : 'missing'
      });
      
      if (!setupIntent.client_secret) {
        console.error('No client secret found in setup intent response');
        return res.status(500).json({ message: 'Failed to get setup intent client secret' });
      }
      
      res.status(200).json({
        setupIntentId: setupIntent.id,
        clientSecret: setupIntent.client_secret
      });
      
    } catch (error) {
      console.error('Error creating subscription:', error);
      res.status(500).json({ message: 'Failed to create subscription' });
    }
  });

  // Confirm subscription after payment method is collected
  app.post('/api/confirm-subscription', requireAuth, async (req: express.Request, res: express.Response) => {
    try {
      const { setupIntentId, paymentMethodId } = req.body;
      const user = (req as any).user;

      console.log('Confirming subscription for user:', user.email, 'with payment method:', paymentMethodId);

      // Retrieve setup intent to get promo code metadata
      const setupIntent = await stripe.setupIntents.retrieve(setupIntentId);
      const promoCode = setupIntent.metadata?.promoCode;
      const discountAmount = setupIntent.metadata?.discountAmount;

      // Prepare subscription creation parameters
      const subscriptionParams: any = {
        customer: user.stripeCustomerId,
        items: [{
          price: 'price_1RWeYxKz4uYyvPgGiS5Jxg6t' // CHF 9.99/month price ID
        }],
        default_payment_method: paymentMethodId,
        metadata: {
          userId: user.id.toString(),
          email: user.email,
          setupIntentId: setupIntentId
        }
      };

      // Apply beta discount if promo code was used
      if (promoCode && discountAmount === '0.6') {
        try {
          // Create or retrieve 60% off coupon with proper configuration
          let coupon;
          try {
            coupon = await stripe.coupons.retrieve('BETA60-FIRST');
          } catch (error) {
            // Create coupon if it doesn't exist - using percent_off for cleaner handling
            coupon = await stripe.coupons.create({
              id: 'BETA60-FIRST',
              percent_off: 60,
              duration: 'once',
              name: 'Beta Discount 60% Off First Month'
            });
          }
          
          subscriptionParams.discounts = [{ coupon: 'BETA60-FIRST' }];
          console.log('Applied 60% beta discount to subscription using discounts array');
        } catch (couponError) {
          console.error('Error applying discount:', couponError);
          // Continue without discount rather than failing
        }
      }

      // Create subscription with the collected payment method
      console.log('Creating subscription with params:', {
        customer: subscriptionParams.customer,
        priceId: subscriptionParams.items[0].price,
        hasCoupon: !!subscriptionParams.coupon,
        couponId: subscriptionParams.coupon
      });
      
      const subscription = await stripe.subscriptions.create(subscriptionParams);
      const subscriptionData = subscription as any;
      console.log('Subscription created successfully:', {
        id: subscription.id,
        status: subscription.status,
        current_period_start: subscriptionData.current_period_start,
        current_period_end: subscriptionData.current_period_end,
        latest_invoice: subscriptionData.latest_invoice
      });

      // Update user's subscription status in database
      console.log('Subscription dates:', {
        current_period_start: subscriptionData.current_period_start,
        current_period_end: subscriptionData.current_period_end,
        start_date: subscriptionData.current_period_start ? new Date(subscriptionData.current_period_start * 1000).toISOString() : 'undefined',
        end_date: subscriptionData.current_period_end ? new Date(subscriptionData.current_period_end * 1000).toISOString() : 'undefined'
      });
      
      // Ensure dates are valid before updating database
      if (!subscriptionData.current_period_start || !subscriptionData.current_period_end) {
        console.error('Invalid subscription dates from Stripe');
        // Fallback to current date and 1 month later using proper month calculation
        const now = new Date();
        const oneMonthLater = new Date(now);
        oneMonthLater.setMonth(oneMonthLater.getMonth() + 1);
        
        await storage.updateUser(user.id, {
          subscriptionId: subscriptionData.id,
          subscriptionStatus: subscriptionData.status,
          subscriptionStartDate: now,
          subscriptionEndDate: oneMonthLater,
          userType: 'artistic_collective'
        });
      } else {
        await storage.updateUser(user.id, {
          subscriptionId: subscriptionData.id,
          subscriptionStatus: subscriptionData.status,
          subscriptionStartDate: new Date(subscriptionData.current_period_start * 1000),
          subscriptionEndDate: new Date(subscriptionData.current_period_end * 1000),
          userType: 'artistic_collective'
        });
      }

      console.log('Subscription confirmed successfully:', subscription.id);

      res.status(200).json({
        subscriptionId: subscription.id,
        status: subscription.status
      });
      
    } catch (error) {
      console.error('Error confirming subscription:', error);
      res.status(500).json({ message: 'Failed to confirm subscription' });
    }
  });
  
  // Get subscription status
  app.get('/api/subscription-status', async (req, res) => {
    try {
      const { email } = req.query;
      
      if (!email || typeof email !== 'string') {
        return res.status(400).json({ message: 'Email parameter is required' });
      }
      
      const user = await storage.getUserByEmail(email);
      
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }
      
      const isSubscribed = user.userType === 'artistic_collective' && 
                          user.subscriptionStatus === 'active' &&
                          (!user.subscriptionEndDate || new Date(user.subscriptionEndDate) > new Date());
      
      res.status(200).json({
        isSubscribed,
        subscriptionStatus: user.subscriptionStatus,
        subscriptionStartDate: user.subscriptionStartDate,
        subscriptionEndDate: user.subscriptionEndDate,
        userType: user.userType
      });
      
    } catch (error) {
      console.error('Error getting subscription status:', error);
      res.status(500).json({ message: 'Failed to get subscription status' });
    }
  });

  // Stripe webhook handler for subscription events
  app.post('/api/webhooks/stripe-subscription', async (req, res) => {
    const sig = req.headers['stripe-signature'] as string;
    
    if (!sig) {
      return res.status(400).send('No signature header');
    }

    let event;

    try {
      event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET || '');
    } catch (err: any) {
      console.log(`Webhook signature verification failed.`, err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    console.log(`Processing webhook event: ${event.type}`);

    try {
      switch (event.type) {
        case 'customer.subscription.created':
        case 'customer.subscription.updated':
          const subscription = event.data.object as any;
          const userId = subscription.metadata?.userId;
          
          if (userId) {
            await storage.updateUser(parseInt(userId), {
              subscriptionId: subscription.id,
              subscriptionStatus: subscription.status,
              subscriptionStartDate: new Date(subscription.current_period_start * 1000),
              subscriptionEndDate: new Date(subscription.current_period_end * 1000),
              userType: subscription.status === 'active' ? 'artistic_collective' : 'normal'
            });
            
            console.log(`Updated user ${userId} subscription status to ${subscription.status}`);
          }
          break;

        case 'customer.subscription.deleted':
          const deletedSubscription = event.data.object as any;
          const deletedUserId = deletedSubscription.metadata?.userId;
          
          if (deletedUserId) {
            await storage.updateUser(parseInt(deletedUserId), {
              subscriptionStatus: 'canceled',
              userType: 'normal'
            });
            
            console.log(`Canceled subscription for user ${deletedUserId}`);
          }
          break;

        case 'invoice.payment_succeeded':
          const invoice = event.data.object as any;
          if (invoice.subscription) {
            const sub = await stripe.subscriptions.retrieve(invoice.subscription as string);
            const invoiceUserId = (sub as any).metadata?.userId;
            
            if (invoiceUserId) {
              await storage.updateUser(parseInt(invoiceUserId), {
                subscriptionStatus: 'active',
                subscriptionEndDate: new Date((sub as any).current_period_end * 1000),
                userType: 'artistic_collective'
              });
              
              console.log(`Payment succeeded for user ${invoiceUserId}`);
            }
          }
          break;

        case 'invoice.payment_failed':
          const failedInvoice = event.data.object as any;
          if (failedInvoice.subscription) {
            const failedSub = await stripe.subscriptions.retrieve(failedInvoice.subscription as string);
            const failedUserId = (failedSub as any).metadata?.userId;
            
            if (failedUserId) {
              // Allow 24 hours grace period before revoking access
              const gracePeriodEnd = new Date(Date.now() + 24 * 60 * 60 * 1000);
              
              await storage.updateUser(parseInt(failedUserId), {
                subscriptionStatus: 'past_due',
                subscriptionEndDate: gracePeriodEnd
              });
              
              console.log(`Payment failed for user ${failedUserId}, grace period until ${gracePeriodEnd}`);
            }
          }
          break;

        default:
          console.log(`Unhandled event type: ${event.type}`);
      }

      res.json({ received: true });
    } catch (error) {
      console.error('Error processing webhook:', error);
      res.status(500).json({ error: 'Webhook processing failed' });
    }
  });

  // Legacy endpoint - now redirects to subscription
  app.post('/api/create-credit-payment-intent', async (req, res) => {
    res.status(410).json({ 
      message: 'Credit purchases are no longer available. Please subscribe to the Artistic Collective.',
      redirectTo: '/api/create-subscription'
    });
  });
  
  // Confirm credit purchase functionality has been moved to the enhanced implementation below
  // (around line 1360)
  
  // Special route for serving videos with correct MIME type
  app.get('/assets/videos/:filename', (req, res) => {
    const filename = req.params.filename;
    const videoPath = path.join(process.cwd(), 'public', 'assets', 'videos', filename);
    
    if (!fs.existsSync(videoPath)) {
      return res.status(404).send('Video not found');
    }
    
    const mimeType = getMimeType(videoPath);
    res.setHeader('Content-Type', mimeType);
    fs.createReadStream(videoPath).pipe(res);
  });
  // Define storage paths for Object Storage
  defineStoragePaths();
  
  // Endpoint to upload an image
  app.post("/api/upload-image", async (req, res) => {
    try {
      const { imageData, confirmationId, email } = req.body;
      
      if (!imageData) {
        return res.status(400).json({ message: "Image data is required" });
      }
      
      if (!confirmationId) {
        return res.status(400).json({ message: "Confirmation ID is required" });
      }
      
      if (!email) {
        return res.status(400).json({ message: "Email is required for Object Storage" });
      }
      
      // Save to Object Storage only - no fallback
      const imagePath = await saveBase64Image(imageData, confirmationId, email);
      
      // Return the path to the client
      return res.status(200).json({ imagePath });
    } catch (error) {
      console.error("Error uploading image:", error);
      res.status(500).json({ 
        message: error instanceof Error ? error.message : "Error uploading image" 
      });
    }
  });

  // Endpoint to upload a video file
  app.post("/api/upload-video", async (req, res) => {
    try {
      const { videoData, filename, email } = req.body;
      
      if (!videoData) {
        return res.status(400).json({ message: "Video data is required" });
      }
      
      if (!filename) {
        return res.status(400).json({ message: "Filename is required" });
      }
      
      if (!email) {
        return res.status(400).json({ message: "Email is required for Object Storage" });
      }
      
      // Convert base64 video data to buffer
      const videoBuffer = Buffer.from(videoData.split(',')[1], 'base64');
      
      // Generate unique filename
      const timestamp = Date.now();
      const videoId = crypto.randomUUID();
      const extension = filename.split('.').pop() || 'mp4';
      const uniqueFilename = `video-${videoId}-${timestamp}.${extension}`;
      
      // Upload to Object Storage
      const storageKey = `users/${email}/videos/${uniqueFilename}`;
      await objectStorage.uploadBuffer(storageKey, videoBuffer, 'video/mp4');
      
      console.log(`✅ Video uploaded to Object Storage: ${storageKey}`);
      
      // Trigger video compression in the background (don't wait for it)
      import('./services/video-compressor').then(({ compressVideo }) => {
        console.log(`Triggering background video compression for: ${storageKey}`);
        // We'll need the image ID later when it's created, so for now just log
        // Video compression will be handled when the poster is generated
      }).catch(error => {
        console.error('Failed to trigger video compression:', error);
      });
      
      // Return the storage path to the client
      return res.status(200).json({ videoPath: storageKey });
    } catch (error) {
      console.error("Error uploading video:", error);
      res.status(500).json({ 
        message: error instanceof Error ? error.message : "Error uploading video" 
      });
    }
  });


  // Validate shipping information and return a client secret
  app.post("/api/prepare-checkout", async (req, res) => {
    try {
      // Validate shipping data using the schema that doesn't require image
      const shippingData = checkoutShippingSchema.parse(req.body);
      
      // Generate a unique confirmation ID
      const confirmationId = storage.generateConfirmationId();
      
      // Calculate total amount based on quantity (poster price * quantity + shipping)
      const CATALOGUE_POSTER_PRICE = 2995; // Force CHF 29.95 in cents for catalogue orders
      const posterAmount = CATALOGUE_POSTER_PRICE * shippingData.quantity;
      const shippingAmount = SHIPPING_PRICE; // CHF 0.00 shipping fee in cents
      const totalAmount = posterAmount + shippingAmount;
      
      console.log(`Order calculation: ${shippingData.quantity} posters at CHF ${CATALOGUE_POSTER_PRICE/100} each + CHF ${shippingAmount/100} shipping = CHF ${totalAmount/100}`);
      console.log(`CATALOGUE_POSTER_PRICE is: ${CATALOGUE_POSTER_PRICE} cents`);
      console.log(`Total amount being sent to Stripe: ${totalAmount} cents`);
      
      // Create a PaymentIntent with the calculated amount and currency
      const paymentIntent = await stripe.paymentIntents.create({
        amount: totalAmount, // Using the real calculated total amount
        currency: "chf",
        // Store shipping data, quantity, and confirmationId in metadata
        metadata: { 
          confirmationId,
          firstName: shippingData.firstName,
          lastName: shippingData.lastName,
          email: shippingData.email,
          quantity: shippingData.quantity.toString(),
          actualAmount: totalAmount.toString(), // Store the actual calculated amount
          testMode: "true" // Flag indicating this is a test payment
        },
        payment_method_types: ['card'],
      });

      // Return the client secret and confirmation ID
      res.status(200).json({
        clientSecret: paymentIntent.client_secret,
        confirmationId
      });
    } catch (error) {
      console.error("Error preparing checkout:", error);
      res.status(400).json({ 
        message: error instanceof Error ? error.message : "Invalid shipping data" 
      });
    }
  });

  // New endpoint for cart checkout - processes multiple items at once
  app.post("/api/complete-cart-order", async (req, res) => {
    try {
      console.log("Processing cart order:", req.body);
      
      // Extract data from request
      const { 
        cartItems, 
        orderConfirmationId, 
        paymentIntentId,
        ...shippingData // The rest of the fields are shipping data
      } = req.body;
      
      // Validate required fields
      if (!cartItems || !Array.isArray(cartItems) || cartItems.length === 0) {
        return res.status(400).json({ 
          error: 'Cart items are required and must be an array' 
        });
      }
      
      if (!paymentIntentId) {
        return res.status(400).json({ 
          error: 'Payment intent ID is required' 
        });
      }
      
      if (!orderConfirmationId) {
        return res.status(400).json({ 
          error: 'Order confirmation ID is required' 
        });
      }
      
      // Verify the payment intent was successful
      console.log("Verifying payment intent:", paymentIntentId);
      const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
      
      if (paymentIntent.status !== "succeeded") {
        return res.status(400).json({
          error: "Payment has not been completed successfully", 
          status: paymentIntent.status
        });
      }
      
      // Process the first item as the primary order item
      const primaryItem = cartItems[0];
      const imageUrl = primaryItem.imageUrl;
      
      if (!imageUrl) {
        return res.status(400).json({
          error: "Image URL is required for the primary cart item"
        });
      }
      
      // Create order in the database
      const orderData: InsertOrder = {
        firstName: shippingData.firstName,
        lastName: shippingData.lastName,
        email: shippingData.email,
        address: shippingData.address,
        city: shippingData.city,
        state: shippingData.state,
        zipCode: shippingData.zipCode,
        country: shippingData.country,
        confirmationId: orderConfirmationId,
        quantity: cartItems.length,
        amount: 60 * cartItems.length, // Force 60 cents per poster
        posterImageUrl: imageUrl,
        originalImageUrl: imageUrl, // Use same URL as original
        style: primaryItem.style || 'catalogue',
        status: 'paid'
      };
      
      // Store the order
      const createdOrder = await storage.createOrder(orderData);
      
      // Send confirmation email
      try {
        await sendOrderConfirmationEmail(shippingData.email, orderConfirmationId, cartItems.length);
        console.log(`Order confirmation email sent to ${shippingData.email}`);
      } catch (emailError) {
        console.error('Error sending confirmation email:', emailError);
        // Don't fail if email sending fails
      }
      
      return res.json({
        success: true,
        message: `Cart order completed with ${cartItems.length} posters`,
        confirmationId: orderConfirmationId,
        orderId: createdOrder.id
      });
      
    } catch (error) {
      console.error('Error processing cart order:', error);
      return res.status(500).json({ 
        error: 'Failed to process cart order',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });
  
  // Create catalogue order with multiple items (for catalogue purchases)
  app.post("/api/complete-catalogue-order", async (req, res) => {
    try {
      console.log("Completing catalogue order:", req.body);
      
      const { 
        cartItems, 
        orderConfirmationId, 
        paymentIntentId,
        ...shippingData 
      } = req.body;
      
      // Make sure we have cart items
      if (!cartItems || !Array.isArray(cartItems) || cartItems.length === 0) {
        return res.status(400).json({
          error: "Cart items are required"
        });
      }
      
      // Check that we have necessary shipping data
      if (!shippingData.firstName || !shippingData.lastName || !shippingData.email) {
        return res.status(400).json({
          error: "Complete shipping information is required"
        });
      }
      
      // Fixed price per poster
      const POSTER_PRICE = 29.95; // CHF (for database storage in CHF)
      
      // Always generate a CAT-prefixed confirmation ID for catalogue orders, ignoring Stripe ID
      const catalogueConfirmationId = storage.generateCatalogueConfirmationId();
      
      // Calculate total amount based on individual item quantities
      const totalAmount = cartItems.reduce((total, item) => total + ((item.quantity || 1) * POSTER_PRICE), 0);
      
      // Create the catalogue order in the database with current timestamp
      const catalogueOrderData: InsertCatalogueOrder = {
        firstName: shippingData.firstName,
        lastName: shippingData.lastName,
        email: shippingData.email,
        address: shippingData.address,
        city: shippingData.city,
        state: shippingData.state,
        zipCode: shippingData.zipCode,
        country: shippingData.country,
        confirmationId: catalogueConfirmationId,
        amount: totalAmount,
        status: 'paid',
        createdAt: getZurichTimestamp()
      };
      
      // Prepare the catalogue order items with proper quantities and image URLs
      const catalogueOrderItems: InsertCatalogueOrderItem[] = cartItems.map(item => {
        console.log(`Creating order item: style=${item.style}, quantity=${item.quantity}, fullImageUrl=${item.fullImageUrl}`);
        
        return {
          orderId: 0, // This will be set after creating the order
          posterImageUrl: item.fullImageUrl || item.imageUrl, // Use the full generated image URL for admin dashboard
          style: item.style || 'standard',
          quantity: item.quantity || 1,
          price: POSTER_PRICE
        };
      });
      
      // Store the order with its items
      const createdOrder = await storage.createCatalogueOrder(catalogueOrderData, catalogueOrderItems);
      
      // Send order notification to admin
      try {
        // Temporarily convert catalogue order to regular order format for email service
        // Calculate total quantity for email display
        const emailTotalQuantity = catalogueOrderItems.reduce((total, item) => total + (item.quantity || 1), 0);
        
        const emailOrderData = {
          id: createdOrder.id,
          confirmationId: createdOrder.confirmationId,
          firstName: createdOrder.firstName,
          lastName: createdOrder.lastName,
          email: createdOrder.email,
          quantity: emailTotalQuantity,
          status: createdOrder.status,
          createdAt: createdOrder.createdAt
        };
        
        await sendNewOrderNotificationEmail(emailOrderData);
        console.log(`New catalogue order notification sent for order ${catalogueConfirmationId}`);
      } catch (emailError) {
        console.error('Error sending admin notification email:', emailError);
        // Don't fail if email sending fails
      }
      
      // Send confirmation email to customer
      try {
        const customerTotalQuantity = catalogueOrderItems.reduce((total, item) => total + (item.quantity || 1), 0);
        await sendOrderConfirmationEmail(shippingData.email, catalogueConfirmationId, customerTotalQuantity);
        console.log(`Order confirmation email sent to ${shippingData.email}`);
      } catch (emailError) {
        console.error('Error sending confirmation email:', emailError);
        // Don't fail if email sending fails
      }
      
      const responseTotalQuantity = catalogueOrderItems.reduce((total, item) => total + (item.quantity || 1), 0);
      return res.json({
        success: true,
        message: `Catalogue order completed with ${responseTotalQuantity} posters`,
        confirmationId: catalogueConfirmationId,
        orderId: createdOrder.id
      });
      
    } catch (error) {
      console.error('Error processing catalogue order:', error);
      return res.status(500).json({ 
        error: 'Failed to process catalogue order',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // Complete the order after payment success
  app.post("/api/complete-order", async (req, res) => {
    try {
      console.log("Complete order request body:", req.body);
      
      // Extract all possible fields from the request
      const { 
        paymentIntentId,
        firstName, lastName, email, address, city, state, zipCode, country, // Direct shipping fields
        shippingData, // Alternative way shipping data might be passed
        confirmationId,
        imageUrl, // Path to the generated poster image
        originalImageUrl // Path to the original uploaded image
      } = req.body;
      
      // Check for required payment data
      if (!paymentIntentId) {
        return res.status(400).json({ 
          message: "Payment intent ID is required" 
        });
      }

      // Extract shipping data either from direct fields or from shippingData object
      const orderShippingData = shippingData || {
        firstName, lastName, email, address, city, state, zipCode, country
      };
      
      // Verify we have complete shipping information
      if (!orderShippingData.email || !orderShippingData.firstName || !orderShippingData.lastName) {
        return res.status(400).json({ 
          message: "Complete shipping information is required" 
        });
      }
      
      // For cart checkout, we may not have a confirmation ID yet - try to retrieve it from payment intent
      let orderConfirmationId = confirmationId;
      
      // For the image URL - required for storing the order
      // In cart checkout, we must have imageUrl from the cart item
      if (!imageUrl && !originalImageUrl) {
        return res.status(400).json({
          message: "At least one image URL is required to complete the order"
        });
      }
      
      // If only originalImageUrl is provided, use it for both
      const finalImageUrl = imageUrl || originalImageUrl;
      const finalOriginalImageUrl = originalImageUrl || imageUrl;
      
      // Log the final image URLs for order completion
      console.log('Final image URLs for order completion:');
      console.log('Poster image URL:', finalImageUrl);
      console.log('Original image URL:', finalOriginalImageUrl);

      // Verify the payment intent was successful
      console.log("Verifying payment intent:", paymentIntentId);
      const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
      console.log("Payment intent status:", paymentIntent.status, "Metadata:", paymentIntent.metadata);
      
      if (paymentIntent.status !== "succeeded") {
        return res.status(400).json({
          message: "Payment has not been completed successfully"
        });
      }
      
      // If confirmationId wasn't provided, try to get it from the payment intent metadata
      if (!orderConfirmationId && paymentIntent.metadata.confirmationId) {
        orderConfirmationId = paymentIntent.metadata.confirmationId;
        console.log("Using confirmation ID from payment intent metadata:", orderConfirmationId);
      }
      
      // If we still don't have a confirmationId, generate a new one
      if (!orderConfirmationId) {
        orderConfirmationId = storage.generateConfirmationId();
        console.log("Generated new confirmation ID:", orderConfirmationId);
      }
      
      try {
        // Check if the poster and original image URLs are from Object Storage
        const isPosterFromObjectStorage = finalImageUrl.startsWith('/api/storage-image/');
        const isOriginalFromObjectStorage = finalOriginalImageUrl && finalOriginalImageUrl.startsWith('/api/storage-image/');
        
        // For Object Storage paths, we don't need to copy files - just use the URLs directly
        if (isPosterFromObjectStorage && (!finalOriginalImageUrl || isOriginalFromObjectStorage)) {
          console.log('Both poster and original image are from Object Storage, skipping file copying');
          
          // Directly use the URLs from Object Storage
          const finalPosterPath = finalImageUrl;
          const finalOriginalPath = finalOriginalImageUrl || finalImageUrl;
          
          // Determine the poster style for the order
          let posterStyle = 'standard';
          
          // Check if it's a catalogue image
          if (finalPosterPath.includes('/catalogue/') || finalPosterPath.includes('/public-images/')) {
            posterStyle = 'catalogue'; // Special indicator for catalogue orders
            console.log(`Using 'catalogue' style for order from catalogue`);
          } else {
            // Try to extract style from URL for generated images
            const styleMatch = finalPosterPath.match(/\/generated\/[^-]+-([^.]+)\.[^.]+$/);
            if (styleMatch && styleMatch[1]) {
              posterStyle = styleMatch[1].replace(/^[a-f0-9-]+-/, '');
              console.log(`Extracted style from URL: ${posterStyle}`);
            }
          }
          
          // Use the shipping data from the request for this order
          const finalShippingData = orderShippingData;
          
          // Prepare final order data for storage
          const orderData: InsertOrder = {
            firstName: finalShippingData.firstName,
            lastName: finalShippingData.lastName,
            email: finalShippingData.email,
            address: finalShippingData.address,
            city: finalShippingData.city,
            state: finalShippingData.state,
            zipCode: finalShippingData.zipCode,
            country: finalShippingData.country,
            confirmationId: orderConfirmationId,
            quantity: req.body.quantity || 1,
            amount: 60, // Force 60 cents per poster
            posterImageUrl: finalPosterPath,
            originalImageUrl: finalOriginalPath,
            style: posterStyle,
            status: 'paid'
          };
          
          // Store order in database
          await storage.createOrder(orderData);
          
          // Send confirmation email
          try {
            await sendOrderConfirmationEmail(finalShippingData.email, orderConfirmationId, 1);
            // Send admin notification for single poster orders
            await sendNewOrderNotificationEmail(orderData);
            console.log(`Order confirmation email sent to ${shippingData.email}`);
          } catch (emailError) {
            console.error('Error sending confirmation email:', emailError);
            // Don't fail the order if email fails
          }
          
          return res.json({
            success: true,
            message: "Order completed successfully",
            confirmationId
          });
        }
        
        // If we get here, at least one of the images is not from Object Storage
        // and needs traditional file copying
        console.log('Copying files for completed order...');
        
        // Check if imageUrl is local or external
        let finalPosterPath: string;
        let finalOriginalPath: string;
        
        // For generated images, we need to handle paths that start with /uploads/generated
        // And original images that start with /uploads/temp
        // These are local files in our server that we need to copy to the respective directories
        const timestamp = Date.now();
        
        if (imageUrl.startsWith('/uploads/generated/')) {
          console.log('Generated image detected, copying to order directory...');
          
          // Get the extension from the file
          const extension = path.extname(imageUrl) || '.png';
          
          // For the poster (processed) image - copy from generated folder to orders folder
          const finalPosterName = `POSTER-${confirmationId}${extension}`;
          console.log(`Using extension: ${extension} for poster image`);
          
          try {
            // Get the full source path from public directory
            const sourceRelativePath = imageUrl.startsWith('/') ? imageUrl.substring(1) : imageUrl;
            const sourcePath = path.join(process.cwd(), 'public', sourceRelativePath);
            
            console.log(`Source image exists: ${fs.existsSync(sourcePath)}`);
            
            // Email is required for Object Storage
            if (!shippingData.email) {
              throw new Error('Email is required for saving order images to Object Storage');
            }
            
            // Copy to Object Storage
            finalPosterPath = await storageAdapter.copyFileToStorage(
              sourceRelativePath,
              'orders',
              finalPosterName,
              shippingData.email
            );
            
            // Use the originalImageUrl if provided, otherwise use the same as the poster image
            if (originalImageUrl && originalImageUrl.startsWith('/')) {
              console.log('Using provided original image:', originalImageUrl);
              const originalSourcePath = originalImageUrl.startsWith('/') ? originalImageUrl.substring(1) : originalImageUrl;
              const originalExtension = path.extname(originalImageUrl) || '.png';
              const finalOriginalName = `ORIGINAL-${confirmationId}${originalExtension}`;
              
              try {
                // Verify original image exists
                const originalFullPath = path.join(process.cwd(), 'public', originalSourcePath);
                console.log(`Original image exists: ${fs.existsSync(originalFullPath)}`);
                
                // Special handling for /uploads/temp/ paths - this is where original uploads are stored
                if (originalImageUrl.startsWith('/uploads/temp/')) {
                  console.log('Original image is from temp directory, moving to originals folder...');
                }
                
                // Copy to Object Storage
                finalOriginalPath = await storageAdapter.copyFileToStorage(
                  originalSourcePath,
                  'orders/originals',
                  finalOriginalName,
                  shippingData.email
                );
              } catch (err) {
                console.error('Error copying original image:', err);
                // If original image copy fails, use the generated one as fallback
                const finalOriginalName = `ORIGINAL-${confirmationId}${extension}`;
                // Copy to Object Storage
                finalOriginalPath = await storageAdapter.copyFileToStorage(
                  sourceRelativePath,
                  'orders/originals',
                  finalOriginalName,
                  shippingData.email
                );
              }
            } else {
              // Fallback to using the same image as the poster
              console.log('No original image provided, using generated image as fallback');
              const finalOriginalName = `ORIGINAL-${confirmationId}${extension}`;
              // Copy to Object Storage
              finalOriginalPath = await storageAdapter.copyFileToStorage(
                sourceRelativePath,
                'orders/originals',
                finalOriginalName,
                shippingData.email
              );
            }
          } catch (err) {
            console.error('Error copying generated image:', err);
            throw err;
          }
        } else if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
          // It's an external URL, use fetch to download the image
          console.log('External URL detected, fetching the image...');
          
          // Check if email is available for Object Storage
          if (!shippingData.email) {
            throw new Error('Email is required for saving order images to Object Storage');
          }
          
          // For the poster image
          finalPosterPath = await fetchImageAndSave(
            imageUrl,
            'orders',
            `POSTER-${confirmationId}-${timestamp}.png`,
            shippingData.email
          );
          
          // For the original image - use the original image URL if provided
          if (originalImageUrl && (originalImageUrl.startsWith('http://') || originalImageUrl.startsWith('https://'))) {
            console.log('Using provided external original image URL');
            finalOriginalPath = await fetchImageAndSave(
              originalImageUrl,
              'orders/originals',
              `ORIGINAL-${confirmationId}-${timestamp}.png`,
              shippingData.email
            );
          } else {
            console.log('No original external image provided, using generated image');
            finalOriginalPath = await fetchImageAndSave(
              imageUrl,
              'orders/originals',
              `ORIGINAL-${confirmationId}-${timestamp}.png`,
              shippingData.email
            );
          }
        } else if (imageUrl.startsWith('/uploads/temp/')) {
          // Original image from temp directory - copy to both locations
          console.log('Original image from temp directory detected, copying to required locations...');
          const originalExtension = path.extname(imageUrl) || '.png'; 
          
          // For the original image - move from temp to originals
          const finalOriginalName = `ORIGINAL-${confirmationId}${originalExtension}`;
          console.log(`Moving original image from temp to originals with name: ${finalOriginalName}`);
          
          const sourceRelativePath = imageUrl.startsWith('/') ? imageUrl.substring(1) : imageUrl;
          // Copy to Object Storage
          finalOriginalPath = await storageAdapter.copyFileToStorage(
            sourceRelativePath,
            'orders/originals',
            finalOriginalName,
            shippingData.email
          );
          
          // For the poster image - if we don't have a separate poster image, use the original
          if (!originalImageUrl || originalImageUrl === imageUrl) {
            console.log('No separate poster image provided, using original as poster too');
            const finalPosterName = `POSTER-${confirmationId}${originalExtension}`;
            // Copy to Object Storage
            finalPosterPath = await storageAdapter.copyFileToStorage(
              sourceRelativePath,
              'orders',
              finalPosterName,
              shippingData.email
            );
          } else if (originalImageUrl.startsWith('/uploads/generated/')) {
            // We have a generated image for the poster
            console.log('Using generated image for poster');
            const posterExtension = path.extname(originalImageUrl) || '.png';
            const finalPosterName = `POSTER-${confirmationId}${posterExtension}`;
            
            const posterSourcePath = originalImageUrl.startsWith('/') ? 
              originalImageUrl.substring(1) : originalImageUrl;
              
            // Copy to Object Storage
            finalPosterPath = await storageAdapter.copyFileToStorage(
              posterSourcePath,
              'orders',
              finalPosterName,
              shippingData.email
            );
          } else {
            // Default case - use the original image
            console.log('Using provided image for poster');
            const finalPosterName = `POSTER-${confirmationId}${originalExtension}`;
            // Copy to Object Storage
            finalPosterPath = await storageAdapter.copyFileToStorage(
              sourceRelativePath,
              'orders',
              finalPosterName,
              shippingData.email
            );
          }
        } else {
          // It's another local path, use copyFile
          console.log('Other local path detected, copying the file...');
          const originalExtension = path.extname(imageUrl) || '.png'; // Default to .png if no extension
          
          // For the poster (processed) image
          const finalPosterName = `POSTER-${confirmationId}${originalExtension}`;
          console.log(`Preserving file extension: ${originalExtension} for poster image`);
          // Copy to Object Storage
          finalPosterPath = await storageAdapter.copyFileToStorage(
            imageUrl,
            'orders',
            finalPosterName,
            shippingData.email
          );
          
          // For the original image - use the originalImageUrl if provided
          if (originalImageUrl) {
            console.log('Using provided original image for local path case');
            const originalSourceExtension = path.extname(originalImageUrl) || '.png';
            const finalOriginalName = `ORIGINAL-${confirmationId}${originalSourceExtension}`;
            // Copy to Object Storage
            finalOriginalPath = await storageAdapter.copyFileToStorage(
              originalImageUrl,
              'orders/originals',
              finalOriginalName,
              shippingData.email
            );
          } else {
            console.log('No original image provided for local path case');
            const finalOriginalName = `ORIGINAL-${confirmationId}${originalExtension}`;
            // Copy to Object Storage
            finalOriginalPath = await storageAdapter.copyFileToStorage(
              imageUrl,
              'orders/originals',
              finalOriginalName,
              shippingData.email
            );
          }
        }
        
        // When using Object Storage, we don't need to delete local files
        // Object Storage will automatically manage file lifecycle
        console.log('Images successfully saved to Object Storage for order:', confirmationId);
        
        console.log(`Files copied successfully: 
          Poster Image: ${finalPosterPath}
          Original Image: ${finalOriginalPath}`);
        
        // Create order in database with confirmation ID, quantity, and both URLs
        const orderData = {
          ...shippingData,
          confirmationId,
          posterImageUrl: finalPosterPath,
          originalImageUrl: finalOriginalPath,
          style: req.body.style || 'Renaissance', // Use style from request or default to Renaissance
          quantity: req.body.quantity || 1, // Include quantity from request or default to 1
          amount: 60, // Force 60 cents per poster
          status: 'pending' // Set initial status
        };
        
        const order = await storage.createOrder(orderData);
        
        // Send order confirmation email to customer
        if (shippingData.email) {
          try {
            // Get quantity from request or use default of 1
            const quantity = req.body.quantity || 1;
            console.log(`Sending order confirmation email to ${shippingData.email} for order ${confirmationId} with quantity ${quantity}`);
            const emailResult = await sendOrderConfirmationEmail(shippingData.email, confirmationId, quantity);
            console.log('Customer email sending result:', emailResult);
          } catch (emailError) {
            console.error('Error sending confirmation email:', emailError);
            // Don't fail the order if email fails, just log it
          }
        } else {
          console.warn('No email provided for order confirmation');
        }
        
        // Send notification email to admin about the new order
        try {
          console.log(`Sending admin notification email for new order ${confirmationId}`);
          const adminEmailResult = await sendNewOrderNotificationEmail(order);
          console.log('Admin notification email result:', adminEmailResult);
        } catch (adminEmailError) {
          console.error('Error sending admin notification email:', adminEmailError);
          // Don't fail the order if admin email fails, just log it
        }
        
        res.status(201).json({
          orderId: order.id,
          confirmationId: order.confirmationId
        });
      } catch (fileError) {
        console.error("Error managing order files:", fileError);
        return res.status(500).json({
          message: "Error saving order files"
        });
      }
    } catch (error) {
      console.error("Error completing order:", error);
      res.status(500).json({ 
        message: error instanceof Error ? error.message : "Error completing order" 
      });
    }
  });

  // New GPT Image API integration with style support
  app.post("/api/generate-gpt-image", async (req, res) => {
    try {
      console.log("Generating image with GPT Image API...");
      
      const { imageData, style, stylePrompt, email, originalVideoPath, videoFrameTimestamp, hasVideoData } = req.body;
      
      console.log('📹 Request body video data:', {
        originalVideoPath,
        videoFrameTimestamp,
        hasVideoData
      });
      
      if (!imageData) {
        return res.status(400).json({ message: "Image data is required" });
      }
      
      // If email is provided, only verify the email is verified (July 9, 2025: Generation is FREE for all)
      if (email) {
        const user = await storage.getUserByEmail(email);
        
        if (user) {
          // As of July 9, 2025: All users get unlimited free generations
          // Only check if email is verified
          const userCredits = await storage.getGenerationCreditsByEmail(email);
          
          if (!userCredits || !userCredits.verified) {
            return res.status(403).json({ message: "Email not verified" });
          }
          
          console.log(`User ${email} verified. Unlimited generations allowed (free for all users).`);
        } else {
          return res.status(404).json({ message: "User not found" });
        }
      }
      
      // Get the style information or use defaults
      const styleId = style || "renaissance";
      
      // Use Object Storage path for style images - no more local file system!
      const styleObjectStoragePath = `styles/images/${styleId}.png`;
      
      // Generate a confirmation ID for this request
      const confirmationId = `gpt-img-${Date.now()}`;
      
      // Save the user's image and get a URL to it
      const imagePath = await saveBase64Image(imageData, confirmationId, email);
      const fullImageUrl = `${req.protocol}://${req.get('host')}${imagePath}`;
      console.log("User image saved at:", fullImageUrl);
      
      // Get the style image from Object Storage
      const styleImageBuffer = await objectStorage.downloadImage(styleObjectStoragePath);
      
      // We get the style image URL from our API endpoint that serves from Object Storage
      const fullStyleUrl = `${req.protocol}://${req.get('host')}/api/storage-image/${styleObjectStoragePath}`;
      console.log("Using style image from:", fullStyleUrl);
      
      // Ensure Replicate API key is available
      if (!process.env.REPLICATE_API_KEY) {
        throw new Error("Replicate API key is required for GPT Image generation");
      }
      
      // Ensure OpenAI API key is available
      if (!process.env.PosterTheMoment_OpenAI_Key) {
        throw new Error("OpenAI API key is required for GPT Image generation");
      }
      
      // Use the provided style prompt or a default one
      const promptToUse = stylePrompt || "Use the second image as a style reference in the Renaissance painting style. Apply its visual style—color palette, chiaroscuro lighting, brushwork, and realism—to the first image without altering its content, geometry, or composition. Preserve subject proportions and layout. This is a style transfer only, not a reinterpretation.";
      
      // Create a prediction using Replicate API
      console.log("Creating Replicate prediction for GPT Image generation with OpenAI GPT Image model...");
      console.log("Using parameters:", {
        version: "8eb8e1a075a4c5040e16c987a19c1a4582fd4aec5932cf9cd2265fd875072ad2",
        prompt: promptToUse,
        style: styleId,
        aspect_ratio: "2:3",
        input_images: [fullImageUrl, fullStyleUrl],
        number_of_images: 1,
        quality: "auto",
        background: "auto",
        output_compression: 90,
        output_format: "png"
      });
      
      // Parameters for GPT Image API according to requirements
      const input = {
        openai_api_key: process.env.PosterTheMoment_OpenAI_Key,
        prompt: promptToUse,
        aspect_ratio: "2:3",
        input_images: [fullImageUrl, fullStyleUrl], // First the user image, then the style image
        number_of_images: 1,
        quality: "auto",
        background: "auto",
        output_compression: 90,
        output_format: "png",
        moderation: "low"
      };
      
      console.log(input)
      // Using the run method as shown in the documentation
      const output = await replicate.run("openai/gpt-image-1", { input });
      
      console.log("GPT Image generation completed");
      
      // Log the output for debugging
      console.log("Output type:", typeof output);
      console.log("Output is array:", Array.isArray(output));
      console.log("Output length:", Array.isArray(output) ? output.length : 'N/A');
      
      // Check if we have a valid output
      if (!output || !Array.isArray(output) || output.length === 0) {
        throw new Error("No output generated by the model");
      }
      
      // Get the first generated image URL
      const generatedImageUrl = output[0];
      console.log("Generated image URL:", generatedImageUrl);
      
      // Fetch and save the generated image
      const timestamp = Date.now();
      const outputDir = 'uploads/generated';
      const finalFilename = `gpt-image-${styleId}-${timestamp}.png`;
      
      // Store the original image path in a session variable for reference
      global.lastUploadedImagePath = imagePath;
      
      // Save the generated image to Object Storage
      if (!email) {
        throw new Error('Email is required for saving images to Object Storage');
      }
      
      // Save to Object Storage with the user's email - no fallback
      const videoDataToSave = hasVideoData ? {
        originalVideoPath,
        videoFrameTimestamp
      } : undefined;
      
      console.log('📹 Video data to save:', {
        hasVideoData,
        originalVideoPath,
        videoFrameTimestamp,
        videoDataToSave
      });
      
      const generatedImagePath = await fetchImageAndSave(
        generatedImageUrl,
        outputDir,
        finalFilename,
        email,
        videoDataToSave
      );
      
      console.log(`Image successfully saved to Object Storage for user ${email}`);
      
      // Note: Automatic thumbnail generation is now handled directly in the uploadGeneratedImage function
      
      // Return the URL to the saved generated image and the original image path
      res.status(200).json({
        posterUrl: generatedImagePath,
        previewUrl: generatedImagePath, // Use same URL for preview and high-res
        originalImagePath: imagePath, // Include the original image path
        style: styleId
      });
      
    } catch (error) {
      console.error("Error generating GPT image:", error);
      
      // Log additional properties that might be in the error object
      console.error("Error details:", JSON.stringify(error, Object.getOwnPropertyNames(error), 2));
      
      // Provide a user-friendly error message
      // Don't expose internal errors to the client
      let errorCode = 500;
      let errorMessage = "We're experiencing technical difficulties. Please try again later. Your credit has not been used.";
      
      // Return a user-friendly error response
      res.status(errorCode).json({ 
        message: errorMessage,
        serviceUnavailable: true,
        creditPreserved: true
      });
    }
  });
  
  // API status check endpoint
  app.get("/api/check-api-status", async (req, res) => {
    try {
      const results = {
        replicate: false
      };
      
      // Check Replicate API
      if (process.env.REPLICATE_API_KEY) {
        try {
          const response = await fetch(
            "https://api.replicate.com/v1/models",
            {
              headers: {
                "Authorization": `Token ${process.env.REPLICATE_API_KEY}`
              }
            }
          );
          results.replicate = response.ok;
          console.log("Replicate API Check:", results.replicate ? "OK" : "Failed");
        } catch (error) {
          console.error("Replicate API check error:", error);
        }
      }
      
      res.status(200).json(results);
    } catch (error) {
      console.error("Error checking API status:", error);
      res.status(500).json({ 
        message: error instanceof Error ? error.message : "Error checking API status" 
      });
    }
  });



  // Micro-payment system API routes
  
  // 1. Send email verification code
  app.post("/api/verify-email", async (req, res) => {
    try {
      const { email } = req.body;
      
      if (!email) {
        return res.status(400).json({ message: "Email is required" });
      }
      
      // Generate verification code
      const verificationCode = storage.generateVerificationCode();
      
      // Check if user already exists
      let userCredits = await storage.getGenerationCreditsByEmail(email);
      
      if (userCredits) {
        // Update existing user with new verification code
        await storage.updateGenerationCredits(userCredits.id, {
          verificationCode: verificationCode,
          lastGeneratedAt: new Date(),
          verified: false
        });
      } else {
        // Create new user
        userCredits = await storage.createGenerationCredits({
          email,
          verificationCode: verificationCode,
          freeCreditsUsed: 0,
          paidCredits: 0,
          verified: false,
          ipAddress: req.ip
        });
      }
      
      // Send verification email
      const emailResult = await sendVerificationEmail(email, verificationCode);
      
      if (!emailResult.success) {
        console.error("Failed to send verification email:", emailResult.error);
        return res.status(500).json({ message: "Failed to send verification email" });
      }
      
      res.status(200).json({ message: "Verification code sent successfully" });
    } catch (error) {
      console.error("Error sending verification email:", error);
      res.status(500).json({ 
        message: error instanceof Error ? error.message : "Error sending verification email" 
      });
    }
  });
  
  // 2. Verify email with code
  app.post("/api/confirm-verification", async (req, res) => {
    try {
      const { email, code } = req.body;
      
      if (!email || !code) {
        return res.status(400).json({ message: "Email and verification code are required" });
      }
      
      const verified = await storage.verifyEmail(email, code);
      
      if (!verified) {
        return res.status(400).json({ message: "Invalid verification code" });
      }
      
      res.status(200).json({ 
        verified: true,
        freeCreditsRemaining: 2, // Start with 2 free credits
        message: "Email verified successfully"
      });
    } catch (error) {
      console.error("Error verifying email:", error);
      res.status(500).json({ 
        message: error instanceof Error ? error.message : "Error verifying email" 
      });
    }
  });
  
  // Get user's generated images for dashboard
  app.get('/api/user-images', async (req, res) => {
    try {
      const { email } = req.query;
      
      if (!email) {
        return res.status(400).json({ error: 'Email parameter is required' });
      }
      
      // Fetch user's generated images from the database
      const userImages = await db.select({
        id: generatedImages.id,
        generatedPath: generatedImages.generatedPath,
        originalPath: generatedImages.originalPath,
        thumbnailPath: generatedImages.thumbnailPath,
        style: generatedImages.style,
        createdAt: generatedImages.createdAt,
        isPublic: generatedImages.isPublic,
        isSaved: generatedImages.isSaved,
      })
      .from(generatedImages)
      .where(eq(generatedImages.userId, email as string))
      .orderBy(desc(generatedImages.createdAt));
      
      // Generate URLs for thumbnails (faster loading) and full images
      const imagesWithUrls = await Promise.all(
        userImages.map(async (image) => {
          const { getImageUrl } = await import('./services/object-storage');
          // Use thumbnail for dashboard display (faster loading)
          const thumbnailUrl = image.thumbnailPath ? await getImageUrl(image.thumbnailPath) : await getImageUrl(image.generatedPath);
          // Keep full image URL for modal/download
          const fullImageUrl = await getImageUrl(image.generatedPath);
          return {
            ...image,
            imageUrl: thumbnailUrl, // Dashboard will load thumbnails
            fullImageUrl: fullImageUrl, // Available for modal
          };
        })
      );
      
      res.json({ images: imagesWithUrls });
    } catch (error) {
      console.error('Error fetching user images:', error);
      res.status(500).json({ error: 'Failed to fetch user images' });
    }
  });

  // 3. Check credits
  app.get("/api/check-credits", async (req, res) => {
    try {
      const { email } = req.query;
      
      if (!email) {
        return res.status(400).json({ message: "Email is required" });
      }
      
      const userCredits = await storage.getGenerationCreditsByEmail(email as string);
      
      if (!userCredits || !userCredits.verified) {
        return res.status(400).json({ 
          verified: false,
          message: "Email not verified" 
        });
      }
      
      const freeCreditsUsed = userCredits.freeCreditsUsed || 0;
      const paidCredits = userCredits.paidCredits || 0;
      const freeCreditsRemaining = Math.max(0, 2 - freeCreditsUsed);
      
      res.status(200).json({
        verified: true,
        freeCreditsRemaining,
        paidCredits,
        totalCreditsRemaining: freeCreditsRemaining + paidCredits
      });
    } catch (error) {
      console.error("Error checking credits:", error);
      res.status(500).json({ 
        message: error instanceof Error ? error.message : "Error checking credits" 
      });
    }
  });
  
  // 4. Purchase credits
  app.post("/api/purchase-credits", async (req, res) => {
    try {
      const { email, package: creditPackage } = req.body;
      
      if (!email || !creditPackage) {
        return res.status(400).json({ message: "Email and package are required" });
      }
      
      const userCredits = await storage.getGenerationCreditsByEmail(email);
      
      if (!userCredits || !userCredits.verified) {
        return res.status(400).json({ message: "Email not verified" });
      }
      
      let creditsToAdd = 0;
      let amountCHF = 0;
      
      // Determine package details
      switch (creditPackage) {
        case 'basic': // 5 generations
          creditsToAdd = 5;
          amountCHF = 5;
          break;
        case 'standard': // 20 generations
          creditsToAdd = 20;
          amountCHF = 15;
          break;
        case 'premium': // 50 generations
          creditsToAdd = 50;
          amountCHF = 30;
          break;
        default:
          return res.status(400).json({ message: "Invalid package selection" });
      }
      
      // Create a Stripe payment intent
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
        apiVersion: '2025-04-30.basil',
      });
      
      // Create payment intent with comprehensive metadata for failsafe credit allocation
      const paymentIntent = await stripe.paymentIntents.create({
        amount: amountCHF * 100, // Convert to cents
        currency: 'chf',
        metadata: {
          email,
          credits: creditsToAdd.toString(),
          package: creditPackage,
          packageId: creditPackage, // Include both formats for consistency
          amount: amountCHF.toString(), // Store amount for verification
          timestamp: Date.now().toString() // Store timestamp for auditing
        }
      });
      
      res.status(200).json({
        clientSecret: paymentIntent.client_secret,
        amount: amountCHF,
        credits: creditsToAdd
      });
    } catch (error) {
      console.error("Error purchasing credits:", error);
      res.status(500).json({ 
        message: error instanceof Error ? error.message : "Error purchasing credits" 
      });
    }
  });
  
  // 5. Confirm credit purchase
  app.post("/api/confirm-credit-purchase", async (req, res) => {
    // Define all variables at the top of the function to ensure proper scoping
    let creditsToAdd = 0;
    let success = false;
    let retryCount = 0;
    const maxRetries = 3;
    let beforeCredits = null;
    let paymentIntent = null;
    
    try {
      console.log("Credit purchase confirmation request body:", req.body);
      
      // Extract variables from request body, supporting multiple parameter names
      const email = req.body.email;
      const paymentIntentId = req.body.paymentIntentId;
      
      // Accept ANY of these parameter names for backward compatibility
      const packageId = req.body.packageId || req.body.package || req.body.creditPackage;
      
      console.log(`Debug - Email: ${email}, PaymentIntentId: ${paymentIntentId}, PackageId: ${packageId}`);
      
      // Validate required parameters
      if (!email) {
        return res.status(400).json({ message: "Email is required" });
      }
      
      if (!paymentIntentId) {
        return res.status(400).json({ message: "Payment intent ID is required" });
      }
      
      // For credit confirmation, packageId is OPTIONAL as we'll determine credits from Stripe
      
      // Initialize Stripe client
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
        apiVersion: '2025-04-30.basil',
      });
      
      try {
        // Verify the payment intent
        paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
        console.log("Processing payment intent:", {
          id: paymentIntent.id,
          status: paymentIntent.status,
          amount: paymentIntent.amount,
          metadata: paymentIntent.metadata 
        });
        
        if (paymentIntent.status !== 'succeeded') {
          return res.status(400).json({ 
            message: `Payment not completed. Current status: ${paymentIntent.status}`,
            status: paymentIntent.status
          });
        }
        
        // First try to use packageId from the request
        if (packageId) {
          console.log(`Using packageId from request: ${packageId}`);
          // Normalize package ID to handle various formats (lowercase, trim, etc.)
          const normalizedPackageId = String(packageId).trim().toLowerCase();
          
          switch (normalizedPackageId) {
            case 'basic':
              creditsToAdd = 1;
              break;
            case 'standard':
              creditsToAdd = 3;
              break;
            case 'premium':
              creditsToAdd = 5;
              break;
            default:
              // Continue to next method of determining credits
              console.log(`Unknown packageId: ${normalizedPackageId}, trying metadata next`);
          }
        }
        
        // If we couldn't determine from packageId, try metadata
        if (creditsToAdd === 0 && paymentIntent.metadata && paymentIntent.metadata.credits) {
          creditsToAdd = parseInt(paymentIntent.metadata.credits || '0', 10);
          console.log(`Credits from metadata: ${creditsToAdd}`);
        } 
        
        // Fallback to determine credits based on amount paid
        if (creditsToAdd === 0) {
          // Amount is in cents, so we convert to CHF
          const amountInCHF = paymentIntent.amount / 100;
          console.log(`Amount in CHF: ${amountInCHF}`);
          
          // Apply our credit package logic based on amount
          if (amountInCHF === 1) {
            creditsToAdd = 1; // Basic package
          } else if (amountInCHF === 2) {
            creditsToAdd = 3; // Standard package
          } else if (amountInCHF === 3) {
            creditsToAdd = 5; // Premium package
          } else {
            // For unknown amounts, use 1 CHF = 1 credit
            creditsToAdd = Math.round(amountInCHF);
          }
          console.log(`Credits determined from amount: ${creditsToAdd}`);
        }
        
        // If we still couldn't determine credits after all our methods, 
        // use a safe default rather than failing
        if (creditsToAdd <= 0) {
          console.warn("Could not determine credits from any source, using default value of 1");
          creditsToAdd = 1; // Default to 1 credit if we can't determine - better than failing payment
        }
      } catch (stripeError) {
        console.error("Stripe API error:", stripeError);
        return res.status(500).json({ 
          message: "Error verifying payment with Stripe. Please refresh and try again."
        });
      }
      
      // Check user's current credits before updating
      beforeCredits = await storage.getGenerationCreditsByEmail(email);
      console.log(`Before update - User ${email} has ${beforeCredits?.paidCredits || 0} paid credits`);
      
      // Add credits to user account with retry mechanism
      while (!success && retryCount < maxRetries) {
        try {
          success = await storage.addPaidCredits(email, creditsToAdd);
          if (success) {
            console.log(`Successfully added ${creditsToAdd} credits to account: ${email}`);
            break;
          }
          retryCount++;
          // Short delay between retries
          await new Promise(resolve => setTimeout(resolve, 200));
        } catch (creditError) {
          console.error(`Error adding credits (attempt ${retryCount + 1}):`, creditError);
          retryCount++;
          if (retryCount >= maxRetries) throw creditError;
          // Longer delay if there was an exception
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
      
      if (!success) {
        console.error(`Failed to add credits after ${maxRetries} attempts`);
        return res.status(500).json({ 
          message: "Failed to add credits to account. Please refresh your page - your credits may appear after refreshing."
        });
      }
      
      // Get updated credit information and verify the update worked
      const userCredits = await storage.getGenerationCreditsByEmail(email);
      console.log(`After update - User ${email} has ${userCredits?.paidCredits || 0} paid credits`);
      
      const freeCreditsUsed = userCredits?.freeCreditsUsed || 0;
      const paidCredits = userCredits?.paidCredits || 0;
      const freeCreditsRemaining = Math.max(0, 2 - freeCreditsUsed);
      
      // Log a warning if credits weren't properly added
      if (beforeCredits && userCredits && typeof beforeCredits.paidCredits === 'number' && typeof userCredits.paidCredits === 'number') {
        if (beforeCredits.paidCredits + creditsToAdd !== userCredits.paidCredits) {
          console.warn(`Credits may not have been added correctly. Before: ${beforeCredits.paidCredits}, Added: ${creditsToAdd}, After: ${userCredits.paidCredits}`);
        }
      }
      
      res.status(200).json({
        success: true,
        creditsAdded: creditsToAdd,
        freeCreditsRemaining,
        paidCredits,
        totalCreditsRemaining: freeCreditsRemaining + paidCredits
      });
    } catch (error) {
      console.error("Error confirming credit purchase:", error);
      
      res.status(500).json({ 
        message: error instanceof Error ? error.message : "Error confirming credit purchase" 
      });
    }
  });
  
  // 6. Use credit for generation - FREE FOR ALL USERS (as of July 9, 2025)
  app.post("/api/use-generation-credit", async (req, res) => {
    try {
      const { email } = req.body;
      
      if (!email) {
        return res.status(400).json({ message: "Email is required" });
      }
      
      const userCredits = await storage.getGenerationCreditsByEmail(email);
      
      if (!userCredits || !userCredits.verified) {
        return res.status(400).json({ message: "Email not verified" });
      }
      
      // As of July 9, 2025: Poster generation is completely free for all users
      // Return unlimited credits (∞) for all verified users
      res.status(200).json({
        success: true,
        freeCreditsRemaining: Infinity,
        paidCredits: 0,
        totalCreditsRemaining: Infinity
      });
    } catch (error) {
      console.error("Error using generation credit:", error);
      res.status(500).json({ 
        message: error instanceof Error ? error.message : "Error using generation credit" 
      });
    }
  });
  
  // Create a shareable image with white border and watermark for download
  app.get('/api/get-shareable-image/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { email } = req.query;
      
      if (!email) {
        return res.status(400).json({ error: 'Email parameter is required' });
      }
      
      // Extract the image ID and style from the passed ID parameter
      // Format could be like: 61dbb390-4948-489e-8fcf-63a2385ffff3-artdeco
      const parts = id.split('-');
      const style = parts.length > 4 ? parts[parts.length - 1] : ''; // Extract the style name if present
      const imageId = style ? id.substring(0, id.length - style.length - 1) : id;
      
      // Construct the path to the generated image in Object Storage
      const generatedImagePath = `users/${email}/generated/${id}.png`;
      
      // Check if image exists in Object Storage
      // const imageExists = await objectStorage.imageExists(generatedImagePath);
      // if (!imageExists) {
      //   console.error(`Image not found in Object Storage: ${generatedImagePath}`);
      //   return res.status(404).json({ error: 'Image not found' });
      // }
      
      // Download the image from Object Storage
      console.log(`Downloading image from Object Storage: ${generatedImagePath}`);
      const imageBuffer = await objectStorage.downloadImage(generatedImagePath);
      
      // Get image dimensions
      const metadata = await sharp(imageBuffer).metadata();
      const { width = 1024, height = 1536 } = metadata;
      
      // Create a white border around the image with watermark
      // Border size: 5% of the shorter dimension
      const borderSize = Math.floor(Math.min(width, height) * 0.05);
      
      console.log(`Creating shareable image with ${borderSize}px border`);
      
      // Create a new image with white background and the original image centered
      const processedImageBuffer = await sharp({
        create: {
          width: width + (borderSize * 2),
          height: height + (borderSize * 2),
          channels: 4,
          background: { r: 255, g: 255, b: 255, alpha: 1 }
        }
      })
      .composite([
        // Original image in the center
        {
          input: imageBuffer,
          top: borderSize,
          left: borderSize
        },
        // Watermark at the very bottom center of the image (within the white border)
        {
          input: Buffer.from(
            `<svg width="${width + (borderSize * 2)}" height="${borderSize}">
              <text 
                x="${(width + (borderSize * 2)) / 2}" 
                y="${Math.floor(borderSize * 0.7)}" 
                font-family="Arial" 
                font-size="${Math.floor(borderSize * 0.5)}px" 
                fill="#8a8a8a" 
                text-anchor="middle"
              >coffeeandprints.com</text>
            </svg>`
          ),
          gravity: 'south',
          top: 0,
          left: 0
        },
      ])
      .toBuffer();
      
      // Set response headers for file download
      res.setHeader('Content-Disposition', `attachment; filename="poster-${id}.png"`);
      res.setHeader('Content-Type', 'image/png');
      
      // Send the processed image directly as the response
      res.send(processedImageBuffer);
      
    } catch (error) {
      console.error('Error creating shareable image:', error);
      res.status(500).json({ error: 'Failed to create shareable image' });
    }
  });

  // Process image for download (adds border and watermark)
  app.post('/api/process-image-for-download', async (req, res) => {
    try {
      const { imageUrl } = req.body;
      
      if (!imageUrl || typeof imageUrl !== 'string') {
        return res.status(400).json({ message: 'Image URL is required' });
      }
      
      console.log('Processing image for download:', imageUrl);
      
      // Process the image by adding a white border
      const processedImageResponse = await addBorderAndWatermark(imageUrl);
      
      // Parse the JSON response from the image processor
      const imageData = JSON.parse(processedImageResponse);
      
      // Set the appropriate headers for image download
      res.setHeader('Content-Type', imageData.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${imageData.fileName}"`);
      
      // Send the buffer directly to the client
      res.send(imageData.buffer);
    } catch (error) {
      console.error('Error processing image for download:', error);
      res.status(500).json({ 
        success: false,
        message: 'Failed to process image' 
      });
    }
  });

  // Thumbnail generation endpoint for existing images (migration utility)
  app.post("/api/generate-thumbnails", async (req, res) => {
    try {
      const limit = parseInt(req.body.limit as string) || 50;
      
      console.log(`Starting thumbnail generation for up to ${limit} existing images...`);
      
      const { generateThumbnailsForExistingImages } = await import('./services/thumbnail-generator');
      const processedCount = await generateThumbnailsForExistingImages(limit);
      
      res.json({
        success: true,
        message: `Successfully generated thumbnails for ${processedCount} images`,
        processedCount
      });
    } catch (error) {
      console.error('Error generating thumbnails:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to generate thumbnails',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // Video compression endpoint for existing videos (migration utility)
  app.post("/api/compress-videos", async (req, res) => {
    try {
      const limit = parseInt(req.body.limit as string) || 5;
      
      console.log(`Starting video compression for up to ${limit} existing videos...`);
      
      const { compressExistingVideos } = await import('./services/video-compressor');
      const processedCount = await compressExistingVideos(limit);
      
      res.json({
        success: true,
        message: `Successfully compressed ${processedCount} videos`,
        processedCount
      });
    } catch (error) {
      console.error('Error compressing videos:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to compress videos',
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
    }
  });

  // Share image endpoint with white border - creates 419×610px image with borders
  app.post("/api/share-image-with-border", async (req, res) => {
    try {
      const { imageUrl } = req.body;
      
      if (!imageUrl) {
        return res.status(400).json({ 
          success: false,
          message: 'Image URL is required' 
        });
      }
      
      // Create share image with white border on 419×610px canvas
      const shareImageBuffer = await createShareImageWithBorder(imageUrl);
      
      // Set headers for image download
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Content-Disposition', 'attachment; filename="poster-share.png"');
      
      // Send the buffer directly to the client
      res.send(shareImageBuffer);
    } catch (error) {
      console.error('Error creating share image with border:', error);
      res.status(500).json({ 
        success: false,
        message: 'Failed to create share image with border' 
      });
    }
  });

  // User poster selling statistics endpoint
  app.get('/api/user-poster-stats', async (req, res) => {
    try {
      const { email } = req.query;
      
      if (!email || typeof email !== 'string') {
        return res.status(400).json({ error: 'Email parameter is required' });
      }
      
      // Get user data from storage
      const user = await storage.getUserByEmail(email);
      
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }
      
      // Check subscription status
      const isSubscribed = user.userType === 'artistic_collective' && 
                          user.subscriptionStatus === 'active' &&
                          (!user.subscriptionEndDate || new Date(user.subscriptionEndDate) > new Date());
      
      // Get poster count from user record
      const postersForSale = user.postersForSale || 0;
      
      console.log(`User stats debug for ${email}:`, {
        userId: user.id,
        userType: user.userType,
        subscriptionStatus: user.subscriptionStatus,
        postersForSale: user.postersForSale,
        postersForSaleCalculated: postersForSale,
        isSubscribed
      });
      
      // Set cache-control headers to prevent caching of dynamic data
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.set('Pragma', 'no-cache');
      res.set('Expires', '0');
      
      res.json({
        postersForSale,
        isSubscribed,
        canSellPoster: isSubscribed || postersForSale < 2
      });
    } catch (error) {
      console.error('Error getting user poster stats:', error);
      res.status(500).json({ error: 'Failed to get user poster stats' });
    }
  });

  // Feed API endpoint - get public posts for feed
  // Like/unlike a poster
  app.post('/api/posters/:id/like', async (req, res) => {
    try {
      const { id } = req.params;
      const token = req.cookies.auth_token || req.cookies.token;
      
      if (!token) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      
      const payload = verifyToken(token);
      if (!payload) {
        return res.status(401).json({ error: 'Invalid token' });
      }
      
      // Get user ID
      const user = await db.select().from(users).where(eq(users.email, payload.email)).limit(1);
      if (user.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }
      
      const userId = user[0].id;
      const { posterLikes } = await import('@shared/schema');
      
      // Check if already liked
      const existingLike = await db
        .select()
        .from(posterLikes)
        .where(and(
          eq(posterLikes.imageId, id),
          eq(posterLikes.userId, userId)
        ))
        .limit(1);
      
      if (existingLike.length > 0) {
        // Unlike - remove the like
        await db
          .delete(posterLikes)
          .where(and(
            eq(posterLikes.imageId, id),
            eq(posterLikes.userId, userId)
          ));
        
        // Get updated like count
        const likeCountResult = await db
          .select({ count: sql<number>`count(*)` })
          .from(posterLikes)
          .where(eq(posterLikes.imageId, id));
        
        const likeCount = Number(likeCountResult[0]?.count || 0);
        
        res.json({ hasLiked: false, likeCount });
      } else {
        // Like - add new like
        await db.insert(posterLikes).values({
          imageId: id,
          userId: userId
        });
        
        // Get updated like count
        const likeCountResult = await db
          .select({ count: sql<number>`count(*)` })
          .from(posterLikes)
          .where(eq(posterLikes.imageId, id));
        
        const likeCount = Number(likeCountResult[0]?.count || 0);
        
        res.json({ hasLiked: true, likeCount });
      }
    } catch (error) {
      console.error('Error liking/unliking poster:', error);
      res.status(500).json({ error: 'Failed to update like status' });
    }
  });

  app.get('/api/feed', async (req, res) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 10;
      const offset = (page - 1) * limit;
      
      // Get current user if authenticated
      const token = req.cookies.token;
      let currentUserId: number | null = null;
      if (token) {
        const payload = verifyToken(token);
        if (payload) {
          const user = await db.select().from(users).where(eq(users.email, payload.email)).limit(1);
          if (user.length > 0) {
            currentUserId = user[0].id;
          }
        }
      }
      
      // Get public posts with video data (only posts that have videos)
      const posts = await db
        .select({
          id: generatedImages.id,
          userId: generatedImages.userId,
          originalPath: generatedImages.originalPath,
          generatedPath: generatedImages.generatedPath,
          thumbnailPath: generatedImages.thumbnailPath,
          originalVideoPath: generatedImages.originalVideoPath,
          compressedVideoPath: generatedImages.compressedVideoPath,
          videoFrameTimestamp: generatedImages.videoFrameTimestamp,
          style: generatedImages.style,
          createdAt: generatedImages.createdAt,
          username: users.username,
          name: generatedImages.name,

          totalSupply: generatedImages.totalSupply,
          soldCount: generatedImages.soldCount,
          pricePerUnit: generatedImages.pricePerUnit,
        })
        .from(generatedImages)
        .innerJoin(users, eq(generatedImages.userId, users.email))
        .where(eq(generatedImages.isPublic, true))
        .orderBy(desc(generatedImages.createdAt))
        .limit(limit + 1) // Get one extra to check if there are more
        .offset(offset);
      
      // Check if there are more posts
      const hasMore = posts.length > limit;
      const actualPosts = hasMore ? posts.slice(0, limit) : posts;
      
      // Don't filter - include all public posts (with or without video)
      const allPosts = actualPosts;
      
      // Get like counts and check if current user has liked each post
      const { posterLikes } = await import('@shared/schema');
      const postsWithLikes = await Promise.all(
        allPosts.map(async (post) => {
          // Get like count
          const likeCountResult = await db
            .select({ count: sql<number>`count(*)` })
            .from(posterLikes)
            .where(eq(posterLikes.imageId, post.id));
          
          const likeCount = likeCountResult[0]?.count || 0;
          
          // Check if current user has liked
          let hasLiked = false;
          if (currentUserId) {
            const userLike = await db
              .select()
              .from(posterLikes)
              .where(and(
                eq(posterLikes.imageId, post.id),
                eq(posterLikes.userId, currentUserId)
              ))
              .limit(1);
            hasLiked = userLike.length > 0;
          }
          
          return {
            ...post,
            likeCount,
            hasLiked
          };
        })
      );
      
      res.json({
        posts: postsWithLikes,
        hasMore,
        page,
        totalReturned: postsWithLikes.length
      });
    } catch (error) {
      console.error('Error fetching feed:', error);
      res.status(500).json({ error: 'Failed to fetch feed' });
    }
  });

  // Subscription management routes
  
  // Get subscription information
  app.get('/api/subscription-info', requireAuth, async (req, res) => {
    try {
      const userEmail = (req as any).user.email;
      
      // Get user data from storage
      const user = await storage.getUserByEmail(userEmail);
      
      if (!user || user.userType !== 'artistic_collective') {
        return res.status(404).json({ 
          message: 'No subscription found',
          isActive: false 
        });
      }
      
      // If user has Stripe subscription ID, get details from Stripe
      if (user.subscriptionId) {
        try {
          const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
          const subscription = await stripe.subscriptions.retrieve(user.subscriptionId);
          
          return res.json({
            isActive: subscription.status === 'active',
            currentPeriodEnd: new Date((subscription as any).current_period_end * 1000).toISOString(),
            willCancelAtPeriodEnd: (subscription as any).cancel_at_period_end,
            status: subscription.status
          });
        } catch (stripeError) {
          console.error('Error fetching subscription from Stripe:', stripeError);
          // Fall back to database information
        }
      }
      
      // Fall back to database subscription information
      const subscriptionInfo = {
        isActive: user.subscriptionStatus === 'active' && 
                  (!user.subscriptionEndDate || new Date(user.subscriptionEndDate) > new Date()),
        currentPeriodEnd: user.subscriptionEndDate,
        willCancelAtPeriodEnd: false,
        status: user.subscriptionStatus || 'inactive'
      };
      
      res.json(subscriptionInfo);
    } catch (error) {
      console.error('Error fetching subscription info:', error);
      res.status(500).json({ 
        message: 'Failed to fetch subscription information' 
      });
    }
  });
  
  // Cancel subscription
  app.post('/api/cancel-subscription', requireAuth, async (req, res) => {
    try {
      const userEmail = (req as any).user.email;
      
      // Get user data from storage
      const user = await storage.getUserByEmail(userEmail);
      
      if (!user || user.userType !== 'artistic_collective') {
        return res.status(404).json({ 
          message: 'No active subscription found' 
        });
      }
      
      // If user has Stripe subscription ID, cancel it through Stripe
      if (user.subscriptionId) {
        try {
          const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
          
          // Immediately cancel the subscription
          const subscription = await stripe.subscriptions.cancel(user.subscriptionId);
          
          console.log(`Stripe subscription ${user.subscriptionId} immediately cancelled for user ${userEmail}`);
          
          // Update database to reflect immediate cancellation
          await storage.updateUser(user.id, {
            subscriptionStatus: 'canceled',
            userType: 'normal'
          });
          
          return res.json({
            success: true,
            message: 'Subscription cancelled successfully'
          });
        } catch (stripeError) {
          console.error('Error cancelling Stripe subscription:', stripeError);
          return res.status(500).json({ 
            message: 'Failed to cancel subscription through payment processor' 
          });
        }
      }
      
      // If no Stripe subscription, update database to mark for cancellation
      // For database-only subscriptions, we'll set the end date to the current period end
      try {
        await storage.updateUserSubscriptionStatus(userEmail, {
          subscriptionStatus: 'cancelled',
          userType: 'normal',
          // Keep the current end date so user retains access until then
        });
        
        console.log(`Database subscription cancelled for user ${userEmail}`);
        
        res.json({
          success: true,
          message: 'Subscription cancelled successfully',
          currentPeriodEnd: user.subscriptionEndDate
        });
      } catch (dbError) {
        console.error('Error updating subscription in database:', dbError);
        res.status(500).json({ 
          message: 'Failed to cancel subscription' 
        });
      }
    } catch (error) {
      console.error('Error cancelling subscription:', error);
      res.status(500).json({ 
        message: 'Failed to cancel subscription' 
      });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}
