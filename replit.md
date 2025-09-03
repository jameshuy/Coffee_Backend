# Coffee&Prints - AI-Powered Poster Creation Platform

## Overview

Coffee&Prints is a full-stack web application that transforms user-uploaded photos into artistic A3 posters using AI-powered style transfer. The platform features a marketplace for buying and selling limited edition posters, user authentication with subscription management, and a complete order fulfillment system. Built with React/TypeScript frontend and Express.js backend, it integrates multiple external services including AI image generation, payment processing, and cloud storage.

## System Architecture

### Frontend Architecture
- **Framework**: React 18 with TypeScript and Vite for development/building
- **UI Library**: Radix UI components with Tailwind CSS for styling
- **State Management**: TanStack Query for server state, React Context for authentication and cart
- **Routing**: Wouter for lightweight client-side routing
- **Payments**: Stripe Elements for checkout and Stripe Connect for marketplace payouts

### Backend Architecture
- **Framework**: Express.js with TypeScript in ESM modules
- **Database**: PostgreSQL with Drizzle ORM for type-safe database operations
- **Authentication**: JWT-based with bcrypt password hashing and cookie storage
- **File Storage**: Replit Object Storage for all image assets (originals, generated, thumbnails)
- **Image Processing**: Sharp library for image manipulation and thumbnail generation

### Key Technologies
- **AI Integration**: Replicate API for style transfer and poster generation
- **Email Service**: Resend for transactional emails (order confirmations, verification codes)
- **Payment Processing**: Stripe for subscriptions and marketplace transactions
- **Analytics**: Google Analytics 4 for user behavior tracking
- **Deployment**: Replit with autoscale deployment target

## Key Components

### User Management System
- Password-based authentication with JWT tokens
- User types: normal users and artistic collective members
- Email verification system with 6-digit codes
- Subscription management with Stripe integration
- Stripe Connect integration for sellers to receive payouts

### Image and Video Generation Pipeline
1. **Upload**: Users upload images or videos (up to 10 seconds) via drag-and-drop or file picker
2. **Frame Selection**: For videos, users scrub through timeline to select desired frame with precise timestamp
3. **Processing**: EXIF orientation normalization and image validation
4. **Storage**: Original images and videos stored in Object Storage with user-specific paths
5. **AI Generation**: Style transfer using Replicate API with customizable prompts
6. **Post-processing**: Border addition and thumbnail generation
7. **Video Merge**: Frame-perfect video-to-poster transitions using FFmpeg at exact user-selected timestamp
8. **Delivery**: Generated images and merged videos served via Object Storage

### Marketplace System
- Public catalogue of user-generated posters
- Support for unlimited prints (29.95 CHF) and limited editions (custom pricing)
- Edition numbering and inventory tracking for limited releases
- Shopping cart functionality with Stripe checkout
- Search and filtering capabilities

### Order Management
- Complete order tracking from generation to fulfillment
- Admin panel for order management and status updates
- Automated email notifications for customers and administrators
- Support for both poster orders and catalogue purchases

## Data Flow

### Image Generation Flow
```
User Upload → Object Storage → Database Record → AI Processing → 
Generated Image → Thumbnail Creation → Object Storage → User Dashboard
```

### Marketplace Purchase Flow
```
Browse Catalogue → Add to Cart → Stripe Checkout → 
Order Creation → Admin Notification → Order Fulfillment
```

### User Authentication Flow
```
Registration → Email Verification → JWT Token → 
Secure API Access → Session Management
```

## External Dependencies

### Core Services
- **Replit Object Storage**: Primary file storage for all images
- **Replicate API**: AI-powered image style transfer
- **Stripe**: Payment processing and Connect marketplace
- **Resend**: Transactional email service
- **Neon Database**: PostgreSQL hosting with connection pooling

### Development Dependencies
- **Drizzle Kit**: Database migrations and schema management
- **Sharp**: High-performance image processing
- **React GA4**: Google Analytics integration
- **Various UI Libraries**: Radix UI, Lucide React icons, Framer Motion

## Deployment Strategy

### Production Environment
- **Platform**: Replit with autoscale deployment
- **Build Process**: Vite for frontend, esbuild for backend bundling
- **Environment Variables**: Secure storage of API keys and configuration
- **Port Configuration**: Port 5000 internally mapped to port 80 externally
- **Asset Serving**: All static assets served from Object Storage

### Development Environment
- **Hot Reloading**: Vite dev server with HMR
- **Database**: PostgreSQL 16 module with automatic provisioning
- **Package Management**: npm with lock file for consistent dependencies
- **Process Management**: tsx for TypeScript execution in development

### Performance Optimizations
- **Database**: Connection pooling, query caching, and retry mechanisms
- **Images**: Thumbnail generation, lazy loading, and CDN-like serving
- **Frontend**: Code splitting, lazy loading of routes, and optimized bundle sizes
- **Caching**: NodeCache for API responses and pre-signed URL caching

