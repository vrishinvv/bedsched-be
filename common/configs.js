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
}

console.log(config)


export {
    config,
}
