// Data for the visual rule builder (public/static/rules.js): field catalog + selectable options for one publication.
import type { Env } from '../types';
import { all } from './db';
import { FIELDS } from './segments';
import { parseJSON } from './util';

export async function ruleCatalog(env: Env, pubId: string) {
  const [tags, tiers, segments, posts, automations, lists, polls, surveys, products, events, custom, sets] = await Promise.all([
    all<{ tag: string }>(env, 'SELECT DISTINCT tag FROM subscriber_tags WHERE pub_id = ? ORDER BY tag LIMIT 500', pubId),
    all<any>(env, 'SELECT id, name FROM tiers WHERE pub_id = ? ORDER BY position', pubId),
    all<any>(env, 'SELECT id, name FROM segments WHERE pub_id = ? ORDER BY name', pubId),
    all<any>(env, `SELECT id, title FROM posts WHERE pub_id = ? AND status = 'published' ORDER BY published_at DESC LIMIT 200`, pubId),
    all<any>(env, 'SELECT id, name FROM automations WHERE pub_id = ? ORDER BY name', pubId),
    all<any>(env, 'SELECT id, name FROM lists WHERE pub_id = ? ORDER BY name', pubId),
    all<any>(env, 'SELECT id, question, options FROM polls WHERE pub_id = ? ORDER BY created_at DESC LIMIT 100', pubId),
    all<any>(env, 'SELECT id, title, questions FROM surveys WHERE pub_id = ? ORDER BY created_at DESC LIMIT 100', pubId),
    all<any>(env, 'SELECT id, name FROM products WHERE pub_id = ? ORDER BY name', pubId),
    all<any>(env, 'SELECT id, title FROM live_events WHERE pub_id = ? ORDER BY starts_at DESC LIMIT 100', pubId),
    all<any>(env, 'SELECT key, label FROM custom_fields WHERE pub_id = ? ORDER BY label', pubId),
    all<any>(env, 'SELECT id, name FROM condition_sets WHERE pub_id = ? ORDER BY name', pubId),
  ]);
  return {
    fields: FIELDS,
    options: {
      tag: tags.map((t) => t.tag),
      tier: tiers.map((t) => [t.id, t.name]),
      segment: segments.map((s) => [s.id, s.name]),
      post: posts.map((p) => [p.id, p.title || '(untitled)']),
      automation: automations.map((a) => [a.id, a.name]),
      list: lists.map((l) => [l.id, l.name]),
      poll: polls.map((p) => ({ id: p.id, question: p.question, options: parseJSON(p.options, []) })),
      survey: surveys.map((s) => ({ id: s.id, title: s.title, questions: parseJSON(s.questions, []) })),
      product: products.map((p) => [p.id, p.name]),
      event: events.map((e) => [e.id, e.title]),
      custom: custom,
      condition_set: sets.map((s) => [s.id, s.name]),
    },
  };
}
