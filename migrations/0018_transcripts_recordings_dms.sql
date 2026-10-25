-- 0018: automatic podcast transcripts, auto-recorded webinars (chunked uploads), member-to-member DMs,
-- verified Discord linking, and reader "log in with your phone".

-- ── Podcasts: background transcription state
ALTER TABLE episodes ADD COLUMN transcript_status TEXT;      -- queued | running | done | skipped | failed (NULL = never attempted)
ALTER TABLE episodes ADD COLUMN transcript_note TEXT;        -- human-readable reason for skipped / failed
ALTER TABLE episodes ADD COLUMN transcript_progress TEXT;    -- JSON resume state while a long file is transcribed in chunks

-- ── Events: record automatically when the host goes live
ALTER TABLE live_events ADD COLUMN record_auto INTEGER NOT NULL DEFAULT 1;

-- One row per studio recording session. Chunks are uploaded while live (MediaRecorder timeslices) to
-- <pub>/private/recordings/<id>/<seq>.part and stitched into one object when the session finishes.
CREATE TABLE IF NOT EXISTS event_recordings (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES live_events(id) ON DELETE CASCADE,
  pub_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'recording',   -- recording | finalizing | ready | failed | empty
  mime TEXT NOT NULL DEFAULT 'video/webm',
  parts INTEGER NOT NULL DEFAULT 0,           -- highest chunk sequence number + 1
  bytes INTEGER NOT NULL DEFAULT 0,
  key TEXT,                                   -- final object key once stitched
  progress TEXT,                              -- JSON resume state for multipart stitching
  error TEXT,
  auto INTEGER NOT NULL DEFAULT 1,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_recordings_event ON event_recordings(event_id, started_at);
CREATE INDEX IF NOT EXISTS idx_event_recordings_status ON event_recordings(status, updated_at);

-- ── Community: member-to-member DMs (chat_rooms.kind = 'dm'), blocks, DM opt-out, verified Discord
ALTER TABLE community_members ADD COLUMN dms_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE community_members ADD COLUMN discord_username TEXT;
ALTER TABLE community_members ADD COLUMN discord_verified INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS community_blocks (
  pub_id TEXT NOT NULL,
  blocker_id TEXT NOT NULL,                   -- subscriber id
  blocked_id TEXT NOT NULL,                   -- subscriber id
  created_at INTEGER NOT NULL,
  PRIMARY KEY (pub_id, blocker_id, blocked_id)
);
CREATE INDEX IF NOT EXISTS idx_community_blocks_blocked ON community_blocks(pub_id, blocked_id);

-- ── Reader device login: device_logins rows with kind = 'reader' belong to a publication site.
ALTER TABLE device_logins ADD COLUMN kind TEXT NOT NULL DEFAULT 'user';
ALTER TABLE device_logins ADD COLUMN pub_id TEXT;
ALTER TABLE device_logins ADD COLUMN email TEXT;
