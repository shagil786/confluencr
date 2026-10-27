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

it('rejects text that PostgreSQL cannot store or index', async () => {
  expect((await request(app).post('/accounts').send({ name: 'A\u0000B' })).status).toBe(400);
  const id = '00000000-0000-4000-8000-000000000001';
  const entry = { type: 'credit', amount: '1', description: 'ok', reference_id: 'ok' };
  for (const body of [{ ...entry, description: 'A\u0000B' }, { ...entry, reference_id: 'A\u0000B' }, { ...entry, reference_id: 'é'.repeat(129) }]) {
    expect((await request(app).post(`/accounts/${id}/transactions`).send(body)).status).toBe(400);
  }
  expect((await request(app).post('/transfers').send({ source_account_id: id, destination_account_id: '00000000-0000-4000-8000-000000000002', amount: '1', description: 'ok', reference_id: 'é'.repeat(129) })).status).toBe(400);
});
