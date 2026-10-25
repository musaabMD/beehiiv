// GIF search for the editor. GIPHY is called server-side so the API key never reaches the browser.
// Selected GIFs are copied into the media library (R2) so emails don't depend on a third-party host.
import { Hono } from 'hono';
import type { AppEnv, Env } from '../../types';
import { integration } from '../../lib/integrations';
import { importFromUrl } from '../../lib/media';
import { rateLimit } from '../../lib/guard';

const app = new Hono<AppEnv>();

async function giphyKey(env: Env, pubId: string): Promise<string | null> {
  const cfg = await integration(env, pubId, 'giphy');
  return cfg?.api_key || env.GIPHY_API_KEY || null;
}

app.get('/gifs', async (c) => {
  const pub = c.get('pub');
  const key = await giphyKey(c.env, pub.id);
  if (!key) return c.json({ configured: false, results: [], help: 'Add a GIPHY API key in Settings → Integrations → GIPHY to search GIFs. You can still paste a GIF URL or upload a .gif.' });
  if (!(await rateLimit(c.env, 'gifs:' + pub.id, 120, 60))) return c.json({ configured: true, results: [], error: 'Too many searches — try again in a minute.' }, 429);
  const q = (c.req.query('q') || '').trim().slice(0, 100);
  const offset = Math.max(0, Math.min(4900, Number(c.req.query('offset')) || 0));
  const url = q
    ? `https://api.giphy.com/v1/gifs/search?api_key=${encodeURIComponent(key)}&q=${encodeURIComponent(q)}&limit=24&offset=${offset}&rating=pg-13&lang=en`
    : `https://api.giphy.com/v1/gifs/trending?api_key=${encodeURIComponent(key)}&limit=24&offset=${offset}&rating=pg-13`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) return c.json({ configured: true, results: [], error: j?.meta?.msg || `GIPHY returned ${r.status}` }, 502);
    const results = (j.data || []).map((g: any) => ({
      id: g.id,
      title: g.title || 'GIF',
      preview: g.images?.fixed_width?.webp || g.images?.fixed_width?.url,
      url: g.images?.downsized_medium?.url || g.images?.original?.url,
      width: Number(g.images?.downsized_medium?.width || g.images?.original?.width) || null,
      height: Number(g.images?.downsized_medium?.height || g.images?.original?.height) || null,
    })).filter((g: any) => g.preview && g.url);
    return c.json({ configured: true, results, next: (j.pagination?.offset || 0) + results.length < (j.pagination?.total_count || 0) ? offset + results.length : null });
  } catch (e: any) {
    return c.json({ configured: true, results: [], error: 'Could not reach GIPHY: ' + (e?.message || e) }, 502);
  }
});

/** Copy a GIF (GIPHY result or any pasted .gif URL) into the media library. */
app.post('/gifs/import', async (c) => {
  const pub = c.get('pub');
  const b = await c.req.json<{ url?: string; title?: string }>().catch(() => ({} as any));
  const url = String(b.url || '').trim();
  if (!/^https:\/\//i.test(url)) return c.json({ error: 'Use an https:// GIF URL' }, 400);
  try {
    const r = await importFromUrl(c.env, pub.id, url, c.get('user').id);
    if (!r.mime.startsWith('image/')) return c.json({ error: 'That URL is not an image' }, 400);
    if (b.title) await c.env.DB.prepare('UPDATE uploads SET alt = ? WHERE id = ?').bind(String(b.title).slice(0, 200), r.id).run();
    return c.json(r);
  } catch (e: any) {
    return c.json({ error: String(e?.message || e) }, 400);
  }
});

export default app;
