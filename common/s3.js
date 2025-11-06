import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import crypto from 'crypto';
import { config } from './configs.js';

// Initialize S3 client
const s3Client = new S3Client({
  region: config.awsRegion,
  credentials: {
    accessKeyId: config.awsAccessKeyId,
    secretAccessKey: config.awsSecretAccessKey,
  },
});

const BUCKET_NAME = config.s3BucketName;

/**
 * Generate a pre-signed URL for uploading a photo to S3
 * @param {string} photoType - 'person' or 'aadhaar'
 * @param {number} locationId - Location ID
 * @param {number} tentIndex - Tent index
 * @param {number} blockIndex - Block index
 * @returns {Promise<{uploadUrl: string, key: string}>}
 */
export async function generateUploadUrl(photoType, locationId, tentIndex, blockIndex) {
  const timestamp = Date.now();
  const uuid = crypto.randomUUID();
  const key = `location-${locationId}/tent-${tentIndex}/block-${blockIndex}/${timestamp}-${uuid}-${photoType}.jpg`;

  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    ContentType: 'image/jpeg',
    ACL: 'private',
  });

  // URL valid for 5 minutes
  const uploadUrl = await getSignedUrl(s3Client, command, { 
    expiresIn: 300,
    signableHeaders: new Set(['host', 'content-type']),
  });

  return { uploadUrl, key };
}

/**
 * Generate a pre-signed URL for viewing/downloading a photo from S3
 * @param {string} key - S3 object key
 * @returns {Promise<string>} Pre-signed URL valid for 1 hour
 */
export async function generateViewUrl(key) {
  if (!key) return null;

  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
  });

  // URL valid for 1 hour
  return await getSignedUrl(s3Client, command, { expiresIn: 3600 });
}

/**
 * Generate view URLs for multiple photo keys
 * @param {Array<string>} keys - Array of S3 object keys
 * @returns {Promise<Array<string>>} Array of pre-signed URLs
 */
export async function generateViewUrls(keys) {
  return await Promise.all(keys.map(key => generateViewUrl(key)));
}
