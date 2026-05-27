import pg from 'pg';
import { getConfig } from '../config.ts';

const { Pool } = pg;

const config = getConfig();

export const db = new Pool({
  connectionString: config.databaseUrl,
});

db.on('error', (err) => {
  console.error('Unexpected Postgres pool error:', err);
});
