// Realistic demo data for the seeded "p_demo" publication (run after scripts/seed.mjs).
// Usage: node scripts/demo-data.mjs > demo.sql && npx wrangler d1 execute openhive --local --file demo.sql [--persist-to dir]
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const wpick = (pairs) => { const t = pairs.reduce((n, p) => n + p[1], 0); let r = rnd() * t; for (const [v, w] of pairs) { if ((r -= w) <= 0) return v; } return pairs[0][0]; };
const q = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const DAY = 86400000;
const NOW = Date.now();
const PUB = 'p_demo';
const out = [];
const rows = {};
const add = (table, cols, vals) => { (rows[table] ||= { cols, vals: [] }).vals.push(vals); };
const id = (p, n) => `${p}${n.toString(36)}${Math.floor(rnd() * 1e6).toString(36)}`;

const FIRST = ['Ava', 'Liam', 'Noah', 'Emma', 'Olivia', 'Mia', 'Lucas', 'Amir', 'Sara', 'Yusuf', 'Chen', 'Priya', 'Diego', 'Lena', 'Omar', 'Hana', 'Ivan', 'Zoe', 'Kai', 'Nora'];
const LAST = ['Smith', 'Khan', 'Garcia', 'Nguyen', 'Müller', 'Rossi', 'Kim', 'Patel', 'Silva', 'Brown', 'Ali', 'Cohen', 'Novak', 'Tanaka', 'Haddad'];
const DOMAINS = [['gmail.com', 50], ['outlook.com', 15], ['yahoo.com', 10], ['icloud.com', 12], ['proton.me', 3], ['acme.io', 10]];
const SOURCES = [['website', 30], ['form', 15], ['magic_link', 10], ['import', 10], ['referral', 10], ['recommendation', 10], ['boost', 5], ['api', 4], ['linkinbio', 6]];
const COUNTRIES = [['US', 40], ['GB', 12], ['DE', 8], ['IN', 10], ['CA', 7], ['SA', 6], ['BR', 5], ['FR', 5], ['AU', 4], ['NG', 3]];
const UTM = [[null, 60], ['twitter', 12], ['linkedin', 8], ['newsletter-swap', 8], ['google', 7], ['instagram', 5]];

// subscribers
const subs = [];
for (let i = 0; i < 2000; i++) {
  const created = NOW - Math.floor(Math.pow(rnd(), 0.7) * 180 * DAY);
  const f = pick(FIRST), l = pick(LAST);
  const email = `${f.toLowerCase()}.${l.toLowerCase().replace(/ü/g, 'u')}${i}@${wpick(DOMAINS)}`;
  const statusR = rnd();
  const status = statusR < 0.07 ? 'unsubscribed' : statusR < 0.09 ? 'bounced' : 'active';
  const tier = rnd() < 0.08 ? 'premium' : 'free';
  const utm = wpick(UTM);
  const engagement = Math.floor(rnd() * 100);
  const s = { id: `sd_${i}`, created, status, tier, email, engagement };
  subs.push(s);
  add('subscribers', ['id', 'pub_id', 'email', 'name', 'status', 'tier', 'source', 'utm_source', 'utm_medium', 'utm_campaign', 'referrer_url', 'landing_path', 'referral_code', 'custom', 'country', 'confirmed_at', 'unsubscribed_at', 'engagement', 'created_at', 'updated_at'],
    [s.id, PUB, email, `${f} ${l}`, status, tier, wpick(SOURCES), utm, utm ? (utm === 'newsletter-swap' ? 'email' : 'social') : null, utm ? 'launch' : null,
      rnd() < 0.5 ? pick(['https://www.google.com/', 'https://t.co/x', 'https://www.linkedin.com/', 'https://news.ycombinator.com/', null]) : null,
      pick(['/', '/', '/p/why-open-source-wins', '/archive', '/bio', '/p/the-cloudflare-stack']), `rd${i.toString(36)}x`, '{}', wpick(COUNTRIES), created,
      status === 'unsubscribed' ? created + Math.floor(rnd() * (NOW - created)) : null, engagement, created, created]);
}

