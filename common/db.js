import pg from 'pg'
import { config } from "./configs.js"

const { Pool } = pg

const db = new Pool({
    connectionString: config.databaseUrl,
    ssl: {
        rejectUnauthorized: false
    },
    // Optimized pool settings for Neon
    min: 5, // Keep minimum 5 connections alive (prevents eviction)
    max: 10, // Maximum connections
    idleTimeoutMillis: 0, // Don't disconnect idle clients (min will keep them alive)
    connectionTimeoutMillis: 10000, // Timeout for acquiring connection
});

// Warm up the pool on startup - create 5 connections eagerly
// (min doesn't auto-create, it only prevents eviction after they're created)
(async () => {
    try {
        console.log('[DB] Warming up connection pool...');
        const warmupStart = Date.now();
        const warmupPromises = [];
        // Create 5 warm connections - these will stay alive due to min: 5
        for (let i = 0; i < 5; i++) {
            warmupPromises.push(db.query('SELECT 1'));
        }
        await Promise.all(warmupPromises);
        console.log(`[DB] Pool warmed up with 5 connections in ${Date.now() - warmupStart}ms - will stay alive indefinitely`);
    } catch (err) {
        console.error('[DB] Pool warmup failed:', err.message);
    }
})();

async function execQuery(text, params = []) {
  const startTime = Date.now();
  try {
    const acquireStart = Date.now();
    const client = await db.connect();
    const acquireTime = Date.now() - acquireStart;
    
    const queryStart = Date.now();
    const results = await client.query(text, params);
    const queryTime = Date.now() - queryStart;
    
    client.release();
    
    const totalTime = Date.now() - startTime;
    
    // Log slow queries
    if (totalTime > 100) {
      console.log(`[DB SLOW] Total: ${totalTime}ms | Acquire: ${acquireTime}ms | Query: ${queryTime}ms | SQL: ${text.substring(0, 100)}...`);
    }
    
    return results;

  } catch (err) {
    console.error('Query error:', err.message);
    throw err;
  }
}



export { db, execQuery };
