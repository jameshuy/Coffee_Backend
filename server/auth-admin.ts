/**
 * Admin authentication utilities
 * Provides secure authentication for the admin panel
 */
import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

// Store active sessions with expiration timestamps
interface AdminSession {
  sessionToken: string;
  expiresAt: number;
  lastActivity: number;
}

// In-memory session store (would be replaced by database in production)
const adminSessions: Map<string, AdminSession> = new Map();

// Session duration in milliseconds (2 hours)
const SESSION_DURATION_MS = 2 * 60 * 60 * 1000;

// Activity timeout in milliseconds (30 minutes)
const ACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;

// Maximum failed login attempts before temporary lockout
const MAX_FAILED_ATTEMPTS = 5;
// Lockout duration in milliseconds (10 minutes)
const LOCKOUT_DURATION_MS = 10 * 60 * 1000;

// Track failed login attempts by IP
const failedAttempts: Map<string, { count: number, lockUntil: number }> = new Map();

/**
 * Validate admin credentials against environment variables
 * @param username Submitted username
 * @param password Submitted password
 * @returns Boolean indicating if credentials are valid
 */
export function validateAdminCredentials(username: string, password: string): boolean {
  // Get admin credentials from environment variables, use defaults if not set
  // Default credentials for development only: admin/poster2024
  const validUsername = process.env.ADMIN_USERNAME || "admin";
  const validPassword = process.env.ADMIN_PASSWORD || "poster2024";
  
  // Log if using default credentials
  if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD) {
    console.warn('Using default admin credentials - should be changed in production');
  }
  
  // Compare credentials using a more straightforward approach
  // In a production environment, use a proper password hashing method like bcrypt
  const usernameMatch = username === validUsername;
  const passwordMatch = password === validPassword;
  
  return usernameMatch && passwordMatch;
}

/**
 * Create a new admin session
 * @returns Session token for the new session
 */
export function createAdminSession(): string {
  // Generate a random session token
  const sessionToken = crypto.randomBytes(32).toString('hex');
  
  // Calculate expiration time
  const expiresAt = Date.now() + SESSION_DURATION_MS;
  
  // Store session with expiration
  adminSessions.set(sessionToken, {
    sessionToken,
    expiresAt,
    lastActivity: Date.now()
  });
  
  // Clean up expired sessions
  cleanupExpiredSessions();
  
  return sessionToken;
}

/**
 * Remove expired admin sessions
 */
function cleanupExpiredSessions(): void {
  const now = Date.now();
  
  // Use Array.from to convert Map entries to array to avoid iterator issues
  Array.from(adminSessions.entries()).forEach(([token, session]) => {
    // Remove if session is expired or inactive
    if (session.expiresAt < now || (now - session.lastActivity) > ACTIVITY_TIMEOUT_MS) {
      adminSessions.delete(token);
    }
  });
}

/**
 * Verify if a session token is valid
 * @param sessionToken Session token to verify
 * @returns Boolean indicating if token is valid
 */
export function verifyAdminSession(sessionToken: string): boolean {
  const session = adminSessions.get(sessionToken);
  
  if (!session) {
    return false;
  }
  
  const now = Date.now();
  
  // Check if session is expired
  if (session.expiresAt < now) {
    adminSessions.delete(sessionToken);
    return false;
  }
  
  // Check if session is inactive
  if ((now - session.lastActivity) > ACTIVITY_TIMEOUT_MS) {
    adminSessions.delete(sessionToken);
    return false;
  }
  
  // Update last activity time
  session.lastActivity = now;
  
  return true;
}

/**
 * Destroy an admin session
 * @param sessionToken Session token to destroy
 */
export function destroyAdminSession(sessionToken: string): void {
  adminSessions.delete(sessionToken);
}

/**
 * Check if an IP is currently locked out due to failed login attempts
 * @param ip IP address to check
 * @returns Boolean indicating if IP is locked out
 */
export function isIpLockedOut(ip: string): boolean {
  const attempt = failedAttempts.get(ip);
  
  if (!attempt) {
    return false;
  }
  
  // Check if lockout period has expired
  if (attempt.lockUntil < Date.now()) {
    failedAttempts.delete(ip);
    return false;
  }
  
  return attempt.count >= MAX_FAILED_ATTEMPTS;
}

/**
 * Record a failed login attempt for an IP address
 * @param ip IP address that failed to log in
 */
export function recordFailedLoginAttempt(ip: string): void {
  const attempt = failedAttempts.get(ip) || { count: 0, lockUntil: 0 };
  
  attempt.count += 1;
  
  // Set lockout time if max attempts reached
  if (attempt.count >= MAX_FAILED_ATTEMPTS) {
    attempt.lockUntil = Date.now() + LOCKOUT_DURATION_MS;
  }
  
  failedAttempts.set(ip, attempt);
}

/**
 * Reset failed login attempts for an IP address
 * @param ip IP address to reset
 */
export function resetFailedLoginAttempts(ip: string): void {
  failedAttempts.delete(ip);
}

/**
 * Middleware to check admin authentication
 */
export function requireAdminAuth(req: Request, res: Response, next: NextFunction) {
  // Check for session token in cookies
  const sessionToken = req.cookies?.adminSessionToken;
  
  if (!sessionToken || !verifyAdminSession(sessionToken)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  
  next();
}

/**
 * Log admin activity
 * @param action Action performed
 * @param details Additional details about the action
 * @param ip IP address of the admin
 */
export function logAdminActivity(action: string, details: string, ip: string): void {
  const timestamp = new Date().toISOString();
  console.log(`[ADMIN ACTIVITY] ${timestamp} | IP: ${ip} | ${action} | ${details}`);
  
  // In a production environment, this would write to a persistent log store
}