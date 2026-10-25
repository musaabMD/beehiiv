// Prices and facts for the compare pages, read from each platform's own pricing and help pages on CHECKED_ON.
// Scenario: one issue a week (~4.3 emails per subscriber a month), monthly billing, USD, cheapest plan that fits.
// Update CHECKED_ON whenever you refresh the numbers.

export const CHECKED_ON = '2026-10-25';
export const SIZES = [1000, 4000, 10000, 50000, 100000];

/** OpenHive's monthly Cloudflare bill: Workers Paid $5 (needed for Email Sending, 3,000 emails included),
 *  then $0.35 per 1,000 emails. Requests, CPU, D1 and R2 stay inside the included amounts at these sizes. */
export const OPENHIVE_COST = SIZES.map((s) => Math.round((5 + Math.max(0, s * 4.3 - 3000) * 0.35 / 1000) * 100) / 100);

export const OPENHIVE_COST_NOTES = [
  'OpenHive is a one-time purchase of the source code. You run it on your own Cloudflare account, so the monthly figure is Cloudflare\'s bill, not ours.',
  'Sending email needs Cloudflare\'s Workers Paid plan: $5 a month, which includes 3,000 emails. After that Cloudflare Email Sending costs $0.35 per 1,000 emails. One issue a week to 10,000 subscribers is about 43,000 emails: $5 + 40,000 × $0.35 / 1,000 = $19.',
  'At these list sizes, page views, tracking, the database (D1) and file storage (R2) stay inside what Cloudflare includes. Welcome and confirmation emails add a little. Prices are from Cloudflare\'s pricing pages on October 25, 2026; Cloudflare may change them.',
];

export type Cell = boolean | string;
export interface PriceAt { plan: string; usd: number | null }
export interface Platform {
  slug: string; name: string; color: string;
  summary: string;
  prices: PriceAt[];              // one per SIZES entry
  priceNote?: string;
  features: Record<string, Cell>; // keyed by FEATURE_ROWS labels
  theyHave: string[];
  weHave: string[];
  exportSteps: string[];          // HTML allowed (our own copy)
  exportSource?: string;
  extraSteps: Array<{ h: string; p: string }>;
}

/** [label, OpenHive's value] */
export const FEATURE_ROWS: Array<[string, Cell]> = [
  ['Fee on paid subscriptions', '0% (Stripe fees only)'],
  ['Official MCP server for AI agents', true],
  ['Open source / source code included', 'Full source code'],
  ['Runs on your own account', 'Your Cloudflare'],
  ['Recommendation network', 'Your install only'],
  ['Ad network', 'Your own advertisers'],
  ['Support', 'Docs and email'],
];

const WE_HAVE_COMMON = [
  'One payment for the source code, then only your Cloudflare bill',
  'Your data in your own Cloudflare account, exportable any time',
  'Paid subscriptions, products, webinars, podcasts and community in one app, with 0% platform fees',
  'REST API, webhooks and an MCP server on every install',
];

