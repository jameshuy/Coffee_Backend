import { Router, Request, Response } from 'express';
import { db } from './db';
import { generatedImages, users } from '@shared/schema';
import { desc, eq, sql, like } from 'drizzle-orm';
import { getImageUrl } from './services/object-storage';
import { verifyToken } from './auth-service';
import { storage } from './storage';
import { invalidateCache } from './db';
import NodeCache from 'node-cache';

export const catalogueRouter = Router();

// Cache for storing pre-signed URLs to reduce API calls to Object Storage
// TTL of 1 hour for each URL
const urlCache = new NodeCache({ stdTTL: 3600 });

/**
 * Middleware to authenticate any logged-in user
 */
async function requireAuthentication(req: Request, res: Response, next: Function) {
  try {
    const token = req.cookies?.auth_token;
    
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const decoded = verifyToken(token);
    if (!decoded) {
      return res.status(401).json({ error: 'Invalid token' });
    }
    
    // Verify user exists
    const userResults = await db.select().from(users).where(eq(users.email, decoded.email));
    if (userResults.length === 0) {
      return res.status(401).json({ error: 'User not found' });
    }
    
    const user = userResults[0];
    
    // Add user info to request for downstream use
    (req as any).user = user;
    next();
  } catch (error) {
    console.error('Authorization error:', error);
    return res.status(500).json({ error: 'Authorization failed' });
  }
}

/**
 * Middleware to authenticate admin users only
 */
async function requireAdminAuth(req: Request, res: Response, next: Function) {
  try {
    // Check for admin session token (set by admin login)
    const sessionToken = req.cookies?.adminSessionToken;
    
    if (!sessionToken) {
      return res.status(401).json({ error: 'Admin authentication required' });
    }
    
    // For admin routes, we validate the session token differently
    // The admin login sets adminSessionToken, not a JWT token
    // So we just check if the session exists for now
    // In production, this should validate against a session store
    
    next();
  } catch (error) {
    console.error('Admin authorization error:', error);
    return res.status(500).json({ error: 'Admin authorization failed' });
  }
}

/**
 * Update edition number (sold count) for admin control
 * @route PATCH /api/admin/images/:id/edition
 */
catalogueRouter.patch('/admin/images/:id/edition', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { soldCount } = req.body;

    if (typeof soldCount !== 'number' || soldCount < 0) {
      return res.status(400).json({ error: 'Invalid sold count value' });
    }

    // Get current image to check totalSupply
    const imageResults = await db
      .select()
      .from(generatedImages)
      .where(eq(generatedImages.id, id));

    if (imageResults.length === 0) {
      return res.status(404).json({ error: 'Image not found' });
    }

    const image = imageResults[0];
    const totalSupply = image.totalSupply || 10;

    // Ensure soldCount doesn't exceed totalSupply
    if (soldCount > totalSupply) {
      return res.status(400).json({ error: 'Sold count cannot exceed total supply' });
    }

    // Update the sold count
    await db
      .update(generatedImages)
      .set({ soldCount })
      .where(eq(generatedImages.id, id));

    // Note: Cache invalidation removed to avoid errors - admin changes are less frequent

    res.json({ 
      success: true, 
      soldCount,
      editionNumber: soldCount + 1,
      remainingSupply: totalSupply - soldCount
    });

  } catch (error) {
    console.error('Error updating edition number:', error);
    res.status(500).json({ error: 'Failed to update edition number' });
  }
});

/**
 * Get all public images with pagination
 * @route GET /api/public-images
 */
