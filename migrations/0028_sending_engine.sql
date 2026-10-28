-- Sending engine: job priorities, delivery attempt history, throttles (read by lib/throttle, written by the
-- Deliverability Guardian), emergency stops, API idempotency, scheduled/expiring transactional mail, adaptive pace.

-- Job priority: lower runs first (0 transactional, 1 automations, 2 webhooks, 3 other, 5 newsletters, 7 bulk/imports)
ALTER TABLE jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 5;
ALTER TABLE jobs ADD COLUMN finished_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_jobs_prio ON jobs(status, priority, run_at);

-- Every attempt to hand a message to the provider, including retries (newsletter/automation deliveries and
-- transactional messages; delivery_id is deliveries.id or tx_messages.id)
CREATE TABLE IF NOT EXISTS delivery_attempts (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'marketing',       -- marketing | transactional
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,                         -- sent | simulated | deferred | failed | suppressed | bounced
  response TEXT,                                -- provider message id or error
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_delivery_attempts ON delivery_attempts(delivery_id, attempt);
CREATE INDEX IF NOT EXISTS idx_delivery_attempts_created ON delivery_attempts(created_at);

-- Throttle factors. scope: global | provider:gmail|outlook|yahoo|apple|other | workspace:<id>.
-- factor 0 = paused, 0.5 = half speed, 1 = normal; rows with until < now are ignored.
CREATE TABLE IF NOT EXISTS send_throttles (
  scope TEXT PRIMARY KEY,
  factor REAL NOT NULL,
  reason TEXT,
  until INTEGER,
  created_at INTEGER
);

-- Emergency stops (kill switch). scope: global | workspace:<id>. Queued work waits while a stop exists.
CREATE TABLE IF NOT EXISTS sending_stops (
  scope TEXT PRIMARY KEY,
  reason TEXT,
  stopped_by TEXT,
  created_at INTEGER NOT NULL
);

-- Idempotency-Key replay store for API calls (POST /posts/:id/send, transactional batch)
CREATE TABLE IF NOT EXISTS api_idempotency (
  pub_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  key TEXT NOT NULL,
  fingerprint TEXT NOT NULL DEFAULT '',
  status_code INTEGER NOT NULL DEFAULT 0,       -- 0 = in progress
  response TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (pub_id, endpoint, key)
);

-- Transactional: scheduling, expiry, retries, inline images / attachment metadata, custom headers
ALTER TABLE tx_messages ADD COLUMN scheduled_at INTEGER;
ALTER TABLE tx_messages ADD COLUMN expires_at INTEGER;
ALTER TABLE tx_messages ADD COLUMN sent_at INTEGER;
ALTER TABLE tx_messages ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tx_messages ADD COLUMN payload TEXT;           -- rendered message kept while queued/scheduled/deferred
ALTER TABLE tx_messages ADD COLUMN attachments_meta TEXT NOT NULL DEFAULT '[]';
ALTER TABLE tx_messages ADD COLUMN headers TEXT NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_txmsg_status ON tx_messages(status, scheduled_at);

-- Adaptive pace per newsletter send (1 = full speed; drops on deferrals/errors, recovers gradually)
ALTER TABLE sends ADD COLUMN pace REAL NOT NULL DEFAULT 1;
