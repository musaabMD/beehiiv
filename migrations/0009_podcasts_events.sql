-- Podcasts + events additions
ALTER TABLE episodes ADD COLUMN transcript_vtt TEXT;
ALTER TABLE episodes ADD COLUMN archived_at INTEGER;
ALTER TABLE live_events ADD COLUMN coaching TEXT NOT NULL DEFAULT '{}';   -- {duration_min, days_ahead, availability:[{dow,start,end}]}
ALTER TABLE live_events ADD COLUMN stream_started_at INTEGER;
ALTER TABLE event_registrations ADD COLUMN booking_id TEXT;
ALTER TABLE event_registrations ADD COLUMN kind TEXT NOT NULL DEFAULT 'attendee'; -- attendee | replay
CREATE INDEX IF NOT EXISTS idx_episodes_status ON episodes(status, published_at);
CREATE INDEX IF NOT EXISTS idx_feedtok_sub ON podcast_feed_tokens(subscriber_id);
CREATE INDEX IF NOT EXISTS idx_events_pub ON live_events(pub_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_bookings_product ON bookings(product_id, starts_at);
