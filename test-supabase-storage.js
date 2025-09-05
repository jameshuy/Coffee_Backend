import { supabase, STORAGE_BUCKET } from './server/config/supabase.js';
import dotenv from 'dotenv';

dotenv.config();

async function testSupabaseStorage() {
  console.log('🧪 Testing Supabase Storage Integration...');
  console.log('Bucket:', STORAGE_BUCKET);
  
  try {
    // Test 1: List buckets to see if our bucket exists
    console.log('\n1. Checking if bucket exists...');
    const { data: buckets, error: bucketsError } = await supabase.storage.listBuckets();
    
    if (bucketsError) {
      console.error('❌ Error listing buckets:', bucketsError);
      return;
    }
    
    console.log('📦 Available buckets:', buckets.map(b => b.name));
    
    const bucketExists = buckets.some(bucket => bucket.name === STORAGE_BUCKET);
    if (!bucketExists) {
      console.log(`⚠️  Bucket '${STORAGE_BUCKET}' does not exist. Creating it...`);
      
      const { data: newBucket, error: createError } = await supabase.storage.createBucket(STORAGE_BUCKET, {
        public: false, // Keep private for security
        allowedMimeTypes: ['image/jpeg', 'image/png', 'image/gif', 'video/mp4', 'video/webm'],
        fileSizeLimit: 50 * 1024 * 1024 // 50MB limit
      });
      
      if (createError) {
        console.error('❌ Error creating bucket:', createError);
        return;
      }
      
      console.log('✅ Bucket created successfully:', newBucket);
    } else {
      console.log('✅ Bucket exists!');
    }
    
    // Test 2: Try to upload a small test file
    console.log('\n2. Testing file upload...');
    const testContent = Buffer.from('Hello from Supabase Storage!');
    const testPath = 'test/hello.txt';
    
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(testPath, testContent, {
        contentType: 'text/plain',
        upsert: true
      });
    
    if (uploadError) {
      console.error('❌ Error uploading test file:', uploadError);
      return;
    }
    
    console.log('✅ Test file uploaded successfully:', uploadData);
    
    // Test 3: Try to download the test file
    console.log('\n3. Testing file download...');
    const { data: downloadData, error: downloadError } = await supabase.storage
      .from(STORAGE_BUCKET)
      .download(testPath);
    
    if (downloadError) {
      console.error('❌ Error downloading test file:', downloadError);
      return;
    }
    
    const text = await downloadData.text();
    console.log('✅ Test file downloaded successfully:', text);
    
    // Test 4: Generate a signed URL
    console.log('\n4. Testing signed URL generation...');
    const { data: urlData, error: urlError } = await supabase.storage
      .from(STORAGE_BUCKET)
      .createSignedUrl(testPath, 3600);
    
    if (urlError) {
      console.error('❌ Error generating signed URL:', urlError);
      return;
    }
    
    console.log('✅ Signed URL generated:', urlData.signedUrl);
    
    // Test 5: Clean up test file
    console.log('\n5. Cleaning up test file...');
    const { error: deleteError } = await supabase.storage
      .from(STORAGE_BUCKET)
      .remove([testPath]);
    
    if (deleteError) {
      console.error('❌ Error deleting test file:', deleteError);
      return;
    }
    
    console.log('✅ Test file deleted successfully');
    
    console.log('\n🎉 All Supabase Storage tests passed!');
    
  } catch (error) {
    console.error('❌ Unexpected error during testing:', error);
  }
}

testSupabaseStorage();

