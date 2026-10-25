-- Community group chats: publication rooms + member-created group chats, real-time via the ChatRoom Durable Object.
CREATE TABLE IF NOT EXISTS chat_rooms (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'public',          -- public (publication room) | group (member-created, invite only)
  access TEXT NOT NULL DEFAULT 'free',          -- free | premium | tiers (public rooms)
  tier_ids TEXT NOT NULL DEFAULT '[]',
  is_default INTEGER NOT NULL DEFAULT 0,
  slow_mode_sec INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_by_subscriber_id TEXT,
  created_by_user_id TEXT,
  last_message_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (pub_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_chat_rooms_pub ON chat_rooms(pub_id, kind, position);

-- Membership for group chats + read state for every room. member_key = 's:<subscriber_id>' or 'u:<user_id>'.
CREATE TABLE IF NOT EXISTS chat_room_members (
  room_id TEXT NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
  member_key TEXT NOT NULL,
  pub_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',          -- owner | member
  joined INTEGER NOT NULL DEFAULT 1,            -- 1 = participant of a group chat; 0 = read-state row only
  last_read_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, member_key)
);
CREATE INDEX IF NOT EXISTS idx_chat_members_key ON chat_room_members(member_key);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
  pub_id TEXT NOT NULL,
  author_subscriber_id TEXT,
  author_user_id TEXT,
  author_name TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  image_url TEXT,
  reply_to TEXT,
  reactions TEXT NOT NULL DEFAULT '{}',         -- {"👍": ["s:abc", "u:def"]}
  status TEXT NOT NULL DEFAULT 'visible',       -- visible | deleted | hidden | removed
  edited_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_room ON chat_messages(room_id, created_at);

ALTER TABLE community_members ADD COLUMN chat_banned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE community_members ADD COLUMN chat_muted_until INTEGER;