export const PLATFORMS: Platform[] = [
  {
    slug: 'beehiiv', name: 'beehiiv', color: '#ff7a59',
    summary: 'beehiiv has more ways to grow and earn: an ad network, Boosts and managed support. At 4,000 subscribers it costs $109 a month; OpenHive runs for about $10 a month on Cloudflare after a one-time $30.',
    prices: [{ plan: 'Free', usd: 0 }, { plan: 'Lite', usd: 109 }, { plan: 'Lite', usd: 139 }, { plan: 'Lite', usd: 299 }, { plan: 'Lite', usd: 469 }],
    priceNote: 'beehiiv Free covers up to 2,500 subscribers.',
    features: { 'Fee on paid subscriptions': '0% (Stripe fees)', 'Official MCP server for AI agents': 'Yes (writes on Lite and up)', 'Open source / source code included': false, 'Runs on your own account': false, 'Recommendation network': 'Yes, across beehiiv', 'Ad network': 'Yes', 'Support': 'Yes, 24/7 priority on Pro' },
    theyHave: ['A large ad network with brands ready to book', 'Boosts and recommendations across every beehiiv newsletter', 'Hosted for you: no Cloudflare account, nothing to deploy or update', 'A support team'],
    weHave: WE_HAVE_COMMON,
    exportSteps: ['In beehiiv, go to <b>Settings → Export Data → Export Subscribers</b>. Pick <b>All Subscribers</b> to include custom fields, or <b>Basic</b> for email, status and tier.', 'beehiiv emails you a CSV and lists it under Historical Exports. The link lasts 24 hours.'],
    exportSource: 'https://www.beehiiv.com/support/article/12258595483543-exporting-post-content-or-subscriber-data-from-beehiiv',
    extraSteps: [{ h: 'Move your paid subscribers', p: 'Connect your Stripe account and recreate your tiers under <b>Monetize</b>. Existing paid subscriptions don\'t move by themselves: mark those readers premium in OpenHive (from their subscriber page or the API) so they keep access, and move their billing in Stripe when you\'re ready.' }],
  },
  {
    slug: 'substack', name: 'Substack', color: '#ff6719',
    summary: 'Substack is free to run and keeps 10% of paid subscriptions. OpenHive is a flat cost with 0% platform fees, emails from your own domain, and your AI agent can run it.',
    prices: [{ plan: 'Free', usd: 0 }, { plan: 'Free', usd: 0 }, { plan: 'Free', usd: 0 }, { plan: 'Free', usd: 0 }, { plan: 'Free', usd: 0 }],
    priceNote: 'Substack charges no monthly fee but keeps 10% of paid subscription revenue, plus Stripe\'s fees.',
    features: { 'Fee on paid subscriptions': '10% plus Stripe', 'Official MCP server for AI agents': false, 'Open source / source code included': false, 'Runs on your own account': false, 'Recommendation network': 'Yes (app, Notes)', 'Ad network': false, 'Support': 'Yes' },
    theyHave: ['A discovery network: the Substack app, Notes and recommendations', 'Reader apps for iOS and Android', 'Free to start, nothing to host'],
    weHave: ['0% of your paid subscriptions: on $5,000 a month that\'s $500 a month you keep', ...WE_HAVE_COMMON],
    exportSteps: ['In Substack, open <b>Dashboard → Subscribers</b>, choose <b>All subscribers</b>, then <b>⋯ → Export</b> with all columns.', 'For everything at once, <b>Settings → Import/Export</b> gives a zip with your posts and list. Substack\'s export doesn\'t include names.'],
    exportSource: 'https://support.substack.com/hc/en-us/articles/6314498343700',
    extraSteps: [{ h: 'Move your paid subscribers', p: 'Substack bills through your own Stripe account. Connect it, recreate your tiers under <b>Monetize</b>, and mark your paid readers premium in OpenHive (from their subscriber page or the API) so they keep access while their billing moves.' }],
  },
  {
    slug: 'mailchimp', name: 'Mailchimp', color: '#ffe01b',
    summary: 'Mailchimp is a marketing suite with SMS and hundreds of integrations. For a newsletter of 4,000 subscribers it costs $75 a month on Essentials; OpenHive about $10 on Cloudflare.',
    prices: [{ plan: 'Essentials', usd: 26.5 }, { plan: 'Essentials', usd: 75 }, { plan: 'Essentials', usd: 110 }, { plan: 'Essentials', usd: 385 }, { plan: 'Standard', usd: 800 }],
    priceNote: 'List prices. Mailchimp currently offers 50% off for the first 12 months.',
    features: { 'Fee on paid subscriptions': 'No paid newsletters', 'Official MCP server for AI agents': 'Claude connector (drafts only)', 'Open source / source code included': false, 'Runs on your own account': false, 'Recommendation network': false, 'Ad network': false, 'Support': 'Yes' },
    theyHave: ['SMS and multichannel campaigns', '300+ integrations and customer journeys', 'Phone and priority support on Premium', 'Hosted for you'],
    weHave: ['Paid subscriptions built in', ...WE_HAVE_COMMON],
    exportSteps: ['In Mailchimp, go to <b>Audience → Export audience → Export CSV</b>.', 'You get a zip with one CSV per status: subscribed, unsubscribed, non-subscribed and cleaned (bounced). Import only <b>subscribed</b>, or import them all: OpenHive keeps unsubscribed and cleaned readers out when the file has a status column.'],
    exportSource: 'https://mailchimp.com/help/view-export-contacts/',
    extraSteps: [],
  },
  {
    slug: 'kit', name: 'Kit', color: '#fb6970',
    summary: 'Kit is free up to 10,000 subscribers, and its MCP server comes with Creator. Past 10,000 it costs $379 a month at 50,000; OpenHive about $79 on Cloudflare.',
    prices: [{ plan: 'Free', usd: 0 }, { plan: 'Free', usd: 0 }, { plan: 'Free', usd: 0 }, { plan: 'Creator', usd: 379 }, { plan: 'Creator', usd: 679 }],
    priceNote: 'Kit Free covers up to 10,000 subscribers.',
    features: { 'Fee on paid subscriptions': '3.5% + 30¢ total (Kit keeps 0.6%)', 'Official MCP server for AI agents': 'Yes, on Creator and up', 'Open source / source code included': false, 'Runs on your own account': false, 'Recommendation network': 'Yes (Creator Network)', 'Ad network': 'Paid Recommendations', 'Support': 'Yes' },
    theyHave: ['A free plan up to 10,000 subscribers', 'The Creator Network and Paid Recommendations', 'Hosted for you'],
    weHave: WE_HAVE_COMMON,
    exportSteps: ['In Kit, open <b>Subscribers</b>, select all (filter by status if you like), then <b>⋯ → Export</b>.', 'Kit emails you a CSV with first name, email, created date, status, tags and custom fields. The link lasts 5 days.'],
    exportSource: 'https://help.kit.com/en/articles/2502489-how-to-export-subscribers',
    extraSteps: [],
  },
  {
    slug: 'mailerlite', name: 'MailerLite', color: '#09c269',
    summary: 'Both have an MCP server. At 4,000 subscribers MailerLite costs $49 a month on Comfort and OpenHive about $10, and OpenHive comes with its source code.',
    prices: [{ plan: 'Comfort', usd: 19 }, { plan: 'Comfort', usd: 49 }, { plan: 'Comfort', usd: 89 }, { plan: 'Comfort', usd: 319 }, { plan: 'Comfort', usd: 439 }],
    priceNote: 'MailerLite\'s free plan covers 250 subscribers.',
    features: { 'Fee on paid subscriptions': 'Stripe fees', 'Official MCP server for AI agents': 'Yes', 'Open source / source code included': false, 'Runs on your own account': false, 'Recommendation network': false, 'Ad network': false, 'Support': 'Yes, 24/7' },
    theyHave: ['Landing pages and e-commerce integrations', 'An AI writing assistant', '24/7 support', 'Hosted for you'],
    weHave: WE_HAVE_COMMON,
    exportSteps: ['In MailerLite, open <b>Subscribers</b>, use <b>Set columns</b> to show the fields you want, select all, then <b>Actions → Export</b> as CSV.', 'Export each status (active, unsubscribed, bounced, spam complaints) if you want OpenHive to keep the inactive ones suppressed.'],
    exportSource: 'https://www.mailerlite.com/help/how-to-export-subscribers',
    extraSteps: [],
  },
  {
    slug: 'buttondown', name: 'Buttondown', color: '#0069ff',
    summary: 'Buttondown costs less up to 1,000 subscribers. At 4,000 it costs $29 a month against OpenHive\'s $10 on Cloudflare, and paid subscriptions are a $9 add-on.',
    prices: [{ plan: 'Basic', usd: 9 }, { plan: 'Standard', usd: 29 }, { plan: 'Professional', usd: 79 }, { plan: 'Up to 60k', usd: 319 }, { plan: 'Up to 100k', usd: 459 }],
    priceNote: 'Paid subscriptions are a $9 a month add-on on Buttondown.',
    features: { 'Fee on paid subscriptions': '0% (Stripe fees, $9 add-on)', 'Official MCP server for AI agents': false, 'Open source / source code included': false, 'Runs on your own account': false, 'Recommendation network': false, 'Ad network': false, 'Support': 'Yes' },
    theyHave: ['A Markdown-first editor loved by writers', 'Managed deliverability and migration help', 'Hosted for you'],
    weHave: WE_HAVE_COMMON,
    exportSteps: ['In Buttondown, open <b>Subscribers</b> and click <b>Export</b> at the top right.', 'The CSV includes email, subscriber type, tags, metadata, UTM fields and subscribe and unsubscribe dates.'],
    exportSource: 'https://docs.buttondown.com/data-exports-subscriber',
    extraSteps: [],
  },
  {
    slug: 'ghost', name: 'Ghost', color: '#738a94',
    summary: 'Ghost is a publishing platform, and open source too. For the newsletter alone at 4,000 subscribers, Ghost(Pro) Publisher costs $75 a month and OpenHive about $10 on Cloudflare.',
    prices: [{ plan: 'Publisher', usd: 35 }, { plan: 'Publisher', usd: 75 }, { plan: 'Publisher', usd: 105 }, { plan: 'Publisher', usd: 249 }, { plan: 'Publisher', usd: 329 }],
    priceNote: 'Ghost(Pro) Starter is $18 a month for up to 1,000 members but has no paid subscriptions. Ghost can also be self-hosted.',
    features: { 'Fee on paid subscriptions': '0% (Stripe fees)', 'Official MCP server for AI agents': false, 'Open source / source code included': 'Yes (MIT)', 'Runs on your own account': 'If you self-host', 'Recommendation network': 'Yes (Recommendations, Explore)', 'Ad network': false, 'Support': 'Yes on Ghost(Pro)' },
    theyHave: ['A mature open-source publishing platform with a theme marketplace', 'Social-web (ActivityPub) distribution and Ghost Explore', 'Managed hosting, CDN and backups on Ghost(Pro)'],
    weHave: ['Webinars, podcasts, digital products and community built in', ...WE_HAVE_COMMON],
    exportSteps: ['In Ghost, go to <b>Settings → Advanced → Import/Export → Export</b> for everything, or open <b>Members</b>, filter, then <b>⋯ → Export</b>.', 'The members CSV includes labels and subscription status.'],
    exportSource: 'https://ghost.org/help/exports/',
    extraSteps: [{ h: 'Bring your posts', p: 'Ghost\'s full export includes your posts. Recreate key pages in the website builder and add redirects so old URLs keep working.' }],
  },
  {
    slug: 'emailoctopus', name: 'EmailOctopus', color: '#7c3aed',
    summary: 'EmailOctopus is free up to 2,500 subscribers and close on price after that: $31.50 a month at 4,000 on Pro, against OpenHive\'s $10 on Cloudflare.',
    prices: [{ plan: 'Starter', usd: 0 }, { plan: 'Pro', usd: 31.5 }, { plan: 'Pro', usd: 44.5 }, { plan: 'Pro', usd: 178 }, { plan: 'Pro', usd: 345 }],
    priceNote: 'EmailOctopus Starter is free up to 2,500 subscribers and 10,000 emails a month.',
    features: { 'Fee on paid subscriptions': 'No paid newsletters', 'Official MCP server for AI agents': false, 'Open source / source code included': false, 'Runs on your own account': false, 'Recommendation network': false, 'Ad network': false, 'Support': 'Yes' },
    theyHave: ['A free plan up to 2,500 subscribers', 'Managed deliverability', 'Hosted for you'],
    weHave: ['Paid subscriptions built in', ...WE_HAVE_COMMON],
    exportSteps: ['In EmailOctopus, open the list, set the <b>Status</b> filter, select all, then <b>Actions → Export</b> with all fields.', 'The download is a zip; it stays in your export history for 7 days.'],
    exportSource: 'https://help.emailoctopus.com/article/116-exporting-contacts-from-a-list',
    extraSteps: [],
  },
  {
    slug: 'mailcheap', name: 'MailCheap', color: '#374151',
    summary: 'MailCheap is open source too, and its cloud plans are priced by emails sent. It\'s close to OpenHive\'s Cloudflare cost and cheaper at 100,000 subscribers; OpenHive adds paid subscriptions, products, webinars, podcasts and community.',
    prices: [{ plan: 'Starter', usd: 19 }, { plan: 'Starter', usd: 19 }, { plan: 'Growth', usd: 39 }, { plan: 'Scale', usd: 149 }, { plan: 'Scale', usd: 149 }],
    priceNote: 'MailCheap Cloud plans are sized by emails a month (Starter 20,000, Growth 75,000, Pro 200,000, Scale 500,000). MailCheap can also be self-hosted.',
    features: { 'Fee on paid subscriptions': 'No paid newsletters listed', 'Official MCP server for AI agents': 'Yes', 'Open source / source code included': 'Yes (AGPL-3.0)', 'Runs on your own account': 'If you self-host', 'Recommendation network': false, 'Ad network': false, 'Support': 'Yes' },
    theyHave: ['Sending set up for you, on a shared address or your domain', 'Automatic list cleanup of dormant contacts', 'Cheaper than OpenHive\'s Cloudflare bill at 100,000 subscribers', 'Hosted for you if you pick the cloud plan'],
    weHave: ['Paid subscriptions, digital products, webinars, podcasts and community built in', 'Website builder, automations and segments', ...WE_HAVE_COMMON.slice(1)],
    exportSteps: ['In MailCheap, open <b>Contacts</b>, then <b>⋯ → Export</b>. It exports whatever the current filter shows.', 'The CSV includes email, status, source and subscribe dates.'],
    exportSource: 'https://mailcheap.ai/help/contacts',
    extraSteps: [],
  },
];

export const platformBySlug = (slug: string) => PLATFORMS.find((p) => p.slug === slug.toLowerCase());
