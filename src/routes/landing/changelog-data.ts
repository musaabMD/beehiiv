// Product changelog for /changelog, newest first. Add an entry for every user-visible change.
export interface ChangelogEntry { date: string; slug: string; title: string; body: string[]; links?: Array<[string, string]> }

export const CHANGELOG: ChangelogEntry[] = [
  {
    date: '2026-10-26', slug: 'try-it', title: 'Get a real sample issue in your inbox',
    body: [
      'On the demo, type your email on the Try it page and get the latest issue for real, then watch it on a live status page as it\'s sent, opened and clicked. It scores 10/10 on mail-tester.com, with SPF, DKIM and DMARC all passing.',
      'The Deliverability page now counts only real emails, so these samples are its data.',
    ],
    links: [['Try it', '/try'], ['Deliverability', '/open']],
  },
  {
    date: '2026-10-26', slug: 'accurate-numbers', title: 'More accurate opens and clicks',
    body: [
      'Security scanners that open and click every link are now filtered: very old browser versions, clicks from cloud data centers, and an open and click arriving together. A real test showed one scanner counted as a reader before; now it isn\'t.',
      'A post\'s numbers are the same everywhere: the post page, lists, the API and AI tools. Delivered means accepted by the mailbox provider, unsubscribes count readers who left within 7 days, and test and sample sends are left out.',
      'Emails hide their preview text in a way spam filters don\'t flag.',
    ],
  },
  {
    date: '2026-10-26', slug: 'co-editing-merge', title: 'Co-editing merges edits in the same paragraph',
    body: ['Two people typing in the same paragraph no longer overwrite each other: both edits merge as you type, and your cursor stays where it was.'],
  },
  {
    date: '2026-10-26', slug: 'speed-images-webinars', title: 'Faster pages, smaller images, bigger webinars',
    body: [
      'Publication pages are cached at Cloudflare\'s edge for readers who aren\'t logged in, load their styles inline and fonts without blocking, and run their database reads together. Analytics → Website now shows real visitors\' page speed.',
      'Images added by URL or pasted are resized to 1,600px WebP on the server: a 14.7 MB photo becomes 189 KB. Webinars stream through Cloudflare Realtime for large audiences.',
    ],
  },
  {
    date: '2026-10-25', slug: 'bounces-in-app', title: 'Bounces and complaints come straight back',
    body: [
      'OpenHive now receives bounce and spam-complaint reports itself, through Cloudflare Email Routing and Cloudflare\'s sending events, and turns them into suppressions. Settings → Email shows every report it received. Reports only count for addresses this install actually emailed, so nobody can be suppressed by a forged report.',
      'Bounces and complaints on account email (login links, receipts) now fill the transactional suppression list on their own, and a reader who complained about a newsletter still gets their login link. The default sending domain now warms up like custom domains.',
      'Fixed: emails set a Feedback-ID header that Cloudflare doesn\'t allow, which could make real sends fail. OpenHive now uses its own tracking header.',
    ],
    links: [['Deliverability guide', '/docs/deliverability']],
  },
  {
    date: '2026-10-25', slug: 'templates-library', title: '31 designed templates, linked styles and website page templates',
    body: [
      'The template library now has 31 designs: weekly briefs, digests, essays, interviews, sponsor issues, podcast notes, sales, tutorials, welcome and automation emails, with previews and categories.',
      'Posts keep a live link to their template\'s style, so changing a template\'s colors or fonts updates the posts made from it, including posts created through the API. Welcome and automation emails can start from a template.',
      'The website builder has 10 built-in page templates (About, Start here, Advertise, Podcast, Events, Link in bio and more) and can save a single section as a reusable block.',
    ],
    links: [['Templates', '/features/templates']],
  },
  {
    date: '2026-10-25', slug: 'editor-upgrades', title: 'Email-only and web-only blocks, and a sharper editor',
    body: [
      'Any block can now show in email only or on the web only, so one draft makes two versions. Bluesky posts embed properly, Stocktwits messages show as cards, and section background images now show in Outlook.',
      'AI rewrite, translate and fix keep your bold, links and footnotes. The size gauge measures the email exactly as it will be sent. Search and replace reaches buttons, captions, alt text and tables. Pasting from Google Docs keeps headings, and its images are copied into your media library before Google\'s links expire. Gallery captions take bold, italics and links.',
    ],
    links: [['Editor', '/features/editor']],
  },
  {
    date: '2026-10-25', slug: 'community-dms', title: 'Members can message each other',
    body: [
      'Community members can send each other direct messages in real time, with an inbox and unread counts. Members can block someone, report a message to the moderation queue, or turn DMs off. Members link Discord with Discord login, and upcoming Luma events show in the community.',
    ],
    links: [['Community', '/features/community']],
  },
  {
    date: '2026-10-25', slug: 'auto-transcripts-recordings', title: 'Automatic transcripts and recordings',
    body: [
      'Every podcast episode is transcribed automatically after upload, long episodes in pieces, with captions published in the feed. Webinars record automatically when you go live and upload every few seconds, so closing the tab loses nothing.',
    ],
  },
  {
    date: '2026-10-25', slug: 'reader-phone-login', title: 'Readers can log in with their phone',
    body: ['On a publication\'s site, readers can log in on a computer by scanning a code and approving on their phone.'],
  },
  {
    date: '2026-10-25', slug: 'api-webhooks', title: 'Webhook versions, REST automations and more MCP tools',
    body: [
      'Webhook endpoints stay on the payload version they were created with until you upgrade them, and every delivery attempt is kept in the log. The REST API can now create, edit, publish, pause and resume automations, and create polls and surveys. AI agents can manage podcast shows and episodes, products and promo codes over MCP. Survey results update live.',
    ],
    links: [['REST API', '/docs/api'], ['MCP tools', '/docs/mcp-tools']],
  },
  {
    date: '2026-10-25', slug: 'ai-on', title: 'AI features switched on',
    body: ['The AI writer, AI images, text-to-speech audio versions, transcripts and the ⌘J assistant now run on Cloudflare Workers AI out of the box.'],
  },
  {
    date: '2026-10-25', slug: 'redesign', title: 'A lighter site, with every feature listed',
    body: ['The site has a new light design. Every feature page lists each capability one by one with its real status, next to a screenshot of the real app.'],
    links: [['All features', '/features']],
  },
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
