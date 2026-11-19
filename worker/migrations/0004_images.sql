-- Migração: galeria de imagens geradas
-- npx wrangler d1 execute saturnia-db --remote --file=migrations/0004_images.sql
CREATE TABLE IF NOT EXISTS images (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  prompt     TEXT NOT NULL,
  data       TEXT NOT NULL,      -- imagem JPEG em base64
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_images_user ON images(user_id, created_at DESC);
