import type { RequestHandler } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { postTransaction, type Transaction } from './ledger.js';
import { formatBalance } from './accounts.js';
import { HttpError } from './errors.js';

export function createTransactionHandler(pool: Pool): RequestHandler {
  return async (req, res, next) => {
    try {
      const id = z.string().uuid().parse(req.params.id);
      res.status(201).json(await postTransaction(pool, id, req.body));
    } catch (error) { next(error); }
  };
}

export interface HistoryQuery {
  type?: 'credit' | 'debit';
  page: number;
  limit: number;
}

export interface HistoryPage {
  data: Transaction[];
  pagination: { page: number; limit: number; total_records: number; total_pages: number };
}

const positiveInteger = z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(Number.MAX_SAFE_INTEGER));
const historySchema = z.object({
  type: z.enum(['credit', 'debit']).optional(),
  page: positiveInteger.default(1),
  limit: positiveInteger.pipe(z.number().max(100)).default(20),
}).strict();

export async function getHistory(pool: Pool, accountId: string, query: HistoryQuery): Promise<HistoryPage | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const account = await client.query('SELECT 1 FROM accounts WHERE id = $1', [accountId]);
    if (!account.rowCount) {
      await client.query('COMMIT');
      return null;
    }
    const values = query.type ? [accountId, query.type] : [accountId];
    const where = `account_id = $1${query.type ? ' AND type = $2' : ''}`;
    const count = await client.query(`SELECT COUNT(*) AS total FROM transactions WHERE ${where}`, values);
    const rows = await client.query(
      `SELECT id, account_id, type, amount_minor, description, reference_id, created_at FROM transactions WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, query.limit, ((BigInt(query.page) - 1n) * BigInt(query.limit)).toString()],
    );
    await client.query('COMMIT');
    const total_records = Number(count.rows[0].total);
    return {
      data: rows.rows.map((row) => ({ id: row.id, account_id: row.account_id, type: row.type, amount: formatBalance(row.amount_minor), description: row.description, reference_id: row.reference_id, created_at: row.created_at })),
      pagination: { page: query.page, limit: query.limit, total_records, total_pages: Math.ceil(total_records / query.limit) },
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export function historyHandler(pool: Pool): RequestHandler {
  return async (req, res, next) => {
    try {
      const id = z.string().uuid().parse(req.params.id);
      const query = historySchema.parse(req.query);
      const history = await getHistory(pool, id, query);
      if (!history) throw new HttpError(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
      res.json(history);
    } catch (error) { next(error); }
  };
}