catalogueRouter.get('/public-images', async (req: Request, res: Response) => {
  try {
    // Parse pagination parameters
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = parseInt(req.query.offset as string) || 0;
    const search = req.query.search as string;

    // Fetch public images from the database including thumbnail paths and user info
    let publicImages;
    let count;
    
    if (search && search.trim()) {
      // Query with search filter
      publicImages = await db.select({
        id: generatedImages.id,
        name: generatedImages.name,
        generatedPath: generatedImages.generatedPath,
        thumbnailPath: generatedImages.thumbnailPath,
        originalPath: generatedImages.originalPath,
        style: generatedImages.style,
        createdAt: generatedImages.createdAt,
        userId: generatedImages.userId,
        username: users.username,
        
        totalSupply: generatedImages.totalSupply,
        soldCount: generatedImages.soldCount,
        pricePerUnit: generatedImages.pricePerUnit,
        momentLink: generatedImages.momentLink,
      })
      .from(generatedImages)
      .leftJoin(users, eq(generatedImages.userId, users.email))
      .where(sql`${generatedImages.isPublic} = true AND (${users.username} ILIKE ${'%' + search.trim() + '%'} OR ${generatedImages.name} ILIKE ${'%' + search.trim() + '%'})`)
      .orderBy(desc(generatedImages.createdAt))
      .limit(limit)
      .offset(offset);

      // Count with search filter
      const countResult = await db
        .select({ count: sql<number>`count(*)` })
        .from(generatedImages)
        .leftJoin(users, eq(generatedImages.userId, users.email))
        .where(sql`${generatedImages.isPublic} = true AND (${users.username} ILIKE ${'%' + search.trim() + '%'} OR ${generatedImages.name} ILIKE ${'%' + search.trim() + '%'})`);
      count = countResult[0].count;
    } else {
      // Query without search filter
      publicImages = await db.select({
        id: generatedImages.id,
        name: generatedImages.name,
        generatedPath: generatedImages.generatedPath,
        thumbnailPath: generatedImages.thumbnailPath,
        originalPath: generatedImages.originalPath,
        style: generatedImages.style,
        createdAt: generatedImages.createdAt,
        userId: generatedImages.userId,
        username: users.username,
        
        totalSupply: generatedImages.totalSupply,
        soldCount: generatedImages.soldCount,
        pricePerUnit: generatedImages.pricePerUnit,
        momentLink: generatedImages.momentLink,
      })
      .from(generatedImages)
      .leftJoin(users, eq(generatedImages.userId, users.email))
      .where(eq(generatedImages.isPublic, true))
      .orderBy(desc(generatedImages.createdAt))
      .limit(limit)
      .offset(offset);

      // Count without search filter
      const countResult = await db
        .select({ count: sql<number>`count(*)` })
        .from(generatedImages)
        .where(eq(generatedImages.isPublic, true));
      count = countResult[0].count;
    }

    // Filter out images without thumbnails and generate URLs for thumbnails only
    const imagesWithThumbnails = publicImages.filter(image => image.thumbnailPath);
    
    const imagesWithUrls = await Promise.all(
      imagesWithThumbnails.map(async (image) => {
        // Use only thumbnails for catalogue display - no fallback to full images
        const imagePath = image.thumbnailPath!; // We know this exists due to filter
        const fullImagePath = image.generatedPath;
        
        // Check cache first for thumbnail
        const cacheKey = `image_url_${imagePath}`;
        let imageUrl = urlCache.get(cacheKey) as string;
        
        if (!imageUrl) {
          // Generate a new URL if not cached
          imageUrl = await getImageUrl(imagePath);
          urlCache.set(cacheKey, imageUrl);
        }

        // Also cache the full image URL for modal display
        const fullCacheKey = `image_url_${fullImagePath}`;
        let fullImageUrl = urlCache.get(fullCacheKey) as string;
        
        if (!fullImageUrl) {
          fullImageUrl = await getImageUrl(fullImagePath);
          urlCache.set(fullCacheKey, fullImageUrl);
        }

        return {
          ...image,
          imageUrl, // This will be the thumbnail for grid display
          fullImageUrl, // This will be the full resolution for modal
          usingThumbnail: !!image.thumbnailPath, // Flag to indicate if we're using thumbnails
          // Supply and availability information (all posters are limited edition)
          totalSupply: image.totalSupply || 10, // Default to 10 if not set
          soldCount: image.soldCount || 0,
          pricePerUnit: image.pricePerUnit || 29.95,
          remainingSupply: Math.max(0, (image.totalSupply || 10) - (image.soldCount || 0)),
          isAvailable: (image.totalSupply || 10) > (image.soldCount || 0),
          momentLink: image.momentLink // Include moment link for social icon
        };
      })
    );

    res.json({
      images: imagesWithUrls,
      pagination: {
        total: count,
        limit,
        offset,
        hasMore: offset + limit < count
      }
    });
  } catch (error) {
    console.error('Error fetching public images:', error);
    res.status(500).json({ error: 'Failed to retrieve public images' });
  }
});

