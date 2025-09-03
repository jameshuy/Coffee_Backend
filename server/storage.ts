import { 
  orders, 
  type Order, 
  type InsertOrder, 
  generationCredits, 
  type GenerationCredits, 
  type InsertGenerationCredits,
  catalogueOrders,
  catalogueOrderItems,
  type CatalogueOrder,
  type InsertCatalogueOrder,
  type CatalogueOrderItem,
  type InsertCatalogueOrderItem,
  users,
  type User,
  type InsertUser,
  generatedImages,
  type GeneratedImage,
  type InsertGeneratedImage,
  posterPurchases,
  type PosterPurchase,
  type InsertPosterPurchase
} from "@shared/schema";
import { db, executeWithRetry, cachedQuery, invalidateCache, withConnection } from "./db";
import { eq } from "drizzle-orm";

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

// modify the interface with any CRUD methods
// you might need

export interface IStorage {
  // Order management methods
  createOrder(order: InsertOrder): Promise<Order>;
  getOrders(): Promise<Order[]>;
  getOrderById(id: number): Promise<Order | undefined>;
  updateOrderStatus(id: number, status: string): Promise<boolean>;
  generateConfirmationId(): string;

  // Catalogue order management methods
  createCatalogueOrder(order: InsertCatalogueOrder, items: InsertCatalogueOrderItem[]): Promise<CatalogueOrder>;
  getCatalogueOrders(): Promise<CatalogueOrder[]>;
  getCatalogueOrderById(id: number): Promise<{order: CatalogueOrder, items: CatalogueOrderItem[]} | undefined>;
  updateCatalogueOrderStatus(id: number, status: string): Promise<boolean>;
  generateCatalogueConfirmationId(): string;

  // Generation credits methods
  getGenerationCreditsByEmail(email: string): Promise<GenerationCredits | undefined>;
  createGenerationCredits(credits: InsertGenerationCredits): Promise<GenerationCredits>;
  updateGenerationCredits(id: number, updates: Partial<GenerationCredits>): Promise<GenerationCredits | undefined>;
  incrementFreeCreditsUsed(email: string): Promise<boolean>;
  decrementPaidCredits(email: string): Promise<boolean>;
  addPaidCredits(email: string, creditsToAdd: number): Promise<boolean>;
  verifyEmail(email: string, token: string): Promise<boolean>;
  generateVerificationCode(): string;
  
  // User account methods
  getUserByEmail(email: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(userData: InsertUser): Promise<User>;
  updateUser(id: number, updates: Partial<User>): Promise<User | undefined>;
  updateUserSubscriptionStatus(email: string, updates: Partial<User>): Promise<boolean>;

  // Generated images and limited editions methods
  getGeneratedImageById(id: string): Promise<GeneratedImage | undefined>;
  updateGeneratedImage(id: string, updates: Partial<GeneratedImage>): Promise<GeneratedImage | undefined>;
  createPosterPurchase(purchase: InsertPosterPurchase): Promise<PosterPurchase>;
  getPosterPurchasesByImageId(imageId: string): Promise<PosterPurchase[]>;
  getNextEditionNumber(imageId: string): Promise<number>;
  checkImageAvailability(imageId: string): Promise<{ available: boolean; remainingSupply: number }>;
}

// Generate a unique confirmation ID with SIN- prefix for single orders
function generateConfirmationId(): string {
  const randomNum = Math.floor(100000 + Math.random() * 900000); // 6-digit number
  return `SIN-${randomNum}`;
}

// Generate a unique confirmation ID with CAT- prefix for catalogue orders
function generateCatalogueConfirmationId(): string {
  const randomNum = Math.floor(100000 + Math.random() * 900000); // 6-digit number
  return `CAT-${randomNum}`;
}

export class DatabaseStorage implements IStorage {
  
  async updateUserSubscriptionStatus(email: string, updates: Partial<User>): Promise<boolean> {
    try {
      const updatesWithTimestamp = {
        ...updates,
        updatedAt: new Date()
      };
      
      const result = await executeWithRetry(async () => {
        return db.update(users)
          .set(updatesWithTimestamp)
          .where(eq(users.email, email))
          .returning();
      });
      
      // Invalidate cache for this user
      invalidateCache(`user:${email}`);
      
      return result.length > 0;
    } catch (error) {
      console.error('Error updating user subscription status:', error);
      return false;
    }
  }

