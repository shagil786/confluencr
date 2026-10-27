# Transaction Ledger API

A local Node.js and PostgreSQL ledger with accounts, credit/debit transactions, paginated history, and atomic transfers. See [API documentation](docs/api.md) for requests, responses, and assumptions.

## Requirements

Node.js 22.12 or newer, npm, Docker with Compose, and curl. The Compose defaults bind PostgreSQL to localhost port 5432; set `POSTGRES_PORT` in `.env` and use the same port in both database URLs if that port is already in use.

## Start

From the project directory:

```sh
npm ci
cp .env.example .env
docker compose up -d postgres
```

Wait until PostgreSQL accepts connections, then create the separate test database and apply the schema to the application database:

```sh
docker compose exec postgres createdb -U ledger ledger_test
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U ledger -d ledger < db/001_init.sql
npm run build
npm start
```

The server reads `.env` and listens on port 3000 by default. The schema can be reapplied to an existing Task 1–3 database without dropping its data; it adds the transfer table and link column if missing.

## Test

In a separate terminal, export the test URL (the test runner does not load `.env` automatically):

```sh
export TEST_DATABASE_URL=postgresql://ledger:ledger@localhost:5432/ledger_test
npm test
```

The test database name must end in `_test`. Tests apply the schema and delete only accounts and records they create. Use a dedicated database: tests create temporary triggers on the transactions table, so do not run them against shared or application data.

Stop the Node server with Ctrl-C, then stop PostgreSQL without deleting its volume:

```sh
docker compose stop postgres
```

## Design and limits

Amounts are decimal strings converted to integer minor units without rounding. Each account row is locked while posting; balance changes and entries commit or roll back together. Transfers lock both accounts in ID order to avoid opposing lock order. History uses a repeatable-read snapshot for its count and page. Offset pagination can shift between requests, and equal timestamps are ordered by ID rather than commit order.

This is an assessment service for local synthetic data. It has no authentication or tenant isolation; do not expose it publicly or use real customer data. It does not provide production banking, external settlement, fees, currency conversion, or overdrafts.
