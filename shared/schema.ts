import { pgTable, text, serial, integer, boolean, doublePrecision, timestamp, uuid, foreignKey } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { relations } from "drizzle-orm";

// User accounts table with password auth
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  password: text("password").notNull(), // Stores hashed passwords
  username: text("username").notNull().unique(),
  userType: text("user_type").notNull().default("normal"), // 'normal' | 'artistic_collective'
  profileImageUrl: text("profile_image_url"),
  stripeConnectAccountId: text("stripe_connect_account_id"), // Stripe Connect account ID
  stripeConnectEnabled: boolean("stripe_connect_enabled").default(false), // Whether payouts are enabled
  stripeOnboardingComplete: boolean("stripe_onboarding_complete").default(false), // Whether onboarding is complete
  // Subscription fields
  stripeCustomerId: text("stripe_customer_id"), // Stripe customer ID for subscriptions
  subscriptionId: text("subscription_id"), // Stripe subscription ID
  subscriptionStatus: text("subscription_status"), // active, canceled, past_due, etc.
  subscriptionStartDate: timestamp("subscription_start_date"),
  subscriptionEndDate: timestamp("subscription_end_date"),
  postersForSale: integer("posters_for_sale").default(0), // Track how many posters user has put up for sale
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// User type validation
export const userTypeSchema = z.enum(["normal", "artistic_collective"]);

export const insertUserSchema = createInsertSchema(users).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  userType: userTypeSchema.optional().default("normal"),
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;
export type UserType = z.infer<typeof userTypeSchema>;

// Order schema
export const orders = pgTable("orders", {
  id: serial("id").primaryKey(),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  email: text("email").notNull(),
  address: text("address").notNull(),
  city: text("city").notNull(),
  state: text("state").notNull(),
  zipCode: text("zip_code").notNull(), // This will be postalCode in API responses
  country: text("country").notNull(),
  confirmationId: text("confirmation_id").notNull().unique(),
  originalImageUrl: text("original_image_url"), // Made optional
  posterImageUrl: text("poster_image_url"),
  style: text("style").default("standard"),
  quantity: integer("quantity").default(1), // Add quantity field with default of 1
  amount: doublePrecision("amount").default(29.95), // Total amount in CHF
  status: text("status").default("pending"), // Order status: pending, printed, shipped, delivered
  createdAt: text("created_at").notNull(), // Store as ISO string
});

export const insertOrderSchema = createInsertSchema(orders).omit({
  id: true,
  createdAt: true,
});

export type InsertOrder = z.infer<typeof insertOrderSchema>;
export type Order = typeof orders.$inferSelect;

