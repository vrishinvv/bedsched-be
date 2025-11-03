import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';
dotenv.config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function getLocations() {
  try {
    const result = await pool.query('SELECT id, name FROM locations ORDER BY id');
    console.log('Locations:', JSON.stringify(result.rows, null, 2));
    await pool.end();
  } catch (err) {
    console.error('Error:', err);
    await pool.end();
    process.exit(1);
  }
}

getLocations();