/**
 * Admin endpoint: Get all public images with full resolution (not thumbnails)
 * @route GET /api/admin/catalogue
 */
catalogueRouter.get('/admin/catalogue', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    // Parse pagination parameters
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = parseInt(req.query.offset as string) || 0;
    const search = req.query.search as string;

    // Fetch public images from the database
    let publicImages;
    let count;
    
    if (search && search.trim()) {
      // Query with search filter
      publicImages = await db.select({
        id: generatedImages.id,
        name: generatedImages.name,
        generatedPath: generatedImages.generatedPath,
        thumbnailPath: generatedImages.thumbnailPath,
        originalPath: generatedImages.originalPath,
        style: generatedImages.style,
        createdAt: generatedImages.createdAt,
        userId: generatedImages.userId,
        username: users.username,
        
        totalSupply: generatedImages.totalSupply,
        soldCount: generatedImages.soldCount,
        pricePerUnit: generatedImages.pricePerUnit,
        momentLink: generatedImages.momentLink,
      })
      .from(generatedImages)
      .leftJoin(users, eq(generatedImages.userId, users.email))
      .where(sql`${generatedImages.isPublic} = true AND (${users.username} ILIKE ${'%' + search.trim() + '%'} OR ${generatedImages.name} ILIKE ${'%' + search.trim() + '%'})`)
      .orderBy(desc(generatedImages.createdAt))
      .limit(limit)
      .offset(offset);

      // Count with search filter
      const countResult = await db
        .select({ count: sql<number>`count(*)` })
        .from(generatedImages)
        .leftJoin(users, eq(generatedImages.userId, users.email))
        .where(sql`${generatedImages.isPublic} = true AND (${users.username} ILIKE ${'%' + search.trim() + '%'} OR ${generatedImages.name} ILIKE ${'%' + search.trim() + '%'})`);
      count = countResult[0].count;
    } else {
      // Query without search filter
      publicImages = await db.select({
        id: generatedImages.id,
        name: generatedImages.name,
        generatedPath: generatedImages.generatedPath,
        thumbnailPath: generatedImages.thumbnailPath,
        originalPath: generatedImages.originalPath,
        style: generatedImages.style,
        createdAt: generatedImages.createdAt,
        userId: generatedImages.userId,
        username: users.username,
        
        totalSupply: generatedImages.totalSupply,
        soldCount: generatedImages.soldCount,
        pricePerUnit: generatedImages.pricePerUnit,
        momentLink: generatedImages.momentLink,
      })
      .from(generatedImages)
      .leftJoin(users, eq(generatedImages.userId, users.email))
      .where(eq(generatedImages.isPublic, true))
      .orderBy(desc(generatedImages.createdAt))
      .limit(limit)
      .offset(offset);

      // Count without search filter
      const countResult = await db
        .select({ count: sql<number>`count(*)` })
        .from(generatedImages)
        .where(eq(generatedImages.isPublic, true));
      count = countResult[0].count;
    }

    // Generate URLs for FULL IMAGES (not thumbnails) - key difference from regular catalogue
    const imagesWithUrls = await Promise.all(
      publicImages.map(async (image) => {
        // Use generated path (full resolution) instead of thumbnail path
        const imagePath = image.generatedPath;
        
        // Check cache first for full image
        const cacheKey = `image_url_${imagePath}`;
        let imageUrl = urlCache.get(cacheKey) as string;
        
        if (!imageUrl) {
          // Generate a new URL if not cached
          imageUrl = await getImageUrl(imagePath);
          urlCache.set(cacheKey, imageUrl);
        }

        // For admin view, both imageUrl and fullImageUrl point to the full resolution
        return {
          ...image,
          imageUrl, // Full resolution for grid display (admin view)
          fullImageUrl: imageUrl, // Same full resolution for modal
          usingThumbnail: false, // Admin view always uses full images
          // Supply and availability information (all posters are limited edition)
          totalSupply: image.totalSupply || 10, // Default to 10 if not set
          soldCount: image.soldCount || 0,
          pricePerUnit: image.pricePerUnit || 29.95,
          remainingSupply: Math.max(0, (image.totalSupply || 10) - (image.soldCount || 0)),
          isAvailable: (image.totalSupply || 10) > (image.soldCount || 0),
          momentLink: image.momentLink // Include moment link for social icon
        };
      })
    );

    res.json({
      images: imagesWithUrls,
      pagination: {
        total: count,
        limit,
        offset,
        hasMore: offset + limit < count
      }
    });
  } catch (error) {
    console.error('Error fetching admin catalogue:', error);
    res.status(500).json({ error: 'Failed to retrieve admin catalogue' });
  }
});

