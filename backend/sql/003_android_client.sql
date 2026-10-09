-- The Android app signs in as client 'android'.
ALTER TABLE sessions DROP CONSTRAINT sessions_client_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_client_check CHECK (client IN ('web', 'ios', 'android'));
