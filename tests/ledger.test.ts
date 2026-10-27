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
  if (createdIds.length) {
    await pool.query('DELETE FROM transactions WHERE account_id = ANY($1::uuid[])', [createdIds]);
    await pool.query('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [createdIds]);
  }
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

async function account(): Promise<string> {
  const response = await request(app).post('/accounts').send({ name: 'Ledger test' });
  expect(response.status).toBe(201);
  createdIds.push(response.body.id);
  return response.body.id;
}

function post(id: string, body: object) {
  return request(app).post(`/accounts/${id}/transactions`).send(body);
}

function entry(type: string, amount: string, reference_id: string) {
  return { type, amount, description: 'Test entry', reference_id };
}

async function expectLedgerBalance(id: string, expected: string) {
  const balance = await request(app).get(`/accounts/${id}/balance`);
  expect(balance.body.balance).toBe(expected);
  const result = await pool.query(`SELECT COALESCE(SUM(CASE WHEN type = 'credit' THEN amount_minor ELSE -amount_minor END), 0)::text AS total FROM transactions WHERE account_id = $1`, [id]);
  const minor = BigInt(result.rows[0].total);
  expect(`${minor / 100n}.${(minor % 100n).toString().padStart(2, '0')}`).toBe(expected);
}

describe('transaction posting', () => {
  it('posts credits and debits atomically and rejects insufficient funds', async () => {
    const id = await account();
    const credit = await post(id, entry('credit', '100', 'credit'));
    expect(credit.status).toBe(201);
    expect(credit.body).toMatchObject({ account_id: id, type: 'credit', amount: '100.00', description: 'Test entry', reference_id: 'credit' });
    expect(credit.body.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(Number.isNaN(Date.parse(credit.body.created_at))).toBe(false);
    expect((await post(id, entry('debit', '30', 'debit'))).status).toBe(201);
    const rejected = await post(id, entry('debit', '150', 'too-much'));
    expect(rejected.status).toBe(409);
    expect(rejected.body.error.code).toBe('INSUFFICIENT_FUNDS');
    await expectLedgerBalance(id, '70.00');
  });

  it('rejects missing and malformed accounts and invalid requests without changing state', async () => {
    const id = await account();
    expect((await post(randomUUID(), entry('credit', '1', 'missing'))).status).toBe(404);
    expect((await post('bad-id', entry('credit', '1', 'bad'))).status).toBe(400);
    for (const body of [entry('credit', '0', 'a'), entry('credit', '-1', 'b'), entry('credit', '1.001', 'c'), entry('credit', '90071992547409.92', 'd'), entry('other', '1', 'e'), entry('credit', '1e2', 'f'), entry('credit', '1', ''), { ...entry('credit', '1', 'g'), description: ' ' }, { ...entry('credit', '1', 'h'), extra: true }, { ...entry('credit', '1', 'i'), amount: 1 }]) {
      expect((await post(id, body)).status).toBe(400);
    }
    await expectLedgerBalance(id, '0.00');
  });

  it('rejects same and changed retries but permits the reference on another account', async () => {
    const id = await account();
    const other = await account();
    const body = entry('credit', '10', 'shared');
    expect((await post(id, body)).status).toBe(201);
    for (const retry of [body, entry('debit', '100', 'shared')]) {
      const response = await post(id, retry);
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('DUPLICATE_REFERENCE');
    }
    expect((await post(other, body)).status).toBe(201);
    await expectLedgerBalance(id, '10.00');
    await expectLedgerBalance(other, '10.00');
  });

  it('serializes simultaneous identical posts', async () => {
    const id = await account();
    const body = entry('credit', '10', 'concurrent');
    const responses = await Promise.all([post(id, body), post(id, body)]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(responses.find((response) => response.status === 409)?.body.error.code).toBe('DUPLICATE_REFERENCE');
    await expectLedgerBalance(id, '10.00');
  });

  it('serializes concurrent debits so they cannot overspend', async () => {
    const id = await account();
    expect((await post(id, entry('credit', '100', 'initial'))).status).toBe(201);
    const responses = await Promise.all([post(id, entry('debit', '80', 'one')), post(id, entry('debit', '80', 'two'))]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(responses.find((response) => response.status === 409)?.body.error.code).toBe('INSUFFICIENT_FUNDS');
    await expectLedgerBalance(id, '20.00');
  });

  it('rolls back the balance when the ledger insert fails', async () => {
    const id = await account();
    expect((await post(id, entry('credit', '10', 'initial'))).status).toBe(201);
    const reference = randomUUID();
    const client = await pool.connect();
    try {
      await client.query(`CREATE FUNCTION pg_temp.fail_ledger_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$`);
      await client.query(`CREATE TRIGGER fail_ledger_insert BEFORE INSERT ON transactions FOR EACH ROW WHEN (NEW.reference_id = '${reference}') EXECUTE FUNCTION pg_temp.fail_ledger_insert()`);
      expect((await post(id, entry('credit', '5', reference))).status).toBe(500);
      await expectLedgerBalance(id, '10.00');
      const rows = await pool.query('SELECT reference_id FROM transactions WHERE account_id = $1', [id]);
      expect(rows.rows).toEqual([{ reference_id: 'initial' }]);
    } finally {
      await client.query('DROP TRIGGER IF EXISTS fail_ledger_insert ON transactions');
      client.release();
    }
  });

  it('rejects a credit that would overflow the balance', async () => {
    const id = await account();
    expect((await post(id, entry('credit', '90071992547409.91', 'max'))).status).toBe(201);
    expect((await post(id, entry('credit', '0.01', 'overflow'))).status).toBe(400);
    await expectLedgerBalance(id, '90071992547409.91');
  });
});
