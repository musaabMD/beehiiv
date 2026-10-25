-- Monetize module: indexes + small additive columns.
ALTER TABLE subscriptions ADD COLUMN cancel_at_period_end INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN order_id TEXT;
ALTER TABLE ad_opportunities ADD COLUMN settled_at INTEGER;
ALTER TABLE advertisers ADD COLUMN owner_pub_id TEXT;

CREATE INDEX IF NOT EXISTS idx_subscriptions_pub ON subscriptions(pub_id, status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_group ON subscriptions(group_owner_id);
CREATE INDEX IF NOT EXISTS idx_orders_token ON orders(delivery_token);
CREATE INDEX IF NOT EXISTS idx_orders_ref ON orders(pub_id, kind, ref_id);
CREATE INDEX IF NOT EXISTS idx_adopp_pub ON ad_opportunities(pub_id, status);
CREATE INDEX IF NOT EXISTS idx_adopp_campaign ON ad_opportunities(campaign_id);
CREATE INDEX IF NOT EXISTS idx_wallet_pub ON wallet_entries(pub_id, status);
CREATE INDEX IF NOT EXISTS idx_bookings_product ON bookings(product_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_reviews_product ON product_reviews(product_id, status);