## Changelog
- June 23, 2025. Initial setup
- June 30, 2025. Implemented video upload feature with frame selection
- June 30, 2025. Streamlined creation flow by removing image resizer step
- June 30, 2025. Implemented frame-perfect video-to-poster merge feature with FFmpeg transitions
- July 2, 2025. Major codebase cleanup - removed zombie code, unused files, and FFmpeg dependencies. Transitioned to frontend-only video transitions
- July 2, 2025. Implemented Instagram/TikTok-style feed feature with video-to-poster transitions, infinite scroll, and authentication redirect updates
- July 2, 2025. Fixed feed display issues by implementing proper video file serving, adding video existence checking, and configuring fallback modes for missing video files
- July 2, 2025. Production cleanup - removed 14 unused components and 9 unused npm packages (canny-edge-detector, jimp, ssim.js, memorystore, passport, passport-local, openid-client, upscaler, @upscalerjs/esrgan-medium)
- July 4, 2025. Fixed poster display timing in feed to ensure 3-second duration regardless of frame position
- July 4, 2025. Added poster names to feed items matching catalogue modal styling
- July 4, 2025. Investigating video data not saving to database - added debug logging to track video path flow
- July 4, 2025. Fixed critical bug where old video would persist when user goes back from style picker and uploads new video - now properly clearing all video state
- July 4, 2025. Added debug logging to identify video path not being sent to database - found state management issue where uploadedVideoPath might be null at generation time
- July 4, 2025. Fixed video path propagation by passing video path to VideoFrameSelector component and including it in frame selection data
- July 4, 2025. Fixed mobile video upload race condition by tracking upload state and preventing frame selection until video upload completes - shows visual indicators for upload status
- July 4, 2025. Replaced video upload text labels with loading spinner overlay on upload box matching image generation UI pattern
- July 4, 2025. Updated landing page slideshow to play video clip as first item instead of static image, then cycle through remaining poster images
- July 6, 2025. Fixed catalogue share link thumbnail loading issue by updating availability endpoint to include image URLs
- July 7, 2025. Major update - removed unlimited editions, all posters are now limited edition only with minimum price of 29.95 CHF. Converted existing unlimited editions to limited editions with 10 supply. Removed supplyType from database schema and all related code.
- July 9, 2025. Implemented completely free poster generation - removed all credit checks and subscription prompts from generation flow. Updated all users to artistic_collective type for unlimited access. Updated UI to show ∞ credits for all users.
- July 9, 2025. UI improvements - removed 'Edition' text from poster overlays (now shows '#2/10' instead of 'Edition #2/10'). Updated landing page Try it button to 'Try it, it's free'. Added paintbrush icon to catalogue button for unauthenticated users on feed page with improved spacing.
- January 5, 2025. Major branding update - changed main website title from "poster the moment" to "Coffee&Prints" with "Prints" displayed in gold color (#f1b917). Updated all navigation headings across the application.
- January 5, 2025. Updated landing page subtext to align with Coffee&Prints branding - changed first line to "Turn great moments into collectible posters" and second line to "Get featured in one of our partnered cafés" to reflect café partnership business model.
- January 5, 2025. Reverted website background from red back to black across all pages (Home, Feed, Create, Dashboard, Admin, Navigation, etc.) while maintaining Coffee&Prints branding and updated subtext.
- August 8, 2025. Complete domain rebrand from posterthemoment.com to coffeeandprints.com - updated all email services (Resend), contact information in privacy policy/terms, share text, watermarks, and admin panel URLs. All email addresses now use @coffeeandprints.com domain.
- August 9, 2025. Implemented comprehensive mobile responsive design for /partners page - compressed content spacing, reduced font sizes, and optimized layout for video visibility. Added consistent page subheadings across all pages: "Catalogue", "Moments" (Feed), "Create", and "Partners" positioned to the right of Coffee&Prints branding with matching typography and styling.
- August 9, 2025. Updated landing page slideshow with new artistic poster images while keeping Ferrari video and red pop art Ferrari as first two items. Added vintage palm building, tropical palms, Mediterranean building, coastal scene, and pop art coffee cup images.
- August 9, 2025. Created PartnerModal component with exact styling matching LoginModal for café partnership inquiries. Added API endpoint /api/partner-inquiry with email notifications to admin. Integrated modal into Partners page with 'Partner with us' button.
- August 9, 2025. Replaced Partners page background video with café hero image showing actual Coffee&Prints poster displayed in real café setting. Removed title text, made navigation and footer backgrounds transparent, and optimized image display with proper responsive fitting using background-size: contain to show complete image without cropping.
- August 9, 2025. Updated Partners page text formatting with superscript "1/4th of a square meter" and reduced mobile background overlay opacity from 50% to 30% for better image visibility while maintaining desktop readability.
- August 9, 2025. Fixed partner inquiry email routing from info@coffeeandprints.com to partners@coffeeandprints.com for proper partnership inquiry handling.
- January 10, 2025. **CRITICAL BUG FIX**: Complete removal of all credit checking that was blocking free poster generation. Fixed three endpoints:
  1. `/api/generate-gpt-image` - Removed credit enforcement that was returning 402 "No credits remaining" errors
  2. `/api/generation-credits` - Now returns unlimited credits (999) for all verified users
  3. `/api/use-generation-credit` - Returns infinite credits without deducting anything
  Poster generation is now truly free for all verified users as intended since July 9, 2025.
- January 10, 2025. Fixed JSON parsing error in poster generation - Removed dead error handling code after apiRequest (which already throws on non-OK responses). Added HTML detection to catch when server returns HTML with 200 status in production. Response is now read as text first, checked for HTML markers, then parsed as JSON. Shows user-friendly error message instead of raw HTML in toast notifications.

## User Preferences

Preferred communication style: Simple, everyday language.