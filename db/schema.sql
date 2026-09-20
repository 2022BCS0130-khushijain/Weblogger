-- Inkwell database schema. Safe to run many times (everything is IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  google_id     TEXT UNIQUE,
  email         TEXT UNIQUE,
  phone         TEXT UNIQUE,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  avatar_url    TEXT,
  bio           TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,          -- we store only a hash, never the token itself
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(user_id);

CREATE TABLE IF NOT EXISTS categories (
  id    SERIAL PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE
);
INSERT INTO categories(name) VALUES
  ('Technology'),('Art'),('Sports'),('Yoga'),('Travel'),('Food'),('Science'),('Other')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS blogs (
  id            BIGSERIAL PRIMARY KEY,
  author_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_id   INT REFERENCES categories(id),
  title         TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  content       TEXT NOT NULL DEFAULT '',
  tags          TEXT[] NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'DRAFT'   CHECK (status IN ('DRAFT','PUBLISHED')),
  visibility    TEXT NOT NULL DEFAULT 'PRIVATE' CHECK (visibility IN ('PUBLIC','PRIVATE')),
  view_count    INT NOT NULL DEFAULT 0,
  share_count   INT NOT NULL DEFAULT 0,
  published_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  search        TSVECTOR,
  -- The rule from the design: a DRAFT can never be PUBLIC.
  CONSTRAINT draft_must_be_private CHECK (status = 'PUBLISHED' OR visibility = 'PRIVATE')
);
CREATE INDEX IF NOT EXISTS idx_blogs_author    ON blogs(author_id);
CREATE INDEX IF NOT EXISTS idx_blogs_published ON blogs(published_at DESC) WHERE status='PUBLISHED' AND visibility='PUBLIC';
CREATE INDEX IF NOT EXISTS idx_blogs_category  ON blogs(category_id);
CREATE INDEX IF NOT EXISTS idx_blogs_tags      ON blogs USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_blogs_search    ON blogs USING GIN(search);

-- Keep the search column up to date automatically (title > tags > content).
CREATE OR REPLACE FUNCTION blogs_search_update() RETURNS trigger AS $$
BEGIN
  NEW.search :=
    setweight(to_tsvector('english', coalesce(NEW.title,'')), 'A') ||
    setweight(to_tsvector('english', coalesce(array_to_string(NEW.tags,' '),'')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.content,'')), 'C');
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS blogs_search_trg ON blogs;
CREATE TRIGGER blogs_search_trg BEFORE INSERT OR UPDATE OF title, content, tags ON blogs
  FOR EACH ROW EXECUTE FUNCTION blogs_search_update();

-- Likes / bookmarks / favorites: one row per (user, blog). The PRIMARY KEY makes double-likes impossible.
CREATE TABLE IF NOT EXISTS blog_likes (
  blog_id BIGINT NOT NULL REFERENCES blogs(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, blog_id)
);
CREATE INDEX IF NOT EXISTS idx_likes_blog ON blog_likes(blog_id);

CREATE TABLE IF NOT EXISTS bookmarks (
  blog_id BIGINT NOT NULL REFERENCES blogs(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, blog_id)
);
CREATE INDEX IF NOT EXISTS idx_bookmarks_blog ON bookmarks(blog_id);

CREATE TABLE IF NOT EXISTS favorites (
  blog_id BIGINT NOT NULL REFERENCES blogs(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, blog_id)
);

CREATE TABLE IF NOT EXISTS blog_views (
  id BIGSERIAL PRIMARY KEY,
  blog_id BIGINT NOT NULL REFERENCES blogs(id) ON DELETE CASCADE,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_views_blog_time ON blog_views(blog_id, created_at);

CREATE TABLE IF NOT EXISTS comments (
  id BIGSERIAL PRIMARY KEY,
  blog_id BIGINT NOT NULL REFERENCES blogs(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_comment_id BIGINT REFERENCES comments(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_comments_blog ON comments(blog_id, created_at);

CREATE TABLE IF NOT EXISTS collections (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_collections_user ON collections(user_id);

CREATE TABLE IF NOT EXISTS collection_blogs (
  collection_id BIGINT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  blog_id BIGINT NOT NULL REFERENCES blogs(id) ON DELETE CASCADE,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, blog_id)
);

CREATE TABLE IF NOT EXISTS follows (
  follower_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  following_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, following_id),
  CHECK (follower_id <> following_id)
);
CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id);

CREATE TABLE IF NOT EXISTS chat_messages (
  id BIGSERIAL PRIMARY KEY,
  blog_id BIGINT NOT NULL REFERENCES blogs(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chat_blog_time ON chat_messages(blog_id, id DESC);

CREATE TABLE IF NOT EXISTS notifications (
  id BIGSERIAL PRIMARY KEY,
  user_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,   -- who gets it
  actor_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,   -- who did it
  type TEXT NOT NULL CHECK (type IN ('like','comment','reply','follow')),
  blog_id BIGINT REFERENCES blogs(id) ON DELETE CASCADE,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, is_read, id DESC);
