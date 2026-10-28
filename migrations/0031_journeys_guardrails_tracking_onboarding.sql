-- 0031: AI revenue journeys, experiment guardrails, custom tracking domains, onboarding wizard (time-to-first-send).

-- Custom tracking domain (verified domains row with kind = 'tracking'): open pixel, click redirects, unsubscribe and
-- preference links use https://<tracking_domain> instead of APP_URL. Set only while the domain is verified.
ALTER TABLE publications ADD COLUMN tracking_domain TEXT;

-- "Describe your goal" → generated draft automation. One row per generated plan (preview), linked once created.
CREATE TABLE IF NOT EXISTS ai_journeys (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL,
  user_id TEXT,
  goal TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '{}',          -- {product, price, audience/segment_id, tone}
  source TEXT NOT NULL,                        -- ai | template
  template_key TEXT,                           -- fallback template that was adapted
  plan TEXT NOT NULL,                          -- {name, description, triggers, steps, notes}
  notes TEXT NOT NULL DEFAULT '[]',            -- validation notes / why the fallback was used
  automation_id TEXT,
  ms INTEGER,                                  -- generation time
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_journeys_pub ON ai_journeys(pub_id, created_at);

-- Owner-set guardrails for experiments. kind: default (publication-wide for newsletter tests, ref_id '') | post | automation
CREATE TABLE IF NOT EXISTS experiment_guardrails (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  ref_id TEXT NOT NULL DEFAULT '',
  config TEXT NOT NULL DEFAULT '{}',           -- {enabled, max_unsub_pct, max_complaint_pct, min_rpr_pct, min_sample, window_days, control}
  last_checked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (pub_id, kind, ref_id)
);

-- Every guardrail decision, with a plain-English explanation and the metrics behind it.
CREATE TABLE IF NOT EXISTS guardrail_events (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL,
  kind TEXT NOT NULL,                          -- post | automation
  ref_id TEXT NOT NULL,                        -- send id (post) or automation id
  target TEXT NOT NULL DEFAULT '',             -- variant letter or split step id
  stopped TEXT NOT NULL DEFAULT '',            -- arm(s) stopped, e.g. "B" or "path B"
  safe TEXT NOT NULL DEFAULT '',               -- arm everyone now gets
  explanation TEXT NOT NULL,
  metrics TEXT NOT NULL DEFAULT '{}',
  moved INTEGER NOT NULL DEFAULT 0,            -- in-flight journeys re-routed
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_guardrail_events ON guardrail_events(pub_id, created_at);
CREATE INDEX IF NOT EXISTS idx_guardrail_events_ref ON guardrail_events(kind, ref_id, target);

-- Onboarding wizard progress + time-to-first-send.
CREATE TABLE IF NOT EXISTS onboarding_progress (
  pub_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,                 -- signup time of the user (or wizard start)
  sender_choice TEXT,                          -- shared | domain
  domain_id TEXT,
  test_to TEXT,
  test_outbox_id TEXT,
  test_status TEXT,
  first_send_at INTEGER,
  next_choice TEXT,                            -- import | form | skip
  completed_at INTEGER,
  updated_at INTEGER NOT NULL
);
