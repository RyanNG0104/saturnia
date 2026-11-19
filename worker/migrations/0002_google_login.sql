-- Migração: login com o Google (aplicada em bancos criados antes desse recurso)
-- npx wrangler d1 execute saturnia-db --remote --file=migrations/0002_google_login.sql
ALTER TABLE users ADD COLUMN google_sub TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google ON users(google_sub);
