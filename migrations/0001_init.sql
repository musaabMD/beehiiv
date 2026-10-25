-- OpenHive schema. All ids are TEXT (random), all times are INTEGER unix ms.
PRAGMA foreign_keys = ON;

-- ───────────── Identity, workspaces, teams ─────────────
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  password_hash TEXT,
  avatar_url TEXT,
  bio TEXT,
  socials TEXT NOT NULL DEFAULT '{}',          -- json {x, linkedin, website, ...}
  is_guest INTEGER NOT NULL DEFAULT 0,          -- guest author without login
  is_superadmin INTEGER NOT NULL DEFAULT 0,     -- instance operator (ad network review, etc.)
  email_verified INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                          -- sha256(token)
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  user_agent TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- Single-use tokens: password reset, login magic link, cross-device login, email verify
CREATE TABLE auth_tokens (
  id TEXT PRIMARY KEY,                          -- sha256(token)
  kind TEXT NOT NULL,                           -- reset | login | device | verify | reader_login
  user_id TEXT,
  pub_id TEXT,
  subscriber_id TEXT,
  data TEXT NOT NULL DEFAULT '{}',
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE publications (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  logo_url TEXT,
  favicon_url TEXT,
  language TEXT NOT NULL DEFAULT 'en',
  timezone TEXT NOT NULL DEFAULT 'UTC',
  category TEXT,
  from_name TEXT,
  reply_to TEXT,
  footer_html TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',             -- CAN-SPAM postal address
  theme TEXT NOT NULL DEFAULT '{}',             -- website theme tokens json
  email_style TEXT NOT NULL DEFAULT '{}',       -- default email style tokens json
  settings TEXT NOT NULL DEFAULT '{}',          -- misc json (double_opt_in, paywall meter, robots, ga id, link params...)
  custom_domain TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL
);

-- Role at workspace level (pub_id = '') or publication level. roles: owner | admin | member | contributor
CREATE TABLE memberships (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  pub_id TEXT NOT NULL DEFAULT '',
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, pub_id, user_id)
);
CREATE INDEX idx_memberships_user ON memberships(user_id);

CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  pub_id TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  invited_by TEXT,
  created_at INTEGER NOT NULL,
  accepted_at INTEGER
);

CREATE TABLE transfers (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL,
  from_user_id TEXT NOT NULL,
  to_email TEXT NOT NULL,
  consent_text TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',       -- pending | accepted | cancelled
  created_at INTEGER NOT NULL,
  accepted_at INTEGER
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  pub_id TEXT,
  user_id TEXT,
  action TEXT NOT NULL,
  target TEXT,
  data TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_audit_pub ON audit_log(pub_id, created_at);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  created_by TEXT,
  revoked_at INTEGER,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL
);

