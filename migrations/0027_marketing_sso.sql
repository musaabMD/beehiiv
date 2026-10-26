-- Marketing channels (social posting, campaigns, ad audiences) and single sign-on (Google + per-workspace OIDC).

-- Connected social accounts. Credentials (app password / access token) are AES-GCM encrypted with a key derived
-- from the APP_SECRET env secret (see lib/auth.ts sealSecret). Share-intent networks (LinkedIn, X, Threads,
-- Facebook) have no stored credentials; they only need a row when the user wants them listed for auto-share links.
CREATE TABLE IF NOT EXISTS social_accounts (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL,
  network TEXT NOT NULL,                 -- bluesky | mastodon
  handle TEXT NOT NULL,                  -- @alice.bsky.social / @alice@mastodon.social
  display_name TEXT NOT NULL DEFAULT '',
  service_url TEXT NOT NULL,             -- Bluesky PDS (https://bsky.social) or Mastodon instance URL
  remote_id TEXT,                        -- DID / Mastodon account id
  profile_url TEXT,
  credentials TEXT NOT NULL,             -- sealed JSON {identifier, password} or {token}
  auto_share INTEGER NOT NULL DEFAULT 0, -- post automatically when a newsletter post is published
  status TEXT NOT NULL DEFAULT 'active', -- active | error
  last_error TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_social_accounts_pub ON social_accounts(pub_id);

CREATE TABLE IF NOT EXISTS social_posts (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  network TEXT NOT NULL,
  text TEXT NOT NULL,
  link_url TEXT,
  image_key TEXT,                        -- media library R2 key
  image_alt TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | posting | posted | failed | cancelled
  scheduled_at INTEGER,
  posted_at INTEGER,
  remote_id TEXT,
  remote_url TEXT,                       -- link to the live post
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  post_id TEXT,                          -- newsletter post this shares (auto-share)
  campaign_id TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_social_posts_pub ON social_posts(pub_id, created_at);
CREATE INDEX IF NOT EXISTS idx_social_posts_due ON social_posts(status, scheduled_at);

-- Campaigns group posts, social posts, events, automations and landing pages; utm_campaign = slug.
CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  goal TEXT NOT NULL DEFAULT '',
  goal_kind TEXT NOT NULL DEFAULT 'signups', -- signups | revenue | clicks | registrations
  goal_target INTEGER NOT NULL DEFAULT 0,
  starts_at INTEGER,
  ends_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active',     -- active | archived
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (pub_id, slug)
);

CREATE TABLE IF NOT EXISTS campaign_items (
  campaign_id TEXT NOT NULL,
  pub_id TEXT NOT NULL,
  kind TEXT NOT NULL,                    -- post | social | event | automation | page
  ref_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (campaign_id, kind, ref_id)
);
CREATE INDEX IF NOT EXISTS idx_campaign_items_ref ON campaign_items(kind, ref_id);

-- Ad audiences: secret pull URLs for hashed segment exports (Google Customer Match / Meta Custom Audiences).
CREATE TABLE IF NOT EXISTS ad_audience_feeds (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL,
  segment_id TEXT NOT NULL,
  platform TEXT NOT NULL,                -- google | meta
  name TEXT NOT NULL DEFAULT '',
  token_hash TEXT NOT NULL UNIQUE,       -- sha256 of the secret in the URL (shown once)
  token_hint TEXT NOT NULL DEFAULT '',
  pull_count INTEGER NOT NULL DEFAULT 0,
  last_pulled_at INTEGER,
  last_rows INTEGER,
  revoked_at INTEGER,
  created_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ad_feeds_pub ON ad_audience_feeds(pub_id);

-- Single sign-on: identities linked to users (provider = 'google' or 'oidc:<workspace_id>').
CREATE TABLE IF NOT EXISTS user_identities (
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  last_login_at INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX IF NOT EXISTS idx_user_identities_user ON user_identities(user_id);

-- Per-workspace Enterprise SSO (generic OIDC).
CREATE TABLE IF NOT EXISTS workspace_sso (
  workspace_id TEXT PRIMARY KEY,
  issuer TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_secret TEXT NOT NULL,           -- sealed
  domain TEXT NOT NULL,                  -- allowed email domain (lowercase)
  verify_token TEXT NOT NULL,            -- DNS TXT _lnkbase-sso.<domain> = lnkbase-sso=<token>
  domain_verified_at INTEGER,
  enabled INTEGER NOT NULL DEFAULT 0,
  enforce INTEGER NOT NULL DEFAULT 0,    -- SSO-only login for the domain (password / magic link / Google refused)
  default_role TEXT NOT NULL DEFAULT 'member', -- role for people provisioned on first SSO login
  tested_at INTEGER,                     -- first successful SSO sign-in (required before enforce)
  updated_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workspace_sso_domain ON workspace_sso(domain);
