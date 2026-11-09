import pg from 'pg';
import { config } from './config.js';

// Neon/managed Postgres: put ?sslmode=require in DATABASE_URL and pg will use TLS.
export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

// Run fn inside one transaction. Anything thrown rolls everything back,
// including audit rows written in the same transaction.
export async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection already broken */
    }
    throw err;
  } finally {
    client.release();
  }
}
