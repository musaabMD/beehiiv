// Media library on R2. Images are resized/compressed client-side before upload (public/static/app.js
// `OH.optimizeImage`), and URL imports are fetched server-side so every image ends up in the library.
import type { Env } from '../types';
import { insert } from './db';
import { id, now } from './util';
import { mediaUrl } from './ai';

export const MAX_UPLOAD = 200 * 1024 * 1024; // podcasts/recordings can be big
const ALLOWED = /^(image\/(png|jpe?g|gif|webp|avif|svg\+xml)|audio\/(mpeg|mp3|mp4|x-m4a|aac|wav|ogg|webm)|video\/(mp4|webm|quicktime)|application\/(pdf|zip|epub\+zip|vnd\.openxmlformats.*|msword|vnd\.ms-.*)|text\/(plain|csv|markdown|vtt))$/;

export interface Stored { id: string; key: string; url: string; name: string; mime: string; size: number }

export async function storeFile(env: Env, pubId: string, file: File, opts: { folder?: string; userId?: string; alt?: string; source?: string; width?: number; height?: number } = {}): Promise<Stored> {
  const mime = file.type || 'application/octet-stream';
  if (!ALLOWED.test(mime)) throw new Error(`File type ${mime} is not allowed`);
  if (file.size > MAX_UPLOAD) throw new Error('File is too large');
  const ext = (file.name.match(/\.[a-z0-9]{1,6}$/i)?.[0] || '').toLowerCase();
  const key = `${pubId}/${opts.folder || 'uploads'}/${id()}${ext}`;
  await env.MEDIA.put(key, file.stream(), { httpMetadata: { contentType: mime, cacheControl: 'public, max-age=31536000, immutable' } });
  const uid = id();
  await insert(env, 'uploads', { id: uid, pub_id: pubId, key, name: file.name.slice(0, 200), mime, size: file.size, width: opts.width ?? null, height: opts.height ?? null, alt: opts.alt || '', source: opts.source || 'upload', created_by: opts.userId ?? null, created_at: now() });
  return { id: uid, key, url: mediaUrl(env, key), name: file.name, mime, size: file.size };
}

export async function importFromUrl(env: Env, pubId: string, url: string, userId?: string): Promise<Stored> {
  const r = await fetch(url, { headers: { 'user-agent': 'OpenHive-MediaImport/1.0' } });
  if (!r.ok) throw new Error(`Could not fetch image (${r.status})`);
  const mime = (r.headers.get('content-type') || '').split(';')[0];
  const buf = await r.arrayBuffer();
  const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'image');
  const file = new File([buf], name, { type: mime });
  return storeFile(env, pubId, file, { userId, source: 'url' });
}

/** Serve an R2 object with range support (podcast players need byte ranges). */
export async function serveObject(env: Env, key: string, req: Request, extraHeaders: Record<string, string> = {}): Promise<Response> {
  const range = req.headers.get('range');
  let obj: R2ObjectBody | R2Object | null;
  let status = 200;
  const headers = new Headers(extraHeaders);
  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/);
    const head = await env.MEDIA.head(key);
    if (!head) return new Response('Not found', { status: 404 });
    const start = m?.[1] ? Number(m[1]) : 0;
    const end = m?.[2] ? Number(m[2]) : head.size - 1;
    obj = await env.MEDIA.get(key, { range: { offset: start, length: end - start + 1 } });
    status = 206;
    headers.set('content-range', `bytes ${start}-${end}/${head.size}`);
    headers.set('content-length', String(end - start + 1));
  } else {
    obj = await env.MEDIA.get(key);
  }
  if (!obj || !('body' in obj)) return new Response('Not found', { status: 404 });
  obj.writeHttpMetadata(headers);
  // Uploaded files are served from the app's own domain, so they must never run scripts here.
  // SVG (and anything that isn't plain media/PDF) gets a locked-down CSP; nosniff stops type guessing.
  headers.set('x-content-type-options', 'nosniff');
  const type = (headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!/^(image\/(png|jpe?g|gif|webp|avif)|audio\/.*|video\/.*|application\/pdf)$/.test(type)) {
    headers.set('content-security-policy', "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox");
  }
  if (type === 'image/svg+xml' && !headers.has('content-disposition')) headers.set('content-disposition', 'inline');
  headers.set('accept-ranges', 'bytes');
  headers.set('etag', obj.httpEtag);
  if (!headers.has('cache-control')) headers.set('cache-control', 'public, max-age=31536000, immutable');
  if (!range) headers.set('content-length', String(obj.size));
  return new Response(obj.body, { status, headers });
}