// Generation Credits schema for micro-payments
export const generationCredits = pgTable("generation_credits", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  freeCreditsTotal: integer("free_credits_total").default(2), // Each user gets 2 free credits
  freeCreditsUsed: integer("free_credits_used").default(0),
  paidCredits: integer("paid_credits").default(0),
  lastGeneratedAt: timestamp("last_generated_at").defaultNow(),
  verificationCode: text("verification_code"), // For email verification
  verified: boolean("verified").default(false),
  ipAddress: text("ip_address"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertGenerationCreditsSchema = createInsertSchema(generationCredits).omit({
  id: true,
  lastGeneratedAt: true,
  createdAt: true, // Omit this as it defaults to now
});

export type InsertGenerationCredits = z.infer<typeof insertGenerationCreditsSchema>;
export type GenerationCredits = typeof generationCredits.$inferSelect;

// Table for tracking generated images for the marketplace
export const generatedImages = pgTable("generated_images", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(), // Email or user ID
  name: text("name"), // User-defined poster name
  originalPath: text("original_path").notNull(),
  generatedPath: text("generated_path").notNull(),
  thumbnailPath: text("thumbnail_path"), // Path to compressed thumbnail image
  style: text("style").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  isPublic: boolean("is_public").default(false),
  isSaved: boolean("is_saved").default(false), // Track if user saved/downloaded the image
  // Limited edition fields
  totalSupply: integer("total_supply"), // Total number of editions available
  soldCount: integer("sold_count").default(0), // tracks sales
  pricePerUnit: doublePrecision("price_per_unit").default(29.95), // Price per unit in CHF (minimum 29.95)
  editionPricingType: text("edition_pricing_type").default("flat"), // 'flat' | 'tiered' for future flexibility
  momentLink: text("moment_link"), // Optional link to social media moment/story
  city: text("city"), // City where the poster was created
  // Video processing fields
  originalVideoPath: text("original_video_path"), // Path to original video file
  compressedVideoPath: text("compressed_video_path"), // Path to compressed video file for faster loading
  videoFrameTimestamp: doublePrecision("video_frame_timestamp"), // Timestamp of selected frame
  mergedVideoUrl: text("merged_video_url"), // URL to processed video-to-poster transition
  videoProcessingStatus: text("video_processing_status").default("pending"), // 'pending' | 'processing' | 'completed' | 'failed'
  updatedAt: timestamp("updated_at").defaultNow().notNull()
});

export const insertGeneratedImagesSchema = createInsertSchema(generatedImages).omit({
  id: true,
  createdAt: true,
});

export type InsertGeneratedImage = z.infer<typeof insertGeneratedImagesSchema>;
export type GeneratedImage = typeof generatedImages.$inferSelect;

// Table for tracking individual poster purchases and edition numbers
export const posterPurchases = pgTable("poster_purchases", {
  id: serial("id").primaryKey(),
  userEmail: text("user_email").notNull(),
  imageId: uuid("image_id").notNull().references(() => generatedImages.id),
  editionNumber: integer("edition_number").notNull(), // Sequential: 1, 2, 3...
  purchaseDate: timestamp("purchase_date").defaultNow().notNull(),
  amountPaid: doublePrecision("amount_paid").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertPosterPurchaseSchema = createInsertSchema(posterPurchases).omit({
  id: true,
  createdAt: true,
});

export type InsertPosterPurchase = z.infer<typeof insertPosterPurchaseSchema>;
export type PosterPurchase = typeof posterPurchases.$inferSelect;

// Catalogue Order schema for orders from the catalogue
export const catalogueOrders = pgTable("catalogue_orders", {
  id: serial("id").primaryKey(),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  email: text("email").notNull(),
  address: text("address").notNull(),
  city: text("city").notNull(),
  state: text("state").notNull(),
  zipCode: text("zip_code").notNull(),
  country: text("country").notNull(),
  confirmationId: text("confirmation_id").notNull().unique(),
  amount: doublePrecision("amount").default(0.60), // Total order amount in CHF
  status: text("status").default("pending"), // Order status: pending, printed, shipped, delivered
  createdAt: text("created_at").notNull(), // Store as ISO string
});

// Catalogue Order Items schema for individual items in a catalogue order
export const catalogueOrderItems = pgTable("catalogue_order_items", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id").notNull().references(() => catalogueOrders.id),
  posterImageUrl: text("poster_image_url").notNull(),
  style: text("style"),
  quantity: integer("quantity").default(1), // Quantity of this specific item
  price: doublePrecision("price").default(29.95), // Price per item in CHF
  createdAt: timestamp("created_at").defaultNow(),
});

// Set up relations between tables
export const catalogueOrdersRelations = relations(catalogueOrders, ({ many }) => ({
  items: many(catalogueOrderItems),
}));

export const catalogueOrderItemsRelations = relations(catalogueOrderItems, ({ one }) => ({
  order: one(catalogueOrders, {
    fields: [catalogueOrderItems.orderId],
    references: [catalogueOrders.id],
  }),
}));

export const posterPurchasesRelations = relations(posterPurchases, ({ one }) => ({
  image: one(generatedImages, {
    fields: [posterPurchases.imageId],
    references: [generatedImages.id],
  }),
}));

export const generatedImagesRelations = relations(generatedImages, ({ many }) => ({
  purchases: many(posterPurchases),
  likes: many(posterLikes),
}));

// Table for tracking poster likes
export const posterLikes = pgTable("poster_likes", {
  id: serial("id").primaryKey(),
  imageId: uuid("image_id").notNull().references(() => generatedImages.id),
  userId: integer("user_id").notNull().references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertPosterLikeSchema = createInsertSchema(posterLikes).omit({
  id: true,
  createdAt: true,
});

export type InsertPosterLike = z.infer<typeof insertPosterLikeSchema>;
export type PosterLike = typeof posterLikes.$inferSelect;

export const posterLikesRelations = relations(posterLikes, ({ one }) => ({
  image: one(generatedImages, {
    fields: [posterLikes.imageId],
    references: [generatedImages.id],
  }),
  user: one(users, {
    fields: [posterLikes.userId],
    references: [users.id],
  }),
}));

// Create insert schemas for the new tables
export const insertCatalogueOrderSchema = createInsertSchema(catalogueOrders).omit({
  id: true,
});

export const insertCatalogueOrderItemSchema = createInsertSchema(catalogueOrderItems).omit({
  id: true,
  createdAt: true,
});

// Create types for the new tables
export type InsertCatalogueOrder = z.infer<typeof insertCatalogueOrderSchema>;
export type CatalogueOrder = typeof catalogueOrders.$inferSelect;
export type InsertCatalogueOrderItem = z.infer<typeof insertCatalogueOrderItemSchema>;
export type CatalogueOrderItem = typeof catalogueOrderItems.$inferSelect;

// Beta release statistics table (easily removable)
export const betaReleaseStats = pgTable("beta_release_stats", {
  id: serial("id").primaryKey(),
  sex: text("sex").notNull(), // 'male' | 'female' | 'prefer_not_to_say'
  ageBracket: text("age_bracket").notNull(), // '10-19' | '20-29' | '30-39' | '40-49' | '50-59' | '60+'
  city: text("city").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertBetaReleaseStatsSchema = createInsertSchema(betaReleaseStats).omit({
  id: true,
  createdAt: true,
});

export type InsertBetaReleaseStats = z.infer<typeof insertBetaReleaseStatsSchema>;
export type BetaReleaseStats = typeof betaReleaseStats.$inferSelect;
