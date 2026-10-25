// Third-party integrations driven by the event bus. Every call is best-effort: errors are logged, never thrown.
import type { Env } from '../types';
import { all, one } from './db';
import { onEvent } from './events';
import { logError } from './jobs';
import { parseJSON, sha256 } from './util';

export const PROVIDERS: Record<string, { name: string; blurb: string; fields: Array<{ key: string; label: string; secret?: boolean; hint?: string }> }> = {
  google_analytics: { name: 'Google Analytics', blurb: 'Adds GA4 tracking to your website.', fields: [{ key: 'measurement_id', label: 'Measurement ID', hint: 'Looks like G-XXXXXXXXXX' }] },
  hubspot: { name: 'HubSpot', blurb: 'Creates/updates a HubSpot contact for every new subscriber.', fields: [{ key: 'token', label: 'Private app access token', secret: true, hint: 'Scopes: crm.objects.contacts.write' }, { key: 'lifecycle', label: 'Lifecycle stage', hint: 'Optional, e.g. subscriber' }] },
  meta: { name: 'Meta (Facebook) Pixel + Conversions API', blurb: 'Sends a Lead event to Meta for every new subscriber (server-side, hashed email).', fields: [{ key: 'pixel_id', label: 'Pixel ID' }, { key: 'token', label: 'Conversions API access token', secret: true }, { key: 'test_event_code', label: 'Test event code', hint: 'Optional — from Events Manager' }] },
  manychat: { name: 'ManyChat', blurb: 'Capture subscribers from Instagram/Messenger flows using a ManyChat "External Request" action.', fields: [{ key: 'api_key', label: 'OpenHive API key used in ManyChat', secret: true, hint: 'Create one under API keys' }] },
  linktree: { name: 'Linktree', blurb: 'Capture newsletter signups from your Linktree.', fields: [] },
  discord: { name: 'Discord', blurb: 'Sync Discord roles with paid tiers.', fields: [{ key: 'guild_id', label: 'Server (guild) ID' }, { key: 'bot_token', label: 'Bot token', secret: true }] },
  luma: { name: 'Luma', blurb: 'Sync events with your Luma calendar.', fields: [{ key: 'api_key', label: 'Luma API key', secret: true }, { key: 'calendar_id', label: 'Calendar ID', hint: 'Optional' }] },
  cloudflare_realtime: { name: 'Cloudflare Realtime (live events at scale)', blurb: 'Relays webinar video through Cloudflare\'s SFU so audiences of thousands watch from the nearest edge instead of the host\'s browser. Create an SFU app in the Cloudflare dashboard → Realtime.', fields: [{ key: 'app_id', label: 'SFU App ID' }, { key: 'app_token', label: 'SFU App Secret', secret: true }] },
  zapier: { name: 'Zapier / Make / n8n', blurb: 'Create subscribers from any app (inbound API) and trigger workflows from OpenHive events (webhooks).', fields: [] },
};

export async function integration(env: Env, pubId: string, provider: string): Promise<Record<string, any> | null> {
  const r = await one<{ config: string; active: number }>(env, 'SELECT config, active FROM integrations WHERE pub_id = ? AND provider = ?', pubId, provider);
  return r && r.active ? parseJSON(r.config, {}) : null;
}

export async function pushHubspot(env: Env, cfg: Record<string, any>, email: string, name: string, extra: Record<string, string> = {}) {
  const [firstname, ...rest] = (name || '').split(' ');
  const properties: Record<string, string> = { email, ...(firstname ? { firstname } : {}), ...(rest.length ? { lastname: rest.join(' ') } : {}), ...(cfg.lifecycle ? { lifecyclestage: cfg.lifecycle } : {}), ...extra };
  const headers = { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' };
  const r = await fetch('https://api.hubapi.com/crm/v3/objects/contacts', { method: 'POST', headers, body: JSON.stringify({ properties }) });
  if (r.status === 409) {
    // exists → update by email
    const u = await fetch(`https://api.hubapi.com/crm/v3/objects/contacts/${encodeURIComponent(email)}?idProperty=email`, { method: 'PATCH', headers, body: JSON.stringify({ properties }) });
    if (!u.ok) throw new Error(`HubSpot update ${u.status}: ${(await u.text()).slice(0, 200)}`);
    return;
  }
  if (!r.ok) throw new Error(`HubSpot ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

export async function pushMetaLead(env: Env, cfg: Record<string, any>, email: string, sourceUrl?: string) {
  const body: any = {
    data: [{ event_name: 'Lead', event_time: Math.floor(Date.now() / 1000), action_source: 'website', event_source_url: sourceUrl, user_data: { em: [await sha256(email.trim().toLowerCase())] } }],
  };
  if (cfg.test_event_code) body.test_event_code = cfg.test_event_code;
  const r = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(cfg.pixel_id)}/events?access_token=${encodeURIComponent(cfg.token)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Meta CAPI ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

onEvent(async (env, e) => {
  if (e.type !== 'subscription.created' || !e.subscriberId) return;
  const rows = await all<{ provider: string; config: string }>(env, `SELECT provider, config FROM integrations WHERE pub_id = ? AND active = 1 AND provider IN ('hubspot','meta')`, e.pubId);
  if (!rows.length) return;
  const sub = await one<any>(env, 'SELECT email, name, landing_path, source FROM subscribers WHERE id = ?', e.subscriberId);
  if (!sub) return;
  for (const row of rows) {
    const cfg = parseJSON<Record<string, any>>(row.config, {});
    try {
      if (row.provider === 'hubspot' && cfg.token) await pushHubspot(env, cfg, sub.email, sub.name, {});
      if (row.provider === 'meta' && cfg.pixel_id && cfg.token) await pushMetaLead(env, cfg, sub.email, sub.landing_path || undefined);
    } catch (err) {
      await logError(env, `integration:${row.provider}`, err, e.pubId);
    }
  }
});
