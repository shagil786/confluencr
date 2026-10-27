import { Pool } from 'pg';

export function createPool(): Pool {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  return new Pool({ connectionString: process.env.DATABASE_URL });
}
