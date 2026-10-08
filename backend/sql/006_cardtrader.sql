-- One CardTrader seller connection per account. The token is stored encrypted
-- (AES-256-GCM, key outside the database); the sync columns are the state of the
-- background import of /products/export.
CREATE TABLE cardtrader_connections (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  token_ciphertext bytea NOT NULL,
  app_id bigint NOT NULL,
  app_name text NOT NULL,
  ct_user_id bigint NOT NULL,
  connected_at timestamptz NOT NULL DEFAULT now(),
  sync_status text NOT NULL DEFAULT 'queued'
    CHECK (sync_status IN ('queued', 'running', 'done', 'failed')),
  sync_started_at timestamptz,
  sync_finished_at timestamptz,
  sync_error text,
  sync_stats jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- Copies imported from CardTrader keep their product id: the next sync updates
-- them in place and removes the ones no longer for sale.
ALTER TABLE inventory_items ADD COLUMN ct_product_id bigint;
CREATE UNIQUE INDEX inventory_items_ct_product_idx
  ON inventory_items (account_id, ct_product_id) WHERE ct_product_id IS NOT NULL;
