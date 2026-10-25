-- Programmatic ads: always-on auto-filled ad slots. (3D analytics reuses saved_reports from 0010.)
ALTER TABLE ad_campaigns ADD COLUMN programmatic INTEGER NOT NULL DEFAULT 0;      -- available for auto-fill
ALTER TABLE ad_campaigns ADD COLUMN target_categories TEXT NOT NULL DEFAULT '[]'; -- publication categories to target ([] = all)
ALTER TABLE ad_opportunities ADD COLUMN programmatic INTEGER NOT NULL DEFAULT 0;

-- One row per ad actually rendered (email delivery or web view) — drives CPM billing, frequency caps and reports.
CREATE TABLE IF NOT EXISTS ad_impressions (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  pub_id TEXT NOT NULL,
  post_id TEXT,
  subscriber_id TEXT,
  delivery_id TEXT,
  channel TEXT NOT NULL DEFAULT 'email',   -- email | web
  billed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_adimp_delivery ON ad_impressions(opportunity_id, delivery_id) WHERE delivery_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_adimp_opp ON ad_impressions(opportunity_id, billed);
CREATE INDEX IF NOT EXISTS idx_adimp_sub ON ad_impressions(subscriber_id, campaign_id, created_at);
CREATE INDEX IF NOT EXISTS idx_adimp_pub ON ad_impressions(pub_id, created_at);
CREATE INDEX IF NOT EXISTS idx_adopp_prog ON ad_opportunities(pub_id, programmatic, post_id, campaign_id);
