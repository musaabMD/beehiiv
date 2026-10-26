-- Hosted service (Lnkbase Newsletter): the platform's own plans, each workspace's plan + billing state,
-- and the sending-safety state of a shared multi-tenant sender. Defaults live in src/lib/plans.ts (DEFAULT_PLANS);
-- the rows below are the same values and can be edited afterwards (Platform admin → Plans, or SQL).

CREATE TABLE IF NOT EXISTS platform_plans (
  id TEXT PRIMARY KEY,                          -- stable: free | starter | pro | scale
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  monthly_cents INTEGER NOT NULL DEFAULT 0,
  annual_cents INTEGER NOT NULL DEFAULT 0,      -- 10x monthly by default
  max_subscribers INTEGER,                      -- active subscribers across the workspace; NULL = unlimited
  monthly_emails INTEGER,                       -- marketing emails per calendar month (UTC); NULL = unlimited
  branding INTEGER NOT NULL DEFAULT 0,          -- 1 = "Sent with Lnkbase Newsletter" email footer + site badge
  stripe_product_id TEXT,                       -- created on first checkout when empty
  stripe_price_monthly TEXT,                    -- optional: use existing Stripe prices instead of creating them
  stripe_price_annual TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO platform_plans (id, name, description, monthly_cents, annual_cents, max_subscribers, monthly_emails, branding, position, active, created_at, updated_at) VALUES
  ('free',    'Free',    'Everything you need to start.',             0,     0,    500,   2500, 1, 0, 1, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('starter', 'Starter', 'For a growing newsletter.',                 1200, 12000,  2500,  12500, 0, 1, 1, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('pro',     'Pro',     'For established publications.',             2900, 29000, 10000,  50000, 0, 2, 1, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('scale',   'Scale',   'For large audiences and media companies.', 12900, 129000, 50000, 250000, 0, 3, 1, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000);

-- Workspace plan + platform billing (Stripe subscription on the platform's own account, or simulated without a key)
ALTER TABLE workspaces ADD COLUMN plan_id TEXT NOT NULL DEFAULT 'free';
ALTER TABLE workspaces ADD COLUMN plan_interval TEXT;                      -- month | year
ALTER TABLE workspaces ADD COLUMN plan_status TEXT NOT NULL DEFAULT 'active'; -- active | past_due
ALTER TABLE workspaces ADD COLUMN plan_period_end INTEGER;
ALTER TABLE workspaces ADD COLUMN plan_pending_id TEXT;                    -- downgrade that takes effect at plan_period_end
ALTER TABLE workspaces ADD COLUMN plan_pending_interval TEXT;
ALTER TABLE workspaces ADD COLUMN plan_grace_until INTEGER;                -- failed payment: paid limits until then, then Free limits
ALTER TABLE workspaces ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE workspaces ADD COLUMN stripe_subscription_id TEXT;
-- Sending safety
ALTER TABLE workspaces ADD COLUMN sending_status TEXT NOT NULL DEFAULT 'active'; -- active | suspended
ALTER TABLE workspaces ADD COLUMN sending_note TEXT;                       -- why it was suspended (shown to the owner)
ALTER TABLE workspaces ADD COLUMN sending_changed_at INTEGER;
ALTER TABLE workspaces ADD COLUMN trusted_at INTEGER;                      -- first large campaign approved (or grandfathered)
ALTER TABLE workspaces ADD COLUMN usage_warned TEXT;                       -- 'YYYY-MM' of the last 80% usage email

CREATE INDEX IF NOT EXISTS idx_workspaces_stripe_sub ON workspaces(stripe_subscription_id);

-- Why a send is paused / held / rejected (campaign safety, approval queue, plan limits)
ALTER TABLE sends ADD COLUMN status_reason TEXT;
ALTER TABLE sends ADD COLUMN reviewed_by TEXT;
ALTER TABLE sends ADD COLUMN reviewed_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_sends_status ON sends(status);

-- Usage + reputation queries per publication
CREATE INDEX IF NOT EXISTS idx_deliveries_pub_sent ON deliveries(pub_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_deliveries_pub_created ON deliveries(pub_id, created_at);

-- Platform plan checkouts (Stripe Checkout session or the built-in simulated checkout)
CREATE TABLE IF NOT EXISTS platform_checkouts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  interval TEXT NOT NULL,                       -- month | year
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',       -- pending | paid | expired
  stripe_session_id TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  paid_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_platform_checkouts_ws ON platform_checkouts(workspace_id, created_at);

-- Platform-level safety events (pauses, suspensions, approvals) for the admin area
CREATE TABLE IF NOT EXISTS platform_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  send_id TEXT,
  kind TEXT NOT NULL,                           -- campaign_paused | suspended | unsuspended | approval_requested | approved | rejected | plan_changed | usage_warning | send_blocked
  detail TEXT NOT NULL DEFAULT '',
  actor TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_platform_events_ws ON platform_events(workspace_id, created_at);

-- The demo publication's workspace is on Scale (and trusted) so the demo is never capped.
UPDATE workspaces SET plan_id = 'scale', trusted_at = CAST(strftime('%s','now') AS INTEGER) * 1000
  WHERE id IN (SELECT workspace_id FROM publications WHERE slug = 'demo')
     OR owner_id IN (SELECT id FROM users WHERE email = 'demo@openhive.dev');

-- Grandfather workspaces that already sent a large campaign: they don't need first-campaign approval.
UPDATE workspaces SET trusted_at = CAST(strftime('%s','now') AS INTEGER) * 1000
  WHERE trusted_at IS NULL AND id IN (
    SELECT p.workspace_id FROM sends s JOIN publications p ON p.id = s.pub_id WHERE s.kind = 'post' AND s.status = 'sent' AND s.total > 1000);
