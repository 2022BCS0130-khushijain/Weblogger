import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';

const dir = path.dirname(fileURLToPath(import.meta.url));

export async function runMigrations() {
  const sql = fs.readFileSync(path.join(dir, '..', 'db', 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('✔ database schema is up to date');
}

// `npm run migrate` runs this file directly.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runMigrations().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
}