  // Catalogue Order Methods
  async createCatalogueOrder(insertOrder: InsertCatalogueOrder, items: InsertCatalogueOrderItem[]): Promise<CatalogueOrder> {
    try {
      // Add createdAt timestamp and ensure all optional fields have defaults
      const orderWithTimestamp = {
        ...insertOrder,
        // Default values for optional fields
        status: insertOrder.status || "pending",
        quantity: items.length,
        amount: insertOrder.amount || (items.length * 29.95),
        createdAt: getZurichTimestamp()
      };
      
      // Start a transaction
      return await withConnection(async (client) => {
        // Insert the catalogue order
        const [order] = await db.insert(catalogueOrders)
                              .values(orderWithTimestamp)
                              .returning();
        
        // Insert all items with the order ID
        if (items.length > 0) {
          const itemsWithOrderId = items.map(item => ({
            ...item,
            orderId: order.id,
            price: item.price || 29.95
          }));
          
          await db.insert(catalogueOrderItems)
                .values(itemsWithOrderId);
        }
        
        // Invalidate catalogue orders list cache
        invalidateCache('catalogue-orders:list');
        
        return order;
      });
    } catch (error) {
      console.error('Error creating catalogue order:', error);
      throw error; // Rethrow as this is a critical operation
    }
  }
  
  async getCatalogueOrders(): Promise<CatalogueOrder[]> {
    try {
      // Cache catalogue orders list for 1 minute
      return await cachedQuery(
        'catalogue-orders:list', 
        async () => {
          return executeWithRetry(async () => {
            return db.select().from(catalogueOrders);
          });
        },
        60 // 1 minute TTL
      );
    } catch (error) {
      console.error('Error fetching catalogue orders:', error);
      return [];
    }
  }
  
  async getCatalogueOrderById(id: number): Promise<{order: CatalogueOrder, items: CatalogueOrderItem[]} | undefined> {
    try {
      // Cache individual catalogue order lookups for 1 minute
      return await cachedQuery(
        `catalogue-order:${id}`,
        async () => {
          const [order] = await executeWithRetry(async () => {
            return db.select().from(catalogueOrders).where(eq(catalogueOrders.id, id));
          });
          
          if (!order) {
            return undefined;
          }
          
          const items = await executeWithRetry(async () => {
            return db.select().from(catalogueOrderItems).where(eq(catalogueOrderItems.orderId, id));
          });
          
          return { order, items };
        },
        60 // 1 minute TTL
      );
    } catch (error) {
      console.error(`Error fetching catalogue order with ID ${id}:`, error);
      return undefined;
    }
  }
  
  async updateCatalogueOrderStatus(id: number, status: string): Promise<boolean> {
    try {
      const result = await executeWithRetry(async () => {
        return db.update(catalogueOrders)
                .set({ status })
                .where(eq(catalogueOrders.id, id))
                .returning({ id: catalogueOrders.id });
      });
      
      if (result.length === 0) {
        return false;
      }
      
      // Invalidate related caches
      invalidateCache(`catalogue-order:${id}`);
      invalidateCache('catalogue-orders:list');
      
      return true;
    } catch (error) {
      console.error(`Error updating catalogue order status for ID ${id}:`, error);
      return false;
    }
  }
  
  generateCatalogueConfirmationId(): string {
    return generateCatalogueConfirmationId();
  }

  async createOrder(insertOrder: InsertOrder): Promise<Order> {
    try {
      // Add createdAt timestamp and ensure all optional fields have defaults
      const orderWithTimestamp = {
        ...insertOrder,
        // Default values for optional fields
        posterImageUrl: insertOrder.posterImageUrl || null,
        originalImageUrl: insertOrder.originalImageUrl || null,
        style: insertOrder.style || "standard",
        status: insertOrder.status || "pending",
        quantity: insertOrder.quantity || 1,
        amount: insertOrder.amount || 29.95,
        createdAt: getZurichTimestamp()
      };
      
      const result = await executeWithRetry(async () => {
        return db.insert(orders).values(orderWithTimestamp).returning();
      });
      
      // Invalidate orders list cache
      invalidateCache('orders:list');
      
      return result[0];
    } catch (error) {
      console.error('Error creating order:', error);
      throw error; // Rethrow as this is a critical operation
    }
  }

