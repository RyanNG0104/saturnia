-- Migração: preferências do usuário (cor dos botões e primeiro acesso)
-- npx wrangler d1 execute saturnia-db --remote --file=migrations/0003_preferences.sql
ALTER TABLE users ADD COLUMN accent TEXT NOT NULL DEFAULT 'roxo';
ALTER TABLE users ADD COLUMN onboarded INTEGER NOT NULL DEFAULT 0;