// posts + sends + deliveries + opens/clicks
const TITLES = ['Why open source wins', 'The Cloudflare stack', 'Shipping in public', 'Notes on pricing', 'Email deliverability 101', 'How we grew to 2k readers', 'A tour of D1', 'Writing every week', 'The case for owning your list', 'Durable Objects explained', 'Our first paid tier', 'Recommendations that work', 'Building in the edge', 'AI and the newsletter', 'Podcasting from R2', 'Webinars without Zoom', 'Referral programs', 'Design tokens for email', 'Metered paywalls', 'One year in'];
const PROVIDER = (e) => (/gmail/.test(e) ? 'gmail' : /outlook/.test(e) ? 'outlook' : /yahoo/.test(e) ? 'yahoo' : /icloud/.test(e) ? 'apple' : /proton/.test(e) ? 'proton' : 'other');
const posts = [];
TITLES.forEach((t, i) => {
  const at = NOW - (TITLES.length - i) * 8 * DAY + 9 * 3600000;
  const slug = t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-$/, '');
  const pid = `pd_${i}`;
  posts.push({ id: pid, at, slug });
  add('posts', ['id', 'pub_id', 'title', 'subtitle', 'slug', 'content', 'status', 'platform', 'audience', 'email_subject', 'preview_text', 'published_at', 'created_at', 'updated_at', 'word_count'],
    [pid, PUB, t, 'Issue #' + (i + 1), slug, '{"blocks":[{"type":"paragraph","data":{"html":"Hello readers."}}]}', 'published', 'both', 'all', t, 'This week: ' + t.toLowerCase(), at, at - DAY, at, 900 + Math.floor(rnd() * 900)]);
  const sid = `se_${i}`;
  const recips = subs.filter((s) => s.created < at && (s.status === 'active' || rnd() < 0.5));
  let sent = 0;
  const openBase = 0.38 + rnd() * 0.18, clickBase = 0.04 + rnd() * 0.05;
  for (const s of recips) {
    if (rnd() > 0.75) continue; // sample to keep the dataset light
    const did = `dd_${i}_${s.id}`;
    const bounce = rnd() < 0.012 ? pick(['hard', 'soft', 'mailbox_full', 'dns', 'policy']) : null;
    const complained = !bounce && rnd() < 0.0015;
    const status = bounce ? 'bounced' : complained ? 'complained' : 'sent';
    const eng = s.engagement / 100;
    const opened = status === 'sent' && rnd() < openBase * (0.5 + eng);
    const clicked = opened && rnd() < clickBase * (1 + eng) * 2;
    const sentAt = at + Math.floor(rnd() * 600000);
    const openAt = opened ? sentAt + Math.floor(rnd() * 2 * DAY) : null;
    add('deliveries', ['id', 'send_id', 'pub_id', 'subscriber_id', 'email', 'status', 'bounce_type', 'attempts', 'provider', 'sent_at', 'opened_at', 'open_count', 'clicked_at', 'click_count', 'created_at'],
      [did, sid, PUB, s.id, s.email, status, complained ? 'complaint' : bounce, 1, PROVIDER(s.email), status === 'sent' ? sentAt : null, openAt, opened ? 1 + Math.floor(rnd() * 3) : 0, clicked ? openAt + 60000 : null, clicked ? 1 : 0, sentAt]);
    if (opened) add('opens', ['id', 'delivery_id', 'send_id', 'pub_id', 'is_bot', 'device', 'country', 'created_at'], [`o_${did}`, did, sid, PUB, 0, pick(['mobile', 'mobile', 'desktop', 'tablet']), 'US', openAt]);
    if (clicked) add('clicks', ['id', 'delivery_id', 'send_id', 'pub_id', 'url', 'is_bot', 'created_at'], [`c_${did}`, did, sid, PUB, pick(['https://example.com/a', 'https://github.com/openhive', 'https://lnkbase.com/beehiiv']), 0, openAt + 60000]);
    if (status === 'sent' && rnd() < 0.03) add('clicks', ['id', 'delivery_id', 'send_id', 'pub_id', 'url', 'is_bot', 'ua', 'created_at'], [`cb_${did}`, did, sid, PUB, 'https://example.com/a', 1, 'Mimecast/1.0', sentAt + 3000]);
    if (status !== 'bounced') sent++;
  }
  add('sends', ['id', 'pub_id', 'post_id', 'kind', 'subject', 'status', 'total', 'sent', 'failed', 'created_at', 'started_at', 'completed_at'], [sid, PUB, pid, 'post', t, 'sent', recips.length, sent, 0, at, at, at + 900000]);
});

