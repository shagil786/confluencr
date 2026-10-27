import express, { type Express } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { createAccount, getBalance } from './accounts.js';
import { errorHandler, HttpError } from './errors.js';
import { createTransactionHandler, historyHandler } from './transactions.js';
import { transferHandler } from './transfers.js';

export function createApp(pool: Pool): Express {
  const app = express();
  app.use(express.json());
  app.post('/accounts', async (req, res, next) => {
    try {
      const { name } = z.object({ name: z.string().trim().min(1).refine((value) => !value.includes('\0')) }).strict().parse(req.body);
      res.status(201).json(await createAccount(pool, name));
    } catch (error) { next(error); }
  });
  app.get('/accounts/:id/balance', async (req, res, next) => {
    try {
      const id = z.string().uuid().parse(req.params.id);
      const balance = await getBalance(pool, id);
      if (!balance) throw new HttpError(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
      res.json(balance);
    } catch (error) { next(error); }
  });
  app.post('/accounts/:id/transactions', createTransactionHandler(pool));
  app.get('/accounts/:id/transactions', historyHandler(pool));
  app.post('/transfers', transferHandler(pool));
  app.use(errorHandler);
  return app;
}
