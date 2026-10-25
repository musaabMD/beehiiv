-- Inbound bounce/complaint processing, transactional suppression, default-domain warm-up, webhook attempt history.

-- Outbox: provider message id + mail kind so async bounces/complaints (DSN, ARF, Email Sending events)
-- can be matched back to the original message and to the right suppression layer.
ALTER TABLE outbox ADD COLUMN message_id TEXT;
ALTER TABLE outbox ADD COLUMN kind TEXT NOT NULL DEFAULT 'marketing';   -- marketing | transactional
CREATE INDEX IF NOT EXISTS idx_outbox_msgid ON outbox(message_id);
CREATE INDEX IF NOT EXISTS idx_outbox_to ON outbox(to_email, created_at);
CREATE INDEX IF NOT EXISTS idx_deliveries_msgid ON deliveries(message_id);

-- Every inbound report we processed (email() handler, Email Sending events queue, /hooks/*).
CREATE TABLE IF NOT EXISTS inbound_reports (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,                         -- email | queue | hook
  kind TEXT NOT NULL,                           -- bounce | complaint | unsubscribe | delayed | ignored | forwarded | rejected
  email TEXT,
  pub_id TEXT,
  mail_kind TEXT,                               -- marketing | transactional
  bounce_type TEXT,                             -- hard | soft | mailbox_full | dns | policy | complaint
  detail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inbound_pub ON inbound_reports(pub_id, created_at);
CREATE INDEX IF NOT EXISTS idx_inbound_created ON inbound_reports(created_at);

-- Platform sending domains (the default MAIL_FROM domain) tracked for warm-up + blocklists
-- without being a publication's custom domain.
CREATE TABLE IF NOT EXISTS platform_domains (
  hostname TEXT PRIMARY KEY,
  warmup_started_at INTEGER,
  blocklisted INTEGER NOT NULL DEFAULT 0,
  dns_report TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

-- Webhooks: full history of delivery attempts (the delivery row keeps only the latest).
CREATE TABLE IF NOT EXISTS webhook_delivery_attempts (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL REFERENCES webhook_deliveries(id) ON DELETE CASCADE,
  webhook_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  manual INTEGER NOT NULL DEFAULT 0,
  url TEXT NOT NULL,
  response_code INTEGER,
  response_body TEXT,
  error TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_whda_delivery ON webhook_delivery_attempts(delivery_id, attempt);
