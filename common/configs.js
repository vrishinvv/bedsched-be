import dotenv from 'dotenv';
dotenv.config();

const config = {
    random: process.env.RANDOM || 10,
    port: process.env.PORT || 3001,
    databaseUrl: process.env.DATABASE_URL,
    frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
    nodeEnv: process.env.NODE_ENV || 'development',
    reservationTTLHours: Number(process.env.RESERVATION_TTL_HOURS || 7),
    jwtSecret: process.env.JWT_SECRET || 'dev-insecure-secret',
    // AWS S3 Configuration
    awsRegion: process.env.AWS_REGION || 'us-east-1',
    awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID,
    awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    s3BucketName: process.env.S3_BUCKET_NAME || 'bedsched-photos',
}

console.log(config)


export {
    config,
}