// suppressions
for (const s of subs.filter((x) => x.status === 'bounced')) add('suppressions', ['id', 'scope', 'pub_id', 'email', 'reason', 'expires_at', 'created_at'], [id('sp', 1), 'global', '', s.email, pick(['hard_bounce:550', 'mailbox_full', 'dns_failure']), null, NOW - 5 * DAY]);
for (const s of subs.filter((x) => x.status === 'unsubscribed').slice(0, 60)) add('suppressions', ['id', 'scope', 'pub_id', 'email', 'reason', 'expires_at', 'created_at'], [id('sp', 2), 'pub', PUB, s.email, 'unsubscribe', null, NOW - 3 * DAY]);

// page views
const CHANNELS = [['direct', 25], ['search', 22], ['social', 20], ['email', 18], ['referral', 9], ['ai', 4], ['paid', 2]];
const REF = { direct: null, search: 'https://www.google.com/', social: 'https://t.co/abc', email: 'https://mail.google.com/', referral: 'https://news.ycombinator.com/', ai: 'https://chatgpt.com/', paid: 'https://www.google.com/aclk' };
const PATHS = ['/', '/archive', '/bio', '/upgrade', ...posts.map((p) => '/p/' + p.slug)];
for (let i = 0; i < 18000; i++) {
  const at = NOW - Math.floor(Math.pow(rnd(), 1.3) * 120 * DAY);
  const ch = wpick(CHANNELS);
  const dev = wpick([['mobile', 58], ['desktop', 37], ['tablet', 5]]);
  const os = dev === 'desktop' ? wpick([['macOS', 45], ['Windows', 45], ['Linux', 10]]) : wpick([['iOS', 55], ['Android', 45]]);
  const p = pick(PATHS);
  add('page_views', ['id', 'pub_id', 'path', 'ref_id', 'referrer', 'channel', 'utm_source', 'utm_medium', 'utm_campaign', 'country', 'device', 'os', 'browser', 'visitor_id', 'created_at'],
    [`pv${i}`, PUB, p, p.startsWith('/p/') ? posts.find((x) => '/p/' + x.slug === p).id : null, REF[ch], ch, ch === 'social' && rnd() < 0.5 ? 'twitter' : ch === 'paid' ? 'google' : null, ch === 'social' ? 'social' : ch === 'paid' ? 'cpc' : null, null,
      wpick(COUNTRIES), dev, os, wpick([['Chrome', 55], ['Safari', 30], ['Firefox', 8], ['Edge', 7]]), 'v' + Math.floor(rnd() * 6000), at]);
}
for (let i = 0; i < 25; i++) add('page_views', ['id', 'pub_id', 'path', 'channel', 'country', 'device', 'os', 'browser', 'visitor_id', 'created_at'], [`pvl${i}`, PUB, pick(PATHS), wpick(CHANNELS), wpick(COUNTRIES), 'mobile', 'iOS', 'Safari', 'live' + (i % 14), NOW - Math.floor(rnd() * 25 * 60000)]);

// bot hits
const BOTS = [['GPTBot', 'ai'], ['ClaudeBot', 'ai'], ['PerplexityBot', 'ai'], ['CCBot', 'ai'], ['Bytespider', 'ai'], ['Googlebot', 'search'], ['Bingbot', 'search'], ['AhrefsBot', 'seo'], ['Link preview', 'preview'], ['Generic bot', 'scraper']];
for (let i = 0; i < 3000; i++) {
  const [bot, cat] = pick(BOTS);
  const at = NOW - Math.floor(rnd() * 60 * DAY);
  add('bot_hits', ['id', 'pub_id', 'bot', 'category', 'path', 'action', 'created_at'], [`bh${i}`, PUB, bot, cat, pick(PATHS), cat === 'ai' && at > NOW - 20 * DAY && bot !== 'PerplexityBot' ? 'blocked' : 'served', at]);
}

