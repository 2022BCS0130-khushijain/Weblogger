import pg from 'pg';
import { config } from './config.js';

// Postgres returns BIGINT as strings by default. Our ids are small, so turn them into numbers.
pg.types.setTypeParser(20, (v) => parseInt(v, 10));

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
pool.on('error', (e) => console.error('pg pool error', e.message));

export const query = (text, params) => pool.query(text, params);

/** Run several queries as one all-or-nothing transaction. */
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn((t, p) => client.query(t, p));
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
