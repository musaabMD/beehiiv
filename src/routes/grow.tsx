/** @jsxImportSource hono/jsx */
// Module: grow — referral program, recommendation network, boosts (paid recommendations), magic links, link in bio.
import { Hono } from 'hono';
import type { AppEnv, Module } from '../types';
import { registerReferrals } from './grow/referrals';
import { registerRecommendations } from './grow/recommendations';
import { registerBoosts } from './grow/boosts';
import { registerLinks } from './grow/links';
import { registerBio } from './grow/bio';

const dash = new Hono<AppEnv>();
const site = new Hono<AppEnv>();
const root = new Hono<AppEnv>();

registerReferrals(dash, site);
registerRecommendations(dash, site);
registerBoosts(dash, site);
registerLinks(dash, site);
registerBio(dash, site);

export default { dash, site, root } satisfies Module;
