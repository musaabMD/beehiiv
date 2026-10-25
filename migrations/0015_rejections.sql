-- Daily counts of addresses refused at signup or import (typo, dead domain, disposable, invalid).
-- Feeds the public deliverability page; stores no addresses.
CREATE TABLE IF NOT EXISTS email_rejections (
  day TEXT NOT NULL,            -- YYYY-MM-DD (UTC)
  reason TEXT NOT NULL,         -- typo | dead_domain | disposable | invalid
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, reason)
);

-- The public deliverability page reads deliveries by date.
CREATE INDEX IF NOT EXISTS idx_deliveries_created ON deliveries(created_at);
