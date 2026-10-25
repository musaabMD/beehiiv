-- Grow + community additions
ALTER TABLE community_members ADD COLUMN discord_user_id TEXT;
ALTER TABLE community_members ADD COLUMN invited_at INTEGER;
ALTER TABLE community_members ADD COLUMN last_seen_at INTEGER;
CREATE TABLE IF NOT EXISTS community_likes (
  post_id TEXT NOT NULL,
  subscriber_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, subscriber_id)
);
CREATE TABLE IF NOT EXISTS community_invites (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL,
  email TEXT NOT NULL,
  subscriber_id TEXT,
  invited_by TEXT,
  created_at INTEGER NOT NULL,
  accepted_at INTEGER,
  UNIQUE (pub_id, email)
);
CREATE INDEX IF NOT EXISTS idx_cposts_channel ON community_posts(channel_id, pinned, last_activity_at);
CREATE INDEX IF NOT EXISTS idx_ccomments_post ON community_comments(post_id, created_at);
CREATE INDEX IF NOT EXISTS idx_boostconv_partner ON boost_conversions(partner_id, status);
CREATE INDEX IF NOT EXISTS idx_links_pub ON links(pub_id, kind);
CREATE INDEX IF NOT EXISTS idx_recs_target ON recommendations(target_pub_id);
