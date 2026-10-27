import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../src/app.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString || !new URL(connectionString).pathname.slice(1).endsWith('_test')) {
  throw new Error('TEST_DATABASE_URL must name a dedicated database ending in _test');
}
const pool = new Pool({ connectionString });
const app = createApp(pool);
const createdIds: string[] = [];

beforeAll(async () => {
  await pool.query(await readFile('db/001_init.sql', 'utf8'));
});
afterAll(async () => {
  if (createdIds.length) await pool.query('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [createdIds]);
  await pool.end();
});

describe('accounts', () => {
  it('creates an account with a generated ID, timestamp and zero balance and reads it', async () => {
    const response = await request(app).post('/accounts').send({ name: 'Asha' });
    expect(response.status).toBe(201);
    const account = response.body;
    if (account.id) createdIds.push(account.id);
    expect(account).toMatchObject({ name: 'Asha', balance: '0.00' });
    expect(account.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(Number.isNaN(Date.parse(account.created_at))).toBe(false);
    const balance = await request(app).get(`/accounts/${account.id}/balance`);
    expect(balance.status).toBe(200);
    expect(balance.body).toEqual({ account_id: account.id, balance: '0.00' });
  });

  it('returns 404 for a missing account and 400 for a malformed ID', async () => {
    expect((await request(app).get(`/accounts/${randomUUID()}/balance`)).status).toBe(404);
    expect((await request(app).get('/accounts/not-a-uuid/balance')).status).toBe(400);
  });

  it.each([{ name: '  ' }, { name: 'Asha', balance: '1.00' }, { name: 'Asha', extra: true }])('rejects invalid account input %o', async (body) => {
    expect((await request(app).post('/accounts').send(body)).status).toBe(400);
  });

  it('rejects a negative balance at the database boundary', async () => {
    await expect(pool.query('INSERT INTO accounts (name, balance_minor) VALUES ($1, $2)', ['invalid', -1])).rejects.toMatchObject({ code: '23514' });
  });
});