  async getOrders(): Promise<Order[]> {
    try {
      // Cache orders list for 1 minute
      return await cachedQuery(
        'orders:list', 
        async () => {
          return executeWithRetry(async () => {
            return db.select().from(orders);
          });
        },
        60 // 1 minute TTL
      );
    } catch (error) {
      console.error('Error fetching orders:', error);
      return [];
    }
  }
  
  async getOrderById(id: number): Promise<Order | undefined> {
    try {
      // Cache individual order lookups for 1 minute
      return await cachedQuery(
        `order:${id}`,
        async () => {
          const result = await executeWithRetry(async () => {
            return db.select().from(orders).where(eq(orders.id, id));
          });
          return result[0];
        },
        60 // 1 minute TTL
      );
    } catch (error) {
      console.error('Error fetching order by ID:', error);
      return undefined;
    }
  }
  
  async updateOrderStatus(id: number, status: string): Promise<boolean> {
    try {
      const result = await executeWithRetry(async () => {
        return db.update(orders)
          .set({ status })
          .where(eq(orders.id, id))
          .returning();
      });
      
      // Invalidate caches
      invalidateCache(`order:${id}`);
      invalidateCache('orders:list');
      
      return result.length > 0;
    } catch (error) {
      console.error('Error updating order status:', error);
      return false;
    }
  }

  // Expose the confirmation ID generator for use in controllers
  generateConfirmationId(): string {
    return generateConfirmationId();
  }

  // Generation credits methods
  async getGenerationCreditsByEmail(email: string): Promise<GenerationCredits | undefined> {
    // Use cached query for frequently accessed read operation
    // Cache for 1 minute (60 seconds) since credits change frequently
    return cachedQuery(
      `credits:${email}`,
      async () => {
        const result = await executeWithRetry(async () => {
          return db.select().from(generationCredits).where(eq(generationCredits.email, email));
        });
        return result[0];
      },
      60 // 1 minute TTL
    );
  }

  async createGenerationCredits(credits: InsertGenerationCredits): Promise<GenerationCredits> {
    try {
      const result = await executeWithRetry(async () => {
        return db.insert(generationCredits).values(credits).returning();
      });
      
      // Invalidate any existing cache for this email
      invalidateCache(`credits:${credits.email}`);
      
      return result[0];
    } catch (error) {
      console.error('Error creating generation credits:', error);
      throw error; // Rethrow as this is a critical operation
    }
  }

  async updateGenerationCredits(id: number, updates: Partial<GenerationCredits>): Promise<GenerationCredits | undefined> {
    try {
      const result = await executeWithRetry(async () => {
        return db.update(generationCredits)
          .set(updates)
          .where(eq(generationCredits.id, id))
          .returning();
      });
      
      // Find the user record to invalidate cache properly
      const updated = result[0];
      if (updated && updated.email) {
        invalidateCache(`credits:${updated.email}`);
      }
      
      return result[0];
    } catch (error) {
      console.error('Error updating generation credits:', error);
      return undefined;
    }
  }

  async incrementFreeCreditsUsed(email: string): Promise<boolean> {
    try {
      // Execute with retry for connection resilience
      return await executeWithRetry(async () => {
        const user = await this.getGenerationCreditsByEmail(email);
        if (!user) return false;

        const currentCredits = user.freeCreditsUsed || 0;
        
        await db.update(generationCredits)
          .set({ 
            freeCreditsUsed: currentCredits + 1,
            lastGeneratedAt: new Date()
          })
          .where(eq(generationCredits.email, email));
        
        // Invalidate the cache for this user
        invalidateCache(`credits:${email}`);
        
        return true;
      });
    } catch (error) {
      console.error('Error incrementing free credits:', error);
      return false;
    }
  }

  async decrementPaidCredits(email: string): Promise<boolean> {
    try {
      // Execute with retry for connection resilience
      return await executeWithRetry(async () => {
        const user = await this.getGenerationCreditsByEmail(email);
        if (!user) return false;
        
        const currentCredits = user.paidCredits || 0;
        if (currentCredits < 1) return false;

        await db.update(generationCredits)
          .set({ 
            paidCredits: currentCredits - 1,
            lastGeneratedAt: new Date()
          })
          .where(eq(generationCredits.email, email));
          
        // Invalidate the cache for this user
        invalidateCache(`credits:${email}`);
        
        return true;
      });
    } catch (error) {
      console.error('Error decrementing paid credits:', error);
      return false;
    }
  }

