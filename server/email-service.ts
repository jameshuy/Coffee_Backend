import { Resend } from 'resend';
import { Order } from './shared/schema';

// Ensure RESEND_API_KEY is provided in environment
if (!process.env.RESEND_API_KEY) {
  console.warn('RESEND_API_KEY is not set. Email functionality will not work properly.');
}

// Default admin email address - can be overridden by environment variable
const DEFAULT_ADMIN_EMAIL = 'orders@coffeeandprints.com';

// Initialize Resend client
const resend = new Resend(process.env.RESEND_API_KEY);

/**
 * Send an order confirmation email to a customer
 * 
 * @param email Customer's email address
 * @param orderNumber Order confirmation ID
 * @param quantity Optional quantity of posters ordered (defaults to 1)
 * @returns Promise with email send result
 */
/**
 * Send a verification code email for the micro-payment system
 * 
 * @param email User's email address
 * @param verificationCode 6-digit verification code
 * @returns Promise with email send result
 */
export async function sendVerificationEmail(email: string, verificationCode: string) {
  try {
    const { data, error } = await resend.emails.send({
      from: 'Coffee&Prints <verification@coffeeandprints.com>',
      to: email,
      subject: 'Your Verification Code for Coffee&Prints',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eaeaea; border-radius: 8px;">
          <h1 style="color: #333; text-align: center;">Verify Your Email</h1>
          
          <p style="font-size: 16px; line-height: 1.5; color: #555;">
            Thanks for using Coffee&Prints. Please use the verification code below to complete your verification:
          </p>
          
          <div style="background-color: #f8f8f8; padding: 15px; border-radius: 6px; margin: 20px 0; text-align: center;">
            <p style="font-size: 32px; font-weight: bold; letter-spacing: 5px; margin: 5px 0; color: #000;">${verificationCode}</p>
          </div>
          
          <p style="font-size: 16px; line-height: 1.5; color: #555;">
            This code will expire in 10 minutes. Please don't share this code with anyone.
          </p>
          
          <p style="font-size: 14px; line-height: 1.5; color: #777; margin-top: 30px;">
            If you didn't request this code, you can safely ignore this email.
          </p>
          
          <div style="text-align: center; margin-top: 30px;">
            <p style="font-size: 14px; color: #999; margin-bottom: 5px;">Thank you for choosing</p>
            <p style="font-size: 18px; font-weight: bold; margin: 0; color: #333;">Coffee&Prints</p>
          </div>
        </div>
      `,
    });

    if (error) {
      console.error('Failed to send verification email:', error);
      return { success: false, error };
    }

    console.log('Verification email sent to:', email);
    return { success: true, data };
  } catch (error) {
    console.error('Error sending verification email:', error);
    return { success: false, error };
  }
}

/**
 * Send a notification email to admin when a new order is received
 * 
 * @param order The new order that was just created (can be either Order or CatalogueOrder type)
 * @returns Promise with email send result
 */
export async function sendNewOrderNotificationEmail(order: any) {
  try {
    // Use admin email from environment or fall back to default
    const adminEmail = process.env.ADMIN_EMAIL || DEFAULT_ADMIN_EMAIL;
    
    // Log which email we're using
    console.log(`Sending admin notification to: ${adminEmail}`);
    console.log(`ADMIN_EMAIL environment variable is: ${process.env.ADMIN_EMAIL || 'not set'}`);
    
    // Format the order date
    const orderDate = order.createdAt 
      ? new Date(order.createdAt).toLocaleString('en-CH', { 
          year: 'numeric', 
          month: 'long', 
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        })
      : 'N/A';
    
    // Format full name
    const fullName = `${order.firstName} ${order.lastName}`;
    
    // Amount with currency - format as CHF (order.amount is already in CHF format)
    const amountValue = order.amount || 29.95; // Default to current poster price
    const amount = `CHF ${amountValue.toFixed(2)}`;
    
    // Determine order type (Single or Catalogue) based on confirmation ID
    const isFromCatalogue = order.confirmationId?.startsWith('CAT-') || false;
    const orderType = isFromCatalogue ? 'Catalogue Order' : 'Single Order';
    
    const { data, error } = await resend.emails.send({
      from: 'Coffee&Prints <orders@coffeeandprints.com>',
      to: adminEmail,
      subject: `🔔 New ${orderType} Received: #${order.confirmationId}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eaeaea; border-radius: 8px;">
          <h1 style="color: #f1b917; text-align: center;">New ${orderType} Notification</h1>
          
          <p style="font-size: 16px; line-height: 1.5; color: #555;">
            A new order has been received and is ready for processing.
          </p>
          
          <div style="background-color: #f8f8f8; padding: 15px; border-radius: 6px; margin: 20px 0;">
            <h2 style="margin-top: 0; color: #333; font-size: 18px;">Order Details</h2>
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="padding: 8px 0; border-bottom: 1px solid #eee; width: 40%;"><strong>Order ID:</strong></td>
                <td style="padding: 8px 0; border-bottom: 1px solid #eee;">${order.confirmationId}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; border-bottom: 1px solid #eee;"><strong>Date:</strong></td>
                <td style="padding: 8px 0; border-bottom: 1px solid #eee;">${orderDate}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; border-bottom: 1px solid #eee;"><strong>Amount:</strong></td>
                <td style="padding: 8px 0; border-bottom: 1px solid #eee;">${amount}</td>
              </tr>

            </table>
          </div>
          
          <!-- Customer information section removed as requested -->
          
          <div style="text-align: center; margin-top: 30px;">
            <a href="${process.env.APP_URL || 'https://coffeeandprints.com'}/admin/login" 
               style="background-color: #f1b917; color: #000; padding: 12px 24px; text-decoration: none; 
                      border-radius: 4px; display: inline-block; font-weight: bold;">
              View in Admin Panel
            </a>
          </div>
        </div>
      `,
    });

    if (error) {
      console.error('Failed to send admin notification email:', error);
      return { success: false, error };
    }

    console.log('Admin notification email sent for order:', order.confirmationId);
    return { success: true, data };
  } catch (error) {
    console.error('Error sending admin notification email:', error);
    return { success: false, error };
  }
}

export async function sendOrderConfirmationEmail(email: string, orderNumber: string, quantity: number = 1) {
  try {
    const { data, error } = await resend.emails.send({
      from: 'Coffee&Prints <info@coffeeandprints.com>',
      to: email,
      subject: 'Your Poster Order Confirmation',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eaeaea; border-radius: 8px;">
          <h1 style="color: #333; text-align: center;">Thank You for Your Order!</h1>
          
          <p style="font-size: 16px; line-height: 1.5; color: #555;">
            We've received your poster order and we're excited to create your gallery-grade print. 
            Your order is now being processed by our printing team in Switzerland.
          </p>
          
          <div style="background-color: #f8f8f8; padding: 15px; border-radius: 6px; margin: 20px 0;">
            <p style="font-size: 14px; margin: 0; color: #666;">Order Number:</p>
            <p style="font-size: 18px; font-weight: bold; margin: 5px 0 0; color: #000;">${orderNumber}</p>
          </div>
          
          <div style="background-color: #f8f8f8; padding: 15px; border-radius: 6px; margin: 20px 0;">
            <p style="font-size: 14px; margin: 0; color: #666;">Order Details:</p>
            <p style="font-size: 16px; margin: 5px 0 0; color: #000;">${quantity} x A3 Gallery-Grade Poster${quantity > 1 ? 's' : ''} (297x420mm)</p>
          </div>
          
          <p style="font-size: 16px; line-height: 1.5; color: #555;">
            Your poster${quantity > 1 ? 's' : ''} will be printed on premium paper and shipped to your specified address.
          </p>
          
          <div style="text-align: center; margin-top: 30px;">
            <p style="font-size: 14px; color: #999; margin-bottom: 5px;">Thank you for choosing</p>
            <p style="font-size: 18px; font-weight: bold; margin: 0; color: #333;">Coffee&Prints</p>
          </div>
        </div>
      `,
    });

    if (error) {
      console.error('Failed to send confirmation email:', error);
      return { success: false, error };
    }

    console.log('Order confirmation email sent:', data);
    return { success: true, data };
  } catch (error) {
    console.error('Error sending confirmation email:', error);
    return { success: false, error };
  }
}

