/** @jsxImportSource hono/jsx */
import type { Child } from 'hono/jsx';
import type { Ctx, Publication } from '../../types';
import { DashLayout } from '../../ui/layout';
import { one } from '../../lib/db';
import { settings } from '../../lib/pub';

export function page(c: Ctx, sub: string, title: string, body: Child, actions?: Child) {
  return c.html(<DashLayout c={c} title={title} section="settings" sub={sub} actions={actions}>{body}</DashLayout>);
}

/** Merge keys into publications.settings JSON. */
export async function saveSettings(c: Ctx, patch: Record<string, unknown>) {
  const pub = c.get('pub');
  const fresh = await one<Publication>(c.env, 'SELECT settings FROM publications WHERE id = ?', pub.id);
  const merged: Record<string, unknown> = { ...settings({ ...pub, settings: fresh?.settings || pub.settings }), ...patch };
  for (const [k, v] of Object.entries(merged)) if (v === undefined) delete merged[k];
  await c.env.DB.prepare('UPDATE publications SET settings = ? WHERE id = ?').bind(JSON.stringify(merged), pub.id).run();
}

export const ROLES: Array<[string, string]> = [['admin', 'Admin — billing, exports, integrations, payments, domains'], ['member', 'Member — full access minus admin settings'], ['contributor', 'Contributor — draft posts & automations only']];