  async addPaidCredits(email: string, creditsToAdd: number): Promise<boolean> {
    try {
      // Execute with retry for connection resilience
      return await executeWithRetry(async () => {
        const user = await this.getGenerationCreditsByEmail(email);
        if (!user) return false;

        const currentCredits = user.paidCredits || 0;
        
        await db.update(generationCredits)
          .set({ paidCredits: currentCredits + creditsToAdd })
          .where(eq(generationCredits.email, email));
        
        // Invalidate the cache for this user
        invalidateCache(`credits:${email}`);
        
        return true;
      });
    } catch (error) {
      console.error('Error adding paid credits:', error);
      return false;
    }
  }

  async verifyEmail(email: string, token: string): Promise<boolean> {
    try {
      // Execute with retry for connection resilience
      return await executeWithRetry(async () => {
        const user = await this.getGenerationCreditsByEmail(email);
        if (!user || user.verificationCode !== token) return false;

        await db.update(generationCredits)
          .set({ verified: true })
          .where(eq(generationCredits.email, email));
        
        // Invalidate the cache for this user
        invalidateCache(`credits:${email}`);
        
        return true;
      });
    } catch (error) {
      console.error('Error verifying email:', error);
      return false;
    }
  }

  generateVerificationCode(): string {
    // Generate a 6-digit verification code
    return Math.floor(100000 + Math.random() * 900000).toString();
  }
  
  // User account methods
  async getUserByEmail(email: string): Promise<User | undefined> {
    try {
      // Cache user lookups for 5 minutes since they rarely change
      return await cachedQuery(
        `user:${email}`,
        async () => {
          const result = await executeWithRetry(async () => {
            return db.select().from(users).where(eq(users.email, email));
          });
          return result[0];
        },
        300 // 5 minute TTL
      );
    } catch (error) {
      console.error('Error fetching user by email:', error);
      return undefined;
    }
  }


  async getUserByUsername(username: string): Promise<User | undefined> {
    try {
      return await cachedQuery(
        `user:username:${username}`,
        async () => {
          const result = await executeWithRetry(async () => {
            return db.select().from(users).where(eq(users.username, username));
          });
          return result[0];
        },
        300
      );
    } catch (error) {
      console.error("Error fetching user by username:", error);
      return undefined;
    }
  }
  async createUser(userData: InsertUser): Promise<User> {
    try {
      const result = await executeWithRetry(async () => {
        return db.insert(users).values({
          ...userData,
          updatedAt: new Date() // Ensure updatedAt is set
        }).returning();
      });
      
      // Invalidate any existing cache for this email
      invalidateCache(`user:${userData.email}`);
      
      return result[0];
    } catch (error) {
      console.error('Error creating user:', error);
      throw error; // Rethrow as this is a critical operation
    }
  }

  async updateUser(id: number, updates: Partial<User>): Promise<User | undefined> {
    try {
      // Always update the updatedAt timestamp
      const updatesWithTimestamp = {
        ...updates,
        updatedAt: new Date()
      };
      
      const result = await executeWithRetry(async () => {
        return db.update(users)
          .set(updatesWithTimestamp)
          .where(eq(users.id, id))
          .returning();
      });
      
      // Find the user record to invalidate cache properly
      const updated = result[0];
      if (updated && updated.email) {
        invalidateCache(`user:${updated.email}`);
      }
      
      return updated;
    } catch (error) {
      console.error('Error updating user:', error);
      return undefined;
    }
  }

  // Generated images and limited editions methods
  async getGeneratedImageById(id: string): Promise<GeneratedImage | undefined> {
    try {
      return await cachedQuery(
        `generated-image:${id}`,
        async () => {
          const result = await executeWithRetry(async () => {
            return db.select().from(generatedImages).where(eq(generatedImages.id, id));
          });
          return result[0];
        },
        60 // 1 minute TTL
      );
    } catch (error) {
      console.error('Error fetching generated image by ID:', error);
      return undefined;
    }
  }

