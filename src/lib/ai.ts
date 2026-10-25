// AI helpers on Workers AI (binding `AI`). When the binding isn't configured, functions return a clear
// "not configured" result so the UI can explain how to enable it, instead of failing.
import type { Env } from '../types';
import { insert } from './db';
import { id, now } from './util';

export const TEXT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
export const IMAGE_MODEL = '@cf/black-forest-labs/flux-1-schnell';
export const TTS_MODEL = '@cf/myshell-ai/melotts';
export const STT_MODEL = '@cf/openai/whisper-large-v3-turbo';

export function aiEnabled(env: Env) {
  return !!env.AI;
}

export const AI_DISABLED_MSG = 'AI is not configured on this instance. Enable the Workers AI binding ("ai": { "binding": "AI" }) in wrangler.jsonc and redeploy.';

export async function aiText(env: Env, prompt: string, system = 'You are a helpful writing assistant for a newsletter editor. Reply with the requested text only, no preamble.', maxTokens = 1200): Promise<{ ok: boolean; text: string }> {
  if (!env.AI) return { ok: false, text: AI_DISABLED_MSG };
  try {
    const r: any = await env.AI.run(TEXT_MODEL as any, { messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }], max_tokens: maxTokens } as any);
    return { ok: true, text: String(r?.response ?? r?.result?.response ?? '').trim() };
  } catch (e: any) {
    return { ok: false, text: 'AI request failed: ' + (e?.message || e) };
  }
}

export async function aiJSON<T = any>(env: Env, prompt: string, system: string): Promise<T | null> {
  const r = await aiText(env, prompt, system + '\nRespond with valid JSON only.', 2000);
  if (!r.ok) return null;
  const m = r.text.match(/[\[{][\s\S]*[\]}]/);
  try { return m ? (JSON.parse(m[0]) as T) : null; } catch { return null; }
}

/** Generate an image and store it in R2 + the media library. Returns the public URL. */
export async function aiImage(env: Env, pubId: string, prompt: string, userId?: string): Promise<{ ok: boolean; url?: string; error?: string }> {
  if (!env.AI) return { ok: false, error: AI_DISABLED_MSG };
  try {
    const r: any = await env.AI.run(IMAGE_MODEL as any, { prompt, steps: 4 } as any);
    const b64: string = r?.image;
    if (!b64) return { ok: false, error: 'No image returned' };
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const key = `${pubId}/ai/${id()}.jpg`;
    await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: 'image/jpeg', cacheControl: 'public, max-age=31536000, immutable' } });
    await insert(env, 'uploads', { id: id(), pub_id: pubId, key, name: prompt.slice(0, 80), mime: 'image/jpeg', size: bytes.length, alt: prompt.slice(0, 200), source: 'ai', created_by: userId ?? null, created_at: now() });
    return { ok: true, url: mediaUrl(env, key) };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/** Text to speech → R2 audio key. Splits long text into chunks and concatenates MP3 frames. */
export async function aiSpeech(env: Env, key: string, text: string, lang = 'en'): Promise<{ ok: boolean; error?: string }> {
  if (!env.AI) return { ok: false, error: AI_DISABLED_MSG };
  try {
    const chunks: string[] = [];
    let buf = '';
    for (const sentence of text.split(/(?<=[.!?])\s+/)) {
      if ((buf + ' ' + sentence).length > 900) { chunks.push(buf); buf = sentence; } else buf = buf ? buf + ' ' + sentence : sentence;
    }
    if (buf) chunks.push(buf);
    const parts: Uint8Array[] = [];
    for (const ch of chunks.slice(0, 60)) {
      const r: any = await env.AI.run(TTS_MODEL as any, { prompt: ch, lang } as any);
      const b64 = r?.audio;
      if (b64) parts.push(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    }
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    await env.MEDIA.put(key, out, { httpMetadata: { contentType: 'audio/mpeg' } });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/** Speech to text for podcast transcripts. */
export async function aiTranscribe(env: Env, audio: ArrayBuffer): Promise<{ ok: boolean; text: string; vtt?: string }> {
  if (!env.AI) return { ok: false, text: AI_DISABLED_MSG };
  try {
    const bytes = new Uint8Array(audio);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const r: any = await env.AI.run(STT_MODEL as any, { audio: btoa(bin) } as any);
    return { ok: true, text: r?.text || '', vtt: r?.vtt };
  } catch (e: any) {
    return { ok: false, text: 'Transcription failed: ' + (e?.message || e) };
  }
}

export function mediaUrl(env: Env, key: string) {
  return `${env.APP_URL.replace(/\/$/, '')}/media/${key}`;
}
