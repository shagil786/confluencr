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
    await pool.query('DELETE FROM transfers WHERE source_account_id = ANY($1::uuid[]) OR destination_account_id = ANY($1::uuid[])', [createdIds]);
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

  it('accepts amounts with leading zeros', async () => {
    const id = await account();
    expect((await post(id, entry('credit', '0000000000000001.00', 'zeros'))).status).toBe(201);
    await expectLedgerBalance(id, '1.00');
  });

  it('waits for an account lock before posting', async () => {
    const id = await account();
    const locker = await pool.connect();
    await locker.query('BEGIN');
    await locker.query('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [id]);
    const pending = post(id, entry('credit', '1', 'lock-test')).then((result) => result);
    try {
      let waiting = false;
      for (let i = 0; i < 100 && !waiting; i++) {
        const result = await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE 'SELECT balance_minor FROM accounts%'");
        waiting = (result.rowCount ?? 0) > 0;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(true);
    } finally {
      await locker.query('ROLLBACK');
      locker.release();
    }
    expect((await pending).status).toBe(201);
    await expectLedgerBalance(id, '1.00');
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

describe('transaction history', () => {
  it('orders both types by timestamp and ID and filters with pagination metadata', async () => {
    const id = await account();
    const credit = await post(id, entry('credit', '10', 'first'));
    const debit = await post(id, entry('debit', '2', 'second'));
    const last = await post(id, entry('credit', '1', 'third'));
    expect([credit.status, debit.status, last.status]).toEqual([201, 201, 201]);
    await pool.query("UPDATE transactions SET created_at = CASE WHEN reference_id = 'first' THEN '2020-01-01'::timestamptz ELSE '2021-01-01'::timestamptz END WHERE account_id = $1", [id]);
    const tied = [debit.body.id, last.body.id].sort().reverse();
    const first = await request(app).get(`/accounts/${id}/transactions?page=1&limit=2`);
    expect(first.status).toBe(200);
    expect(first.body.data.map((row: { id: string }) => row.id)).toEqual(tied);
    expect(first.body.pagination).toEqual({ page: 1, limit: 2, total_records: 3, total_pages: 2 });
    const second = await request(app).get(`/accounts/${id}/transactions?page=2&limit=2`);
    expect(second.body.data.map((row: { id: string }) => row.id)).toEqual([credit.body.id]);
    expect(second.body.data[0]).toMatchObject({ account_id: id, type: 'credit', amount: '10.00', description: 'Test entry', reference_id: 'first' });
    const credits = await request(app).get(`/accounts/${id}/transactions?type=credit`);
    expect(credits.body.data.map((row: { id: string }) => row.id)).toEqual([last.body.id, credit.body.id]);
    expect(credits.body.pagination).toEqual({ page: 1, limit: 20, total_records: 2, total_pages: 1 });
    const debits = await request(app).get(`/accounts/${id}/transactions?type=debit`);
    expect(debits.body.data.map((row: { id: string }) => row.id)).toEqual([debit.body.id]);
    expect(debits.body.pagination.total_records).toBe(1);
    const huge = await request(app).get(`/accounts/${id}/transactions?page=9007199254740991&limit=100`);
    expect(huge.status).toBe(200);
    expect(huge.body.data).toEqual([]);
    const beyond = await request(app).get(`/accounts/${id}/transactions?page=3&limit=2`);
    expect(beyond.body).toEqual({ data: [], pagination: { page: 3, limit: 2, total_records: 3, total_pages: 2 } });
  });

  it('returns empty history, distinguishes missing accounts, and validates queries', async () => {
    const id = await account();
    const empty = await request(app).get(`/accounts/${id}/transactions`);
    expect(empty.body).toEqual({ data: [], pagination: { page: 1, limit: 20, total_records: 0, total_pages: 0 } });
    expect((await request(app).get(`/accounts/${randomUUID()}/transactions`)).status).toBe(404);
    expect((await request(app).get('/accounts/bad/transactions')).status).toBe(400);
    for (const query of ['type=other', 'page=0', 'page=-1', 'page=1.5', 'page=abc', 'page=9007199254740992', 'limit=0', 'limit=101', 'limit=1.5', 'limit=', 'extra=x', 'page=1&page=2']) {
      expect((await request(app).get(`/accounts/${id}/transactions?${query}`)).status, query).toBe(400);
    }
  });

  it('uses the same snapshot for count and rows when a transaction commits between them', async () => {
    const id = await account();
    expect((await post(id, entry('credit', '1', 'before'))).status).toBe(201);
    const historyPool = new Pool({ connectionString });
    const realConnect = historyPool.connect.bind(historyPool);
    historyPool.connect = (async () => {
      const client = await realConnect();
      const query = client.query.bind(client);
      client.query = (async (...args: Parameters<typeof query>) => {
        const result = await query(...args);
        if (typeof args[0] === 'string' && /count\s*\(/i.test(args[0])) {
          expect((await post(id, entry('credit', '1', 'during'))).status).toBe(201);
        }
        return result;
      }) as typeof client.query;
      return client;
    }) as typeof historyPool.connect;
    try {
      const response = await request(createApp(historyPool)).get(`/accounts/${id}/transactions`);
      expect(response.status).toBe(200);
      expect(response.body.pagination.total_records).toBe(1);
      expect(response.body.data.map((row: { reference_id: string }) => row.reference_id)).toEqual(['before']);
      expect((await request(app).get(`/accounts/${id}/transactions`)).body.pagination.total_records).toBe(2);
    } finally {
      await historyPool.end();
    }
  });
});


function transferBody(source_account_id: string, destination_account_id: string, amount: string, reference_id: string) {
  return { source_account_id, destination_account_id, amount, description: 'Transfer', reference_id };
}
function transferRequest(body: object) { return request(app).post('/transfers').send(body); }

describe('transfers', () => {
  it('moves funds with linked entries and preserves both ledger sums', async () => {
    const source = await account(), destination = await account();
    expect((await post(source, entry('credit', '100', 'initial'))).status).toBe(201);
    const response = await transferRequest(transferBody(source, destination, '30', 'transfer'));
    expect(response.status).toBe(201);
    expect(response.body.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(response.body.debit).toMatchObject({ account_id: source, type: 'debit', amount: '30.00', reference_id: 'transfer' });
    expect(response.body.credit).toMatchObject({ account_id: destination, type: 'credit', amount: '30.00', reference_id: 'transfer' });
    const linked = await pool.query('SELECT transfer_id FROM transactions WHERE id = ANY($1::uuid[])', [[response.body.debit.id, response.body.credit.id]]);
    expect(linked.rows).toEqual([{ transfer_id: response.body.id }, { transfer_id: response.body.id }]);
    await expectLedgerBalance(source, '70.00');
    await expectLedgerBalance(destination, '30.00');
  });

  it('rejects missing accounts, same account, invalid input and insufficient funds', async () => {
    const source = await account(), destination = await account(), missing = randomUUID();
    expect((await transferRequest(transferBody(missing, destination, '1', 'a'))).status).toBe(404);
    expect((await transferRequest(transferBody(source, missing, '1', 'b'))).status).toBe(404);
    expect((await transferRequest(transferBody(source, source, '1', 'c'))).status).toBe(400);
    expect((await transferRequest(transferBody(source, destination, '0.001', 'd'))).status).toBe(400);
    expect((await transferRequest(transferBody(source, destination, '1', 'e'))).body.error.code).toBe('INSUFFICIENT_FUNDS');
    await expectLedgerBalance(source, '0.00');
    await expectLedgerBalance(destination, '0.00');
  });

  it('rejects duplicate references on either account and destination overflow', async () => {
    const source = await account(), destination = await account();
    expect((await post(source, entry('credit', '10', 'source-ref'))).status).toBe(201);
    expect((await post(destination, entry('credit', '90071992547409.91', 'destination-ref'))).status).toBe(201);
    for (const ref of ['source-ref', 'destination-ref']) {
      const response = await transferRequest(transferBody(source, destination, '1', ref));
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('DUPLICATE_REFERENCE');
    }
    expect((await transferRequest(transferBody(source, destination, '1', 'overflow'))).status).toBe(400);
    await expectLedgerBalance(source, '10.00');
    await expectLedgerBalance(destination, '90071992547409.91');
  });

  it('completes opposite-direction transfers without deadlock', async () => {
    const a = await account(), b = await account();
    expect((await post(a, entry('credit', '100', 'a'))).status).toBe(201);
    expect((await post(b, entry('credit', '100', 'b'))).status).toBe(201);
    const results = await Promise.all([transferRequest(transferBody(a, b, '30', 'ab')), transferRequest(transferBody(b, a, '40', 'ba'))]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    await expectLedgerBalance(a, '110.00');
    await expectLedgerBalance(b, '90.00');
  });

  it('rolls back both balances and entries when the second insert fails', async () => {
    const source = await account(), destination = await account();
    expect((await post(source, entry('credit', '10', 'initial'))).status).toBe(201);
    const reference = randomUUID();
    const client = await pool.connect();
    try {
      await client.query(`CREATE FUNCTION pg_temp.fail_transfer_credit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$`);
      await client.query(`CREATE TRIGGER fail_transfer_credit BEFORE INSERT ON transactions FOR EACH ROW WHEN (NEW.reference_id = '${reference}' AND NEW.type = 'credit') EXECUTE FUNCTION pg_temp.fail_transfer_credit()`);
      expect((await transferRequest(transferBody(source, destination, '5', reference))).status).toBe(500);
      await expectLedgerBalance(source, '10.00');
      await expectLedgerBalance(destination, '0.00');
      expect((await pool.query('SELECT id FROM transactions WHERE reference_id = $1', [reference])).rowCount).toBe(0);
      expect((await pool.query('SELECT id FROM transfers WHERE reference_id = $1', [reference])).rowCount).toBe(0);
    } finally {
      await client.query('DROP TRIGGER IF EXISTS fail_transfer_credit ON transactions');
      client.release();
    }
  });
});
