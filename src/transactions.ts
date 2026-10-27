import type { RequestHandler } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { postTransaction } from './ledger.js';

export function createTransactionHandler(pool: Pool): RequestHandler {
  return async (req, res, next) => {
    try {
      const id = z.string().uuid().parse(req.params.id);
      res.status(201).json(await postTransaction(pool, id, req.body));
    } catch (error) { next(error); }
  };
}
