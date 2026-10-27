import type { Pool } from 'pg';
import { z } from 'zod';
import { formatBalance } from './accounts.js';
import { HttpError } from './errors.js';

const maxMinor = 9007199254740991n;
const transactionSchema = z.object({
  type: z.enum(['credit', 'debit']),
  amount: z.string().refine((value) => {
    if (!/^\d+(?:\.\d{1,2})?$/.test(value)) return false;
    const [rawWhole, fraction = ''] = value.split('.');
    const whole = rawWhole.replace(/^0+/, '') || '0';
    if (whole.length > 14) return false;
    const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
    return minor > 0n && minor <= maxMinor;
  }),
  description: z.string().trim().min(1),
  reference_id: z.string().trim().min(1),
}).strict();

export type TransactionInput = z.input<typeof transactionSchema>;
export interface Transaction {
  id: string;
  account_id: string;
  type: 'credit' | 'debit';
  amount: string;
  description: string;
  reference_id: string;
  created_at: Date;
}

export async function postTransaction(pool: Pool, accountId: string, input: TransactionInput): Promise<Transaction> {
  const { type, amount, description, reference_id } = transactionSchema.parse(input);
  const [rawWhole, fraction = ''] = amount.split('.');
  const whole = rawWhole.replace(/^0+/, '') || '0';
  const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const account = await client.query('SELECT balance_minor FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
    if (!account.rowCount) throw new HttpError(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
    const duplicate = await client.query('SELECT 1 FROM transactions WHERE account_id = $1 AND reference_id = $2', [accountId, reference_id]);
    if (duplicate.rowCount) throw new HttpError(409, 'DUPLICATE_REFERENCE', 'Reference already exists');
    const balance = BigInt(account.rows[0].balance_minor) + (type === 'credit' ? minor : -minor);
    if (balance < 0n) throw new HttpError(409, 'INSUFFICIENT_FUNDS', 'Insufficient funds');
    if (balance > maxMinor) throw new HttpError(400, 'VALIDATION_ERROR', 'Balance exceeds maximum');
    await client.query('UPDATE accounts SET balance_minor = $1 WHERE id = $2', [balance.toString(), accountId]);
    const result = await client.query('INSERT INTO transactions (account_id, type, amount_minor, description, reference_id) VALUES ($1, $2, $3, $4, $5) RETURNING id, account_id, type, amount_minor, description, reference_id, created_at', [accountId, type, minor.toString(), description, reference_id]);
    await client.query('COMMIT');
    const row = result.rows[0];
    return { id: row.id, account_id: row.account_id, type: row.type, amount: formatBalance(row.amount_minor), description: row.description, reference_id: row.reference_id, created_at: row.created_at };
  } catch (error) {
    await client.query('ROLLBACK');
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505' && 'constraint' in error && error.constraint === 'transactions_account_id_reference_id_key') {
      throw new HttpError(409, 'DUPLICATE_REFERENCE', 'Reference already exists');
    }
    throw error;
  } finally {
    client.release();
  }
}
