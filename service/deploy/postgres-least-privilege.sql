-- Least-privilege PostgreSQL role for the Khaoyu Note team profile.
-- Run this as the database owner (or a superuser) AFTER migrations have been applied:
--   psql "$KHAOYU_SERVICE_DATABASE_URL_OWNER" \
--     -v app_password='...' -v database_name='khaoyu' -f postgres-least-privilege.sql
-- Then point the service at the application role instead of the owner role:
--   postgres://khaoyu_app:<password>@db:5432/khaoyu?sslmode=require
--
-- The application role cannot create, alter or drop schema objects and cannot manage roles.
CREATE ROLE khaoyu_app
  LOGIN
  PASSWORD :'app_password'
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOINHERIT
  NOBYPASSRLS;

GRANT CONNECT ON DATABASE :"database_name" TO khaoyu_app;
GRANT USAGE ON SCHEMA public TO khaoyu_app;

-- Data access only. Migrations continue to run as the owner role.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO khaoyu_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO khaoyu_app;

-- Future tables created by the owner role inherit the same data-only grants.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO khaoyu_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO khaoyu_app;

-- No DDL, no role management, no ownership.
REVOKE CREATE ON SCHEMA public FROM khaoyu_app;
