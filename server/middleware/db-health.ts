import { Request, Response, NextFunction } from 'express';
import { pool } from '../db';

// Database health state
let databaseHealthy = true;
let lastCheckTime = 0;
let consecutiveFailures = 0;

/**
 * Check if the database is healthy
 */
export async function checkDatabaseHealth(): Promise<boolean> {
  try {
    // Simple query to check database connectivity
    await pool.query('SELECT 1');
    
    // Reset failures counter on success
    if (!databaseHealthy) {
      console.log('Database connection recovered after failures');
    }
    
    databaseHealthy = true;
    consecutiveFailures = 0;
    return true;
  } catch (error) {
    consecutiveFailures++;
    
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Database health check failed (${consecutiveFailures} consecutive failures): ${errorMessage}`);
    
    // Only mark as unhealthy after multiple consecutive failures
    // to avoid false positives from transient issues
    if (consecutiveFailures >= 3) {
      databaseHealthy = false;
    }
    
    return false;
  } finally {
    lastCheckTime = Date.now();
  }
}

/**
 * Middleware to check database health and circuit-break on issues
 * Only prevents write operations when database is unhealthy
 */
export function databaseHealthMiddleware(req: Request, res: Response, next: NextFunction) {
  // Allow reads even when DB is unhealthy
  const isReadOperation = req.method === 'GET';
  
  // Skip health check for read operations if recent check exists
  const needsCheck = !isReadOperation && (Date.now() - lastCheckTime > 30000);
  
  if (!databaseHealthy && !isReadOperation) {
    if (needsCheck) {
      // Perform on-demand check if it's been more than 30 seconds
      checkDatabaseHealth()
        .then(isHealthy => {
          if (isHealthy) {
            // Database recovered, proceed with request
            next();
          } else {
            // Still unhealthy, return error for write operations
            res.status(503).json({
              error: 'Database connection issues. Please try again later.',
              retry: true
            });
          }
        })
        .catch(() => {
          // Check itself failed, assume unhealthy
          res.status(503).json({
            error: 'Database connection issues. Please try again later.',
            retry: true
          });
        });
    } else {
      // Use cached health status (unhealthy)
      res.status(503).json({
        error: 'Database connection issues. Please try again later.',
        retry: true
      });
    }
  } else {
    // Healthy or read operation, proceed
    next();
  }
}

// Schedule regular health checks (every 30 seconds)
setInterval(checkDatabaseHealth, 30000);

// Initial health check on module load
checkDatabaseHealth().catch(error => {
  console.error('Initial database health check failed:', error);
});