/**
 * Set an image's public status (available to all authenticated users)
 * @route PATCH /api/images/:id/public
 */
catalogueRouter.patch('/images/:id/public', requireAuthentication, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { isPublic, totalSupply, pricePerUnit, name, momentLink, city } = req.body;
    const user = (req as any).user;

    if (typeof isPublic !== 'boolean') {
      return res.status(400).json({ error: 'Invalid request body, isPublic must be a boolean' });
    }

    // Validate supply and pricing fields if poster is being published
    if (isPublic) {
      if (!totalSupply || totalSupply < 1 || totalSupply > 1000) {
        return res.status(400).json({ error: 'Posters must have totalSupply between 1 and 1000' });
      }
      if (!pricePerUnit || pricePerUnit < 29.95) {
        return res.status(400).json({ error: 'Posters must have pricePerUnit of at least 29.95 CHF' });
      }
    }

    // Verify the image belongs to the user making the request
    const imageResults = await db
      .select()
      .from(generatedImages)
      .where(eq(generatedImages.id, id));

    if (imageResults.length === 0) {
      return res.status(404).json({ error: 'Image not found' });
    }

    const image = imageResults[0];
    if (image.userId !== user.email) {
      return res.status(403).json({ error: 'You can only modify your own images' });
    }

    // Check user's poster selling eligibility when trying to publish
    if (isPublic) {
      // Check subscription status
      const isSubscribed = user.userType === 'artistic_collective' && 
                          user.subscriptionStatus === 'active' &&
                          (!user.subscriptionEndDate || new Date(user.subscriptionEndDate) > new Date());
      
      // Check if user has already used both their free poster sales
      const postersForSale = user.postersForSale || 0;
      
      if (!isSubscribed && postersForSale >= 2) {
        return res.status(403).json({ 
          error: 'You have already used both your free poster sales. Upgrade to Artistic Collective membership for unlimited poster sales.',
          needsSubscription: true
        });
      }
    }

    // Check if this image already has purchases - if so, prevent changes to supply/pricing
    if (image.isPublic && image.soldCount && image.soldCount > 0) {
      if (totalSupply !== image.totalSupply || pricePerUnit !== image.pricePerUnit) {
        return res.status(400).json({ error: 'Cannot change supply or pricing settings after sales have been made' });
      }
    }

    // Prepare update data
    const updateData: any = { isPublic };
    
    // Always update name if provided
    if (name !== undefined) {
      updateData.name = name;
    }
    
    // Always update momentLink if provided (can be null to clear it)
    if (momentLink !== undefined) {
      updateData.momentLink = momentLink;
    }
    
    // Always update city if provided
    if (city !== undefined) {
      updateData.city = city;
    }
    
    if (isPublic) {
      updateData.editionPricingType = 'flat';
      updateData.totalSupply = totalSupply;
      updateData.pricePerUnit = pricePerUnit;
    }

    // Use database transaction to ensure atomicity
    let posterCountChanged = false;
    await db.transaction(async (tx) => {
      // Update the image
      await tx
        .update(generatedImages)
        .set(updateData)
        .where(eq(generatedImages.id, id));

      // Check subscription status
      const isSubscribed = user.userType === 'artistic_collective' && 
                          user.subscriptionStatus === 'active' &&
                          (!user.subscriptionEndDate || new Date(user.subscriptionEndDate) > new Date());
      
      // Only track poster count for non-subscribed users (subscribed users have unlimited)
      if (!isSubscribed) {
        // If publishing a poster for the first time, increment user's poster count
        if (isPublic && !image.isPublic) {
          console.log(`Incrementing poster count for user ${user.email} - publishing image ${id}`);
          await tx
            .update(users)
            .set({ postersForSale: sql`${users.postersForSale} + 1` })
            .where(eq(users.email, user.email));
          posterCountChanged = true;
        }
        // If unpublishing a poster, decrement user's poster count
        else if (!isPublic && image.isPublic) {
          console.log(`Decrementing poster count for user ${user.email} - unpublishing image ${id}`);
          await tx
            .update(users)
            .set({ postersForSale: sql`GREATEST(0, ${users.postersForSale} - 1)` })
            .where(eq(users.email, user.email));
          posterCountChanged = true;
        }
      }
    });

    // Invalidate user cache after successful transaction if poster count changed
    if (posterCountChanged) {
      invalidateCache(`user:${user.email}`);
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating image public status:', error);
    res.status(500).json({ error: 'Failed to update image public status' });
  }
});