  async updateGeneratedImage(id: string, updates: Partial<GeneratedImage>): Promise<GeneratedImage | undefined> {
    try {
      const result = await executeWithRetry(async () => {
        return db.update(generatedImages)
          .set(updates)
          .where(eq(generatedImages.id, id))
          .returning();
      });
      
      // Invalidate cache for this image
      invalidateCache(`generated-image:${id}`);
      
      return result[0];
    } catch (error) {
      console.error('Error updating generated image:', error);
      return undefined;
    }
  }

  async createPosterPurchase(purchase: InsertPosterPurchase): Promise<PosterPurchase> {
    try {
      const result = await executeWithRetry(async () => {
        return db.insert(posterPurchases).values(purchase).returning();
      });
      
      // Invalidate cache for purchases of this image
      invalidateCache(`poster-purchases:${purchase.imageId}`);
      
      return result[0];
    } catch (error) {
      console.error('Error creating poster purchase:', error);
      throw error; // Rethrow as this is a critical operation
    }
  }

  async getPosterPurchasesByImageId(imageId: string): Promise<PosterPurchase[]> {
    try {
      return await cachedQuery(
        `poster-purchases:${imageId}`,
        async () => {
          return executeWithRetry(async () => {
            return db.select().from(posterPurchases).where(eq(posterPurchases.imageId, imageId));
          });
        },
        60 // 1 minute TTL
      );
    } catch (error) {
      console.error('Error fetching poster purchases by image ID:', error);
      return [];
    }
  }

  async getNextEditionNumber(imageId: string): Promise<number> {
    try {
      const purchases = await this.getPosterPurchasesByImageId(imageId);
      return purchases.length + 1;
    } catch (error) {
      console.error('Error getting next edition number:', error);
      return 1;
    }
  }

  async checkImageAvailability(imageId: string): Promise<{ available: boolean; remainingSupply: number }> {
    try {
      const image = await this.getGeneratedImageById(imageId);
      if (!image) {
        return { available: false, remainingSupply: 0 };
      }

      // If unlimited supply
      if (image.supplyType === 'unlimited') {
        return { available: true, remainingSupply: -1 }; // -1 indicates unlimited
      }

      // For limited supply
      const totalSupply = image.totalSupply || 0;
      const soldCount = image.soldCount || 0;
      const remainingSupply = totalSupply - soldCount;

      return {
        available: remainingSupply > 0,
        remainingSupply: Math.max(0, remainingSupply)
      };
    } catch (error) {
      console.error('Error checking image availability:', error);
      return { available: false, remainingSupply: 0 };
    }
  }
}

// Memory storage implementation for backwards compatibility and local dev
export class MemStorage implements IStorage {
  private users = new Map<number, User>();
  private usersByEmail = new Map<string, number>();
  private currentUserId = 1;
  private orders = new Map<number, Order>();
  private currentOrderId = 1;
  private catalogueOrders = new Map<number, CatalogueOrder>();
  private currentCatalogueOrderId = 1;
  private catalogueOrderItems = new Map<number, CatalogueOrderItem[]>();
  private currentCatalogueOrderItemId = 1;
  private credits = new Map<number, GenerationCredits>();
  private creditsByEmail = new Map<string, number>();
  private currentCreditsId = 1;

  async updateUserSubscriptionStatus(email: string, updates: Partial<User>): Promise<boolean> {
    const userId = this.usersByEmail.get(email);
    if (!userId) return false;
    
    const user = this.users.get(userId);
    if (!user) return false;
    
    const updatedUser = {
      ...user,
      ...updates,
      updatedAt: new Date()
    };
    
    this.users.set(userId, updatedUser);
    return true;
  }

