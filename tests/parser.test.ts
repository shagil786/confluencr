import { expect, it } from 'vitest';
import request from 'supertest';
import type { Pool } from 'pg';
import { createApp } from '../src/app.js';

const app = createApp({} as Pool);

it('returns client errors for oversized and unsupported request bodies', async () => {
  const large = await request(app).post('/accounts').send({ name: 'a'.repeat(110_000) });
  expect(large.status).toBe(413);
  expect(large.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  const encoding = await request(app).post('/accounts').set('Content-Encoding', 'unsupported').send({ name: 'Asha' });
  expect(encoding.status).toBe(415);
  expect(encoding.body.error.code).toBe('UNSUPPORTED_ENCODING');
});
