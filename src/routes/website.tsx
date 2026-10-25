/** @jsxImportSource hono/jsx */
// Module: website — public publication sites + no-code website builder. See docs/ARCHITECTURE.md.
import { Hono } from 'hono';
import type { AppEnv, Module } from '../types';
import site from './website/public';
import dash from './website/dash';

const root = new Hono<AppEnv>();

export default { dash, site, root } satisfies Module;
