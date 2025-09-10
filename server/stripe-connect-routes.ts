import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { db } from './db';
import { users } from '@shared/schema';
import { eq } from 'drizzle-orm';
import { verifyToken } from './auth-service';

declare global {
  namespace Express {
    interface Request {
      user?: { userId: number; email: string; userType: string };
      session?: any;
    }
  }
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

// Check if we're using test or live mode
const isTestMode = process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_');
console.log(`Stripe mode: ${isTestMode ? 'TEST' : 'LIVE'}`);

// For live mode in development, we need to provide a publicly accessible HTTPS URL
function getBaseUrl(req: Request): string {
  if (isTestMode) {
    // Test mode can use HTTP in development
    return process.env.NODE_ENV === 'production' 
      ? `https://${req.get('host')}` 
      : `http://${req.get('host')}`;
  } else {
    // Live mode always requires HTTPS
    if (process.env.NODE_ENV === 'production') {
      return `https://${req.get('host')}`;
    } else {
      // In development with live mode, we need to use a public HTTPS URL
      // Use the Replit deployment domain
      const replicodeUrl = process.env.REPLIT_DOMAINS
        ? `https://${process.env.REPLIT_DOMAINS}`
        : `https://${req.get('host')}`;
      return replicodeUrl;
    }
  }
}

export const stripeConnectRouter = Router();

/**
 * Middleware to authenticate user using JWT token (same as auth routes)
 */
async function requireAuth(req: Request, res: Response, next: Function) {
  try {
    const token = req.cookies?.auth_token;
    
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const decoded = verifyToken(token);
    
    if (!decoded) {
      return res.status(401).json({ error: 'Invalid authentication token' });
    }
    
    // Set user info for the route handlers
    req.user = {
      userId: decoded.userId,
      email: decoded.email,
      userType: decoded.userType
    };
    
    next();
  } catch (error) {
    console.error('Authentication error:', error);
    return res.status(401).json({ error: 'Authentication failed' });
  }
}

/**
 * Create Stripe Connect account and onboarding link
 */
stripeConnectRouter.post('/create-connect-account', requireAuth, async (req: Request, res: Response) => {
  try {
    const userEmail = req.user!.email;
    
    // Get user from database
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, userEmail))
      .limit(1);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Check if user already has a Stripe Connect account
    if (user.stripeConnectAccountId) {
      return res.status(400).json({ error: 'User already has a Stripe Connect account' });
    }

    // Create Stripe Express account for individual creators
    const account = await stripe.accounts.create({
      type: 'express',
      business_type: 'individual', // Most poster creators are individuals, not businesses
      email: userEmail,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      metadata: {
        user_id: user.id.toString(),
        username: user.username,
      },
    });

    // Update user with Stripe account ID
    await db
      .update(users)
      .set({ stripeConnectAccountId: account.id })
      .where(eq(users.email, userEmail));

    // Create account link for onboarding
    // const baseUrl = getBaseUrl(req);
    const baseUrl = process.env.FRONTEND_URL;
    console.log(`Creating onboarding link with base URL: ${baseUrl}`);
    
    const accountLink = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: `${baseUrl}/settings?refresh=true`,
      return_url: `${baseUrl}/settings?success=true`,
      type: 'account_onboarding',
    });

    res.json({
      accountId: account.id,
      onboardingUrl: accountLink.url,
    });
  } catch (error) {
    console.error('Error creating Stripe Connect account:', error);
    res.status(500).json({ error: 'Failed to create Stripe Connect account' });
  }
});

/**
 * Get user's Stripe Connect account status
 */
stripeConnectRouter.get('/connect-status', requireAuth, async (req: Request, res: Response) => {
  try {
    const userEmail = req.user!.email;
    
    // Get user from database
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, userEmail))
      .limit(1);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!user.stripeConnectAccountId) {
      return res.json({
        hasAccount: false,
        onboardingComplete: false,
        payoutsEnabled: false,
      });
    }

    // Get account details from Stripe
    const account = await stripe.accounts.retrieve(user.stripeConnectAccountId);
    
    const payoutsEnabled = account.payouts_enabled || false;
    const onboardingComplete = account.details_submitted || false;

    // Update user record with latest status
    await db
      .update(users)
      .set({
        stripeConnectEnabled: payoutsEnabled,
        stripeOnboardingComplete: onboardingComplete,
      })
      .where(eq(users.email, userEmail));

    res.json({
      hasAccount: true,
      accountId: user.stripeConnectAccountId,
      onboardingComplete,
      payoutsEnabled,
      chargesEnabled: account.charges_enabled || false,
    });
  } catch (error) {
    console.error('Error getting Stripe Connect status:', error);
    res.status(500).json({ error: 'Failed to get Stripe Connect status' });
  }
});

/**
 * Create login link for Stripe Express Dashboard
 */
stripeConnectRouter.post('/dashboard-link', requireAuth, async (req: Request, res: Response) => {
  try {
    const userEmail = req.user!.email;
    
    // Get user from database
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, userEmail))
      .limit(1);

    if (!user || !user.stripeConnectAccountId) {
      return res.status(404).json({ error: 'Stripe Connect account not found' });
    }

    console.log(`Creating dashboard login link for account: ${user.stripeConnectAccountId}`);

    // Create login link
    const loginLink = await stripe.accounts.createLoginLink(user.stripeConnectAccountId);

    console.log(`Dashboard login link created successfully`);

    res.json({
      url: loginLink.url,
    });
  } catch (error) {
    console.error('Error creating dashboard link:', error);
    if (error instanceof Error) {
      console.error('Error details:', error.message);
    }
    res.status(500).json({ error: 'Failed to create dashboard link' });
  }
});

/**
 * Refresh onboarding link
 */
stripeConnectRouter.post('/refresh-onboarding', requireAuth, async (req: Request, res: Response) => {
  try {
    const userEmail = req.user!.email;
    
    // Get user from database
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, userEmail))
      .limit(1);

    if (!user || !user.stripeConnectAccountId) {
      return res.status(404).json({ error: 'Stripe Connect account not found' });
    }

    // Create new account link for onboarding
    // const baseUrl = getBaseUrl(req);
    const baseUrl = process.env.FRONTEND_URL;
    console.log(`Refreshing onboarding link with base URL: ${baseUrl}`);
    
    const accountLink = await stripe.accountLinks.create({
      account: user.stripeConnectAccountId,
      refresh_url: `${baseUrl}/settings?refresh=true`,
      return_url: `${baseUrl}/settings?success=true`,
      type: 'account_onboarding',
    });

    res.json({
      onboardingUrl: accountLink.url,
    });
  } catch (error) {
    console.error('Error refreshing onboarding link:', error);
    res.status(500).json({ error: 'Failed to refresh onboarding link' });
  }
});