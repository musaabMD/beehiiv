// Product changelog for /changelog, newest first. Add an entry for every user-visible change.
export interface ChangelogEntry { date: string; slug: string; title: string; body: string[]; links?: Array<[string, string]> }

export const CHANGELOG: ChangelogEntry[] = [
  {
    date: '2026-10-25', slug: 'deliverability-page', title: 'A public deliverability page',
    body: [
      'The new Deliverability page shows this install\'s own numbers for the last 30 days: delivery rate, hard bounces, spam complaints, and the median open and click rate, with a week-by-week track record.',
      'It also counts the bad addresses stopped at signup and import (typos, dead domains, throwaway inboxes, invalid addresses), and explains exactly how each number is counted. An install that only simulates sending says so at the top.',
    ],
    links: [['See the numbers', '/open']],
  },
  {
    date: '2026-10-25', slug: 'compare', title: 'Compare pages and migration guides',
    body: [
      'Compare shows what a list costs each month on the main newsletter platforms at five list sizes, next to OpenHive\'s one-time price and Cloudflare bill. Each platform has its own page with a feature table and what it does that OpenHive doesn\'t.',
      'Migration guides walk through exporting your list from each platform and importing it here, so unsubscribed and bounced readers stay out.',
    ],
    links: [['Compare', '/compare']],
  },
  {
    date: '2026-10-25', slug: 'feature-pages', title: 'A page for every feature',
    body: ['Features now has a page per area (editor, sending, automations, audience, website, subscriptions, products, events, podcasts, community, growth, ads, analytics, developers and team), each listing what\'s built and what its limits are today.'],
    links: [['All features', '/features']],
  },
  {
    date: '2026-10-25', slug: 'faster-sending', title: 'Sending is about 20 times faster',
    body: [
      'Each send now hands 10 emails at a time to Cloudflare and keeps going between batches instead of waiting for the next minute. The default pace is 1,200 emails a minute per send, up from 50, and you can change it in Settings.',
    ],
  },
  {
    date: '2026-10-25', slug: 'safer-uploads', title: 'Safer uploads',
    body: ['Uploaded files are served so they can never run code on your site: SVG images and text files get a locked-down security policy, and browsers can\'t guess a different file type.'],
  },
  {
    date: '2026-10-25', slug: 'fixes', title: 'Fixes',
    body: [
      'Replays bought from an event page now start "Purchases a product" automations and the product\'s own follow-up.',
      'Picking community channels on a paid tier now gives that tier access to them.',
      'Ad links keep their attribution parameters when the link has a #section, and ad click links only go to the advertiser\'s own site.',
      'Spam complaint reports no longer suppress the address that sent the report.',
      'In the editor, ⌘K adds a link without also opening the command palette.',
    ],
  },
  {
    date: '2026-10-25', slug: 'ads-explorer', title: 'Programmatic ads and a 3D analytics explorer',
    body: ['An auto-ad block fills itself from matching campaigns, and the analytics explorer pivots any two dimensions over time.'],
  },
  {
    date: '2026-10-25', slug: 'rss-trivia-gifs', title: 'RSS-to-send, trivia polls and GIF search',
    body: ['Send each new item of an RSS feed, or a digest of them. Trivia polls keep a leaderboard, and the editor searches GIFs.'],
  },
  {
    date: '2026-10-25', slug: 'group-chats', title: 'Community group chats',
    body: ['Real-time chat rooms for your community, public or private, with mentions and moderation.'],
  },
  {
    date: '2026-10-25', slug: 'live-at-scale', title: 'Live events at scale',
    body: ['Webinars can stream through Cloudflare Realtime for large audiences, with a browser-to-browser mode for small ones.'],
  },
  {
    date: '2026-10-25', slug: 'launch', title: 'OpenHive 1.0',
    body: [
      'The first release: the block editor and send flow, deliverability protections, automations, audience and segments, website builder, paid subscriptions, digital products, webinars, podcasts, community, growth tools, ads and sponsorships, analytics, team roles, and the REST API, webhooks and MCP server.',
    ],
    links: [['Read the docs', '/docs']],
  },
];
