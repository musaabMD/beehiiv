-- Revenue intelligence + unified customer data:
--   revenue attribution (orders → the emails that drove them; last-click, first-touch, linear),
--   holdout groups (incremental lift of a newsletter send or an automation),
--   custom events API (Kit/Segment-style, exactly-once per dedupe key).
-- See lib/attribution.ts, lib/holdout.ts, lib/customevents.ts, lib/timeline.ts.

-- ───────────── Revenue attribution ─────────────
CREATE TABLE IF NOT EXISTS revenue_settings (
  pub_id TEXT PRIMARY KEY,
  window_days INTEGER NOT NULL DEFAULT 7,          -- a click counts toward an order placed within this many days
  updated_at INTEGER NOT NULL
);

-- One row per paid order we looked at (also the "already attributed" marker), attributed or not.
CREATE TABLE IF NOT EXISTS attribution_orders (
  order_key TEXT PRIMARY KEY,                      -- 'o:<orders.id>' (our checkout) | 'x:<external_orders.id>' (Shopify/Woo/Stripe)
  pub_id TEXT NOT NULL,
  source TEXT NOT NULL,                            -- checkout | store
  order_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT '',                   -- subscription | product | ticket | … | shopify | woocommerce | stripe
  subscriber_id TEXT,
  email TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'usd',
  ordered_at INTEGER NOT NULL,
  window_days INTEGER NOT NULL DEFAULT 7,
  touches INTEGER NOT NULL DEFAULT 0,              -- distinct emails clicked in the window (0 = not email-driven)
  processed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attr_orders_pub ON attribution_orders(pub_id, ordered_at);

-- One row per (order, model, email touched). weight sums to 1 per order and model.
CREATE TABLE IF NOT EXISTS revenue_attributions (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL,
  order_key TEXT NOT NULL,
  model TEXT NOT NULL,                             -- last_click | first_touch | linear
  channel TEXT NOT NULL,                           -- newsletter | automation | transactional
  send_id TEXT,
  delivery_id TEXT,
  post_id TEXT,
  automation_id TEXT,
  step_id TEXT,
  tx_message_id TEXT,
  subject TEXT NOT NULL DEFAULT '',
  touch_at INTEGER NOT NULL,
  weight REAL NOT NULL DEFAULT 1,
  revenue_cents REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'usd',
  ordered_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rattr_pub ON revenue_attributions(pub_id, model, ordered_at);
CREATE INDEX IF NOT EXISTS idx_rattr_order ON revenue_attributions(order_key);
CREATE INDEX IF NOT EXISTS idx_rattr_post ON revenue_attributions(post_id, model);
CREATE INDEX IF NOT EXISTS idx_rattr_auto ON revenue_attributions(automation_id, model);

-- clicks by delivery (attribution walks a reader's clicked deliveries)
CREATE INDEX IF NOT EXISTS idx_clicks_delivery ON clicks(delivery_id);

-- ───────────── Holdout groups ─────────────
CREATE TABLE IF NOT EXISTS holdout_configs (
  kind TEXT NOT NULL,                              -- post | automation
  ref_id TEXT NOT NULL,                            -- post id | automation id
  pub_id TEXT NOT NULL,
  pct REAL NOT NULL DEFAULT 0,                     -- 0–50 % of eligible readers held back
  window_days INTEGER NOT NULL DEFAULT 7,          -- conversion window for the lift report
  started_at INTEGER,                              -- when the holdout last went from 0% to on (automations compare runs since then)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (kind, ref_id)
);

-- Readers deliberately not sent / not enrolled (chosen by a stable hash). Never counted as "didn't open".
CREATE TABLE IF NOT EXISTS holdout_members (
  kind TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  pub_id TEXT NOT NULL,
  subscriber_id TEXT NOT NULL,
  send_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (kind, ref_id, subscriber_id)
);
CREATE INDEX IF NOT EXISTS idx_holdout_sub ON holdout_members(subscriber_id);

-- ───────────── Custom events ─────────────
CREATE TABLE IF NOT EXISTS custom_events (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL,
  subscriber_id TEXT,
  email TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  properties TEXT NOT NULL DEFAULT '{}',
  occurred_at INTEGER NOT NULL,
  dedupe_key TEXT,
  source TEXT NOT NULL DEFAULT 'api',              -- api | mcp
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cevents_dedupe_key ON custom_events(pub_id, dedupe_key);
CREATE INDEX IF NOT EXISTS idx_cevents_email ON custom_events(pub_id, email, name, occurred_at);
CREATE INDEX IF NOT EXISTS idx_cevents_sub ON custom_events(subscriber_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_cevents_name ON custom_events(pub_id, name, occurred_at);

-- ───────────── Unified customer timeline (lib/timeline) lookups by reader ─────────────
CREATE INDEX IF NOT EXISTS idx_pv_subscriber ON page_views(subscriber_id, created_at);
CREATE INDEX IF NOT EXISTS idx_txmsg_to ON tx_messages(pub_id, to_email, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_sub ON orders(subscriber_id, created_at);
