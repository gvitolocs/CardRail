CREATE TABLE workspaces (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  scan_settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  revision bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE photos (
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  id text NOT NULL,
  sha256 text NOT NULL,
  bytes integer NOT NULL,
  data bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, id)
);
CREATE TABLE inventory_items (
  id text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  game text NOT NULL, name text NOT NULL, set_name text NOT NULL, number text NOT NULL,
  public_id text NOT NULL DEFAULT '', cardtrader_blueprint_id text NOT NULL DEFAULT '',
  art text NOT NULL DEFAULT '',
  language text NOT NULL, condition text NOT NULL, printing text NOT NULL,
  first_edition boolean NOT NULL DEFAULT false, signed boolean NOT NULL DEFAULT false,
  altered boolean NOT NULL DEFAULT false,
  purpose text NOT NULL DEFAULT 'sale' CHECK (purpose IN ('sale','collection')),
  quantity integer NOT NULL CHECK (quantity >= 0),
  price numeric(12,2) NOT NULL CHECK (price >= 0),
  currency text NOT NULL DEFAULT 'EUR',
  source text NOT NULL DEFAULT 'scan',
  location jsonb,
  photo_id text,
  listings jsonb NOT NULL DEFAULT '[]'::jsonb,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inventory_items_account_created_idx ON inventory_items (account_id, created_at DESC);
CREATE TABLE inventory_events (
  id text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now(),
  cause text NOT NULL,
  item_id text,
  name text NOT NULL DEFAULT '',
  delta integer NOT NULL DEFAULT 0
);
CREATE INDEX inventory_events_account_at_idx ON inventory_events (account_id, at DESC);
CREATE TABLE idempotency_keys (
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  key text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, key)
);