-- ───────────── Sending identities & domains ─────────────
CREATE TABLE sender_addresses (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  purpose TEXT NOT NULL DEFAULT 'newsletter',   -- newsletter | transactional | automations | community
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE domains (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  hostname TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,                           -- web | email
  status TEXT NOT NULL DEFAULT 'pending',       -- pending | verified | failed
  verify_token TEXT NOT NULL,
  dns_report TEXT NOT NULL DEFAULT '{}',
  warmup_started_at INTEGER,
  blocklisted INTEGER NOT NULL DEFAULT 0,
  last_checked_at INTEGER,
  created_at INTEGER NOT NULL
);

-- ───────────── Audience ─────────────
CREATE TABLE subscribers (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',        -- pending | active | unsubscribed | bounced | complained
  tier TEXT NOT NULL DEFAULT 'free',            -- free | premium
  tier_id TEXT,
  trial_ends_at INTEGER,
  source TEXT NOT NULL DEFAULT 'website',       -- website | import | api | magic_link | form | referral | recommendation | boost | manual | event | product | linkinbio
  source_detail TEXT,                           -- form id, partner pub id, etc.
  utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_term TEXT, utm_content TEXT,
  referrer_url TEXT,
  landing_path TEXT,
  referral_code TEXT NOT NULL,
  referred_by TEXT,
  referral_count INTEGER NOT NULL DEFAULT 0,
  custom TEXT NOT NULL DEFAULT '{}',
  country TEXT,
  ip TEXT,
  stripe_customer_id TEXT,
  confirmed_at INTEGER,
  unsubscribed_at INTEGER,
  unsubscribe_reason TEXT,
  last_open_at INTEGER,
  last_click_at INTEGER,
  open_count INTEGER NOT NULL DEFAULT 0,
  click_count INTEGER NOT NULL DEFAULT 0,
  received_count INTEGER NOT NULL DEFAULT 0,
  engagement INTEGER NOT NULL DEFAULT 0,        -- 0-100
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (pub_id, email)
);
CREATE UNIQUE INDEX idx_sub_refcode ON subscribers(referral_code);
CREATE INDEX idx_sub_pub_status ON subscribers(pub_id, status, created_at);

CREATE TABLE subscriber_tags (
  pub_id TEXT NOT NULL,
  subscriber_id TEXT NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (subscriber_id, tag)
);
CREATE INDEX idx_subtags_pub ON subscriber_tags(pub_id, tag);

CREATE TABLE custom_fields (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text',            -- text | number | date | boolean | list
  options TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  UNIQUE (pub_id, key)
);

-- Newsletter lists inside one publication
CREATE TABLE lists (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0,
  public INTEGER NOT NULL DEFAULT 1,            -- shown to readers when picking lists
  created_at INTEGER NOT NULL
);
CREATE TABLE list_members (
  list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  subscriber_id TEXT NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'subscribed',    -- subscribed | unsubscribed
  created_at INTEGER NOT NULL,
  PRIMARY KEY (list_id, subscriber_id)
);

-- Reusable condition sets (used by segments + automations)
CREATE TABLE condition_sets (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  rules TEXT NOT NULL,                          -- json RuleGroup
  created_at INTEGER NOT NULL
);

CREATE TABLE segments (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'dynamic',         -- dynamic | static
  rules TEXT NOT NULL DEFAULT '{"op":"and","rules":[]}',
  cached_count INTEGER NOT NULL DEFAULT 0,
  calculated_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE segment_members (                  -- static segments + cached dynamic membership
  segment_id TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
  subscriber_id TEXT NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
  PRIMARY KEY (segment_id, subscriber_id)
);

-- Activity stream: every subscriber-level event (engagement history)
CREATE TABLE activity (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL,
  subscriber_id TEXT,
  type TEXT NOT NULL,                           -- subscribed, confirmed, unsubscribed, email.sent, email.opened, email.clicked, tag.added, upgraded, purchased, poll.voted ...
  ref_id TEXT,                                  -- post id / automation id / product id
  data TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_activity_sub ON activity(subscriber_id, created_at);
CREATE INDEX idx_activity_pub_type ON activity(pub_id, type, created_at);

CREATE TABLE imports (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL,
  filename TEXT,
  total INTEGER NOT NULL DEFAULT 0,
  imported INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  errors TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'done',
  created_by TEXT,
  created_at INTEGER NOT NULL
);

-- Subscribe forms (embeds, popups) with draft/live versions
CREATE TABLE forms (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'embed',           -- embed | popup | slide_in | inline
  layout TEXT NOT NULL DEFAULT 'full',          -- full | fixed | slim
  draft TEXT NOT NULL DEFAULT '{}',             -- json config (fields, styles tokens, success, lists, survey_id, tags)
  live TEXT,                                    -- published json config
  published_at INTEGER,
  views INTEGER NOT NULL DEFAULT 0,
  submissions INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE surveys (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  questions TEXT NOT NULL DEFAULT '[]',         -- [{id, kind: short|long|single|multi|rating|nps|dropdown|date, label, options, required}]
  status TEXT NOT NULL DEFAULT 'active',
  thank_you TEXT NOT NULL DEFAULT 'Thanks for your response!',
  created_at INTEGER NOT NULL
);
CREATE TABLE survey_responses (
  id TEXT PRIMARY KEY,
  survey_id TEXT NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  pub_id TEXT NOT NULL,
  subscriber_id TEXT,
  answers TEXT NOT NULL,                        -- json {questionId: value}
  created_at INTEGER NOT NULL
);

CREATE TABLE polls (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  options TEXT NOT NULL,                        -- json [{id,label}]
  purpose TEXT NOT NULL DEFAULT 'general',      -- general | topic | product | pricing
  closed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE poll_votes (
  id TEXT PRIMARY KEY,
  poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  pub_id TEXT NOT NULL,
  subscriber_id TEXT,
  option_id TEXT NOT NULL,
  post_id TEXT,
  channel TEXT NOT NULL DEFAULT 'email',        -- email | web
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_poll_vote_unique ON poll_votes(poll_id, subscriber_id);

-- ───────────── Content ─────────────
CREATE TABLE posts (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  subtitle TEXT NOT NULL DEFAULT '',
  slug TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '{"blocks":[]}', -- editor document json
  email_content TEXT,                           -- optional email-only override doc
  status TEXT NOT NULL DEFAULT 'draft',         -- draft | scheduled | published | archived
  platform TEXT NOT NULL DEFAULT 'both',        -- email | web | both
  audience TEXT NOT NULL DEFAULT 'all',         -- all | free | premium
  tier_ids TEXT NOT NULL DEFAULT '[]',
  list_id TEXT,
  segment_ids TEXT NOT NULL DEFAULT '[]',       -- send to
  exclude_segment_ids TEXT NOT NULL DEFAULT '[]',
  email_subject TEXT,
  preview_text TEXT NOT NULL DEFAULT '',
  ab_test TEXT,                                 -- json {subjects:[], sample_pct, wait_minutes, metric, winner}
  cohort_test TEXT,                             -- json {variants:[{name, content_id}], split}
  sender_id TEXT,
  thumbnail_url TEXT,
  seo TEXT NOT NULL DEFAULT '{}',               -- {title, description, og_image, canonical, noindex}
  template_id TEXT,
  style TEXT NOT NULL DEFAULT '{}',             -- style tokens override
  comments_enabled INTEGER NOT NULL DEFAULT 1,
  hide_from_feed INTEGER NOT NULL DEFAULT 0,
  audio_key TEXT,                               -- TTS audio in R2
  word_count INTEGER NOT NULL DEFAULT 0,
  scheduled_at INTEGER,
  published_at INTEGER,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (pub_id, slug)
);
CREATE INDEX idx_posts_pub_status ON posts(pub_id, status, published_at);

CREATE TABLE post_authors (
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (post_id, user_id)
);
CREATE TABLE content_tags (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  UNIQUE (pub_id, slug)
);
CREATE TABLE post_tags (
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES content_tags(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, tag_id)
);
CREATE TABLE post_versions (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE draft_comments (                   -- editorial comment threads in drafts
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  block_id TEXT,
  parent_id TEXT,
  user_id TEXT NOT NULL,
  body TEXT NOT NULL,
  quote TEXT,
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE templates (
  id TEXT PRIMARY KEY,
  pub_id TEXT,                                  -- NULL = built-in library template
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'post',            -- post | welcome | automation | website_page | website_section | website_block
  description TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '{"blocks":[]}',
  style TEXT NOT NULL DEFAULT '{}',             -- {email:{...tokens}, web:{...tokens}}
  is_default INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE uploads (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL,
  key TEXT NOT NULL,                            -- R2 key
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  width INTEGER, height INTEGER,
  alt TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'upload',        -- upload | url | ai
  created_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_uploads_pub ON uploads(pub_id, created_at);

-- Reader-facing
CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  subscriber_id TEXT NOT NULL,
  parent_id TEXT,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'visible',       -- visible | hidden | reported
  likes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE reactions (
  post_id TEXT NOT NULL,
  subscriber_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, subscriber_id, emoji)
);

-- ───────────── Sending & tracking ─────────────
CREATE TABLE sends (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL,
  post_id TEXT,
  automation_id TEXT,
  step_id TEXT,
  kind TEXT NOT NULL DEFAULT 'post',            -- post | automation | test | transactional | community | event
  subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',        -- queued | sending | testing | sent | failed | cancelled
  total INTEGER NOT NULL DEFAULT 0,
  sent INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  cursor TEXT,                                  -- last subscriber id processed
  options TEXT NOT NULL DEFAULT '{}',           -- {segment_ids, exclude, list_id, ab, cohorts}
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER
);
CREATE INDEX idx_sends_pub ON sends(pub_id, created_at);

CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,                          -- also used as tracking token
  send_id TEXT NOT NULL,
  pub_id TEXT NOT NULL,
  subscriber_id TEXT,
  email TEXT NOT NULL,
  variant TEXT,                                 -- A/B subject or cohort
  status TEXT NOT NULL DEFAULT 'queued',        -- queued | sent | deferred | bounced | failed | complained | suppressed
  bounce_type TEXT,                             -- hard | soft | mailbox_full | dns | policy
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  message_id TEXT,
  error TEXT,
  provider TEXT,                                -- gmail | outlook | yahoo | apple | other (by domain)
  sent_at INTEGER,
  opened_at INTEGER,
  open_count INTEGER NOT NULL DEFAULT 0,
  clicked_at INTEGER,
  click_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_deliveries_send ON deliveries(send_id, status);
CREATE INDEX idx_deliveries_sub ON deliveries(subscriber_id);
CREATE INDEX idx_deliveries_retry ON deliveries(status, next_attempt_at);

CREATE TABLE clicks (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL,
  send_id TEXT NOT NULL,
  pub_id TEXT NOT NULL,
  url TEXT NOT NULL,
  is_bot INTEGER NOT NULL DEFAULT 0,
  ua TEXT, country TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_clicks_send ON clicks(send_id);
CREATE TABLE opens (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL,
  send_id TEXT NOT NULL,
  pub_id TEXT NOT NULL,
  is_bot INTEGER NOT NULL DEFAULT 0,            -- Apple MPP / security scanners
  ua TEXT, country TEXT, device TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_opens_send ON opens(send_id);

-- Suppression: scope global | pub | transactional. expires_at NULL = permanent
CREATE TABLE suppressions (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  pub_id TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL,
  reason TEXT NOT NULL,                         -- hard_bounce | soft_bounce | complaint | unsubscribe | manual | fbl | invalid
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (scope, pub_id, email)
);
CREATE INDEX idx_suppress_email ON suppressions(email);

-- Raw outbound log (local simulation viewer + audit)
CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  pub_id TEXT,
  to_email TEXT NOT NULL,
  from_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  html TEXT NOT NULL,
  headers TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,                         -- sent | simulated | failed
  error TEXT,
  created_at INTEGER NOT NULL
);

-- Short links (shareable links, UTM tracking)
CREATE TABLE links (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  url TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'short',           -- short | magic_subscribe
  config TEXT NOT NULL DEFAULT '{}',
  clicks INTEGER NOT NULL DEFAULT 0,
  signups INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- ───────────── Background work ─────────────
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  run_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',       -- pending | running | done | failed
  attempts INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_jobs_due ON jobs(status, run_at);

CREATE TABLE error_log (
  id TEXT PRIMARY KEY,
  pub_id TEXT,
  source TEXT NOT NULL,
  message TEXT NOT NULL,
  stack TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);

-- ───────────── Webhooks & integrations ─────────────
CREATE TABLE webhooks (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  events TEXT NOT NULL DEFAULT '["*"]',
  secret TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '2026-10-01',
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  pub_id TEXT NOT NULL,
  event TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',       -- pending | success | failed | retrying
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  response_code INTEGER,
  response_body TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_whd_hook ON webhook_deliveries(webhook_id, created_at);

CREATE TABLE integrations (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,                       -- google_analytics | hubspot | manychat | meta | linktree | discord | luma | zapier | stripe
  config TEXT NOT NULL DEFAULT '{}',
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  UNIQUE (pub_id, provider)
);

-- ───────────── Automations ─────────────
CREATE TABLE automations (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',         -- draft | active | paused | archived
  trigger TEXT NOT NULL DEFAULT '{}',           -- live trigger json {type, config}
  steps TEXT NOT NULL DEFAULT '[]',             -- live steps json (tree)
  draft_trigger TEXT,                           -- draft edits while live keeps running
  draft_steps TEXT,
  allow_reentry INTEGER NOT NULL DEFAULT 0,
  published_at INTEGER,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE automation_runs (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  pub_id TEXT NOT NULL,
  subscriber_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',        -- active | waiting | completed | exited | failed
  step_path TEXT NOT NULL DEFAULT '[]',         -- path to current step
  next_run_at INTEGER,
  data TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_runs_due ON automation_runs(status, next_run_at);
CREATE INDEX idx_runs_sub ON automation_runs(subscriber_id);
CREATE TABLE automation_logs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  automation_id TEXT NOT NULL,
  step_id TEXT,
  action TEXT NOT NULL,
  result TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_alogs_run ON automation_logs(run_id);

-- ───────────── Monetization ─────────────
CREATE TABLE tiers (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL DEFAULT 'usd',
  monthly_cents INTEGER NOT NULL DEFAULT 0,
  annual_cents INTEGER NOT NULL DEFAULT 0,
  trial_days INTEGER NOT NULL DEFAULT 0,
  paid_trial_cents INTEGER NOT NULL DEFAULT 0,  -- e.g. $1 for trial_days
  benefits TEXT NOT NULL DEFAULT '[]',
  perks TEXT NOT NULL DEFAULT '{}',             -- {podcast_ids:[], channel_ids:[]}
  group_enabled INTEGER NOT NULL DEFAULT 0,
  group_seat_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',        -- active | paused | archived
  stripe_product_id TEXT, stripe_price_monthly TEXT, stripe_price_annual TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE offers (                           -- discount offers / coupons / promo codes (subs, products, tickets)
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  applies_to TEXT NOT NULL DEFAULT 'all',       -- all | subscription | product | event
  target_id TEXT,
  percent_off INTEGER NOT NULL DEFAULT 0,
  amount_off_cents INTEGER NOT NULL DEFAULT 0,
  duration TEXT NOT NULL DEFAULT 'once',        -- once | repeating | forever
  duration_months INTEGER,
  max_redemptions INTEGER,
  redemptions INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  UNIQUE (pub_id, code)
);
CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL,
  subscriber_id TEXT NOT NULL,
  tier_id TEXT NOT NULL,
  interval TEXT NOT NULL DEFAULT 'month',       -- month | year
  status TEXT NOT NULL DEFAULT 'active',        -- trialing | active | paused | past_due | canceled
  amount_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'usd',
  seats INTEGER NOT NULL DEFAULT 1,
  group_owner_id TEXT,                          -- for group seat members
  gift_from_email TEXT,
  gift_message TEXT,
  offer_id TEXT,
  stripe_subscription_id TEXT,
  trial_ends_at INTEGER,
  current_period_end INTEGER,
  paused_at INTEGER,
  canceled_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_subscriptions_sub ON subscriptions(subscriber_id);
CREATE TABLE group_deals (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL,
  company TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  tier_id TEXT NOT NULL,
  seats INTEGER NOT NULL,
  price_cents INTEGER NOT NULL,
  interval TEXT NOT NULL DEFAULT 'year',
  token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'offered',
  created_at INTEGER NOT NULL
);

CREATE TABLE orders (                           -- every payment: subscription, product, ticket, gift, sponsorship
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL,
  kind TEXT NOT NULL,                           -- subscription | product | ticket | gift | group | sponsorship | replay
  ref_id TEXT,                                  -- tier/product/event id
  variant_id TEXT,
  subscriber_id TEXT,
  email TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  platform_fee_cents INTEGER NOT NULL DEFAULT 0,
  offer_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',       -- pending | paid | refunded | failed
  stripe_session_id TEXT,
  stripe_payment_intent TEXT,
  delivery_token TEXT,
  data TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  paid_at INTEGER
);
CREATE INDEX idx_orders_pub ON orders(pub_id, created_at);

CREATE TABLE products (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'download',        -- download | link | guide | template | ebook | membership | coaching | replay
  price_cents INTEGER NOT NULL DEFAULT 0,       -- 0 = free lead magnet
  currency TEXT NOT NULL DEFAULT 'usd',
  cover_url TEXT,
  file_key TEXT,
  link_url TEXT,
  content TEXT,                                 -- guide body
  access_days INTEGER,                          -- membership/time based
  coaching TEXT NOT NULL DEFAULT '{}',          -- {duration_min, availability:[{dow,start,end}], tz, location}
  tags TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',        -- draft | active | archived
  automation_id TEXT,                           -- follow-up automation
  sales_count INTEGER NOT NULL DEFAULT 0,
  revenue_cents INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (pub_id, slug)
);
CREATE TABLE product_variants (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  file_key TEXT,
  link_url TEXT,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE product_reviews (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  pub_id TEXT NOT NULL,
  order_id TEXT,
  name TEXT NOT NULL,
  rating INTEGER NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',       -- pending | approved | rejected
  created_at INTEGER NOT NULL
);
CREATE TABLE bookings (                         -- 1:1 coaching (products + events)
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL,
  product_id TEXT,
  order_id TEXT,
  subscriber_id TEXT,
  email TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed',
  notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

-- Ad network + sponsorships
CREATE TABLE advertisers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  website TEXT,
  logo_url TEXT,
  contact_email TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE ad_campaigns (
  id TEXT PRIMARY KEY,
  advertiser_id TEXT NOT NULL REFERENCES advertisers(id),
  owner_pub_id TEXT,                            -- NULL = network campaign; set = direct sponsorship of that pub
  name TEXT NOT NULL,
  headline TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  image_url TEXT,
  cta_label TEXT NOT NULL DEFAULT 'Learn more',
  url TEXT NOT NULL,
  link_params TEXT NOT NULL DEFAULT '',         -- e.g. utm_source={pub}&ref=openhive
  pricing TEXT NOT NULL DEFAULT 'cpc',          -- cpc | cpm | flat
  rate_cents INTEGER NOT NULL DEFAULT 0,
  budget_cents INTEGER NOT NULL DEFAULT 0,
  spent_cents INTEGER NOT NULL DEFAULT 0,
  categories TEXT NOT NULL DEFAULT '[]',
  review_status TEXT NOT NULL DEFAULT 'pending',-- brand safety: pending | approved | rejected
  review_notes TEXT,
  starts_at INTEGER, ends_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL
);
CREATE TABLE ad_opportunities (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  pub_id TEXT NOT NULL,
  post_id TEXT,
  status TEXT NOT NULL DEFAULT 'available',     -- available | accepted | declined | placed | completed
  scheduled_for INTEGER,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  bot_clicks INTEGER NOT NULL DEFAULT 0,
  earned_cents INTEGER NOT NULL DEFAULT 0,
  decided_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE sponsorship_products (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT 'primary',       -- primary | secondary | classified | dedicated
  description TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE wallet_entries (                   -- earnings + payouts (ads, boosts, recommendations)
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL,
  kind TEXT NOT NULL,                           -- ad | boost | clawback | payout | sponsorship
  ref_id TEXT,
  amount_cents INTEGER NOT NULL,                -- +earning / -payout or clawback
  status TEXT NOT NULL DEFAULT 'pending',       -- pending | available | paid
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

-- ───────────── Growth ─────────────
CREATE TABLE referral_rewards (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  milestone INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'digital',         -- digital | physical | promo | premium
  payload TEXT NOT NULL DEFAULT '',             -- url / promo code / premium days
  image_url TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE referral_awards (
  id TEXT PRIMARY KEY,
  reward_id TEXT NOT NULL,
  pub_id TEXT NOT NULL,
  subscriber_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'awarded',       -- awarded | fulfilled | rejected
  created_at INTEGER NOT NULL,
  UNIQUE (reward_id, subscriber_id)
);
CREATE TABLE recommendations (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL,                         -- recommender
  target_pub_id TEXT,                           -- on-instance publication
  ext_name TEXT, ext_url TEXT, ext_description TEXT, ext_logo TEXT,
  reciprocal INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',        -- active | paused | ended
  subscribers_sent INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE boost_offers (                     -- paid recommendations: advertiser pub pays per subscriber
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL,
  cpa_cents INTEGER NOT NULL,
  budget_cents INTEGER NOT NULL DEFAULT 0,
  spent_cents INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL DEFAULT '',
  auto_accept INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',        -- active | paused | ended
  created_at INTEGER NOT NULL
);
CREATE TABLE boost_partners (
  id TEXT PRIMARY KEY,
  offer_id TEXT NOT NULL REFERENCES boost_offers(id) ON DELETE CASCADE,
  partner_pub_id TEXT NOT NULL,                 -- publisher recommending
  status TEXT NOT NULL DEFAULT 'applied',       -- applied | active | rejected | paused | ended
  subscribers INTEGER NOT NULL DEFAULT 0,
  verified_subscribers INTEGER NOT NULL DEFAULT 0,
  flagged INTEGER NOT NULL DEFAULT 0,
  earned_cents INTEGER NOT NULL DEFAULT 0,
  clawed_back_cents INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (offer_id, partner_pub_id)
);
CREATE TABLE boost_conversions (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL,
  subscriber_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',       -- pending | verified | clawed_back
  fraud_score INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE link_in_bio (
  pub_id TEXT PRIMARY KEY REFERENCES publications(id) ON DELETE CASCADE,
  config TEXT NOT NULL DEFAULT '{}',            -- {headline, bio, avatar, theme tokens, links:[{label,url,icon}], socials, show_posts, show_products, show_tiers, show_form}
  views INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- ───────────── Website ─────────────
CREATE TABLE pages (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,                           -- '' = home override
  content TEXT NOT NULL DEFAULT '{"sections":[]}',
  html_override TEXT,                           -- full HTML access
  seo TEXT NOT NULL DEFAULT '{}',
  paywall TEXT NOT NULL DEFAULT 'none',         -- none | subscribers | premium
  status TEXT NOT NULL DEFAULT 'draft',
  show_in_nav INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (pub_id, slug)
);
CREATE TABLE page_versions (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL,                        -- page id or 'theme:<pub_id>'
  snapshot TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE nav_links (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  location TEXT NOT NULL DEFAULT 'header',      -- header | footer
  label TEXT NOT NULL,
  url TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE redirects (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  from_path TEXT NOT NULL,
  to_url TEXT NOT NULL,
  code INTEGER NOT NULL DEFAULT 301,
  hits INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (pub_id, from_path)
);
CREATE TABLE page_views (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL,
  path TEXT NOT NULL,
  ref_id TEXT,                                  -- post/page/episode id
  referrer TEXT,
  channel TEXT,                                 -- direct | search | social | email | referral | ai
  utm_source TEXT, utm_medium TEXT, utm_campaign TEXT,
  country TEXT, device TEXT, os TEXT, browser TEXT,
  visitor_id TEXT,
  subscriber_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_pv_pub ON page_views(pub_id, created_at);
CREATE TABLE bot_hits (                         -- AI crawler & bot analytics
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL,
  bot TEXT NOT NULL,
  category TEXT NOT NULL,                       -- ai | search | seo | scraper | other
  path TEXT NOT NULL,
  action TEXT NOT NULL,                         -- served | blocked
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_bothits_pub ON bot_hits(pub_id, created_at);

-- Reader accounts (per publication via subscriber); sessions shared instance-wide by email
CREATE TABLE reader_sessions (
  id TEXT PRIMARY KEY,                          -- sha256(token)
  email TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- ───────────── Community ─────────────
CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  access TEXT NOT NULL DEFAULT 'free',          -- free | premium | tiers
  tier_ids TEXT NOT NULL DEFAULT '[]',
  is_default INTEGER NOT NULL DEFAULT 0,
  sync_posts INTEGER NOT NULL DEFAULT 0,        -- newsletter posts auto-posted here
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (pub_id, slug)
);
CREATE TABLE community_members (
  pub_id TEXT NOT NULL,
  subscriber_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',          -- admin | manager | moderator | member
  status TEXT NOT NULL DEFAULT 'active',        -- active | banned | invited
  display_name TEXT,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (pub_id, subscriber_id)
);
CREATE TABLE community_posts (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  author_subscriber_id TEXT,
  author_user_id TEXT,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  post_id TEXT,                                 -- synced newsletter post
  pinned INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'visible',       -- visible | hidden | removed
  reply_count INTEGER NOT NULL DEFAULT 0,
  like_count INTEGER NOT NULL DEFAULT 0,
  last_activity_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE community_comments (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL,
  post_id TEXT NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
  parent_id TEXT,
  author_subscriber_id TEXT,
  author_user_id TEXT,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'visible',
  created_at INTEGER NOT NULL
);
CREATE TABLE community_reports (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL,
  target_kind TEXT NOT NULL,                    -- post | comment | dm
  target_id TEXT NOT NULL,
  reporter_subscriber_id TEXT,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',          -- open | dismissed | actioned
  created_at INTEGER NOT NULL
);
CREATE TABLE direct_messages (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL,
  subscriber_id TEXT NOT NULL,                  -- the member side of the conversation
  from_side TEXT NOT NULL,                      -- member | publication
  user_id TEXT,
  body TEXT NOT NULL,
  read_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_dm_conv ON direct_messages(pub_id, subscriber_id, created_at);

-- ───────────── Podcasts ─────────────
CREATE TABLE podcasts (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  owner_email TEXT,
  cover_url TEXT,
  language TEXT NOT NULL DEFAULT 'en',
  category TEXT NOT NULL DEFAULT 'Technology',
  subcategory TEXT,
  explicit INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'episodic',        -- episodic | serial
  copyright TEXT,
  access TEXT NOT NULL DEFAULT 'public',        -- public | premium (private feeds) | both
  redirect_url TEXT,                            -- RSS moved away (itunes:new-feed-url)
  import_url TEXT,
  apple_url TEXT, spotify_url TEXT, youtube_url TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (pub_id, slug)
);
CREATE TABLE episodes (
  id TEXT PRIMARY KEY,
  podcast_id TEXT NOT NULL REFERENCES podcasts(id) ON DELETE CASCADE,
  pub_id TEXT NOT NULL,
  guid TEXT NOT NULL,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  audio_key TEXT,
  audio_url TEXT,                               -- external (imported) audio
  mime TEXT NOT NULL DEFAULT 'audio/mpeg',
  size INTEGER NOT NULL DEFAULT 0,
  duration INTEGER NOT NULL DEFAULT 0,          -- seconds
  season INTEGER, number INTEGER,
  episode_type TEXT NOT NULL DEFAULT 'full',
  explicit INTEGER NOT NULL DEFAULT 0,
  image_url TEXT,
  transcript TEXT,
  premium INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft',         -- draft | scheduled | published | archived
  published_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (podcast_id, slug)
);
CREATE TABLE podcast_feed_tokens (               -- private feeds per paying subscriber
  token TEXT PRIMARY KEY,
  podcast_id TEXT NOT NULL,
  subscriber_id TEXT NOT NULL,
  revoked_at INTEGER,
  last_access_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE episode_downloads (
  id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL,
  podcast_id TEXT NOT NULL,
  pub_id TEXT NOT NULL,
  listener_hash TEXT NOT NULL,                  -- IAB: ip+ua hash per 24h
  app TEXT, device TEXT, country TEXT,
  is_bot INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  day TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_dl_ep ON episode_downloads(episode_id, day);
CREATE UNIQUE INDEX idx_dl_iab ON episode_downloads(episode_id, listener_hash, day);

-- ───────────── Events / webinars ─────────────
CREATE TABLE live_events (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'webinar',         -- webinar | in_person | coaching
  cover_url TEXT,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  location TEXT,
  capacity INTEGER NOT NULL DEFAULT 10000,
  price_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'usd',
  access TEXT NOT NULL DEFAULT 'public',        -- public | subscribers | premium
  reminders TEXT NOT NULL DEFAULT '[1440,60]',  -- minutes before, up to 5
  stream_status TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | live | ended
  recording_key TEXT,
  replay_product_id TEXT,
  luma_event_id TEXT,
  status TEXT NOT NULL DEFAULT 'published',
  created_at INTEGER NOT NULL,
  UNIQUE (pub_id, slug)
);
CREATE TABLE event_registrations (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES live_events(id) ON DELETE CASCADE,
  pub_id TEXT NOT NULL,
  subscriber_id TEXT,
  email TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  order_id TEXT,
  token TEXT NOT NULL,                          -- join link token
  reminders_sent TEXT NOT NULL DEFAULT '[]',
  attended_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (event_id, email)
);
