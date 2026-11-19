-- Migração: configurações (perfil, estilo das respostas, memória, cor do layout)
-- npx wrangler d1 execute saturnia-db --remote --file=migrations/0005_settings.sql
ALTER TABLE users ADD COLUMN about TEXT NOT NULL DEFAULT '';            -- "sobre você" / instruções para a IA
ALTER TABLE users ADD COLUMN reply_style TEXT NOT NULL DEFAULT 'equilibrado';
ALTER TABLE users ADD COLUMN memory_on INTEGER NOT NULL DEFAULT 1;      -- 0 = não aprender novos fatos
ALTER TABLE users ADD COLUMN layout TEXT NOT NULL DEFAULT 'lavanda';    -- cor do fundo do layout
