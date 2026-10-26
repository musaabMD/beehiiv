// Prices and facts for the compare pages, read from each platform's own pricing and help pages on CHECKED_ON.
// Scenario: one issue a week (~4.3 emails per subscriber a month), monthly billing, USD, cheapest plan that fits.
// Update CHECKED_ON whenever you refresh the numbers. Our own price is the cheapest hosted plan that fits (./brand.ts).
import { planFor, type Plan } from './brand';

export const CHECKED_ON = '2026-10-25';
export const SIZES = [1000, 4000, 10000, 50000, 100000];

/** Our plan and monthly price at each list size (null = custom plan). */
export const OUR_PLANS: Array<Plan | null> = SIZES.map((s) => planFor(s));
export const OPENHIVE_COST: Array<number | null> = OUR_PLANS.map((p) => (p ? p.monthly : null));

export const OPENHIVE_COST_NOTES = [
  'Lnkbase Newsletter is priced by list size, with every feature on every plan: Free up to 500 subscribers, Starter $12 up to 2,500, Pro $29 up to 10,000 and Scale $129 up to 50,000. Each plan includes enough emails for one issue a week, with room for welcome emails and automations.',
  'We take 0% of paid subscriptions, products, tickets and sponsorships; Stripe\'s card fees apply. Above 50,000 subscribers we set a custom plan.',
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

/** [label, our value] */
export const FEATURE_ROWS: Array<[string, Cell]> = [
  ['Fee on paid subscriptions', '0% (Stripe fees only)'],
  ['Official MCP server for AI agents', true],
  ['Free plan', 'Up to 500 subscribers'],
  ['Hosted for you', true],
  ['Recommendation network', 'Every newsletter on Lnkbase'],
  ['Ad network', 'Marketplace plus your own sponsors'],
  ['Support', 'Email'],
];

const WE_HAVE_COMMON = [
  'A free plan, then one flat price by list size with every feature included',
  '0% of your paid subscriptions, products, tickets and sponsorships',
  'Paid subscriptions, products, webinars, podcasts and community in one place',
  'REST API, webhooks and an MCP server so your AI agent can run it',
];

export const PLATFORMS: Platform[] = [
  {
    slug: 'beehiiv', name: 'beehiiv', color: '#ff7a59',
    summary: 'beehiiv has more ways to grow and earn: an ad network with big brands, Boosts and 24/7 support on Pro. At 4,000 subscribers it costs $109 a month; Lnkbase Newsletter costs $29 with every feature.',
    prices: [{ plan: 'Free', usd: 0 }, { plan: 'Lite', usd: 109 }, { plan: 'Lite', usd: 139 }, { plan: 'Lite', usd: 299 }, { plan: 'Lite', usd: 469 }],
    priceNote: 'beehiiv Free covers up to 2,500 subscribers.',
    features: { 'Fee on paid subscriptions': '0% (Stripe fees)', 'Official MCP server for AI agents': 'Yes (writes on Lite and up)', 'Free plan': 'Up to 2,500', 'Hosted for you': true, 'Recommendation network': 'Yes, across beehiiv', 'Ad network': 'Yes', 'Support': 'Yes, 24/7 priority on Pro' },
    theyHave: ['A large ad network with brands ready to book', 'Boosts and recommendations across every beehiiv newsletter', 'A support team'],
    weHave: WE_HAVE_COMMON,
    exportSteps: ['In beehiiv, go to <b>Settings → Export Data → Export Subscribers</b>. Pick <b>All Subscribers</b> to include custom fields, or <b>Basic</b> for email, status and tier.', 'beehiiv emails you a CSV and lists it under Historical Exports. The link lasts 24 hours.'],
    exportSource: 'https://www.beehiiv.com/support/article/12258595483543-exporting-post-content-or-subscriber-data-from-beehiiv',
    extraSteps: [{ h: 'Move your paid subscribers', p: 'Connect your Stripe account and recreate your tiers under <b>Monetize</b>. Existing paid subscriptions don\'t move by themselves: mark those readers premium in Lnkbase Newsletter (from their subscriber page or the API) so they keep access, and move their billing in Stripe when you\'re ready.' }],
  },
  {
    slug: 'substack', name: 'Substack', color: '#ff6719',
    summary: 'Substack is free to run and keeps 10% of paid subscriptions. Lnkbase Newsletter is a flat monthly price with 0% fees, emails from your own domain, and an AI agent that can run it.',
    prices: [{ plan: 'Free', usd: 0 }, { plan: 'Free', usd: 0 }, { plan: 'Free', usd: 0 }, { plan: 'Free', usd: 0 }, { plan: 'Free', usd: 0 }],
    priceNote: 'Substack charges no monthly fee but keeps 10% of paid subscription revenue, plus Stripe\'s fees.',
    features: { 'Fee on paid subscriptions': '10% plus Stripe', 'Official MCP server for AI agents': false, 'Free plan': 'Free, keeps 10% of paid', 'Hosted for you': true, 'Recommendation network': 'Yes (app, Notes)', 'Ad network': false, 'Support': 'Yes' },
    theyHave: ['A discovery network: the Substack app, Notes and recommendations', 'Reader apps for iOS and Android', 'Free to start'],
    weHave: ['0% of your paid subscriptions: on $5,000 a month that\'s $500 a month you keep', ...WE_HAVE_COMMON],
    exportSteps: ['In Substack, open <b>Dashboard → Subscribers</b>, choose <b>All subscribers</b>, then <b>⋯ → Export</b> with all columns.', 'For everything at once, <b>Settings → Import/Export</b> gives a zip with your posts and list. Substack\'s export doesn\'t include names.'],
    exportSource: 'https://support.substack.com/hc/en-us/articles/6314498343700',
    extraSteps: [{ h: 'Move your paid subscribers', p: 'Substack bills through your own Stripe account. Connect it, recreate your tiers under <b>Monetize</b>, and mark your paid readers premium in Lnkbase Newsletter (from their subscriber page or the API) so they keep access while their billing moves.' }],
  },
  {
    slug: 'mailchimp', name: 'Mailchimp', color: '#ffe01b',
    summary: 'Mailchimp is a marketing suite with SMS and hundreds of integrations. For a newsletter of 4,000 subscribers it costs $75 a month on Essentials; Lnkbase Newsletter costs $29 and includes paid subscriptions.',
    prices: [{ plan: 'Essentials', usd: 26.5 }, { plan: 'Essentials', usd: 75 }, { plan: 'Essentials', usd: 110 }, { plan: 'Essentials', usd: 385 }, { plan: 'Standard', usd: 800 }],
    priceNote: 'List prices. Mailchimp currently offers 50% off for the first 12 months.',
    features: { 'Fee on paid subscriptions': 'No paid newsletters', 'Official MCP server for AI agents': 'Claude connector (drafts only)', 'Free plan': 'Up to 250 contacts', 'Hosted for you': true, 'Recommendation network': false, 'Ad network': false, 'Support': 'Yes' },
    theyHave: ['SMS and multichannel campaigns', '300+ integrations and customer journeys', 'Phone and priority support on Premium'],
    weHave: ['Paid subscriptions built in', ...WE_HAVE_COMMON],
    exportSteps: ['In Mailchimp, go to <b>Audience → Export audience → Export CSV</b>.', 'You get a zip with one CSV per status: subscribed, unsubscribed, non-subscribed and cleaned (bounced). Import only <b>subscribed</b>, or import them all: Lnkbase Newsletter keeps unsubscribed and cleaned readers out when the file has a status column.'],
    exportSource: 'https://mailchimp.com/help/view-export-contacts/',
    extraSteps: [],
  },
  {
    slug: 'kit', name: 'Kit', color: '#fb6970',
    summary: 'Kit is free up to 10,000 subscribers, which is hard to beat for a free list. Past that, Kit Creator costs $379 a month at 50,000; Lnkbase Newsletter Scale costs $129.',
    prices: [{ plan: 'Free', usd: 0 }, { plan: 'Free', usd: 0 }, { plan: 'Free', usd: 0 }, { plan: 'Creator', usd: 379 }, { plan: 'Creator', usd: 679 }],
    priceNote: 'Kit Free covers up to 10,000 subscribers.',
    features: { 'Fee on paid subscriptions': '3.5% + 30¢ total (Kit keeps 0.6%)', 'Official MCP server for AI agents': 'Yes, on Creator and up', 'Free plan': 'Up to 10,000', 'Hosted for you': true, 'Recommendation network': 'Yes (Creator Network)', 'Ad network': 'Paid Recommendations', 'Support': 'Yes' },
    theyHave: ['A free plan up to 10,000 subscribers', 'The Creator Network and Paid Recommendations'],
    weHave: WE_HAVE_COMMON,
    exportSteps: ['In Kit, open <b>Subscribers</b>, select all (filter by status if you like), then <b>⋯ → Export</b>.', 'Kit emails you a CSV with first name, email, created date, status, tags and custom fields. The link lasts 5 days.'],
    exportSource: 'https://help.kit.com/en/articles/2502489-how-to-export-subscribers',
    extraSteps: [],
  },
  {
    slug: 'mailerlite', name: 'MailerLite', color: '#09c269',
    summary: 'Both have an MCP server for AI agents. At 4,000 subscribers MailerLite costs $49 a month on Comfort and Lnkbase Newsletter $29, with paid subscriptions, podcasts and events included.',
    prices: [{ plan: 'Comfort', usd: 19 }, { plan: 'Comfort', usd: 49 }, { plan: 'Comfort', usd: 89 }, { plan: 'Comfort', usd: 319 }, { plan: 'Comfort', usd: 439 }],
    priceNote: 'MailerLite\'s free plan covers 250 subscribers.',
    features: { 'Fee on paid subscriptions': 'Stripe fees', 'Official MCP server for AI agents': 'Yes', 'Free plan': 'Up to 250', 'Hosted for you': true, 'Recommendation network': false, 'Ad network': false, 'Support': 'Yes, 24/7' },
    theyHave: ['Landing pages and e-commerce integrations', 'An AI writing assistant', '24/7 support'],
    weHave: WE_HAVE_COMMON,
    exportSteps: ['In MailerLite, open <b>Subscribers</b>, use <b>Set columns</b> to show the fields you want, select all, then <b>Actions → Export</b> as CSV.', 'Export each status (active, unsubscribed, bounced, spam complaints) if you want Lnkbase Newsletter to keep the inactive ones suppressed.'],
    exportSource: 'https://www.mailerlite.com/help/how-to-export-subscribers',
    extraSteps: [],
  },
  {
    slug: 'buttondown', name: 'Buttondown', color: '#0069ff',
    summary: 'Buttondown costs less up to 1,000 subscribers. At 4,000 they\'re the same price, $29 a month, but paid subscriptions are a $9 add-on on Buttondown and built in here.',
    prices: [{ plan: 'Basic', usd: 9 }, { plan: 'Standard', usd: 29 }, { plan: 'Professional', usd: 79 }, { plan: 'Up to 60k', usd: 319 }, { plan: 'Up to 100k', usd: 459 }],
    priceNote: 'Paid subscriptions are a $9 a month add-on on Buttondown.',
    features: { 'Fee on paid subscriptions': '0% (Stripe fees, $9 add-on)', 'Official MCP server for AI agents': false, 'Free plan': '—', 'Hosted for you': true, 'Recommendation network': false, 'Ad network': false, 'Support': 'Yes' },
    theyHave: ['A Markdown-first editor loved by writers', 'Managed deliverability and migration help'],
    weHave: WE_HAVE_COMMON,
    exportSteps: ['In Buttondown, open <b>Subscribers</b> and click <b>Export</b> at the top right.', 'The CSV includes email, subscriber type, tags, metadata, UTM fields and subscribe and unsubscribe dates.'],
    exportSource: 'https://docs.buttondown.com/data-exports-subscriber',
    extraSteps: [],
  },
  {
    slug: 'ghost', name: 'Ghost', color: '#738a94',
    summary: 'Ghost is an open-source publishing platform. For the newsletter alone at 4,000 subscribers, Ghost(Pro) Publisher costs $75 a month and Lnkbase Newsletter $29, with events, products and community included.',
    prices: [{ plan: 'Publisher', usd: 35 }, { plan: 'Publisher', usd: 75 }, { plan: 'Publisher', usd: 105 }, { plan: 'Publisher', usd: 249 }, { plan: 'Publisher', usd: 329 }],
    priceNote: 'Ghost(Pro) Starter is $18 a month for up to 1,000 members but has no paid subscriptions. Ghost can also be self-hosted.',
    features: { 'Fee on paid subscriptions': '0% (Stripe fees)', 'Official MCP server for AI agents': false, 'Free plan': 'No (self-hosting is free)', 'Hosted for you': 'Ghost(Pro), or self-host', 'Recommendation network': 'Yes (Recommendations, Explore)', 'Ad network': false, 'Support': 'Yes on Ghost(Pro)' },
    theyHave: ['A mature open-source publishing platform with a theme marketplace', 'Social-web (ActivityPub) distribution and Ghost Explore', 'Managed hosting, CDN and backups on Ghost(Pro)'],
    weHave: ['Webinars, podcasts, digital products and community built in', ...WE_HAVE_COMMON],
    exportSteps: ['In Ghost, go to <b>Settings → Advanced → Import/Export → Export</b> for everything, or open <b>Members</b>, filter, then <b>⋯ → Export</b>.', 'The members CSV includes labels and subscription status.'],
    exportSource: 'https://ghost.org/help/exports/',
    extraSteps: [{ h: 'Bring your posts', p: 'Ghost\'s full export includes your posts. Recreate key pages in the website builder and add redirects so old URLs keep working.' }],
  },
  {
    slug: 'emailoctopus', name: 'EmailOctopus', color: '#7c3aed',
    summary: 'EmailOctopus is free up to 2,500 subscribers and close on price after that: $31.50 a month at 4,000 on Pro, against $29 here, which also includes paid subscriptions and a website.',
    prices: [{ plan: 'Starter', usd: 0 }, { plan: 'Pro', usd: 31.5 }, { plan: 'Pro', usd: 44.5 }, { plan: 'Pro', usd: 178 }, { plan: 'Pro', usd: 345 }],
    priceNote: 'EmailOctopus Starter is free up to 2,500 subscribers and 10,000 emails a month.',
    features: { 'Fee on paid subscriptions': 'No paid newsletters', 'Official MCP server for AI agents': false, 'Free plan': 'Up to 2,500', 'Hosted for you': true, 'Recommendation network': false, 'Ad network': false, 'Support': 'Yes' },
    theyHave: ['A free plan up to 2,500 subscribers', 'Managed deliverability'],
    weHave: ['Paid subscriptions built in', ...WE_HAVE_COMMON],
    exportSteps: ['In EmailOctopus, open the list, set the <b>Status</b> filter, select all, then <b>Actions → Export</b> with all fields.', 'The download is a zip; it stays in your export history for 7 days.'],
    exportSource: 'https://help.emailoctopus.com/article/116-exporting-contacts-from-a-list',
    extraSteps: [],
  },
  {
    slug: 'mailcheap', name: 'MailCheap', color: '#374151',
    summary: 'MailCheap is cheaper for plain sending: $19 a month at 4,000 subscribers against our $29, and it\'s open source. Lnkbase Newsletter adds paid subscriptions, products, events, podcasts, community and a website.',
    prices: [{ plan: 'Starter', usd: 19 }, { plan: 'Starter', usd: 19 }, { plan: 'Growth', usd: 39 }, { plan: 'Scale', usd: 149 }, { plan: 'Scale', usd: 149 }],
    priceNote: 'MailCheap Cloud plans are sized by emails a month (Starter 20,000, Growth 75,000, Pro 200,000, Scale 500,000). MailCheap can also be self-hosted.',
    features: { 'Fee on paid subscriptions': 'No paid newsletters listed', 'Official MCP server for AI agents': 'Yes', 'Free plan': false, 'Hosted for you': 'Cloud, or self-host', 'Recommendation network': false, 'Ad network': false, 'Support': 'Yes' },
    theyHave: ['Automatic list cleanup of dormant contacts', 'Cheaper than us for plain sending, at every list size'],
    weHave: ['Paid subscriptions, digital products, webinars, podcasts and community built in', 'Website builder, automations and segments', ...WE_HAVE_COMMON.slice(1)],
    exportSteps: ['In MailCheap, open <b>Contacts</b>, then <b>⋯ → Export</b>. It exports whatever the current filter shows.', 'The CSV includes email, status, source and subscribe dates.'],
    exportSource: 'https://mailcheap.ai/help/contacts',
    extraSteps: [],
  },
];

export const platformBySlug = (slug: string) => PLATFORMS.find((p) => p.slug === slug.toLowerCase());
