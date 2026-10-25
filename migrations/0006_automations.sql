-- Automations: indexes for per-step analytics, funnels and journey lookups.
CREATE INDEX IF NOT EXISTS idx_sends_automation ON sends(automation_id, step_id);
CREATE INDEX IF NOT EXISTS idx_alogs_automation_step ON automation_logs(automation_id, step_id);
CREATE INDEX IF NOT EXISTS idx_runs_automation ON automation_runs(automation_id, status, created_at);
