-- Website module: YouTube feed cache (auto-updating YouTube blocks) and lookup indexes.
CREATE TABLE IF NOT EXISTS youtube_cache (
  channel_id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  videos TEXT NOT NULL DEFAULT '[]',          -- json [{id, title, published, thumb}]
  fetched_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pages_pub_status ON pages(pub_id, status);
CREATE INDEX IF NOT EXISTS idx_page_versions_page ON page_versions(page_id, created_at);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_nav_pub ON nav_links(pub_id, location, position);
CREATE INDEX IF NOT EXISTS idx_templates_pub_kind ON templates(pub_id, kind);