/**
 * Get real-time availability for a specific image
 * @route GET /api/images/:id/availability
 */
catalogueRouter.get('/images/:id/availability', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Get image details with user info
    const imageResults = await db
      .select({
        id: generatedImages.id,
        name: generatedImages.name,
        generatedPath: generatedImages.generatedPath,
        thumbnailPath: generatedImages.thumbnailPath,
        style: generatedImages.style,
        createdAt: generatedImages.createdAt,
        userId: generatedImages.userId,
        username: users.username,
        
        totalSupply: generatedImages.totalSupply,
        soldCount: generatedImages.soldCount,
        pricePerUnit: generatedImages.pricePerUnit,
        momentLink: generatedImages.momentLink,
        isPublic: generatedImages.isPublic,
      })
      .from(generatedImages)
      .leftJoin(users, eq(generatedImages.userId, users.email))
      .where(eq(generatedImages.id, id));

    if (imageResults.length === 0) {
      return res.status(404).json({ error: 'Image not found' });
    }

    const image = imageResults[0];

    // If image is not public, it's not available for purchase
    if (!image.isPublic) {
      return res.status(403).json({ error: 'Image is not available for purchase' });
    }

    // Generate URLs for thumbnail and full image
    let imageUrl = '';
    let fullImageUrl = '';
    
    if (image.thumbnailPath) {
      // Check cache first for thumbnail
      const cacheKey = `image_url_${image.thumbnailPath}`;
      imageUrl = urlCache.get(cacheKey) as string;
      
      if (!imageUrl) {
        // Generate a new URL if not cached
        imageUrl = await getImageUrl(image.thumbnailPath);
        urlCache.set(cacheKey, imageUrl);
      }
    }
    
    // Always get full image URL
    const fullCacheKey = `image_url_${image.generatedPath}`;
    fullImageUrl = urlCache.get(fullCacheKey) as string;
    
    if (!fullImageUrl) {
      fullImageUrl = await getImageUrl(image.generatedPath);
      urlCache.set(fullCacheKey, fullImageUrl);
    }

    // Calculate availability (all posters are limited edition)
    const soldCount = image.soldCount || 0;
    const totalSupply = image.totalSupply || 10; // Default to 10 if not set

    const remainingSupply = Math.max(0, totalSupply - soldCount);
    const available = remainingSupply > 0;

    res.json({
      id: image.id,
      name: image.name,
      generatedPath: image.generatedPath,
      style: image.style,
      createdAt: image.createdAt,
      imageUrl: imageUrl || fullImageUrl, // Use thumbnail if available, otherwise full image
      fullImageUrl,
      usingThumbnail: !!image.thumbnailPath,
      username: image.username,
      totalSupply,
      soldCount,
      remainingSupply,
      available,
      pricePerUnit: image.pricePerUnit || 29.95,
      nextEditionNumber: available ? soldCount + 1 : null,
      momentLink: image.momentLink,
      isAvailable: available
    });

  } catch (error) {
    console.error('Error checking image availability:', error);
    res.status(500).json({ error: 'Failed to check image availability' });
  }
});

