-- Audience module: indexes for keyset pagination, filters and results.
CREATE INDEX IF NOT EXISTS idx_sub_pub_created ON subscribers(pub_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_sub_pub_source ON subscribers(pub_id, source);
CREATE INDEX IF NOT EXISTS idx_sub_pub_tier ON subscribers(pub_id, tier);
CREATE INDEX IF NOT EXISTS idx_listmembers_sub ON list_members(subscriber_id);
CREATE INDEX IF NOT EXISTS idx_segmembers_sub ON segment_members(subscriber_id);
CREATE INDEX IF NOT EXISTS idx_survey_resp ON survey_responses(survey_id, created_at);
CREATE INDEX IF NOT EXISTS idx_survey_resp_sub ON survey_responses(subscriber_id);
CREATE INDEX IF NOT EXISTS idx_poll_votes_poll ON poll_votes(poll_id, option_id);
CREATE INDEX IF NOT EXISTS idx_forms_pub ON forms(pub_id, created_at);
