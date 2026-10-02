/**
 * Database schema. Idempotent; applied on first use by each server instance.
 * Every column below exists because an implemented feature needs it — see
 * docs/ARCHITECTURE.md ("Data inventory") before adding anything.
 */
export const schemaSql = `
CREATE TABLE IF NOT EXISTS accounts (
  id               uuid PRIMARY KEY,
  auth_hash        bytea NOT NULL UNIQUE,
  handle           text NOT NULL UNIQUE,
  role             text NOT NULL DEFAULT 'reader' CHECK (role IN ('reader', 'moderator')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  replies_seen_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash     bytea PRIMARY KEY,
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_account_idx ON sessions(account_id);

CREATE TABLE IF NOT EXISTS vaults (
  account_id   uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  version      integer NOT NULL CHECK (version > 0),
  wrapped_key  text NOT NULL CHECK (length(wrapped_key) <= 512),
  ciphertext   text NOT NULL CHECK (length(ciphertext) <= 90000),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Registries, not code. A new category becomes available by inserting a row, so
-- the forum is not limited to the set seeded in server/migrate.ts.
CREATE TABLE IF NOT EXISTS categories (
  slug        text PRIMARY KEY,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  position    integer NOT NULL DEFAULT 100
);

-- One table, two shapes. A *discussion* is a row with parent_id IS NULL; a
-- *reply* is a row with parent_id set. Discussions carry the community metadata
-- (title, category, tags, optional chapter association); replies carry none of
-- it. The discussion "scope" is therefore derived, never stored: a chapter_slug
-- means a chapter discussion, NULL means a community-wide one.
CREATE TABLE IF NOT EXISTS comments (
  id               uuid PRIMARY KEY,
  chapter_slug     text,
  parent_id        uuid REFERENCES comments(id) ON DELETE CASCADE,
  account_id       uuid REFERENCES accounts(id) ON DELETE SET NULL,
  title            text,
  category         text REFERENCES categories(slug) ON DELETE SET NULL,
  tags             text[],
  is_chapter_room  boolean NOT NULL DEFAULT false,
  body             text NOT NULL CHECK (length(body) <= 4000),
  reveals_through  integer NOT NULL CHECK (reveals_through >= 1),
  has_spoiler      boolean NOT NULL DEFAULT false,
  state            text NOT NULL DEFAULT 'visible' CHECK (state IN ('visible', 'hidden', 'removed')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  edited_at        timestamptz,
  deleted_at       timestamptz
);

-- The chapter association becomes optional: that is what lets a discussion
-- exist without a chapter at all. Additive and idempotent, so a database that
-- predates the community forum reaches the current shape on its next start.
ALTER TABLE comments ALTER COLUMN chapter_slug DROP NOT NULL;
ALTER TABLE comments ADD COLUMN IF NOT EXISTS title text;
ALTER TABLE comments ADD COLUMN IF NOT EXISTS category text;
ALTER TABLE comments ADD COLUMN IF NOT EXISTS tags text[];
ALTER TABLE comments ADD COLUMN IF NOT EXISTS is_chapter_room boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS comments_chapter_idx ON comments(chapter_slug, created_at);
CREATE INDEX IF NOT EXISTS comments_parent_idx ON comments(parent_id);
CREATE INDEX IF NOT EXISTS comments_account_idx ON comments(account_id);
CREATE INDEX IF NOT EXISTS comments_roots_idx ON comments(created_at DESC, id DESC) WHERE parent_id IS NULL;
CREATE INDEX IF NOT EXISTS comments_category_idx ON comments(category, created_at DESC) WHERE parent_id IS NULL;
CREATE INDEX IF NOT EXISTS comments_tags_idx ON comments USING gin (tags) WHERE parent_id IS NULL;
-- At most one designated discussion per chapter, enforced by the database.
CREATE UNIQUE INDEX IF NOT EXISTS comments_chapter_room_idx ON comments(chapter_slug) WHERE is_chapter_room;
CREATE TABLE IF NOT EXISTS reactions (
  comment_id  uuid NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  PRIMARY KEY (comment_id, account_id)
);

CREATE TABLE IF NOT EXISTS reports (
  id           uuid PRIMARY KEY,
  comment_id   uuid NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  reporter_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  reason       text NOT NULL CHECK (reason IN ('spoiler', 'harassment', 'spam', 'other')),
  note         text CHECK (length(note) <= 500),
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz,
  UNIQUE (comment_id, reporter_id)
);

CREATE TABLE IF NOT EXISTS rate_events (
  bucket        text NOT NULL,
  window_start  timestamptz NOT NULL,
  count         integer NOT NULL,
  PRIMARY KEY (bucket, window_start)
);
`;
