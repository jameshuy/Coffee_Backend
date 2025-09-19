import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import cors from "cors";

function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  console.log(`${formattedTime} [${source}] ${message}`);
}
import * as path from 'path';

import { databaseHealthMiddleware } from "./middleware/db-health";

import storageRoutes from "./storage-routes";

import { catalogueRouter } from "./catalogue-routes";
import cookieParser from 'cookie-parser';
import authRouter from './auth-routes';

import { stripeConnectRouter } from './stripe-connect-routes';
import * as objectStorage from './services/object-storage';

// Set BASE_URL environment variable for Replicate to access our images
const repl_id = process.env.REPL_ID || '';
const repl_owner = process.env.REPL_OWNER || '';
process.env.BASE_URL = process.env.BASE_URL || `https://${repl_id}.${repl_owner}.repl.co`;

const app = express();

app.use(cors({
  origin: [
    "http://localhost:5173",             // local frontend
    "https://coffee-frontend-tikz.onrender.com" // deployed frontend
  ],
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  credentials: true,
}));

// Add cache-busting headers to prevent browser caching issues after package updates
app.use((req, res, next) => {
  // Don't cache HTML, JS, CSS files in development
  if (req.url.endsWith('.html') || req.url.endsWith('.js') || req.url.endsWith('.css') || req.url === '/') {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

app.use(express.json({ limit: '50mb' })); // Increase JSON payload limit to 50MB for videos
app.use(express.urlencoded({ extended: false, limit: '50mb' })); // Also increase URL-encoded payload limit
app.use(cookieParser()); // Parse cookies for authentication

app.get('/restock', (req, res) => {
  console.log("received")
  res.redirect(301, 'https://forms.gle/JXT3dfNVcptfvi2UA');
});

// Add database health middleware
app.use(databaseHealthMiddleware); // Circuit breaker for DB issues

// All assets are served from Object Storage
// No need to serve any files from public directory

// Use storage routes for Object Storage
app.use('/api', storageRoutes);

// Use catalogue routes for public images
app.use('/api', catalogueRouter);

// Use authentication routes for user accounts
app.use('/api/auth', authRouter);

// Use Stripe Connect routes for payment processing
app.use('/api/stripe-connect', stripeConnectRouter);



app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  // Check Object Storage connection on startup (safely)
  try {
    await objectStorage.imageExists('test-connection');
    log('Object Storage connection verified successfully');
  } catch (error) {
    console.error('Warning: Object Storage connection issue:', (error as Error).message);
  }

  // Object Storage cleanup: No immediate cleanup required
  // Object Storage handles large volumes efficiently
  log('Object Storage cleanup: No immediate cleanup required');
  
  // Add cache-busting headers for development
  app.use((req, res, next) => {
    if (req.url.startsWith('/src/') || req.url.endsWith('.tsx') || req.url.endsWith('.ts')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
    next();
  });

  // Add debug endpoint to test server
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', message: 'Server is running' });
  });

  const server = await registerRoutes(app);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    res.status(status).json({ message });
    throw err;
  });

  // Frontend serving disabled: Only running backend APIs
  log(`Frontend integration disabled; backend API only mode`);

  // ALWAYS serve the app on port 5000
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = 5000;
  server.listen({
    port,
    host: "0.0.0.0",
    reusePort: true,
  }, () => {
    log(`serving on port ${port}`);
  });
})();
