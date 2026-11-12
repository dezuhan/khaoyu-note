DELETE FROM service_meta WHERE key = 'registration_mode';
ALTER TABLE accounts DROP COLUMN approved_at;