/**
 * Purchase a poster with atomic edition assignment for limited editions
 * @route POST /api/purchase-poster
 */
catalogueRouter.post('/purchase-poster', requireAuthentication, async (req: Request, res: Response) => {
  try {
    const { imageId, shippingData } = req.body;
    const user = (req as any).user;

    if (!imageId || !shippingData) {
      return res.status(400).json({ error: 'Image ID and shipping data are required' });
    }

    // Validate required shipping fields
    const requiredFields = ['firstName', 'lastName', 'email', 'address', 'city', 'state', 'zipCode', 'country'];
    for (const field of requiredFields) {
      if (!shippingData[field]) {
        return res.status(400).json({ error: `Missing required field: ${field}` });
      }
    }

    // Use database transaction to ensure atomic operation
    return await db.transaction(async (tx) => {
      // Get current image state within transaction
      const imageResults = await tx
        .select()
        .from(generatedImages)
        .where(eq(generatedImages.id, imageId));

      if (imageResults.length === 0) {
        throw new Error('Image not found');
      }

      const image = imageResults[0];

      if (!image.isPublic) {
        throw new Error('Image is not available for purchase');
      }

      // Check availability (all posters are limited editions)
      const soldCount = image.soldCount || 0;
      const totalSupply = image.totalSupply || 10; // Default to 10 if not set

      if (soldCount >= totalSupply) {
        throw new Error('This limited edition is sold out');
      }

      // Calculate edition number and price
      const editionNumber = (image.soldCount || 0) + 1;
      const pricePerUnit = image.pricePerUnit || 29.95;

      // Create poster purchase record
      const posterPurchase = await storage.createPosterPurchase({
        userEmail: user.email,
        imageId: imageId,
        editionNumber: editionNumber,
        purchaseDate: new Date(),
        amountPaid: pricePerUnit
      });

      // Update sold count in image record
      await tx
        .update(generatedImages)
        .set({ soldCount: editionNumber })
        .where(eq(generatedImages.id, imageId));

      // Create traditional order record for fulfillment
      const confirmationId = `LED-${Math.floor(100000 + Math.random() * 900000)}`;
      
      const orderData = {
        firstName: shippingData.firstName,
        lastName: shippingData.lastName,
        email: shippingData.email,
        address: shippingData.address,
        city: shippingData.city,
        state: shippingData.state,
        zipCode: shippingData.zipCode,
        country: shippingData.country,
        confirmationId: confirmationId,
        quantity: 1,
        amount: pricePerUnit,
        posterImageUrl: `/api/storage-image/${image.generatedPath}`,
        originalImageUrl: image.originalPath,
        style: `${image.style} - Limited Edition #${editionNumber}${image.totalSupply ? `/${image.totalSupply}` : ''}`,
        status: 'paid'
      };

      await storage.createOrder(orderData);

      return res.json({
        success: true,
        message: 'Purchase completed successfully',
        confirmationId: confirmationId,
        editionNumber: editionNumber,
        totalSupply: image.totalSupply,
        amountPaid: pricePerUnit,
        purchaseId: posterPurchase.id
      });
    });

  } catch (error) {
    console.error('Error processing poster purchase:', error);
    res.status(500).json({ 
      error: error instanceof Error ? error.message : 'Failed to process purchase' 
    });
  }
});

