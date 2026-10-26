// Segment rules over external store purchases (Shopify / WooCommerce / the creator's own Stripe).
// Pure SQL builders (no lib imports) so lib/segments can use them without an import cycle.
// Orders are matched to subscribers by publication + email, so purchases made before someone subscribed count too.
import { DAY } from './util';

export const COMMERCE_FIELDS: Record<string, { label: string; kind: string; cmps: string[]; options?: string[] }> = {
  ext_purchased: { label: 'Store: purchased product (name, SKU or product id)', kind: 'text', cmps: ['contains', 'not_contains'] },
  ext_platform: { label: 'Store: customer of', kind: 'enum', cmps: ['eq', 'neq'], options: ['shopify', 'woocommerce', 'stripe'] },
  ext_total_spent: { label: 'Store: total spent', kind: 'number', cmps: ['gt', 'lt', 'eq'] },
  ext_orders_count: { label: 'Store: orders count', kind: 'number', cmps: ['gt', 'lt', 'eq'] },
  ext_last_order: { label: 'Store: last order', kind: 'date', cmps: ['within_days', 'not_within_days', 'never'] },
  cart_abandoned: { label: 'Store: has an abandoned cart', kind: 'bool', cmps: ['is_true', 'is_false'] },
};

const PAID = `FROM external_orders o WHERE o.pub_id = s.pub_id AND o.email = s.email AND o.status = 'paid'`;
const num = (cmp: string) => (cmp === 'gt' ? '>' : cmp === 'lt' ? '<' : '=');

/** SQL for one commerce rule, or null when the field isn't a commerce field. */
export function commerceRule(r: { field: string; cmp: string; value?: any }, t = Date.now()): { sql: string; params: unknown[] } | null {
  const v = r.value;
  switch (r.field) {
    case 'ext_purchased': {
      const s = String(v ?? '').trim();
      const sql = `EXISTS (SELECT 1 FROM external_orders o JOIN external_order_items i ON i.order_id = o.id WHERE o.pub_id = s.pub_id AND o.email = s.email AND o.status = 'paid' AND (i.name LIKE ? OR i.sku = ? OR i.product_id = ?))`;
      return { sql: r.cmp === 'not_contains' ? `NOT ${sql}` : sql, params: [`%${s}%`, s, s] };
    }
    case 'ext_platform': {
      const sql = `EXISTS (SELECT 1 ${PAID} AND o.platform = ?)`;
      return { sql: r.cmp === 'neq' ? `NOT ${sql}` : sql, params: [String(v ?? '')] };
    }
    case 'ext_total_spent':
      return { sql: `(SELECT COALESCE(SUM(o.total_cents), 0) ${PAID}) ${num(r.cmp)} ?`, params: [Math.round(Number(v) * 100) || 0] };
    case 'ext_orders_count':
      return { sql: `(SELECT COUNT(*) ${PAID}) ${num(r.cmp)} ?`, params: [Number(v) || 0] };
    case 'ext_last_order': {
      if (r.cmp === 'never') return { sql: `NOT EXISTS (SELECT 1 ${PAID})`, params: [] };
      const since = t - (Number(v) || 0) * DAY;
      const within = `EXISTS (SELECT 1 ${PAID} AND o.paid_at >= ?)`;
      return { sql: r.cmp === 'not_within_days' ? `NOT ${within}` : within, params: [since] };
    }
    case 'cart_abandoned': {
      const sql = `EXISTS (SELECT 1 FROM abandoned_carts ac WHERE ac.pub_id = s.pub_id AND ac.email = s.email AND ac.status = 'abandoned')`;
      return { sql: r.cmp === 'is_false' ? `NOT ${sql}` : sql, params: [] };
    }
  }
  return null;
}
