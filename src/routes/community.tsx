/** @jsxImportSource hono/jsx */
// Module: community — channels, threaded discussions, DMs, moderation, roles, invites, metrics, Discord sync.
import { Hono } from 'hono';
import type { AppEnv, Module } from '../types';
import { registerCommunityDash } from './community/dash';
import { registerCommunitySite } from './community/site';
import { registerChatSite, registerChatDash } from './community/chat';
import '../lib/discord';

const dash = new Hono<AppEnv>();
const site = new Hono<AppEnv>();
const root = new Hono<AppEnv>();

registerCommunityDash(dash);
registerChatDash(dash);
// Chat routes first: /community/chat/* must win over the /community/:channel catch-alls.
registerChatSite(site);
registerCommunitySite(site);

export default { dash, site, root } satisfies Module;
