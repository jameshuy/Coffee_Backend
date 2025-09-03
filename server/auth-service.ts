/**
 * User authentication service for handling accounts
 * Provides secure password-based authentication with JWT tokens
 */
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { User, InsertUser } from '@shared/schema';
import { storage } from './storage';

// Constants
const JWT_SECRET = process.env.JWT_SECRET || 'posteraiappsecret'; // In production, use environment variable
const JWT_EXPIRY = '7d'; // Token expires in 7 days
const SALT_ROUNDS = 10; // For bcrypt password hashing

/**
 * Register a new user with email and password
 * @param email User's email address
 * @param password Plain text password to hash and store
 * @returns The created user (without password) or null if email already exists
 */
export async function registerUser(email: string, username: string, password: string): Promise<Omit<User, 'password'> | null> {
  try {
    // Check if user already exists
    const existingUser = await storage.getUserByEmail(email);
    if (existingUser) {
      return null; // User already exists
    }

    // Check if username already exists
    const existingUsername = await storage.getUserByUsername(username);
    if (existingUsername) {
      return null; // Username already exists
    }

    // Hash the password
    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

    // Create user record
    const newUser = await storage.createUser({
      email,
      username,
      password: hashedPassword,
      userType: 'artistic_collective', // All users get unlimited access
    });

    // Return user without password
    const { password: _, ...userWithoutPassword } = newUser;
    return userWithoutPassword;
  } catch (error) {
    console.error('Error registering user:', error);
    throw error;
  }
}

/**
 * Authenticate a user with email and password
 * @param email User's email address
 * @param password Plain text password to verify
 * @returns User object (without password) and token if credentials are valid, null otherwise
 */
export async function loginUser(email: string, password: string): 
  Promise<{ user: Omit<User, 'password'>, token: string } | null> {
  try {
    // Get user by email
    const user = await storage.getUserByEmail(email);
    if (!user) {
      return null; // User not found
    }

    // Verify password
    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return null; // Invalid password
    }

    // Generate JWT token
    const token = jwt.sign(
      { userId: user.id, email: user.email, userType: user.userType },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRY }
    );

    // Return user without password and token
    const { password: _, ...userWithoutPassword } = user;
    return { user: userWithoutPassword, token };
  } catch (error) {
    console.error('Error during login:', error);
    throw error;
  }
}

/**
 * Verify a JWT token and extract user data
 * @param token JWT token to verify
 * @returns User ID, email, and userType if token is valid, null otherwise
 */
export function verifyToken(token: string): { userId: number, email: string, userType: string } | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: number, email: string, userType: string };
    return decoded;
  } catch (error) {
    return null; // Invalid token
  }
}

/**
 * Check if a user has exactly 1 free credit used
 * @param email User's email address
 * @returns Boolean indicating if user has used exactly 1 free credit
 */
export async function hasExhaustedFreeCredits(email: string): Promise<boolean> {
  try {
    const credits = await storage.getGenerationCreditsByEmail(email);
    if (!credits) {
      return false; // No credits record found
    }
    
    // Handle potentially null values with defaults
    const freeCreditsUsed = credits.freeCreditsUsed || 0;
    
    // Check for exactly 1 free credit used
    return (freeCreditsUsed === 1);
  } catch (error) {
    console.error('Error checking free credits:', error);
    return false; // Assume not exhausted on error
  }
}

/**
 * Check if a user account exists with the given email
 * @param email User's email address to check
 * @returns Boolean indicating if the user exists
 */
export async function userExists(email: string): Promise<boolean> {
  try {
    const user = await storage.getUserByEmail(email);
    return !!user; // Convert to boolean (true if user exists, false otherwise)
  } catch (error) {
    console.error('Error checking if user exists:', error);
    return false; // Assume user doesn't exist on error
  }
}