-- RSS-to-send feeds + trivia polls.
CREATE TABLE IF NOT EXISTS rss_feeds (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  feed_title TEXT,
  mode TEXT NOT NULL DEFAULT 'each',            -- each | digest
  digest_every_days INTEGER NOT NULL DEFAULT 7, -- digest cadence when digest_weekday is NULL
  digest_weekday INTEGER,                       -- 0=Sun..6=Sat (weekly digest), NULL = every N days
  digest_time TEXT NOT NULL DEFAULT '09:00',    -- HH:MM UTC
  max_items INTEGER NOT NULL DEFAULT 10,
  template_id TEXT,
  audience TEXT NOT NULL DEFAULT 'all',         -- all | free | premium
  segment_ids TEXT NOT NULL DEFAULT '[]',
  exclude_segment_ids TEXT NOT NULL DEFAULT '[]',
  action TEXT NOT NULL DEFAULT 'draft',         -- draft | send
  subject_template TEXT NOT NULL DEFAULT '{{item.title}}',
  intro TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  last_checked_at INTEGER,
  last_sent_at INTEGER,
  last_error TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rss_feeds_pub ON rss_feeds(pub_id);

CREATE TABLE IF NOT EXISTS rss_items (
  feed_id TEXT NOT NULL REFERENCES rss_feeds(id) ON DELETE CASCADE,
  guid TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  link TEXT,
  summary TEXT,
  image TEXT,
  published_at INTEGER,
  post_id TEXT,                                 -- post generated from (or including) this item
  status TEXT NOT NULL DEFAULT 'pending',       -- baseline | pending | used
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (feed_id, guid)
);
CREATE INDEX IF NOT EXISTS idx_rss_items_post ON rss_items(post_id);

ALTER TABLE polls ADD COLUMN kind TEXT NOT NULL DEFAULT 'standard';   -- standard | trivia
ALTER TABLE polls ADD COLUMN correct_option_id TEXT;
ALTER TABLE polls ADD COLUMN explanation TEXT NOT NULL DEFAULT '';
