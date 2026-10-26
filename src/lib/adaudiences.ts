// Ad audiences: export a segment as a hashed customer list for Google Ads Customer Match and Meta (Facebook /
// Instagram) Custom Audiences. Emails are normalized per each platform's documented rules and SHA-256 hashed (hex),
// so plain addresses never leave the platform. A secret pull URL lets an ads tool re-fetch the list on a schedule.
// This is how "retargeting ads" work here: the publication's own ad accounts target their own (consenting) readers.
import type { Env } from '../types';
import { one, all } from './db';
import { compile, segmentGroup, EMPTY_GROUP } from './segments';
import { sha256 } from './util';

export type AdPlatform = 'google' | 'meta';

export const AD_PLATFORMS: Record<AdPlatform, { label: string; header: string; doc: string; upload: string }> = {
  google: {
    label: 'Google Ads Customer Match',
    header: 'Email',
    doc: 'https://support.google.com/google-ads/answer/7659867',
    upload: 'Google Ads → Tools → Shared library → Audience manager → + Customer list → “Upload hashed emails” (CSV with an Email column of SHA-256 hashes).',
  },
  meta: {
    label: 'Meta Custom Audiences',
    header: 'email',
    doc: 'https://www.facebook.com/business/help/2082575038703844',
    upload: 'Meta Ads Manager → Audiences → Create audience → Custom audience → Customer list → upload the CSV (the email column is already SHA-256 hashed).',
  },
};

/**
 * Normalize an email the way each platform documents before hashing:
 * both: trim + lowercase. Google additionally removes dots in the local part of gmail.com / googlemail.com addresses.
 */
export function normalizeEmail(email: string, platform: AdPlatform): string {
  let e = email.trim().toLowerCase();
  if (platform === 'google') {
    const [local, domain] = e.split('@');
    if (domain === 'gmail.com' || domain === 'googlemail.com') e = `${local.replace(/\./g, '')}@${domain}`;
  }
  return e;
}

export async function hashEmail(email: string, platform: AdPlatform): Promise<string> {
  return sha256(normalizeEmail(email, platform));
}

/** Active subscribers of a segment ('all' = every active subscriber), in id order, in pages. */
export async function* segmentEmails(env: Env, pubId: string, segmentId: string, page = 2000): AsyncGenerator<string[]> {
  const g = segmentId === 'all' ? EMPTY_GROUP : segmentGroup(segmentId);
  const c = await compile(env, pubId, g);
  const where = c.sql || '1=1';
  let after = '';
  for (;;) {
    const rows = await all<{ id: string; email: string }>(env, `SELECT s.id, s.email FROM subscribers s WHERE s.pub_id = ? AND s.status = 'active' AND (${where}) AND s.id > ? ORDER BY s.id LIMIT ?`, pubId, ...c.params, after, page);
    if (!rows.length) return;
    yield rows.map((r) => r.email);
    after = rows[rows.length - 1].id;
    if (rows.length < page) return;
  }
}

/** The audience CSV exactly as the platform's customer-list upload expects (header + one hash per line). */
export async function audienceCsv(env: Env, pubId: string, segmentId: string, platform: AdPlatform): Promise<{ csv: string; rows: number }> {
  const seen = new Set<string>();
  const lines = [AD_PLATFORMS[platform].header];
  for await (const batch of segmentEmails(env, pubId, segmentId)) {
    for (const h of await Promise.all(batch.map((e) => hashEmail(e, platform)))) {
      if (seen.has(h)) continue;
      seen.add(h);
      lines.push(h);
    }
  }
  return { csv: lines.join('\n') + '\n', rows: seen.size };
}

export async function segmentName(env: Env, pubId: string, segmentId: string): Promise<string | null> {
  if (segmentId === 'all') return 'All active subscribers';
  return (await one<{ name: string }>(env, 'SELECT name FROM segments WHERE id = ? AND pub_id = ?', segmentId, pubId))?.name ?? null;
}
