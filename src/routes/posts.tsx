/** @jsxImportSource hono/jsx */
// Module: posts — editor, templates, media library, content tags, post analytics, real-time collaboration.
// See docs/ARCHITECTURE.md for the module contract and route ownership.
import { Hono } from 'hono';
import type { AppEnv, Module } from '../types';
import { requirePerm, currentUser, userPubs } from '../lib/auth';
import { one } from '../lib/db';
import list from './posts/list';
import media from './posts/media';
import templates from './posts/templates';
import editor from './posts/editor';
import analytics from './posts/analytics';

const dash = new Hono<AppEnv>();
const root = new Hono<AppEnv>();

dash.use('*', requirePerm('draft'));
dash.route('/', list);
dash.route('/', media);
dash.route('/', templates);
dash.route('/', editor);
dash.route('/', analytics);

/** WebSocket for real-time collaborative editing → CollabRoom Durable Object (one room per post). */
root.get('/collab/:postId', async (c) => {
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') return c.text('Expected WebSocket', 426);
  const user = await currentUser(c);
  if (!user) return c.text('Not signed in', 401);
  const post = await one<{ id: string; pub_id: string }>(c.env, 'SELECT id, pub_id FROM posts WHERE id = ?', c.req.param('postId'));
  if (!post) return c.text('Not found', 404);
  const pubs = await userPubs(c.env, user.id);
  if (!pubs.some((p) => p.id === post.pub_id)) return c.text('Forbidden', 403);
  const stub = c.env.COLLAB.get(c.env.COLLAB.idFromName(post.id));
  const url = new URL(c.req.url);
  url.searchParams.set('post', post.id);
  url.searchParams.set('uid', user.id);
  url.searchParams.set('name', user.name || user.email);
  return stub.fetch(new Request(url.toString(), c.req.raw));
});

export default { dash, root } satisfies Module;
