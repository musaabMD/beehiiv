/** @jsxImportSource hono/jsx */
// Module: audience — subscribers, segments, condition sets, lists, custom fields, forms, surveys, polls, import/export.
// Site: /subscribe, /confirm/:token, /welcome, /poll/*, /survey/*. Root: /embed/*, /f/:id. See docs/ARCHITECTURE.md.
import { Hono } from 'hono';
import type { AppEnv, Module } from '../types';
import { requirePerm } from '../lib/auth';
import subscribers from './audience/subscribers';
import segments from './audience/segments';
import lists from './audience/lists';
import forms from './audience/forms';
import surveys from './audience/surveys';
import site from './audience/public';
import root from './audience/embed';

const dash = new Hono<AppEnv>();
dash.use('*', requirePerm('manage'));
dash.route('/', segments);
dash.route('/', lists);
dash.route('/', forms);
dash.route('/', surveys);
dash.route('/', subscribers);

export default { dash, site, root } satisfies Module;
