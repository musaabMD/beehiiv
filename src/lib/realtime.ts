// Cloudflare Realtime SFU (HTTPS Connection API) client for large live events.
// The host publishes once to Cloudflare's edge; every attendee pulls from the SFU, so audience size no longer
// depends on the host's upload bandwidth. Credentials never reach the browser: all calls go through /live/:id/sfu.
import type { Env } from '../types';
import { integration } from './integrations';

export interface RealtimeCreds { appId: string; token: string; base: string }

/** Per-publication credentials (Settings → Integrations → Cloudflare Realtime), else instance-wide secrets. */
export async function realtimeCreds(env: Env, pubId: string): Promise<RealtimeCreds | null> {
  const cfg = await integration(env, pubId, 'cloudflare_realtime');
  const appId = cfg?.app_id || env.REALTIME_APP_ID;
  const token = cfg?.app_token || env.REALTIME_APP_TOKEN;
  return appId && token ? { appId, token, base: (env.REALTIME_API_BASE || 'https://rtc.live.cloudflare.com/v1').replace(/\/$/, '') } : null;
}

async function call(c: RealtimeCreds, method: string, path: string, body?: unknown): Promise<any> {
  const r = await fetch(`${c.base}/apps/${encodeURIComponent(c.appId)}${path}`, {
    method,
    headers: { authorization: `Bearer ${c.token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || j.errorCode) throw new Error(`Realtime SFU ${path}: ${j.errorDescription || j.errorCode || r.status}`);
  // Check per-track results too (batch operations can partially fail).
  const bad = (j.tracks || []).find((t: any) => t.errorCode);
  if (bad) throw new Error(`Realtime SFU track ${bad.trackName || bad.mid}: ${bad.errorDescription || bad.errorCode}`);
  return j;
}

export async function newSession(c: RealtimeCreds): Promise<string> {
  return (await call(c, 'POST', '/sessions/new')).sessionId;
}

/** Host: publish local tracks. Returns the SFU answer. */
export async function publishTracks(c: RealtimeCreds, sessionId: string, offerSdp: string, tracks: Array<{ mid: string; trackName: string }>) {
  const j = await call(c, 'POST', `/sessions/${sessionId}/tracks/new`, {
    sessionDescription: { type: 'offer', sdp: offerSdp },
    tracks: tracks.map((t) => ({ location: 'local', mid: t.mid, trackName: t.trackName })),
  });
  return { answer: j.sessionDescription, tracks: j.tracks || [] };
}

/** Attendee: request the host's tracks. Returns the SFU offer to answer (plus receiving mids). */
export async function pullTracks(c: RealtimeCreds, sessionId: string, hostSessionId: string, trackNames: string[]) {
  const j = await call(c, 'POST', `/sessions/${sessionId}/tracks/new`, {
    tracks: trackNames.map((trackName) => ({ location: 'remote', sessionId: hostSessionId, trackName })),
  });
  return { offer: j.sessionDescription, requiresImmediateRenegotiation: !!j.requiresImmediateRenegotiation, tracks: j.tracks || [] };
}

export async function renegotiate(c: RealtimeCreds, sessionId: string, answerSdp: string) {
  await call(c, 'PUT', `/sessions/${sessionId}/renegotiate`, { sessionDescription: { type: 'answer', sdp: answerSdp } });
}

export async function closeTracks(c: RealtimeCreds, sessionId: string, mids: string[]) {
  if (!mids.length) return;
  await call(c, 'PUT', `/sessions/${sessionId}/tracks/close`, { tracks: mids.map((mid) => ({ mid })), force: true }).catch(() => {});
}