/**
 * Send a partner inquiry email to admin
 * 
 * @param name Partner's name
 * @param cafeName Café name
 * @param email Partner's email
 * @param location Café location
 * @param address Café address for package delivery
 * @returns Promise with email send result
 */
export async function sendPartnerInquiryEmail(name: string, cafeName: string, email: string, location: string, address: string) {
  try {
    const { data, error } = await resend.emails.send({
      from: 'Coffee&Prints <partnerships@coffeeandprints.com>',
      to: 'partners@coffeeandprints.com',
      subject: 'New Partnership Inquiry',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eaeaea; border-radius: 8px;">
          <h1 style="color: #333; text-align: center;">New Partnership Inquiry</h1>
          
          <p style="font-size: 16px; line-height: 1.5; color: #555;">
            A new café owner is interested in partnering with Coffee&Prints:
          </p>
          
          <div style="background-color: #f8f8f8; padding: 15px; border-radius: 6px; margin: 20px 0;">
            <p style="font-size: 14px; margin: 0 0 10px 0; color: #666;"><strong>Contact Person:</strong></p>
            <p style="font-size: 16px; margin: 0; color: #000;">${name}</p>
          </div>
          
          <div style="background-color: #f8f8f8; padding: 15px; border-radius: 6px; margin: 20px 0;">
            <p style="font-size: 14px; margin: 0 0 10px 0; color: #666;"><strong>Café Name:</strong></p>
            <p style="font-size: 16px; margin: 0; color: #000;">${cafeName}</p>
          </div>
          
          <div style="background-color: #f8f8f8; padding: 15px; border-radius: 6px; margin: 20px 0;">
            <p style="font-size: 14px; margin: 0 0 10px 0; color: #666;"><strong>Email:</strong></p>
            <p style="font-size: 16px; margin: 0; color: #000;">${email}</p>
          </div>
          
          <div style="background-color: #f8f8f8; padding: 15px; border-radius: 6px; margin: 20px 0;">
            <p style="font-size: 14px; margin: 0 0 10px 0; color: #666;"><strong>Location:</strong></p>
            <p style="font-size: 16px; margin: 0; color: #000;">${location}</p>
          </div>
          
          <div style="background-color: #f8f8f8; padding: 15px; border-radius: 6px; margin: 20px 0;">
            <p style="font-size: 14px; margin: 0 0 10px 0; color: #666;"><strong>Café Address:</strong></p>
            <p style="font-size: 16px; margin: 0; color: #000;">${address}</p>
          </div>
          
          <p style="font-size: 16px; line-height: 1.5; color: #555;">
            Please follow up with this partnership opportunity within 24 hours.
          </p>
          
          <div style="text-align: center; margin-top: 30px;">
            <p style="font-size: 18px; font-weight: bold; margin: 0; color: #333;">Coffee&Prints Partnership Team</p>
          </div>
        </div>
      `,
    });

    if (error) {
      console.error('Failed to send partner inquiry email:', error);
      return { success: false, error };
    }

    console.log('Partner inquiry email sent:', data);
    return { success: true, data };
  } catch (error) {
    console.error('Error sending partner inquiry email:', error);
    return { success: false, error };
  }
}
