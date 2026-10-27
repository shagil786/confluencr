# Transaction Ledger API

A local Node.js and PostgreSQL ledger with accounts, credit/debit transactions, paginated history, and atomic transfers. See [API documentation](docs/api.md) for requests, responses, and assumptions.

## Requirements

Node.js 22.12 or newer, npm, Docker with Compose, and curl. The Compose defaults bind PostgreSQL to localhost port 5432; set `POSTGRES_PORT` in `.env` and use the same port in both database URLs if that port is already in use.

## Start

From the project directory, choose an unused Compose project name to isolate its container and volume. Existing volumes retain their data:

```sh
export COMPOSE_PROJECT_NAME=confluencr_ledger
npm ci
test -e .env || cp .env.example .env
docker compose up -d postgres
```

Run `docker compose exec -T postgres pg_isready -U ledger -d ledger` until PostgreSQL accepts connections, then create the separate test database and apply the schema to the application database:

```sh
docker compose exec -T postgres createdb -U ledger ledger_test
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U ledger -d ledger < db/001_init.sql
npm run build
npm start
```

The server reads `.env` and listens on port 3000 by default. The schema adds the transfer table and link column to databases created by the earlier schema without removing existing data; other incompatible schema changes require a migration. Omit `createdb` if the dedicated test database already exists.

## Test

In a separate terminal, export the test URL (the test runner does not load `.env` automatically):

```sh
set -a; . ./.env; set +a
npm test
```

The test database name must end in `_test`. Tests apply the schema and delete only accounts and records they create. Use a dedicated database: tests create temporary triggers on the transactions table, so do not run them against shared or application data.

Stop the Node server with Ctrl-C, then stop PostgreSQL without deleting its volume:

```sh
docker compose stop postgres
```

## Try the core flow

```sh
ACCOUNT=$(curl -sS -X POST http://localhost:3000/accounts -H 'Content-Type: application/json' -d '{"name":"Asha"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
curl -sS -X POST "http://localhost:3000/accounts/$ACCOUNT/transactions" -H 'Content-Type: application/json' -d '{"type":"credit","amount":"100.00","description":"Initial credit","reference_id":"credit-001"}'
curl -sS "http://localhost:3000/accounts/$ACCOUNT/balance"
curl -sS "http://localhost:3000/accounts/$ACCOUNT/transactions?type=credit&page=1&limit=20"
```

The balance is `100.00` and history contains the credit. Python 3 is needed to extract the ID. For an existing PostgreSQL installation, create separate application and test databases, set both URLs in `.env`, and apply the schema with `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/001_init.sql`.

## Design and limits

Amounts are decimal strings converted to integer minor units without rounding. Each account row is locked while posting; balance changes and entries commit or roll back together. Transfers lock both accounts in ID order and commit both entries and balances together. History uses a repeatable-read snapshot for its count and page. Offset pagination can shift between requests, and equal timestamps are ordered by ID rather than commit order.

This is an assessment service for local synthetic data. It has no authentication or tenant isolation; do not expose it publicly or use real customer data. It does not provide production banking, external settlement, fees, currency conversion, or overdrafts.
