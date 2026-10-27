import type { RequestHandler } from 'express';
import type { Pool } from 'pg';
import { transfer } from './ledger.js';

export function transferHandler(pool: Pool): RequestHandler {
  return async (req, res, next) => {
    try {
      res.status(201).json(await transfer(pool, req.body));
    } catch (error) { next(error); }
  };
}
