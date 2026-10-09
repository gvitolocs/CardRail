CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX accounts_email_key ON accounts (lower(email));
CREATE TABLE sessions (
  token_sha256 bytea PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  client text NOT NULL CHECK (client IN ('web','ios')),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_account_idx ON sessions (account_id);
CREATE TABLE auth_failures (
  email_lower text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_failures_email_at_idx ON auth_failures (email_lower, at);
