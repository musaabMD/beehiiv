-- Dashboard & analytics: indexes for report queries + saved custom reports.
CREATE INDEX IF NOT EXISTS idx_sub_pub_created ON subscribers(pub_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sub_pub_unsub ON subscribers(pub_id, unsubscribed_at);
CREATE INDEX IF NOT EXISTS idx_sub_pub_source ON subscribers(pub_id, source);
CREATE INDEX IF NOT EXISTS idx_deliveries_pub_created ON deliveries(pub_id, created_at);
CREATE INDEX IF NOT EXISTS idx_clicks_pub_created ON clicks(pub_id, created_at);
CREATE INDEX IF NOT EXISTS idx_opens_pub_created ON opens(pub_id, created_at);
CREATE INDEX IF NOT EXISTS idx_pv_pub_channel ON page_views(pub_id, channel, created_at);
CREATE INDEX IF NOT EXISTS idx_pv_pub_path ON page_views(pub_id, path);
CREATE INDEX IF NOT EXISTS idx_orders_pub_status ON orders(pub_id, status, paid_at);
CREATE INDEX IF NOT EXISTS idx_dl_pub_created ON episode_downloads(pub_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sends_post ON sends(post_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_pub ON subscriptions(pub_id, status);
CREATE INDEX IF NOT EXISTS idx_wallet_pub ON wallet_entries(pub_id, created_at);

CREATE TABLE IF NOT EXISTS saved_reports (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  config TEXT NOT NULL,                         -- json {metric, group, range, filters:[{field,op,value}]}
  created_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_saved_reports_pub ON saved_reports(pub_id, created_at);
