-- Subscriber intelligence: public-profile signals, value / CLV / purchase-likelihood / churn scores, metric anomalies.

-- One row per subscriber with enrichment from free public sources (see src/lib/signals.ts).
CREATE TABLE IF NOT EXISTS subscriber_signals (
  subscriber_id TEXT PRIMARY KEY REFERENCES subscribers(id) ON DELETE CASCADE,
  pub_id TEXT NOT NULL,
  gravatar_status TEXT,                         -- found | none | error | skipped
  display_name TEXT,
  avatar_url TEXT,
  profile_url TEXT,
  location TEXT,
  job_title TEXT,
  company TEXT,                                 -- from the public Gravatar profile
  socials TEXT NOT NULL DEFAULT '[]',           -- json [{service, label, url}] (verified accounts only)
  social_count INTEGER NOT NULL DEFAULT 0,
  email_domain TEXT,
  business_email INTEGER NOT NULL DEFAULT 0,    -- 1 = not a free / disposable mailbox provider
  organization TEXT,                            -- inferred from a business email domain
  country TEXT,                                 -- from existing data (signup, page views, opens)
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_signals_pub ON subscriber_signals(pub_id, updated_at);

-- Cross-publication cache of public Gravatar lookups, keyed by sha256(email). 404s are cached too.
CREATE TABLE IF NOT EXISTS gravatar_cache (
  hash TEXT PRIMARY KEY,
  status TEXT NOT NULL,                         -- found | none | error
  data TEXT NOT NULL DEFAULT '{}',
  fetched_at INTEGER NOT NULL
);

-- Predictive scores, recomputed periodically (see src/lib/predict.ts for the model).
CREATE TABLE IF NOT EXISTS subscriber_scores (
  subscriber_id TEXT PRIMARY KEY REFERENCES subscribers(id) ON DELETE CASCADE,
  pub_id TEXT NOT NULL,
  value_score INTEGER NOT NULL DEFAULT 0,       -- 0-100 "most valuable subscribers"
  value_percentile INTEGER NOT NULL DEFAULT 0,  -- 0-100 (100 = most valuable in the publication)
  revenue_cents INTEGER NOT NULL DEFAULT 0,     -- historical paid orders
  monthly_value_cents INTEGER NOT NULL DEFAULT 0,
  predicted_cents INTEGER NOT NULL DEFAULT 0,   -- predicted future value
  clv_cents INTEGER NOT NULL DEFAULT 0,         -- historical + predicted
  purchase_score INTEGER NOT NULL DEFAULT 0,
  purchase_likelihood TEXT NOT NULL DEFAULT 'low', -- high | medium | low
  churn_score INTEGER,                          -- paid subscribers only
  churn_risk TEXT,                              -- high | medium | low (NULL for free readers)
  page_views_90d INTEGER NOT NULL DEFAULT 0,
  orders INTEGER NOT NULL DEFAULT 0,
  last_active_at INTEGER,
  computed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scores_pub_value ON subscriber_scores(pub_id, value_score);
CREATE INDEX IF NOT EXISTS idx_scores_pub_churn ON subscriber_scores(pub_id, churn_risk);

-- Metric anomalies (today vs trailing 14-day baseline). One row per publication / metric / day / reference.
CREATE TABLE IF NOT EXISTS anomalies (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL,
  metric TEXT NOT NULL,                         -- unsubscribes | bounces | complaints | open_rate | signups | revenue | traffic
  day TEXT NOT NULL,                            -- YYYY-MM-DD (UTC) the anomaly was detected
  ref_id TEXT NOT NULL DEFAULT '',              -- send id for per-send metrics
  direction TEXT NOT NULL,                      -- up | down
  severity TEXT NOT NULL,                       -- critical | warning | good
  value REAL NOT NULL,
  baseline REAL NOT NULL,
  z REAL,
  message TEXT NOT NULL,
  href TEXT,
  emailed_at INTEGER,
  dismissed_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (pub_id, metric, day, ref_id)
);
CREATE INDEX IF NOT EXISTS idx_anomalies_pub ON anomalies(pub_id, created_at);

CREATE INDEX IF NOT EXISTS idx_pv_pub_subscriber ON page_views(pub_id, subscriber_id);
CREATE INDEX IF NOT EXISTS idx_orders_subscriber ON orders(subscriber_id);
