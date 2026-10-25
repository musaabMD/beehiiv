// Helpers shared by grow + community modules.
import type { Env, Publication } from '../../types';
import { all, run } from '../../lib/db';
import { parseJSON } from '../../lib/util';

/** Emails of owners/admins of a publication (workspace-level or publication-level). */
export async function pubAdminEmails(env: Env, pub: Publication): Promise<string[]> {
  const rows = await all<{ email: string }>(
    env,
    `SELECT DISTINCT u.email FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.workspace_id = ? AND (m.pub_id = '' OR m.pub_id = ?) AND m.role IN ('owner','admin') AND u.is_guest = 0`,
    pub.workspace_id, pub.id,
  );
  return rows.map((r) => r.email);
}

/** Merge keys into publications.settings JSON. */
export async function patchSettings(env: Env, pub: Publication, patch: Record<string, unknown>) {
  const cur = parseJSON<Record<string, unknown>>(pub.settings, {});
  const next = { ...cur, ...patch };
  for (const [k, v] of Object.entries(patch)) if (v === undefined) delete next[k];
  await run(env, 'UPDATE publications SET settings = ? WHERE id = ?', JSON.stringify(next), pub.id);
  pub.settings = JSON.stringify(next);
}

export function utmFromJSON(raw: string | undefined | null): Record<string, string> {
  const j = parseJSON<Record<string, string>>(raw || '', {});
  return j && typeof j === 'object' ? j : {};
}
