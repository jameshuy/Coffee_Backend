import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

// Validate required environment variables
if (!process.env.SUPABASE_URL) {
  throw new Error('SUPABASE_URL environment variable is required');
}

if (!process.env.SUPABASE_ANON_KEY) {
  throw new Error('SUPABASE_ANON_KEY environment variable is required');
}

// Create Supabase client
export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
  {
    auth: {
      persistSession: false, // We don't need auth persistence for server-side operations
    },
  }
);

// Storage bucket name - you can customize this
export const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'images';

console.log('✅ Supabase client initialized successfully');
