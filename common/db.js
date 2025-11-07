import pg from 'pg'
import { config } from "./configs.js"

const { Pool } = pg

const db = new Pool({
    connectionString: config.databaseUrl,
    ssl: {
        rejectUnauthorized: false
    },
    // Optimized pool settings for Neon serverless
    min: 2, // Keep 2 connections warm to avoid cold starts
    max: 10, // Maximum connections
    idleTimeoutMillis: 50000, // 50 seconds - safe buffer under Neon's 60s timeout
    connectionTimeoutMillis: 10000, // Timeout for acquiring connection
    // Add keepalive to detect dead connections faster
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000, // Start sending keepalive packets after 10s
});

// Critical: Handle pool-level errors to prevent crashes
db.on('error', (err, client) => {
    console.error('[DB POOL ERROR] Unexpected error on idle client:', err.message);
    // Don't crash the app - pool will create new connections automatically
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
    console.log('[DB] SIGTERM received, closing pool...');
    db.end(() => {
        console.log('[DB] Pool closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('[DB] SIGINT received, closing pool...');
    db.end(() => {
        console.log('[DB] Pool closed');
        process.exit(0);
    });
});

// Warm up the pool on startup - create connections for immediate use
(async () => {
    try {
        console.log('[DB] Testing connection...');
        const result = await db.query('SELECT NOW()');
        console.log('[DB] Connection successful');
    } catch (err) {
        console.error('[DB] Connection test failed:', err.message);
        // Don't exit - let the app try to reconnect on first real query
    }
})();

async function execQuery(text, params = []) {
  const startTime = Date.now();
  let client;
  try {
    const acquireStart = Date.now();
    client = await db.connect();
    const acquireTime = Date.now() - acquireStart;
    
    const queryStart = Date.now();
    const results = await client.query(text, params);
    const queryTime = Date.now() - queryStart;
    
    client.release();
    
    const totalTime = Date.now() - startTime;
    
    // Log slow queries
    if (totalTime > 100) {
      console.log(`[DB SLOW] Total: ${totalTime}ms | Acquire: ${acquireTime}ms | Query: ${queryTime}ms`);
    }
    
    return results;

  } catch (err) {
    // Release client back to pool if we acquired it
    if (client) {
      try {
        client.release(true); // Pass true to destroy the connection on error
      } catch (releaseErr) {
        console.error('[DB] Error releasing client:', releaseErr.message);
      }
    }
    
    console.error('[DB ERROR]', {
      message: err.message,
      code: err.code
    });
    throw err;
  }
}



export { db, execQuery };
