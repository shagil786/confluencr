CREATE TABLE IF NOT EXISTS accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  balance_minor bigint NOT NULL DEFAULT 0 CHECK (balance_minor BETWEEN 0 AND 9007199254740991),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id),
  type text NOT NULL CHECK (type IN ('credit', 'debit')),
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 1 AND 9007199254740991),
  description text NOT NULL,
  reference_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, reference_id)
);
CREATE INDEX IF NOT EXISTS transactions_account_history_idx ON transactions (account_id, created_at DESC, id DESC);
