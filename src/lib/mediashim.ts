// Fallback object storage in D1 for deployments without R2 (e.g. temporary preview accounts).
// Implements the subset of R2Bucket that OpenHive uses: put / get (with range) / head / delete.
// Files are stored in 900 KB chunks; suitable for demos and small sites, not large podcast libraries.
import type { Env } from '../types';

const CHUNK = 900 * 1024;
let ready: Promise<void> | null = null;

function init(db: D1Database) {
  ready ??= db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS media_blobs (key TEXT PRIMARY KEY, size INTEGER NOT NULL, content_type TEXT, cache_control TEXT, etag TEXT NOT NULL, uploaded INTEGER NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS media_chunks (key TEXT NOT NULL, idx INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (key, idx))'),
  ]).then(() => undefined);
  return ready;
}

async function toBytes(body: any): Promise<Uint8Array> {
  if (body == null) return new Uint8Array();
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  if (typeof body.arrayBuffer === 'function') return new Uint8Array(await body.arrayBuffer());
  return new Uint8Array(await new Response(body).arrayBuffer());
}

function makeObject(row: any, bytes: Uint8Array | null): any {
  const meta = { contentType: row.content_type || undefined, cacheControl: row.cache_control || undefined };
  const obj: any = {
    key: row.key, size: row.size, etag: row.etag, httpEtag: `"${row.etag}"`, uploaded: new Date(row.uploaded), httpMetadata: meta, customMetadata: {},
    writeHttpMetadata(h: Headers) { if (meta.contentType) h.set('content-type', meta.contentType); if (meta.cacheControl) h.set('cache-control', meta.cacheControl); },
  };
  if (bytes) {
    obj.body = new Response(bytes).body;
    obj.arrayBuffer = async () => bytes.slice().buffer;
    obj.text = async () => new TextDecoder().decode(bytes);
  }
  return obj;
}

export function d1Bucket(db: D1Database): R2Bucket {
  const bucket = {
    async put(key: string, body: any, opts?: any) {
      await init(db);
      const bytes = await toBytes(body);
      const etag = [...new Uint8Array(await crypto.subtle.digest('SHA-1', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
      const stmts = [
        db.prepare('DELETE FROM media_chunks WHERE key = ?').bind(key),
        db.prepare('INSERT OR REPLACE INTO media_blobs (key, size, content_type, cache_control, etag, uploaded) VALUES (?, ?, ?, ?, ?, ?)').bind(key, bytes.length, opts?.httpMetadata?.contentType ?? null, opts?.httpMetadata?.cacheControl ?? null, etag, Date.now()),
      ];
      for (let i = 0, n = 0; i < bytes.length || (i === 0 && n === 0); i += CHUNK, n++) {
        stmts.push(db.prepare('INSERT INTO media_chunks (key, idx, data) VALUES (?, ?, ?)').bind(key, n, bytes.subarray(i, i + CHUNK)));
        if (bytes.length === 0) break;
      }
      for (let i = 0; i < stmts.length; i += 20) await db.batch(stmts.slice(i, i + 20));
      return makeObject({ key, size: bytes.length, content_type: opts?.httpMetadata?.contentType, cache_control: opts?.httpMetadata?.cacheControl, etag, uploaded: Date.now() }, null);
    },
    async head(key: string) {
      await init(db);
      const row = await db.prepare('SELECT * FROM media_blobs WHERE key = ?').bind(key).first();
      return row ? makeObject(row, null) : null;
    },
    async get(key: string, opts?: any) {
      await init(db);
      const row: any = await db.prepare('SELECT * FROM media_blobs WHERE key = ?').bind(key).first();
      if (!row) return null;
      const chunks = await db.prepare('SELECT data FROM media_chunks WHERE key = ? ORDER BY idx').bind(key).all<{ data: ArrayBuffer | number[] }>();
      const parts = (chunks.results || []).map((c) => (c.data instanceof ArrayBuffer ? new Uint8Array(c.data) : Uint8Array.from(c.data as number[])));
      let bytes = new Uint8Array(row.size);
      let o = 0;
      for (const p of parts) { bytes.set(p, o); o += p.length; }
      const r = opts?.range;
      if (r && typeof r.offset === 'number') bytes = bytes.slice(r.offset, r.length != null ? r.offset + r.length : undefined);
      return makeObject(row, bytes);
    },
    async delete(keys: string | string[]) {
      await init(db);
      for (const k of Array.isArray(keys) ? keys : [keys]) {
        await db.batch([db.prepare('DELETE FROM media_chunks WHERE key = ?').bind(k), db.prepare('DELETE FROM media_blobs WHERE key = ?').bind(k)]);
      }
    },
  };
  return bucket as unknown as R2Bucket;
}

/** Ensure env.MEDIA exists: real R2 when bound, D1 fallback otherwise. */
export function withMedia(env: Env): Env {
  if (!env.MEDIA && env.DB) (env as any).MEDIA = d1Bucket(env.DB);
  return env;
}
