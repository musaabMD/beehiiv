/** @jsxImportSource hono/jsx */
// Module: monetize — paid subscriptions, offers, digital products, orders, ad network, sponsorships, wallet.
// Fulfillment handlers + lifecycle jobs live in src/lib/billing.ts (registered on import).
import { Hono } from 'hono';
import type { AppEnv, Module } from '../types';
import '../lib/billing';
import { registerTiers } from './monetize/tiers';
import { registerOffers } from './monetize/offers';
import { registerProducts } from './monetize/products';
import { registerOrders } from './monetize/orders';
import { registerAds } from './monetize/ads';
import { registerSponsors } from './monetize/sponsors';
import { registerSite } from './monetize/site';

const dash = new Hono<AppEnv>();
const site = new Hono<AppEnv>();
const root = new Hono<AppEnv>();

registerTiers(dash);
registerOffers(dash);
registerProducts(dash);
registerOrders(dash);
registerAds(dash, root);
registerSponsors(dash);
registerSite(site);

export default { dash, site, root } satisfies Module;
