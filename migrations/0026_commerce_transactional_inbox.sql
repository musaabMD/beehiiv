-- Commerce data sync (Shopify, WooCommerce, the creator's own Stripe), cart abandonment,
-- transactional email API (templates + message log) and the reply Inbox. See docs/COMMERCE.md.

-- ───────────── Store connections ─────────────
CREATE TABLE IF NOT EXISTS commerce_stores (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,                       -- shopify | woocommerce | stripe
  name TEXT NOT NULL DEFAULT '',
  store_url TEXT,                               -- shop domain / site URL (display + recovery links)
  secret TEXT NOT NULL,                         -- webhook signing secret pasted by the owner
  hook_token TEXT NOT NULL UNIQUE,              -- unguessable path segment of the webhook URL
  config TEXT NOT NULL DEFAULT '{}',            -- {abandon_hours, tag_buyers, tag_prefix}
  active INTEGER NOT NULL DEFAULT 1,
  events_count INTEGER NOT NULL DEFAULT 0,
  last_event_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (pub_id, platform)
);

-- Every buyer we hear about. Only customers who accepted marketing become subscribers; the rest stay here
-- (purchase history kept, never emailed).
CREATE TABLE IF NOT EXISTS commerce_customers (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  external_id TEXT,
  email TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  accepts_marketing INTEGER NOT NULL DEFAULT 0,
  subscriber_id TEXT,
  orders_count INTEGER NOT NULL DEFAULT 0,
  total_spent_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'usd',
  first_order_at INTEGER,
  last_order_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (pub_id, platform, email)
);
CREATE INDEX IF NOT EXISTS idx_ccust_email ON commerce_customers(pub_id, email);

CREATE TABLE IF NOT EXISTS external_orders (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  order_number TEXT,
  email TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  subscriber_id TEXT,
  customer_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',       -- pending | paid | refunded | cancelled
  total_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'usd',
  checkout_ref TEXT,                            -- Shopify checkout token / Woo order key: links an abandoned cart
  paid_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (pub_id, platform, external_id)
);
CREATE INDEX IF NOT EXISTS idx_extord_sub ON external_orders(subscriber_id, status);
CREATE INDEX IF NOT EXISTS idx_extord_email ON external_orders(pub_id, email);
CREATE INDEX IF NOT EXISTS idx_extord_pub ON external_orders(pub_id, status, paid_at);

CREATE TABLE IF NOT EXISTS external_order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES external_orders(id) ON DELETE CASCADE,
  pub_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  product_id TEXT,
  sku TEXT,
  name TEXT NOT NULL DEFAULT '',
  quantity INTEGER NOT NULL DEFAULT 1,
  price_cents INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_extitems_order ON external_order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_extitems_product ON external_order_items(pub_id, product_id);

-- Webhook receipt log (also the idempotency record: platforms retry deliveries)
CREATE TABLE IF NOT EXISTS commerce_events (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL,
  store_id TEXT,
  platform TEXT NOT NULL,
  topic TEXT NOT NULL DEFAULT '',
  dedupe_key TEXT,
  status TEXT NOT NULL,                         -- processed | ignored | duplicate | invalid_signature | error
  detail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cevents_dedupe ON commerce_events(pub_id, platform, dedupe_key);
CREATE INDEX IF NOT EXISTS idx_cevents_pub ON commerce_events(pub_id, created_at);

CREATE TABLE IF NOT EXISTS abandoned_carts (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  external_id TEXT NOT NULL,                    -- checkout token / order id
  email TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  subscriber_id TEXT,
  total_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'usd',
  items TEXT NOT NULL DEFAULT '[]',             -- [{name, quantity, price_cents, product_id, image}]
  recovery_url TEXT,
  status TEXT NOT NULL DEFAULT 'open',          -- open | abandoned | recovered | expired
  checkout_updated_at INTEGER NOT NULL,
  abandoned_at INTEGER,
  recovered_at INTEGER,
  order_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (pub_id, platform, external_id)
);
CREATE INDEX IF NOT EXISTS idx_carts_due ON abandoned_carts(status, checkout_updated_at);
CREATE INDEX IF NOT EXISTS idx_carts_sub ON abandoned_carts(subscriber_id, status);

-- ───────────── Transactional email API ─────────────
CREATE TABLE IF NOT EXISTS tx_templates (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  format TEXT NOT NULL DEFAULT 'markdown',      -- markdown | html
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (pub_id, slug)
);

CREATE TABLE IF NOT EXISTS tx_messages (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL,
  api_key_id TEXT,
  template_id TEXT,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,                         -- sent | simulated | failed | suppressed | bounced | complained
  error TEXT,
  message_id TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  idempotency_key TEXT,
  track INTEGER NOT NULL DEFAULT 0,
  links TEXT NOT NULL DEFAULT '[]',
  open_count INTEGER NOT NULL DEFAULT 0,
  opened_at INTEGER,
  click_count INTEGER NOT NULL DEFAULT 0,
  clicked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_txmsg_idem ON tx_messages(pub_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_txmsg_pub ON tx_messages(pub_id, created_at);
CREATE INDEX IF NOT EXISTS idx_txmsg_msgid ON tx_messages(message_id);

-- ───────────── Reply inbox ─────────────
CREATE TABLE IF NOT EXISTS inbox_threads (
  id TEXT PRIMARY KEY,
  pub_id TEXT NOT NULL,
  email TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  subscriber_id TEXT,
  delivery_id TEXT,
  send_id TEXT,
  post_id TEXT,
  subject TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',          -- open | archived
  unread INTEGER NOT NULL DEFAULT 1,
  verified INTEGER NOT NULL DEFAULT 1,          -- sender matched the delivery's recipient
  message_count INTEGER NOT NULL DEFAULT 0,
  last_message_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inbox_pub ON inbox_threads(pub_id, status, last_message_at);
CREATE INDEX IF NOT EXISTS idx_inbox_key ON inbox_threads(pub_id, email, delivery_id);

CREATE TABLE IF NOT EXISTS inbox_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES inbox_threads(id) ON DELETE CASCADE,
  pub_id TEXT NOT NULL,
  direction TEXT NOT NULL,                      -- in | out
  from_email TEXT NOT NULL,
  from_name TEXT NOT NULL DEFAULT '',
  to_email TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  html TEXT,
  message_id TEXT,
  in_reply_to TEXT,
  sent_by TEXT,                                 -- user id for outgoing replies
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inboxmsg_thread ON inbox_messages(thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_inboxmsg_msgid ON inbox_messages(message_id);
