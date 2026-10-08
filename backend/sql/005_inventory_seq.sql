-- Short numeric handle for each copy: the compact inventory sends it instead of the UUID id.
ALTER TABLE inventory_items ADD COLUMN seq bigserial;
CREATE UNIQUE INDEX inventory_items_seq_key ON inventory_items (seq);
