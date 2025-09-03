/**
 * Authentication routes for user accounts
 */
import { Router, Request, Response } from 'express';
import { registerUser, loginUser, verifyToken, hasExhaustedFreeCredits, userExists } from './auth-service';
import { z } from 'zod';
import { db } from './db';
import { users } from '@shared/schema';
import { eq } from 'drizzle-orm';

const authRouter = Router();

// Rate limiting for username checks
const usernameCheckLimiter = new Map<string, { count: number; resetTime: number }>();

const isRateLimited = (ip: string): boolean => {
  const now = Date.now();
  const limit = usernameCheckLimiter.get(ip);
  
  if (!limit || now > limit.resetTime) {
    usernameCheckLimiter.set(ip, { count: 1, resetTime: now + 60000 }); // 1 minute window
    return false;
  }
  
  if (limit.count >= 60) { // 60 requests per minute
    return true;
  }
  
  limit.count++;
  return false;
};

// Middleware to validate request body against a schema
const validateBody = (schema: z.ZodSchema) => {
  return (req: Request, res: Response, next: Function) => {
    try {
      schema.parse(req.body);
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ 
          message: 'Validation error', 
          errors: error.errors 
        });
      }
      return res.status(400).json({ message: 'Invalid request data' });
    }
  };
};

// Username validation and normalization function
const normalizeUsername = (username: string): string => {
  return username
    .toLowerCase()
    .replace(/\s+/g, '_') // Replace spaces with underscores
    .replace(/[^a-z0-9_]/g, ''); // Remove any non-alphanumeric/underscore chars
};

const validateUsername = (username: string): { valid: boolean; error?: string } => {
  const normalized = normalizeUsername(username);
  
  if (normalized.length < 5) {
    return { valid: false, error: 'Username must be at least 5 characters' };
  }
  
  if (normalized.length > 20) {
    return { valid: false, error: 'Username must be 20 characters or less' };
  }
  
  if (!/^[a-z][a-z0-9_]*$/.test(normalized)) {
    return { valid: false, error: 'Username must start with a letter and contain only letters, numbers, and underscores' };
  }
  
  // Reserved usernames
  const reserved = ['admin', 'api', 'www', 'root', 'user', 'support', 'help', 'about', 'contact', 'terms', 'privacy'];
  if (reserved.includes(normalized)) {
    return { valid: false, error: 'This username is reserved' };
  }
  
  return { valid: true };
};

// Generate username suggestions
const generateUsernameSuggestions = (baseUsername: string): string[] => {
  const normalized = normalizeUsername(baseUsername);
  const suggestions = [];
  
  // Add numbers
  for (let i = 1; i <= 5; i++) {
    suggestions.push(`${normalized}${i}`);
  }
  
  // Add random suffixes
  const suffixes = ['_cool', '_pro', '_star', '_ace', '_top'];
  suffixes.forEach(suffix => {
    if ((normalized + suffix).length <= 20) {
      suggestions.push(normalized + suffix);
    }
  });
  
  return suggestions;
};