// tiers, subscriptions, orders, wallet
add('tiers', ['id', 'pub_id', 'name', 'monthly_cents', 'annual_cents', 'status', 'created_at'], ['t_demo', PUB, 'Supporter', 800, 8000, 'active', NOW - 170 * DAY]);
subs.filter((s) => s.tier === 'premium').forEach((s, i) => {
  const yearly = rnd() < 0.3;
  const canceled = rnd() < 0.12;
  add('subscriptions', ['id', 'pub_id', 'subscriber_id', 'tier_id', 'interval', 'status', 'amount_cents', 'created_at', 'updated_at', 'canceled_at'],
    [`sb${i}`, PUB, s.id, 't_demo', yearly ? 'year' : 'month', canceled ? 'canceled' : 'active', yearly ? 8000 : 800, s.created, s.created, canceled ? NOW - Math.floor(rnd() * 60 * DAY) : null]);
  const months = Math.max(1, Math.floor((NOW - s.created) / (30 * DAY)));
  for (let m = 0; m < (yearly ? 1 : months); m++) {
    const at = s.created + m * 30 * DAY;
    add('orders', ['id', 'pub_id', 'kind', 'ref_id', 'subscriber_id', 'email', 'amount_cents', 'currency', 'status', 'created_at', 'paid_at'], [`or${i}_${m}`, PUB, 'subscription', 't_demo', s.id, s.email, yearly ? 8000 : 800, 'usd', 'paid', at, at]);
  }
});
for (let i = 0; i < 140; i++) {
  const s = pick(subs);
  const at = NOW - Math.floor(rnd() * 150 * DAY);
  const kind = wpick([['product', 60], ['ticket', 25], ['sponsorship', 15]]);
  const amt = kind === 'product' ? pick([1900, 2900, 4900]) : kind === 'ticket' ? pick([1500, 2500]) : pick([25000, 50000]);
  add('orders', ['id', 'pub_id', 'kind', 'ref_id', 'subscriber_id', 'email', 'amount_cents', 'currency', 'status', 'created_at', 'paid_at'], [`ox${i}`, PUB, kind, 'x', s.id, s.email, amt, 'usd', 'paid', at, at]);
}
for (let i = 0; i < 40; i++) add('wallet_entries', ['id', 'pub_id', 'kind', 'amount_cents', 'status', 'note', 'created_at'], [`we${i}`, PUB, pick(['ad', 'boost']), 500 + Math.floor(rnd() * 6000), 'available', 'Demo earning', NOW - Math.floor(rnd() * 150 * DAY)]);

// podcast downloads
add('podcasts', ['id', 'pub_id', 'title', 'slug', 'created_at'], ['pc_demo', PUB, 'The Demo Pod', 'demo-pod', NOW - 100 * DAY]);
for (let e = 0; e < 6; e++) {
  const epAt = NOW - (6 - e) * 14 * DAY;
  add('episodes', ['id', 'podcast_id', 'pub_id', 'guid', 'title', 'slug', 'status', 'published_at', 'created_at', 'updated_at'], [`ep${e}`, 'pc_demo', PUB, `guid-${e}`, `Episode ${e + 1}`, `episode-${e + 1}`, 'published', epAt, epAt, epAt]);
  const n = 150 + Math.floor(rnd() * 250);
  for (let i = 0; i < n; i++) {
    const at = epAt + Math.floor(Math.pow(rnd(), 2) * (NOW - epAt));
    const day = new Date(at).toISOString().slice(0, 10);
    add('episode_downloads', ['id', 'episode_id', 'podcast_id', 'pub_id', 'listener_hash', 'app', 'device', 'country', 'is_bot', 'day', 'created_at'],
      [`dl${e}_${i}`, `ep${e}`, 'pc_demo', PUB, `l${e}_${i}`, pick(['Apple Podcasts', 'Spotify', 'Overcast', 'Pocket Casts', 'Web']), pick(['mobile', 'desktop', 'smart speaker']), wpick(COUNTRIES), rnd() < 0.06 ? 1 : 0, day, at]);
  }
}

// activity (comments-style events) for feed
subs.slice(-30).forEach((s, i) => add('activity', ['id', 'pub_id', 'subscriber_id', 'type', 'data', 'created_at'], [`ac${i}`, PUB, s.id, 'subscription.created', '{"source":"website"}', s.created]));

for (const [table, { cols, vals }] of Object.entries(rows)) {
  for (let i = 0; i < vals.length; i += 200) {
    out.push(`INSERT OR IGNORE INTO ${table} (${cols.join(',')}) VALUES\n${vals.slice(i, i + 200).map((v) => '(' + v.map(q).join(',') + ')').join(',\n')};`);
  }
}
console.log(out.join('\n'));
