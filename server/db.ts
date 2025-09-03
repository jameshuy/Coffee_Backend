// import { Pool, neonConfig } from '@neondatabase/serverless';
import {Pool} from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
// import ws from "ws";
import * as schema from "@shared/schema";
import NodeCache from 'node-cache';
import dotenv from "dotenv";
dotenv.config();

// Setup Neon database connection
// neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

// Optimize connection pool for scalability
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  min: 2,               // Minimum connections per instance
  max: 10,              // Maximum connections per instance
  idleTimeoutMillis: 30000,  // How long a connection can be idle before being removed
  connectionTimeoutMillis: 10000, // Connection acquisition timeout
  allowExitOnIdle: true,
  ssl: { rejectUnauthorized: false }
});

// Add connection pool monitoring
pool.on('error', (err: Error) => {
  console.error('Unexpected error on idle client', err);
});

// Add connection pool stats logging (every 5 minutes)
setInterval(async () => {
  const clientCount = await pool.totalCount;
  const idleCount = await pool.idleCount;
  const waitingCount = await pool.waitingCount;
  console.log(`DB Pool Stats - Total: ${clientCount}, Idle: ${idleCount}, Waiting: ${waitingCount}`);
}, 300000);

export const db = drizzle({ client: pool, schema });

/**
 * Utility to safely perform database operations with guaranteed connection release
 * @param operation Function that receives a client and performs database operations
 * @returns Results of the operation
 */
export async function withConnection<T>(operation: (client: any) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await operation(client);
  } finally {
    client.release();
  }
}

/**
 * Execute a query with automatic retry on connection failures
 * @param queryFn Function that performs the database query
 * @param maxRetries Maximum number of retry attempts
 * @returns Query result
 */
export async function executeWithRetry<T>(queryFn: () => Promise<T>, maxRetries = 3): Promise<T> {
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await queryFn();
    } catch (error: any) {
      lastError = error;
      
      // Only retry on connection-related errors
      if (!isConnectionError(error)) {
        throw error;
      }
      
      console.warn(`Database connection error, retrying (${attempt}/${maxRetries})...`, error.message);
      
      // Wait before retrying (exponential backoff)
      await new Promise(resolve => setTimeout(resolve, 100 * Math.pow(2, attempt)));
    }
  }
  
  throw lastError;
}

/**
 * Check if an error is related to connection issues
 */
function isConnectionError(error: any): boolean {
  const connectionErrorCodes = ['57P01', '57P02', '57P03', '08006', '08001', '08004', 'XX000'];
  return connectionErrorCodes.includes(error.code) || 
         error.message.includes('connection') ||
         error.message.includes('timeout');
}

// Initialize cache with TTL of 5 minutes
const queryCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

/**
 * Execute a query with caching for read-heavy operations
 * @param cacheKey Unique key for this query result
 * @param queryFn Function that performs the database query
 * @param ttl Optional custom TTL in seconds
 * @returns Query result (from cache if available)
 */
export async function cachedQuery<T>(
  cacheKey: string, 
  queryFn: () => Promise<T>, 
  ttl: number = 300  // Default 5 minutes TTL
): Promise<T> {
  // Try to get from cache first
  const cached = queryCache.get<T>(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  
  // Not in cache, execute query
  const result = await executeWithRetry(queryFn);
  
  // Store in cache with TTL
  if (ttl !== undefined) {
    queryCache.set(cacheKey, result, ttl);
  } else {
    queryCache.set(cacheKey, result);
  }
  
  return result;
}

/**
 * Invalidate a specific cache key or pattern
 * @param keyPattern Key or pattern to invalidate
 */
export function invalidateCache(keyPattern: string): void {
  if (keyPattern.includes('*')) {
    // Pattern invalidation
    const keys = queryCache.keys().filter(key => 
      new RegExp(keyPattern.replace('*', '.*')).test(key)
    );
    keys.forEach(key => queryCache.del(key));
    console.log(`Invalidated ${keys.length} cache entries matching pattern: ${keyPattern}`);
  } else {
    // Single key invalidation
    queryCache.del(keyPattern);
    console.log(`Invalidated cache entry: ${keyPattern}`);
  }
}