  // Catalogue Order Methods
  async createCatalogueOrder(insertOrder: InsertCatalogueOrder, items: InsertCatalogueOrderItem[]): Promise<CatalogueOrder> {
    const id = this.currentCatalogueOrderId++;
    const order: CatalogueOrder = { 
      id,
      firstName: insertOrder.firstName,
      lastName: insertOrder.lastName,
      email: insertOrder.email,
      address: insertOrder.address,
      city: insertOrder.city,
      state: insertOrder.state,
      zipCode: insertOrder.zipCode,
      country: insertOrder.country,
      confirmationId: insertOrder.confirmationId || generateCatalogueConfirmationId(),
      status: insertOrder.status || "pending",
      // quantity field is stored per item, not per order
      amount: insertOrder.amount || (items.length * 29.95),
      createdAt: new Date().toISOString()
    };
    
    this.catalogueOrders.set(id, order);
    
    // Process all the items with the order ID
    if (items.length > 0) {
      const orderItems = items.map(item => {
        const itemId = this.currentCatalogueOrderItemId++;
        const catalogueItem: CatalogueOrderItem = {
          id: itemId,
          orderId: id,
          posterImageUrl: item.posterImageUrl,
          style: item.style || null,
          quantity: item.quantity || 1,
          price: item.price || 29.95,
          createdAt: new Date()
        };
        return catalogueItem;
      });
      
      this.catalogueOrderItems.set(id, orderItems);
    } else {
      this.catalogueOrderItems.set(id, []);
    }
    
    return order;
  }
  
  async getCatalogueOrders(): Promise<CatalogueOrder[]> {
    return Array.from(this.catalogueOrders.values());
  }
  
  async getCatalogueOrderById(id: number): Promise<{order: CatalogueOrder, items: CatalogueOrderItem[]} | undefined> {
    const order = this.catalogueOrders.get(id);
    if (!order) {
      return undefined;
    }
    
    const items = this.catalogueOrderItems.get(id) || [];
    return { order, items };
  }
  
  async updateCatalogueOrderStatus(id: number, status: string): Promise<boolean> {
    const order = this.catalogueOrders.get(id);
    if (!order) {
      return false;
    }
    
    order.status = status;
    this.catalogueOrders.set(id, order);
    return true;
  }
  
  generateCatalogueConfirmationId(): string {
    return generateCatalogueConfirmationId();
  }

  async createOrder(insertOrder: InsertOrder): Promise<Order> {
    const id = this.currentOrderId++;
    const order: Order = { 
      ...insertOrder, 
      id,
      // Default values for optional fields
      posterImageUrl: insertOrder.posterImageUrl || null,
      originalImageUrl: insertOrder.originalImageUrl || null,
      style: insertOrder.style || "standard",
      status: insertOrder.status || "pending",
      quantity: insertOrder.quantity || 1,
      amount: insertOrder.amount || 29.95,
      createdAt: new Date().toISOString() 
    };
    this.orders.set(id, order);
    return order;
  }

  async getOrders(): Promise<Order[]> {
    return Array.from(this.orders.values());
  }
  
  async getOrderById(id: number): Promise<Order | undefined> {
    return this.orders.get(id);
  }
  
  async updateOrderStatus(id: number, status: string): Promise<boolean> {
    const order = this.orders.get(id);
    
    if (!order) {
      return false;
    }
    
    // Update the status
    order.status = status;
    this.orders.set(id, order);
    
    return true;
  }
  
  generateConfirmationId(): string {
    return generateConfirmationId();
  }

  // Generation credits methods
  async getGenerationCreditsByEmail(email: string): Promise<GenerationCredits | undefined> {
    const id = this.creditsByEmail.get(email);
    if (!id) return undefined;
    return this.credits.get(id);
  }

  async createGenerationCredits(credits: InsertGenerationCredits): Promise<GenerationCredits> {
    const id = this.currentCreditsId++;
    const newCredits: GenerationCredits = {
      ...credits,
      id,
      freeCreditsTotal: credits.freeCreditsTotal || 2, // Default to 2 free credits
      freeCreditsUsed: credits.freeCreditsUsed || 0,
      paidCredits: credits.paidCredits || 0,
      lastGeneratedAt: new Date(),
      verified: credits.verified || false,
      verificationCode: credits.verificationCode || null,
      ipAddress: credits.ipAddress || null,
      createdAt: new Date()
    };
    
    this.credits.set(id, newCredits);
    this.creditsByEmail.set(credits.email, id);
    return newCredits;
  }

  async updateGenerationCredits(id: number, updates: Partial<GenerationCredits>): Promise<GenerationCredits | undefined> {
    const existing = this.credits.get(id);
    if (!existing) return undefined;
    
    const updated = { ...existing, ...updates };
    this.credits.set(id, updated);
    return updated;
  }