catalogueRouter.get('/admin/pending-review', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    // Parse pagination parameters
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = parseInt(req.query.offset as string) || 0;

    // Fetch images that are public but not yet approved
    const pendingImages = await db.select({
      id: generatedImages.id,
      name: generatedImages.name,
      generatedPath: generatedImages.generatedPath,
      thumbnailPath: generatedImages.thumbnailPath,
      originalPath: generatedImages.originalPath,
      style: generatedImages.style,
      createdAt: generatedImages.createdAt,
      userId: generatedImages.userId,
      username: users.username,
      
      totalSupply: generatedImages.totalSupply,
      soldCount: generatedImages.soldCount,
      pricePerUnit: generatedImages.pricePerUnit,
      momentLink: generatedImages.momentLink,
      city: generatedImages.city,
    })
    .from(generatedImages)
    .leftJoin(users, eq(generatedImages.userId, users.email))
    .where(sql`${generatedImages.isPublic} = true AND ${generatedImages.isApproved} = false`)
    .orderBy(desc(generatedImages.createdAt))
    .limit(limit)
    .offset(offset);

    // Count total pending
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(generatedImages)
      .where(sql`${generatedImages.isPublic} = true AND ${generatedImages.isApproved} = false`);
    const count = countResult[0].count;

    // Generate URLs for full images (admin view always uses full resolution)
    const imagesWithUrls = await Promise.all(
      pendingImages.map(async (image) => {
        const imagePath = image.generatedPath;
        
        // Check cache first
        const cacheKey = `image_url_${imagePath}`;
        let imageUrl = urlCache.get(cacheKey) as string;
        
        if (!imageUrl) {
          imageUrl = await getImageUrl(imagePath);
          urlCache.set(cacheKey, imageUrl);
        }

        return {
          ...image,
          imageUrl, // Full resolution for admin view
          fullImageUrl: imageUrl,
          usingThumbnail: false,
          totalSupply: image.totalSupply || 10,
          soldCount: image.soldCount || 0,
          pricePerUnit: image.pricePerUnit || 29.95,
          remainingSupply: Math.max(0, (image.totalSupply || 10) - (image.soldCount || 0)),
          isAvailable: (image.totalSupply || 10) > (image.soldCount || 0),
        };
      })
    );

    res.json({
      images: imagesWithUrls,
      pagination: {
        total: count,
        limit,
        offset,
        hasMore: offset + limit < count
      }
    });
  } catch (error) {
    console.error('Error fetching pending review images:', error);
    res.status(500).json({ error: 'Failed to retrieve pending review images' });
  }
});

catalogueRouter.patch('/admin/images/:id/approve', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Update the image to be approved
    const result = await db
      .update(generatedImages)
      .set({ isApproved: true })
      .where(eq(generatedImages.id, id))
      .returning();

    if (result.length === 0) {
      return res.status(404).json({ error: 'Image not found' });
    }

    res.json({ 
      success: true, 
      message: 'Poster approved and added to catalogue'
    });

  } catch (error) {
    console.error('Error approving poster:', error);
    res.status(500).json({ error: 'Failed to approve poster' });
  }
});

catalogueRouter.patch('/admin/images/:id/reject', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Set the image as not public (rejected)
    const result = await db
      .update(generatedImages)
      .set({ isPublic: false, isApproved: false })
      .where(eq(generatedImages.id, id))
      .returning();

    if (result.length === 0) {
      return res.status(404).json({ error: 'Image not found' });
    }

    res.json({ 
      success: true, 
      message: 'Poster rejected and removed from review queue'
    });

  } catch (error) {
    console.error('Error rejecting poster:', error);
    res.status(500).json({ error: 'Failed to reject poster' });
  }
});