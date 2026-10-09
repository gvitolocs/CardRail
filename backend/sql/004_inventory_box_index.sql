-- Scan commits look up the last occupied position of one box.
CREATE INDEX inventory_items_account_box_idx ON inventory_items (account_id, (location->>'box'));
