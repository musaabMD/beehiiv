// Content for /features and /features/:slug. Every bullet describes something that exists in this codebase;
// "limits" lists what is partial today, so the pages stay honest. Keep in sync when features change.

export interface FeatureArea {
  slug: string;
  icon: string;
  title: string;
  tagline: string;
  intro: string;
  groups: Array<{ h: string; items: string[] }>;
  limits?: string[];
  docs?: { label: string; href: string };
}

export const FEATURE_AREAS: FeatureArea[] = [
  {
    slug: 'editor',
    icon: 'pen',
    title: 'Editor',
    tagline: 'Write once. It lands right in the inbox and on the web.',
    intro: 'A block editor where what you see is what readers get. One draft becomes table-based, inline-styled email HTML for every inbox, Outlook included, and a fast page on your website.',
    groups: [
      { h: 'Writing', items: [
        'Type / to insert any block: headings, lists, quotes, images, galleries, buttons, tables, columns, sections, code, HTML, embeds',
        'Markdown shortcuts (#, -, 1., >, ```) and keyboard shortcuts for links, code, lists and duplicating blocks',
        'Paste from Google Docs with bold, italics, headings, lists and tables kept',
        'Search and replace across the post',
        'Footnotes and citations that work in the inbox and on the web',
        'Table of contents with anchor links',
        'Autosave every few seconds, plus version history',
      ] },
      { h: 'Email that holds up', items: [
        'Table-based, inline-styled HTML with Outlook (MSO) fallbacks',
        'Buttons built from table cells, and links never wrapped around tables, so they click in Outlook',
        'Video, audio and iframes become links or cards in email and stay playable on the web',
        'Vertical alignment in columns',
        'A live size gauge that warns before Gmail clips at 102 KB',
        'Custom HTML blocks are cleaned: scripts, forms and unsafe frames are removed',
      ] },
      { h: 'One draft, many readers', items: [
        'Free and premium versions split by a paywall break',
        'Dynamic sections shown or hidden per tier, segment, tag or random cohort, all in one send',
        'Merge tags like {{subscriber.first_name|there}} and custom fields, with a preview as any real or simulated subscriber',
        'Subject line A/B tests that send the winner by opens or clicks',
        'Random cohort sends to test different content',
      ] },
      { h: 'Blocks for growth and money', items: [
        'Polls readers answer with one click in the inbox, and trivia with a leaderboard',
        'Referral progress, recommendations, ad slots and programmatic ads',
        'Products, events and podcast episodes as blocks',
        'Embeds for YouTube, X, TikTok, Instagram, Spotify, Apple Podcasts, Vimeo and Loom',
        'File attachments, inline audio, image captions with rich text, alt text and titles',
      ] },
      { h: 'Teamwork and AI', items: [
        'Real-time co-editing with presence, plus comment threads on the draft',
        'AI writer, rewrite, translate and fix grammar, and AI images (Cloudflare Workers AI)',
        'An AI assistant one shortcut away (⌘J)',
        'Audio version of any post with text-to-speech',
      ] },
    ],
    limits: [
      'Co-editing merges per block: two people typing in the same paragraph overwrite each other.',
      'AI features need the Workers AI binding switched on in your config.',
      'Section background images don\'t show in Outlook.',
      'Bluesky and Stocktwits embeds are unreliable.',
    ],
  },
  {
    slug: 'sending',
    icon: 'shield',
    title: 'Sending and deliverability',
    tagline: 'The plumbing that keeps you out of spam, already built.',
    intro: 'OpenHive sends through Cloudflare Email Sending on your own domain, with the protections a newsletter needs switched on from day one. Watch the live numbers on the deliverability page.',
    groups: [
      { h: 'Clean lists', items: [
        'Every signup checked: syntax, disposable inboxes, typo\'d domains (gmial.com) and, on forms, a mail server lookup',
        'Imports skip bad addresses and say why for each row',
        'Bot signups stopped with honeypots, timing checks, rate limits and optional Cloudflare Turnstile',
        'An acquisition source and UTM tags on every subscriber',
      ] },
      { h: 'Suppression and bounces', items: [
        'Three suppression layers: global, per publication and transactional',
        'Temporary suppressions that expire (mailbox full 3 days, DNS failure 7 days) and permanent ones for hard bounces and complaints',
        'Every bounce classified as hard, soft, mailbox full, DNS or policy',
        'Deferred mail retried for 26 hours before it counts as a bounce',
        'Feedback-loop (ARF) and bounce webhooks that feed the suppression lists',
      ] },
      { h: 'Inbox rules', items: [
        'One-click unsubscribe (RFC 8058), as Gmail and Yahoo require',
        'A Feedback-ID header on every email so Gmail reports complaints per newsletter',
        'SPF, DKIM and DMARC records generated for your domain, with live DNS checks',
        'Several sender addresses per publication (newsletter, welcome, receipts)',
      ] },
      { h: 'Reputation', items: [
        'New sending domains warm up: 200 a day, doubling daily, uncapped from day 13',
        'Domain blocklists checked every 6 hours; a listed domain pauses sending and alerts admins',
        'Bot clicks and machine opens filtered out of every report',
        'Sends 10 emails at a time, about 1,200 a minute by default (configurable)',
      ] },
    ],
    limits: [
      'Cloudflare manages the sending IPs, so warm-up and blocklist checks cover your domains, not IPs.',
      'Bounce and complaint reports need to be forwarded to the webhook from your mail setup.',
      'Built for newsletters up to the hundreds of thousands, not millions per minute.',
    ],
    docs: { label: 'Deliverability guide', href: '/docs/deliverability' },
  },
  {
    slug: 'automations',
    icon: 'bolt',
    title: 'Automations',
    tagline: 'Welcome sequences and journeys, drawn on a canvas.',
    intro: 'A visual builder for emails that go out on their own: welcome series, onboarding, win-backs and purchase follow-ups. No code.',
    groups: [
      { h: 'Triggers', items: [
        'Signup, with filters for source and source detail',
        'Tag added or removed, field changed, list joined, upgraded to a tier',
        'Purchase, event registration, survey submitted, poll voted',
        'Opened or clicked an email, went inactive, entered a segment, a date field arrives',
        'Enrolled by hand, from a segment or through the API',
      ] },
      { h: 'Steps', items: [
        'Emails written in the same editor as your newsletter',
        'Delays, wait-until a date or time, wait-for a condition with a timeout',
        'Branches on any subscriber condition, and A/B splits',
        'Webhook steps that call your systems, signed, retried up to 5 times',
        'Tag, field, list and tier actions',
      ] },
      { h: 'Safe changes', items: [
        'Edit a draft while the live version keeps running, then compare draft vs live before publishing',
        'In-flight readers move to the matching step when you publish',
        'Reorder steps in bulk',
      ] },
      { h: 'Results', items: [
        'Per-subscriber journey: every step, when it ran and what happened',
        'Opens and clicks for every email in every flow',
        'Segments can filter on whether an automation started, finished or is active',
      ] },
    ],
  },
  {
    slug: 'audience',
    icon: 'users',
    title: 'Audience and segments',
    tagline: 'Know where every reader came from and what they care about.',
    intro: 'Subscribers with tags, custom fields, lists, engagement history and a source on every one. Segments that update themselves.',
    groups: [
      { h: 'Subscribers', items: [
        'A page per subscriber: every email they got, opens, clicks, purchases, tags and fields',
        'Tags, custom fields and several newsletter lists per publication',
        'CSV import with column mapping, tags and fields; export any time',
        'Readers pick which lists they join',
      ] },
      { h: 'Segments', items: [
        'Rules on behavior, attributes and engagement, nested with and/or',
        'Dynamic segments that recalculate hourly and before each send, or static ones that stay fixed',
        'Filter by source (including magic links), UTM, tags, fields, tier, trial status, automations, purchases, polls and surveys',
        'Reusable condition sets shared by segments and automations',
        'Build a segment by describing it in plain English (AI)',
        'Send to a segment, exclude one, or add a whole segment to a list',
      ] },
      { h: 'Surveys and polls', items: [
        'Surveys with 8 question types, including NPS and rating',
        'Polls readers answer with one click right in the email',
        'Every answer tied to a subscriber; turn answers into segments',
        'Results per question, across all surveys, and response by response',
        'A survey step right after signup',
      ] },
    ],
  },
  {
    slug: 'website',
    icon: 'globe',
    title: 'Website',
    tagline: 'A fast site for your newsletter, on your own domain.',
    intro: 'Every publication gets a website with its archive, pages and signup forms, built without code and served from Cloudflare\'s edge.',
    groups: [
      { h: 'Builder', items: [
        'Drag-and-drop page sections, with HTML access when you want it',
        'Site-wide theme: fonts, colors, corners, shadows and custom CSS',
        'Navbar, footer, signup and login modals, pop-ups (delay, scroll, exit intent)',
        'Image carousels and grids, and a YouTube block that shows your latest videos',
        'Save sections and pages as templates; version history with one-click restore',
        'An AI builder that starts a page from a prompt or a screenshot',
      ] },
      { h: 'Publishing and SEO', items: [
        'Custom domains with automatic HTTPS',
        'Custom pages with their own SEO settings and paywalls',
        'Redirects (with CSV import), custom robots.txt, sitemaps and a Google News sitemap',
        'Meta titles and descriptions filled in automatically',
        'NewsArticle schema on posts',
        'Choose which AI crawlers may read your site',
      ] },
      { h: 'Gating', items: [
        'Posts for subscribers only, premium only, or a metered paywall (a few free reads a month)',
        'A page for every author, tag and podcast episode',
      ] },
    ],
  },
  {
    slug: 'subscriptions',
    icon: 'dollar',
    title: 'Paid subscriptions',
    tagline: 'Charge for your newsletter. Keep 100% of it.',
    intro: 'Paid tiers through your own Stripe account. OpenHive takes no cut: 0% platform fees.',
    groups: [
      { h: 'Plans', items: [
        'Several paid tiers, each with monthly and annual prices',
        'Free trials and paid trials, like $1 for 30 days',
        'Discount offers, gift subscriptions and group subscriptions with seats',
        'Custom group deals for teams and companies',
        'Readers pause, resume and cancel on their own',
      ] },
      { h: 'Perks', items: [
        'Premium posts, with a paywall break inside any post',
        'Private podcast feeds per subscriber',
        'Paid community channels',
      ] },
      { h: 'Payments', items: [
        'Stripe Checkout, coupons and signed webhooks',
        'Stripe Connect: money goes straight to the creator\'s account',
        'Test mode without Stripe keys, so every flow can be tried end to end',
      ] },
    ],
  },
  {
    slug: 'products',
    icon: 'shop',
    title: 'Digital products',
    tagline: 'Sell files, guides and coaching from your newsletter.',
    intro: 'A storefront on your site and product blocks for your emails and automations.',
    groups: [
      { h: 'What you can sell', items: [
        'Files, links, guides, templates and ebooks',
        'Memberships and time-limited access',
        '1:1 coaching with bookable slots and calendar invites',
        'Free products that work as lead magnets',
      ] },
      { h: 'Selling', items: [
        'Variants, tags, discount and promo codes',
        'Reviews with moderation, and a review request after purchase',
        'Products sold inside emails and automations',
        'Automatic delivery the moment someone buys, and purchase-triggered follow-ups',
        'Orders dashboard with buyer details, totals per product and CSV export',
        'Duplicate a product in one click',
      ] },
    ],
  },
  {
    slug: 'events',
    icon: 'calendar',
    title: 'Webinars and events',
    tagline: 'Host live sessions without Zoom.',
    intro: 'Live streaming with chat, ticketing and reminders, inside your newsletter platform.',
    groups: [
      { h: 'Live', items: [
        'Native streaming with camera, microphone, screen sharing and chat',
        'Capacity up to 10,000 attendees',
        'Recordings uploaded to your storage, and replays sold as their own product',
      ] },
      { h: 'Tickets', items: [
        'Free and paid events, tickets in 10 currencies, discount codes',
        '1:1 coaching bookings with clash checks',
        'Every buyer linked to their subscriber profile; free events grow your list',
      ] },
      { h: 'Around the event', items: [
        'Up to 5 automatic reminder emails',
        'Calendar invites (.ics) and Google Calendar links',
        'Event blocks for your newsletter and an events page on your site',
        'Orders and revenue per event; Luma import',
      ] },
    ],
    limits: [
      'Large audiences need Cloudflare Realtime (SFU) credentials; without them the host\'s browser streams to everyone.',
      'Recording starts when the host clicks Record and runs in the host\'s browser.',
    ],
  },
  {
    slug: 'podcasts',
    icon: 'mic',
    title: 'Podcasts',
    tagline: 'Host your show next to your newsletter.',
    intro: 'Audio hosting, RSS feeds for every directory, private feeds for paying members, and analytics.',
    groups: [
      { h: 'Hosting', items: [
        'Episodes stored in your Cloudflare R2, zero platform fees',
        'RSS with Apple Podcasts tags and categories, for Apple, Spotify and YouTube',
        'A page for every episode and a full library on your site',
        'Scheduled episodes, and players embedded in posts',
        'Import from another host with episode GUIDs kept, plus RSS redirects',
        'Transcripts with Whisper (Workers AI)',
      ] },
      { h: 'Members', items: [
        'Private feeds per paying subscriber, revoked when they cancel',
        'Bundle the show with a paid tier',
      ] },
      { h: 'Analytics', items: [
        'Downloads and unique listeners per episode and show',
        'Breakdowns by country, app and device; bot downloads filtered',
        'Webhooks for episode and private-feed events',
      ] },
    ],
    limits: ['Transcripts run when you click Generate, for files up to 25 MB.'],
  },
  {
    slug: 'community',
    icon: 'chat',
    title: 'Community',
    tagline: 'A place for readers to talk, built into your newsletter.',
    intro: 'Channels, posts, threaded comments and group chats, free or for paying members.',
    groups: [
      { h: 'Spaces', items: [
        'Channels that are free or gated to paid tiers, with ordering and a default channel',
        'Posts, threaded comments, pinned posts and real-time group chats',
        'Newsletter posts synced into a channel automatically',
        'Direct messages between members and the publication',
      ] },
      { h: 'Running it', items: [
        'Admin, manager and moderator roles, mapped from your team roles',
        'A moderation queue for reported posts and comments; ban and unban',
        'Invite subscribers, segments or emails, starting with your most engaged readers',
        'Metrics on members, posts and activity',
        'Notification emails with your own from name',
        'Discord role sync with subscription tiers',
      ] },
    ],
    limits: ['Members can\'t send each other private messages yet.'],
  },
  {
    slug: 'growth',
    icon: 'trend',
    title: 'Growth',
    tagline: 'Referrals, recommendations and one-click subscribe links.',
    intro: 'The tools that turn readers into more readers.',
    groups: [
      { h: 'Referrals', items: [
        'A referral program with milestones and rewards',
        'Referral blocks in every email with each reader\'s progress',
      ] },
      { h: 'Recommendations and boosts', items: [
        'Recommend other newsletters on the same install, reciprocal with one click',
        'Paid boosts: pay per verified subscriber, or earn by recommending',
        'AI-suggested partners, applications with accept and reject',
        'Fraud checks, a 7-day hold and clawbacks for fake subscribers',
      ] },
      { h: 'Magic links', items: [
        'One-click subscribe links for other newsletters, socials and ads',
        'UTM tags carried through, rate limits, honeypots, and a confirm step only when a click looks like a bot',
        'Double opt-in respected; redirect new readers to your site',
      ] },
      { h: 'Forms and link in bio', items: [
        'Embeddable forms (full width, fixed or slim) for WordPress, Webflow or any site, with a draft and publish flow',
        'An attribution script that records where signups come from',
        'A link-in-bio page on your own domain with a built-in signup form',
      ] },
    ],
    limits: ['The recommendation network covers the publications on your own install.'],
  },
  {
    slug: 'ads',
    icon: 'chart',
    title: 'Ads and sponsorships',
    tagline: 'Sell your own sponsorships and run an ad marketplace.',
    intro: 'Direct sponsorships with your own formats and prices, plus an ad marketplace for the publications on your install.',
    groups: [
      { h: 'Sponsorships', items: [
        'Sponsorship products with your own formats and pricing, and a page where brands book them',
        'Scheduled placements with advertiser details and creative review',
        'Payouts to a wallet, through Stripe Connect transfers',
      ] },
      { h: 'Ad marketplace', items: [
        'Advertisers and campaigns with brand-safety review',
        'Ad opportunities to claim for upcoming posts, dropped in with one click',
        'Earnings per placement and per post, and a history of accepted and declined offers',
        'Bot clicks filtered and never paid; custom link parameters for attribution',
        'Programmatic ad slots that fill automatically',
      ] },
    ],
    limits: ['Advertisers are the ones you or your install\'s admins add; there is no outside ad network.'],
  },
  {
    slug: 'analytics',
    icon: 'chart',
    title: 'Analytics',
    tagline: 'Website, newsletter, revenue and podcast numbers in one place.',
    intro: 'Real-time analytics with no third-party scripts, and every report filtered for bots.',
    groups: [
      { h: 'Reports', items: [
        'Real-time visitors, traffic by channel, page and referrer',
        'Filters for country, device, OS and referrer, and custom conditions on any report',
        'A 3D explorer to pivot any two dimensions over time',
        'Website traffic connected to the subscribers it produced',
        'Per-post opens, clicks, top links and a breakdown by mailbox provider',
      ] },
      { h: 'Bots and crawlers', items: [
        'AI crawler and bot analytics: what was served and what was blocked',
        'Bot opens and clicks filtered out everywhere',
      ] },
      { h: 'Tracking', items: [
        'UTM tags on every link and publication-wide link parameters',
        'Google Analytics 4 if you want it',
      ] },
    ],
  },
  {
    slug: 'developers',
    icon: 'code',
    title: 'API, MCP and webhooks',
    tagline: 'Let your code, and your AI agent, run your newsletter.',
    intro: 'A REST API, an MCP server for Claude, ChatGPT and other AI tools, and signed webhooks.',
    groups: [
      { h: 'REST API', items: [
        'Subscribers, custom fields, tags, posts, segments, automations, tiers, referrals, polls and surveys',
        'A send API: create a post from Markdown or a template, then send or schedule it',
        'Post HTML rendered free vs premium and email vs web',
        'Cursor pagination for millions of rows, 180 requests a minute per key',
        'API keys you create and revoke any time',
      ] },
      { h: 'MCP server', items: [
        'Draft and edit posts, set up subject A/B tests',
        'Ask for opens, clicks and revenue in plain English, compare posts',
        'Look up a subscriber\'s history, build segments by describing them',
        'Create and edit automations, generate AI images into the media library',
        'Manage website pages, redirects and SEO; community posts and DMs; ads; podcasts; products and coupons',
        'Deliverability by mailbox provider, and docs search',
      ] },
      { h: 'Webhooks', items: [
        'Subscriber, tier, list, post, survey, podcast, order and referral events',
        'Pick events per endpoint, HMAC signing secret, retries for about 2 days',
        'A delivery log, manual retry, and endpoints you can switch off',
      ] },
    ],
    docs: { label: 'API reference', href: '/docs/api' },
  },
  {
    slug: 'team',
    icon: 'users',
    title: 'Team and publications',
    tagline: 'Run many newsletters with the right people on each.',
    intro: 'Workspaces with several publications, roles at the workspace or publication level, and authors with profiles.',
    groups: [
      { h: 'Roles', items: [
        'Admin: billing, exports, integrations, payments and domains',
        'Member: everything except admin settings',
        'Contributor: drafts posts and automations only',
        'Roles per workspace or per publication; access removed the moment someone leaves',
      ] },
      { h: 'Authors', items: [
        'Multiple authors per post with bylines',
        'Guest authors for one-off contributors',
        'Author pages with bio, avatar and social links',
      ] },
      { h: 'Accounts', items: [
        'Invite teammates by email',
        'Magic-link login, and log in on desktop by approving from your phone',
        'Publication transfers between owners, with written consent',
      ] },
    ],
  },
];

export const featureBySlug = (slug: string) => FEATURE_AREAS.find((f) => f.slug === slug);