  async incrementFreeCreditsUsed(email: string): Promise<boolean> {
    const user = await this.getGenerationCreditsByEmail(email);
    if (!user) return false;
    
    const updatedUser = {
      ...user,
      freeCreditsUsed: (user.freeCreditsUsed || 0) + 1,
      lastGeneratedAt: new Date()
    };
    
    this.credits.set(user.id, updatedUser);
    return true;
  }

  async decrementPaidCredits(email: string): Promise<boolean> {
    const user = await this.getGenerationCreditsByEmail(email);
    if (!user) return false;
    
    const currentCredits = user.paidCredits || 0;
    if (currentCredits < 1) return false;
    
    const updatedUser = {
      ...user,
      paidCredits: currentCredits - 1,
      lastGeneratedAt: new Date()
    };
    
    this.credits.set(user.id, updatedUser);
    return true;
  }

  async addPaidCredits(email: string, creditsToAdd: number): Promise<boolean> {
    const user = await this.getGenerationCreditsByEmail(email);
    if (!user) return false;
    
    const updatedUser = {
      ...user,
      paidCredits: (user.paidCredits || 0) + creditsToAdd
    };
    
    this.credits.set(user.id, updatedUser);
    return true;
  }

  async verifyEmail(email: string, token: string): Promise<boolean> {
    const user = await this.getGenerationCreditsByEmail(email);
    if (!user || user.verificationCode !== token) return false;
    
    const updatedUser = {
      ...user,
      verified: true
    };
    
    this.credits.set(user.id, updatedUser);
    return true;
  }

  generateVerificationCode(): string {
    // Generate a 6-digit verification code
    return Math.floor(100000 + Math.random() * 900000).toString();
  }
  
  // User account methods  
  async getUserByEmail(email: string): Promise<User | undefined> {
    const userId = this.usersByEmail.get(email);
    if (!userId) return undefined;
    return this.users.get(userId);
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const userId = this.usersByEmail.get(username);
    if (!userId) return undefined;
    return this.users.get(userId);
  }

  async createUser(userData: InsertUser): Promise<User> {
    const id = this.currentUserId++;
    const user: User = {
      id,
      email: userData.email,
      password: userData.password,
      username: userData.username,
      userType: userData.userType || "normal",
      profileImageUrl: userData.profileImageUrl || null,
      stripeConnectAccountId: userData.stripeConnectAccountId || null,
      stripeConnectEnabled: userData.stripeConnectEnabled || false,
      stripeOnboardingComplete: userData.stripeOnboardingComplete || false,
      stripeCustomerId: userData.stripeCustomerId || null,
      subscriptionId: userData.subscriptionId || null,
      subscriptionStatus: userData.subscriptionStatus || null,
      subscriptionStartDate: userData.subscriptionStartDate || null,
      subscriptionEndDate: userData.subscriptionEndDate || null,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    
    this.users.set(id, user);
    this.usersByEmail.set(userData.email, id);
    return user;
  }

  async updateUser(id: number, updates: Partial<User>): Promise<User | undefined> {
    const user = this.users.get(id);
    if (!user) return undefined;
    
    const updatedUser = {
      ...user,
      ...updates,
      updatedAt: new Date()
    };
    
    this.users.set(id, updatedUser);
    return updatedUser;
  }

  // Generated images and limited editions methods - stub implementations for MemStorage
  async getGeneratedImageById(id: string): Promise<GeneratedImage | undefined> {
    // Stub implementation for MemStorage compatibility
    return undefined;
  }

  async updateGeneratedImage(id: string, updates: Partial<GeneratedImage>): Promise<GeneratedImage | undefined> {
    // Stub implementation for MemStorage compatibility
    return undefined;
  }

  async createPosterPurchase(purchase: InsertPosterPurchase): Promise<PosterPurchase> {
    // Stub implementation for MemStorage compatibility
    throw new Error("Poster purchases not supported in MemStorage");
  }

  async getPosterPurchasesByImageId(imageId: string): Promise<PosterPurchase[]> {
    // Stub implementation for MemStorage compatibility
    return [];
  }

  async getNextEditionNumber(imageId: string): Promise<number> {
    // Stub implementation for MemStorage compatibility
    return 1;
  }

  async checkImageAvailability(imageId: string): Promise<{ available: boolean; remainingSupply: number }> {
    // Stub implementation for MemStorage compatibility
    return { available: false, remainingSupply: 0 };
  }

}

// Use the database storage
export const storage = new DatabaseStorage();
