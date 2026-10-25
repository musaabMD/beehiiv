/** @jsxImportSource hono/jsx */
// Module: api — REST API v2 (/api/v2/*) and MCP server (/mcp). See docs/API.md and docs/MCP.md.
import { Hono } from 'hono';
import type { AppEnv, Module } from '../types';
import { apiAuth, apiError, keyFromRequest, limit, RATE_LIMIT } from '../lib/apiauth';
import { handleRpc, PROTOCOL_VERSION, SERVER_INFO } from '../lib/mcp';
import { logError, kick } from '../lib/jobs';
import { ROUTES, BadRequest, NotFound } from './api/rest';
import { openapi } from './api/openapi';
import { now } from '../lib/util';

const dash = new Hono<AppEnv>();
const root = new Hono<AppEnv>();

// Keys are managed in Settings → API keys & MCP.
dash.get('/', (c) => c.redirect('/app/settings/api'));

root.get('/api/v2', (c) => c.json({ name: 'OpenHive API', version: '2', docs: '/docs/api', openapi: '/api/v2/openapi.json', mcp: '/mcp' }));
root.get('/api/v2/openapi.json', (c) => {
  c.header('access-control-allow-origin', '*');
  return c.json(openapi(c.env.APP_URL.replace(/\/$/, '')));
});

// CORS preflight for browser integrations
root.options('/api/v2/*', (c) => new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS', 'access-control-max-age': '86400' } }));

for (const r of ROUTES) {
  const handler = async (c: any) => {
    c.header('access-control-allow-origin', '*');
    try {
      const res = await r.handler(c, c.get('apiPub'));
      // Real-time side effects (webhooks, automations, sends) run right away instead of waiting for cron.
      if (r.method !== 'GET') kick(c.env, c.executionCtx);
      return res;
    } catch (e: any) {
      if (e instanceof BadRequest) return apiError(c, 400, 'bad_request', e.message);
      if (e instanceof NotFound) return apiError(c, 404, 'not_found', e.message);
      await logError(c.env, `api:${r.method} ${r.path}`, e, c.get('apiPub')?.id);
      return apiError(c, 500, 'internal_error', 'Something went wrong. The error has been logged.');
    }
  };
  for (const prefix of ['/api/v2/publications/:pubId', '/api/v2/publication']) root.on(r.method, prefix + r.path, apiAuth, handler);
}
root.all('/api/v2/*', (c) => apiError(c, 404, 'not_found', 'Unknown endpoint. See /api/v2/openapi.json.'));

// ───────── MCP (streamable HTTP, JSON responses) ─────────
root.get('/mcp', (c) => c.json({ error: 'Use POST with JSON-RPC 2.0 messages (streamable HTTP transport). This server does not open an SSE stream.' }, 405, { allow: 'POST' }));
root.delete('/mcp', (c) => c.body(null, 204));
root.options('/mcp', () => new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type, mcp-session-id, mcp-protocol-version', 'access-control-allow-methods': 'POST, GET, DELETE, OPTIONS' } }));
root.post('/mcp', async (c) => {
  c.header('access-control-allow-origin', '*');
  const k = await keyFromRequest(c.env, c.req.raw);
  if (!k) return c.json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized: send "Authorization: Bearer <OpenHive API key>"' } }, 401, { 'www-authenticate': 'Bearer realm="OpenHive"' });
  const rl = await limit(c.env, 'mcp:' + k.keyId, RATE_LIMIT);
  if (!rl.ok) return c.json({ jsonrpc: '2.0', id: null, error: { code: -32002, message: 'Rate limit exceeded' } }, 429, { 'retry-after': String(Math.max(1, Math.ceil((rl.reset - now()) / 1000))) });
  let payload: any;
  try { payload = await c.req.json(); } catch { return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400); }
  c.header('mcp-protocol-version', PROTOCOL_VERSION);
  if (Array.isArray(payload)) {
    const out = (await Promise.all(payload.map((m) => handleRpc(c.env, k.pub, m)))).filter(Boolean);
    return out.length ? c.json(out) : c.body(null, 202);
  }
  const res = await handleRpc(c.env, k.pub, payload);
  if (!res) return c.body(null, 202);
  return c.json(res);
});

root.get('/.well-known/mcp.json', (c) => c.json({ name: SERVER_INFO.name, title: SERVER_INFO.title, version: SERVER_INFO.version, endpoint: c.env.APP_URL.replace(/\/$/, '') + '/mcp', transport: 'streamable-http', authentication: 'bearer (OpenHive API key)' }));

export default { dash, root } satisfies Module;
