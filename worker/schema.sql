-- =========================================================
-- SaturnIA · banco de dados (Cloudflare D1 / SQLite)
-- Aplicar: npx wrangler d1 execute saturnia-db --remote --file=schema.sql
-- =========================================================

-- Usuários (a senha nunca é salva: só o hash PBKDF2 + sal)
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,   -- vazio ('') em contas criadas só com o Google
  password_salt TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  google_sub    TEXT,            -- ID da conta Google, quando vinculada
  accent        TEXT NOT NULL DEFAULT 'roxo',  -- cor dos botões escolhida
  onboarded     INTEGER NOT NULL DEFAULT 0     -- 1 = já passou pelas boas-vindas
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google ON users(google_sub);

-- Sessões de login (guarda só o hash do token)
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Conversas
CREATE TABLE IF NOT EXISTS conversations (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, updated_at DESC);

-- Mensagens de cada conversa
CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content         TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, id);

-- Memória: fatos que a SaturnIA lembra sobre cada usuário
CREATE TABLE IF NOT EXISTS memories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id, id DESC);
