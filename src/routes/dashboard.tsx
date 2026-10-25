/** @jsxImportSource hono/jsx */
// Module: dashboard — see docs/ARCHITECTURE.md for the module contract and route ownership.
import { Hono } from 'hono';
import type { AppEnv, Module } from '../types';

const dash = new Hono<AppEnv>();
const site = new Hono<AppEnv>();
const root = new Hono<AppEnv>();

dash.get('/', (c) => c.text('dashboard: coming soon'));

export default { dash, site, root } satisfies Module;
