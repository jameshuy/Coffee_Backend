/**
 * Admin API routes for the admin panel
 */
import { Router, Request, Response } from 'express';
import { storage } from './storage';
import { requireAdminAuth, validateAdminCredentials, createAdminSession, destroyAdminSession, logAdminActivity, recordFailedLoginAttempt, resetFailedLoginAttempts, isIpLockedOut } from './auth-admin';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { Order } from '@shared/schema';

// Create a router for admin routes
const adminRouter = Router();

// Rate limiting for login attempts (simple in-memory implementation)
const loginRateLimit = new Map<string, { count: number, resetAt: number }>();
const MAX_LOGIN_ATTEMPTS = 10; // Max attempts per 15 minutes
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

function getClientIp(req: Request): string {
  return req.ip || 'unknown';
}

/**
 * Check and update rate limit for an IP
 * @param ip IP address to check
 * @returns Boolean indicating if rate limit is exceeded
 */
function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const rateData = loginRateLimit.get(ip) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
  
  // Reset counter if window has passed
  if (rateData.resetAt < now) {
    rateData.count = 1;
    rateData.resetAt = now + RATE_LIMIT_WINDOW_MS;
  } else {
    rateData.count += 1;
  }
  
  loginRateLimit.set(ip, rateData);
  
  return rateData.count > MAX_LOGIN_ATTEMPTS;
}

// Login validation schema
const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1)
});

// Admin login route
adminRouter.post('/login', async (req: Request, res: Response) => {
  const ip = getClientIp(req);
  
  // Check for rate limiting
  if (checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many login attempts. Please try again later.' });
  }
  
  // Check for IP lockout due to failed attempts
  if (isIpLockedOut(ip)) {
    return res.status(403).json({ error: 'Account temporarily locked due to too many failed attempts. Please try again later.' });
  }
  
  try {
    // Validate request body
    const { username, password } = loginSchema.parse(req.body);
    
    // Validate credentials
    if (validateAdminCredentials(username, password)) {
      // Reset failed attempts on successful login
      resetFailedLoginAttempts(ip);
      
      // Create a session
      const sessionToken = createAdminSession();
      
      // Set session cookie (httpOnly for security)
      res.cookie('adminSessionToken', sessionToken, {
        httpOnly: true,
        secure: true, // Secure in production
        maxAge: 2 * 60 * 60 * 1000, // 2 hours
        sameSite: 'none'
      });
      
      // Log the successful login
      logAdminActivity('LOGIN', 'Successful admin login', ip);
      
      return res.status(200).json({ success: true });
    } else {
      // Record failed attempt
      recordFailedLoginAttempt(ip);
      
      // Log the failed attempt
      logAdminActivity('LOGIN_FAILED', `Failed login attempt with username: ${username}`, ip);
      
      return res.status(401).json({ error: 'Invalid credentials' });
    }
  } catch (error) {
    // Validation error or other exception
    return res.status(400).json({ error: 'Invalid request' });
  }
});

// Admin logout route
adminRouter.post('/logout', requireAdminAuth, (req: Request, res: Response) => {
  const ip = getClientIp(req);
  const sessionToken = req.cookies?.adminSessionToken;
  
  if (sessionToken) {
    // Destroy the session
    destroyAdminSession(sessionToken);
    
    // Clear the cookie
    res.clearCookie('adminSessionToken');
    
    // Log the logout
    logAdminActivity('LOGOUT', 'Admin logged out', ip);
  }
  
  return res.status(200).json({ success: true });
});

