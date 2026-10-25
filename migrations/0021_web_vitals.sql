-- Real-user page speed: Largest Contentful Paint reported by visitors' browsers.
CREATE TABLE IF NOT EXISTS web_vitals (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL,
  path TEXT NOT NULL,
  metric TEXT NOT NULL,      -- 'lcp'
  value INTEGER NOT NULL,    -- milliseconds
  device TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_web_vitals_pub ON web_vitals(pub_id, created_at);
