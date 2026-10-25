-- API module: keyset-pagination indexes (created_at DESC, id DESC per publication) so list endpoints stay fast at millions of rows.
CREATE INDEX IF NOT EXISTS idx_api_subs_keyset ON subscribers(pub_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_api_posts_keyset ON posts(pub_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_api_orders_keyset ON orders(pub_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_api_runs_keyset ON automation_runs(automation_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_api_votes_keyset ON poll_votes(poll_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_api_survey_keyset ON survey_responses(survey_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_api_subscriptions_keyset ON subscriptions(pub_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_api_episodes_keyset ON episodes(podcast_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_api_whd_keyset ON webhook_deliveries(pub_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_api_sub_referred ON subscribers(referred_by);
CREATE INDEX IF NOT EXISTS idx_api_segmem_sub ON segment_members(segment_id, subscriber_id);