// Validation schemas
const registerSchema = z.object({
  email: z.string().email('Invalid email address'),
  username: z.string().min(5, 'Username must be at least 5 characters').max(20, 'Username must be 20 characters or less'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string(),
});

// Check username availability
authRouter.get('/check-username', async (req: Request, res: Response) => {
  try {
    const { username } = req.query;
    const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
    
    // Rate limiting
    if (isRateLimited(clientIp)) {
      return res.status(429).json({ 
        message: 'Too many requests. Please try again later.' 
      });
    }
    
    if (!username || typeof username !== 'string') {
      return res.status(400).json({ 
        message: 'Username parameter is required' 
      });
    }
    
    // Validate username format
    const validation = validateUsername(username);
    if (!validation.valid) {
      return res.status(400).json({ 
        available: false,
        message: validation.error 
      });
    }
    
    const normalized = normalizeUsername(username);
    
    // Check if username exists in database
    const existingUser = await db
      .select({ username: users.username })
      .from(users)
      .where(eq(users.username, normalized))
      .limit(1);
    
    const isAvailable = existingUser.length === 0;
    
    let suggestions: string[] = [];
    if (!isAvailable) {
      // Generate suggestions and check their availability
      const potentialSuggestions = generateUsernameSuggestions(normalized);
      
      for (const suggestion of potentialSuggestions) {
        const suggestionExists = await db
          .select({ username: users.username })
          .from(users)
          .where(eq(users.username, suggestion))
          .limit(1);
        
        if (suggestionExists.length === 0) {
          suggestions.push(suggestion);
        }
        
        // Limit to 3 suggestions
        if (suggestions.length >= 3) break;
      }
    }
    
    res.json({
      available: isAvailable,
      username: normalized,
      suggestions: suggestions.length > 0 ? suggestions : undefined
    });
    
  } catch (error) {
    console.error('Error checking username availability:', error);
    res.status(500).json({ 
      message: 'Internal server error' 
    });
  }
});

// Check if user has exhausted free credits
authRouter.get('/check-free-credits', async (req: Request, res: Response) => {
  try {
    const { email } = req.query;
    
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ message: 'Email parameter is required' });
    }
    
    // Check if the user has used exactly 1 free credit
    const hasUsedOneCredit = await hasExhaustedFreeCredits(email);
    
    // Check if the user already has an account
    const hasAccount = await userExists(email);
    
    console.log(`User ${email} - Exactly 1 free credit used: ${hasUsedOneCredit}, Has account: ${hasAccount}`);
    
    return res.status(200).json({ 
      exhausted: hasUsedOneCredit,
      // Only show account creation if user has exactly 1 free credit used AND doesn't have an account
      shouldCreateAccount: hasUsedOneCredit && !hasAccount
    });
  } catch (error) {
    console.error('Error checking free credits:', error);
    return res.status(500).json({ message: 'Failed to check free credits status' });
  }
});

// Register a new user
authRouter.post('/register', validateBody(registerSchema), async (req: Request, res: Response) => {
  try {
    const { email, username, password } = req.body;
    
    // Normalize the username
    const normalizedUsername = normalizeUsername(username);
    
    // Register the user
    const user = await registerUser(email, normalizedUsername, password);
    
    if (!user) {
      return res.status(409).json({ message: 'User already exists' });
    }
    
    // Generate token and set cookie
    const { token } = await loginUser(email, password) as { user: any, token: string };
    
    // Set HTTP-only cookie with token
    res.cookie('auth_token', token, {
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production'
    });
    
    return res.status(201).json({
      message: 'User registered successfully',
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        userType: user.userType,
      }
    });
  } catch (error) {
    console.error('Error registering user:', error);
    return res.status(500).json({ message: 'Failed to register user' });
  }
});

// Log in a user
authRouter.post('/login', validateBody(loginSchema), async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    
    // Authenticate the user
    const result = await loginUser(email, password);
    
    if (!result) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }
    
    const { user, token } = result;
    
    // Set HTTP-only cookie with token
    res.cookie('auth_token', token, {
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production'
    });
    
    return res.status(200).json({
      message: 'Login successful',
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        userType: user.userType,
      }
    });
  } catch (error) {
    console.error('Error logging in:', error);
    return res.status(500).json({ message: 'Failed to log in' });
  }
});

// Log out
authRouter.post('/logout', (req: Request, res: Response) => {
  // Clear the auth cookie
  res.clearCookie('auth_token');
  
  return res.status(200).json({ message: 'Logged out successfully' });
});

// Check authentication status
authRouter.get('/check', async (req: Request, res: Response) => {
  try {
    const token = req.cookies?.auth_token;
    
    if (!token) {
      return res.status(401).json({ authenticated: false });
    }
    
    const decoded = verifyToken(token);
    
    if (!decoded) {
      return res.status(401).json({ authenticated: false });
    }
    
    // ALWAYS fetch fresh user data from database to get current userType
    const userResults = await db.select().from(users).where(eq(users.email, decoded.email));
    if (userResults.length === 0) {
      // User no longer exists, clear their token
      res.clearCookie('auth_token');
      return res.status(401).json({ authenticated: false });
    }
    
    const user = userResults[0];
    
    // Return fresh user data from database (not from JWT token)
    return res.status(200).json({
      authenticated: true,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        userType: user.userType // This will always be the current value from database
      }
    });
  } catch (error) {
    console.error('Error checking authentication:', error);
    return res.status(500).json({ message: 'Failed to check authentication status' });
  }
});

export default authRouter;