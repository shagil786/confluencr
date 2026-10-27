import type { Pool } from 'pg';

export interface Account {
  id: string;
  name: string;
  balance: string;
  created_at: Date;
}
export interface Balance {
  account_id: string;
  balance: string;
}

export function formatBalance(minor: string): string {
  const amount = BigInt(minor);
  return `${amount / 100n}.${(amount % 100n).toString().padStart(2, '0')}`;
}

export async function createAccount(pool: Pool, name: string): Promise<Account> {
  const { rows } = await pool.query('INSERT INTO accounts (name) VALUES ($1) RETURNING id, name, balance_minor, created_at', [name]);
  const row = rows[0];
  return { id: row.id, name: row.name, balance: formatBalance(row.balance_minor), created_at: row.created_at };
}

export async function getBalance(pool: Pool, id: string): Promise<Balance | null> {
  const { rows } = await pool.query('SELECT id, balance_minor FROM accounts WHERE id = $1', [id]);
  return rows.length ? { account_id: rows[0].id, balance: formatBalance(rows[0].balance_minor) } : null;
}
