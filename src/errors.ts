import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof ZodError || (error instanceof SyntaxError && 'status' in error && error.status === 400)) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid request' } });
  } else if (error instanceof HttpError) {
    res.status(error.status).json({ error: { code: error.code, message: error.message } });
  } else {
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  }
};
