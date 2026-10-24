export async function runInTransaction(pool, operation) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('[DB] Rollback failed:', rollbackError.message);
    }
    throw error;
  } finally {
    client.release();
  }
}

