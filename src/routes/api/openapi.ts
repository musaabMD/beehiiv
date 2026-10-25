// OpenAPI 3.1 document generated from the REST route table.
import { ROUTES } from './rest';

export const API_BASE = '/api/v2/publications/{pubId}';

export function openapi(serverUrl: string) {
  const paths: Record<string, any> = {};
  for (const r of ROUTES) {
    const p = API_BASE + r.path.replace(/:(\w+)/g, '{$1}');
    const params = [{ name: 'pubId', in: 'path', required: true, schema: { type: 'string' }, description: 'Publication id or slug' }];
    for (const m of r.path.matchAll(/:(\w+)/g)) params.push({ name: m[1], in: 'path', required: true, schema: { type: 'string' }, description: m[1] === 'id' && r.path.startsWith('/subscriptions') ? 'Subscriber id or email' : `${m[1]}` });
    for (const [k, d] of Object.entries(r.query || {})) params.push({ name: k, in: 'query', required: false, schema: { type: 'string' }, description: d } as any);
    const op: any = {
      tags: [r.tag],
      summary: r.summary,
      operationId: `${r.method.toLowerCase()}${r.path.replace(/[:/]+(\w)/g, (_, x) => x.toUpperCase()) || 'Publication'}`,
      parameters: params,
      responses: {
        '200': { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { data: {}, next_cursor: { type: ['string', 'null'] }, has_more: { type: 'boolean' } } } } } },
        '401': { $ref: '#/components/responses/Error' }, '404': { $ref: '#/components/responses/Error' }, '429': { $ref: '#/components/responses/Error' },
      },
    };
    if (r.body) op.requestBody = { required: r.method === 'POST', content: { 'application/json': { schema: { type: 'object', properties: Object.fromEntries(Object.entries(r.body).map(([k, d]) => [k, { description: d }])) } } } };
    (paths[p] ||= {})[r.method.toLowerCase()] = op;
  }
  return {
    openapi: '3.1.0',
    info: { title: 'OpenHive API', version: '2.0.0', description: 'REST API for subscribers, posts, segments, automations, tiers, referrals, polls & surveys, webhooks and more. Authenticate with `Authorization: Bearer <API key>`. Lists use cursor pagination (`limit`, `cursor` → `next_cursor`). Rate limit: 180 requests/minute per key (see X-RateLimit-* headers). You can also use `/api/v2/publication/...` as a shortcut for the key\'s publication.' },
    servers: [{ url: serverUrl }],
    security: [{ bearer: [] }],
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
      responses: { Error: { description: 'Error', content: { 'application/json': { schema: { type: 'object', properties: { error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } } } } } } } } },
    },
    paths,
  };
}

/** Grouped route list for the human reference page. */
export function groupedRoutes() {
  const groups = new Map<string, typeof ROUTES>();
  for (const r of ROUTES) (groups.get(r.tag) || groups.set(r.tag, []).get(r.tag)!).push(r);
  return [...groups.entries()];
}
