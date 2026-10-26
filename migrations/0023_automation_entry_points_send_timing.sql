-- Automations: secret inbound webhook URL per automation (Calendly, Typeform, Thinkific, Kajabi, Zapier/Make/n8n …).
ALTER TABLE automations ADD COLUMN webhook_token TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_automations_webhook_token ON automations(webhook_token);

-- Delivery by time zone: the subscriber's IANA time zone (from Cloudflare request.cf.timezone at signup / click / open).
ALTER TABLE subscribers ADD COLUMN timezone TEXT;

-- Content A/B testing: an alternate body ("Variant B content") edited next to the main content.
ALTER TABLE posts ADD COLUMN alt_content TEXT;
-- Send timing: {"mode": "sto"} (each subscriber's usual open hour) or {"mode": "timezone", "local_time": "09:00"}.
ALTER TABLE posts ADD COLUMN send_timing TEXT;

-- Timed sends park deliveries as status 'scheduled' until next_attempt_at.
CREATE INDEX IF NOT EXISTS idx_deliveries_send_due ON deliveries(send_id, status, next_attempt_at);
-- Send-time optimization reads each subscriber's historical opens by delivery.
CREATE INDEX IF NOT EXISTS idx_opens_delivery ON opens(delivery_id);
