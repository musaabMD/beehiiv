-- Deliverability Guardian: DMARC aggregate reports, Guardian incidents, seed (inbox placement) tests.
-- send_throttles is owned by the sending engine (migration 0028) and read when sending; the Guardian writes rows to it.
-- Same schema here with IF NOT EXISTS so either migration can run first.
CREATE TABLE IF NOT EXISTS send_throttles (
  scope TEXT PRIMARY KEY,            -- 'global' | 'provider:gmail|outlook|yahoo|apple|other' | 'workspace:<id>'
  factor REAL NOT NULL,              -- 0 = paused … 1 = normal speed
  reason TEXT,                       -- Guardian rows start with 'guardian:'
  until INTEGER,                     -- expiry (ms); expired rows are ignored
  created_at INTEGER
);

-- One row per received aggregate report (dedupe on reporter + report id).
CREATE TABLE IF NOT EXISTS dmarc_reports (
  id TEXT PRIMARY KEY,
  org TEXT NOT NULL,                 -- reporting mailbox provider (google.com, Outlook.com, Yahoo…)
  report_id TEXT NOT NULL,
  domain TEXT NOT NULL,              -- policy_published.domain
  policy TEXT,                       -- p= of the published policy
  begin_at INTEGER, end_at INTEGER,  -- ms
  messages INTEGER NOT NULL DEFAULT 0,
  rcpt TEXT,                         -- the rua address the report was sent to
  created_at INTEGER NOT NULL,
  UNIQUE (org, report_id)
);
CREATE INDEX IF NOT EXISTS idx_dmarc_reports_domain ON dmarc_reports(domain, begin_at);

-- Per domain, per UTC day, per reporter, per source IP and result: message counts.
CREATE TABLE IF NOT EXISTS dmarc_records (
  domain TEXT NOT NULL,
  day TEXT NOT NULL,                 -- YYYY-MM-DD (report begin, UTC)
  reporter TEXT NOT NULL,
  source_ip TEXT NOT NULL,
  header_from TEXT NOT NULL DEFAULT '',
  dkim TEXT NOT NULL,                -- policy_evaluated dkim (aligned): pass | fail
  spf TEXT NOT NULL,                 -- policy_evaluated spf (aligned): pass | fail
  disposition TEXT NOT NULL,         -- none | quarantine | reject
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (domain, day, reporter, source_ip, header_from, dkim, spf, disposition)
);
CREATE INDEX IF NOT EXISTS idx_dmarc_records_day ON dmarc_records(day);

-- Guardian incidents (one open incident per scope + kind).
CREATE TABLE IF NOT EXISTS guardian_incidents (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,               -- 'provider:outlook' | 'workspace:<id>' | 'domain:<host>' | 'platform'
  workspace_id TEXT,                 -- set for workspace / customer-domain incidents
  kind TEXT NOT NULL,                -- deferrals | bounces | complaints | volume_spike | blocklist | dmarc
  severity TEXT NOT NULL,            -- info | warning | critical
  title TEXT NOT NULL,
  diagnosis TEXT NOT NULL,
  recommendation TEXT NOT NULL,
  action TEXT,                       -- what the Guardian did ('' when it only reported)
  throttle_scope TEXT,               -- send_throttles row it wrote, if any
  metric REAL,
  acted_at INTEGER,                  -- last time it wrote the throttle; recovery only looks at mail sent after this
  status TEXT NOT NULL DEFAULT 'open', -- open | resolved
  opened_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_guardian_open ON guardian_incidents(status, scope, kind);
CREATE INDEX IF NOT EXISTS idx_guardian_ws ON guardian_incidents(workspace_id, opened_at);

-- Inbox placement seed tests: addresses the customer owns, previews sent to them, and the placement they reported.
CREATE TABLE IF NOT EXISTS seed_addresses (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL,
  email TEXT NOT NULL,
  provider TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (pub_id, email)
);
CREATE TABLE IF NOT EXISTS seed_tests (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL,
  post_id TEXT,
  subject TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_seed_tests_pub ON seed_tests(pub_id, created_at);
CREATE TABLE IF NOT EXISTS seed_results (
  id TEXT PRIMARY KEY,               -- also the token in the one-click links
  test_id TEXT NOT NULL,
  pub_id TEXT NOT NULL,
  email TEXT NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'sent', -- sent | failed
  placement TEXT,                    -- inbox | promotions | spam (NULL until marked)
  sent_at INTEGER NOT NULL,
  marked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_seed_results_test ON seed_results(test_id);
CREATE INDEX IF NOT EXISTS idx_seed_results_pub ON seed_results(pub_id, sent_at);

CREATE INDEX IF NOT EXISTS idx_outbox_created ON outbox(created_at);