// Get all orders route
adminRouter.get('/orders', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const ip = getClientIp(req);
    logAdminActivity('VIEW_ORDERS', 'Admin viewed all orders', ip);
    
    const orders = await storage.getOrders();
    
    // Sort orders by createdAt in descending order (newest first)
    orders.sort((a, b) => {
      if (!a.createdAt || !b.createdAt) return 0;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
    
    return res.status(200).json({ orders });
  } catch (error) {
    console.error('Error fetching orders:', error);
    return res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// Get all catalogue orders route
adminRouter.get('/catalogue-orders', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const ip = getClientIp(req);
    logAdminActivity('VIEW_CATALOGUE_ORDERS', 'Admin viewed all catalogue orders', ip);
    
    const orders = await storage.getCatalogueOrders();
    
    // Sort orders by createdAt in descending order (newest first)
    orders.sort((a, b) => {
      if (!a.createdAt || !b.createdAt) return 0;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
    
    return res.status(200).json({ orders });
  } catch (error) {
    console.error('Error fetching catalogue orders:', error);
    return res.status(500).json({ error: 'Failed to fetch catalogue orders' });
  }
});

// Get order by ID route
adminRouter.get('/orders/:id', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const ip = getClientIp(req);
    
    const orderId = parseInt(id, 10);
    if (isNaN(orderId)) {
      return res.status(400).json({ error: 'Invalid order ID' });
    }
    
    const order = await storage.getOrderById(orderId);
    
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    logAdminActivity('VIEW_ORDER', `Admin viewed order ID: ${orderId}`, ip);
    
    return res.status(200).json({ order });
  } catch (error) {
    console.error('Error fetching order:', error);
    return res.status(500).json({ error: 'Failed to fetch order' });
  }
});

// Get catalogue order by ID route
adminRouter.get('/catalogue-orders/:id', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const ip = getClientIp(req);
    
    const orderId = parseInt(id, 10);
    if (isNaN(orderId)) {
      return res.status(400).json({ error: 'Invalid catalogue order ID' });
    }
    
    const orderData = await storage.getCatalogueOrderById(orderId);
    
    if (!orderData) {
      return res.status(404).json({ error: 'Catalogue order not found' });
    }
    
    logAdminActivity('VIEW_CATALOGUE_ORDER', `Admin viewed catalogue order ID: ${orderId}`, ip);
    
    return res.status(200).json(orderData);
  } catch (error) {
    console.error('Error fetching catalogue order:', error);
    return res.status(500).json({ error: 'Failed to fetch catalogue order' });
  }
});

// Update order status route
adminRouter.patch('/orders/:id/status', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const ip = getClientIp(req);
    
    const orderId = parseInt(id, 10);
    if (isNaN(orderId)) {
      return res.status(400).json({ error: 'Invalid order ID' });
    }
    
    // Validate status
    const validStatuses = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    
    const updated = await storage.updateOrderStatus(orderId, status);
    
    if (!updated) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    logAdminActivity('UPDATE_STATUS', `Admin updated order ${orderId} status to ${status}`, ip);
    
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error updating order status:', error);
    return res.status(500).json({ error: 'Failed to update order status' });
  }
});

// Update catalogue order status route
adminRouter.patch('/catalogue-orders/:id/status', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const ip = getClientIp(req);
    
    const orderId = parseInt(id, 10);
    if (isNaN(orderId)) {
      return res.status(400).json({ error: 'Invalid catalogue order ID' });
    }
    
    // Validate status
    const validStatuses = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    
    const updated = await storage.updateCatalogueOrderStatus(orderId, status);
    
    if (!updated) {
      return res.status(404).json({ error: 'Catalogue order not found' });
    }
    
    logAdminActivity('UPDATE_CATALOGUE_STATUS', `Admin updated catalogue order ${orderId} status to ${status}`, ip);
    
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error updating catalogue order status:', error);
    return res.status(500).json({ error: 'Failed to update catalogue order status' });
  }
});

// Export orders as CSV route
adminRouter.get('/orders/export/csv', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const ip = getClientIp(req);
    const orders = await storage.getOrders();
    
    // Sort orders by createdAt in descending order (newest first)
    orders.sort((a, b) => {
      if (!a.createdAt || !b.createdAt) return 0;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
    
    // Generate CSV content
    let csv = 'Order ID,Confirmation ID,Created At,Customer Name,Email,Address,City,Postal Code,Country,Style,Status,Amount\n';
    
    for (const order of orders) {
      // Escape field values that might contain commas
      const escapeCsvField = (field: any) => {
        if (field === null || field === undefined) return '';
        const fieldStr = String(field);
        return fieldStr.includes(',') ? `"${fieldStr}"` : fieldStr;
      };
      
      csv += [
        order.id,
        order.confirmationId,
        order.createdAt,
        escapeCsvField(`${order.firstName} ${order.lastName}`),
        order.email,
        escapeCsvField(order.address),
        escapeCsvField(order.city),
        order.zipCode, // Using zipCode instead of postalCode
        order.country,
        order.style,
        order.status || 'pending',
        (order.amount || 29.95).toFixed(2) // Default to 29.95 CHF if amount is null
      ].join(',') + '\n';
    }
    
    // Set response headers
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="orders-${Date.now()}.csv"`);
    
    logAdminActivity('EXPORT_CSV', `Admin exported ${orders.length} orders as CSV`, ip);
    
    return res.status(200).send(csv);
  } catch (error) {
    console.error('Error exporting orders as CSV:', error);
    return res.status(500).json({ error: 'Failed to export orders' });
  }
});

export default adminRouter;