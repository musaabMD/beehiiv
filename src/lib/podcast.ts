// Podcast helpers: Apple categories, RSS feed builder, RSS import parser, listener app detection.
import { stripTags } from './util';

export const APPLE_CATEGORIES: Record<string, string[]> = {
  Arts: ['Books', 'Design', 'Fashion & Beauty', 'Food', 'Performing Arts', 'Visual Arts'],
  Business: ['Careers', 'Entrepreneurship', 'Investing', 'Management', 'Marketing', 'Non-Profit'],
  Comedy: ['Comedy Interviews', 'Improv', 'Stand-Up'],
  Education: ['Courses', 'How To', 'Language Learning', 'Self-Improvement'],
  Fiction: ['Comedy Fiction', 'Drama', 'Science Fiction'],
  Government: [],
  History: [],
  'Health & Fitness': ['Alternative Health', 'Fitness', 'Medicine', 'Mental Health', 'Nutrition', 'Sexuality'],
  'Kids & Family': ['Education for Kids', 'Parenting', 'Pets & Animals', 'Stories for Kids'],
  Leisure: ['Animation & Manga', 'Automotive', 'Aviation', 'Crafts', 'Games', 'Hobbies', 'Home & Garden', 'Video Games'],
  Music: ['Music Commentary', 'Music History', 'Music Interviews'],
  News: ['Business News', 'Daily News', 'Entertainment News', 'News Commentary', 'Politics', 'Sports News', 'Tech News'],
  'Religion & Spirituality': ['Buddhism', 'Christianity', 'Hinduism', 'Islam', 'Judaism', 'Religion', 'Spirituality'],
  Science: ['Astronomy', 'Chemistry', 'Earth Sciences', 'Life Sciences', 'Mathematics', 'Natural Sciences', 'Nature', 'Physics', 'Social Sciences'],
  'Society & Culture': ['Documentary', 'Personal Journals', 'Philosophy', 'Places & Travel', 'Relationships'],
  Sports: ['Baseball', 'Basketball', 'Cricket', 'Fantasy Sports', 'Football', 'Golf', 'Hockey', 'Rugby', 'Running', 'Soccer', 'Swimming', 'Tennis', 'Volleyball', 'Wilderness', 'Wrestling'],
  Technology: [],
  'True Crime': [],
  'TV & Film': ['After Shows', 'Film History', 'Film Interviews', 'Film Reviews', 'TV Reviews'],
};

export const LANGUAGES: Array<[string, string]> = [
  ['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['pt', 'Portuguese'], ['it', 'Italian'], ['nl', 'Dutch'], ['ar', 'Arabic'],
  ['hi', 'Hindi'], ['ja', 'Japanese'], ['ko', 'Korean'], ['zh', 'Chinese'], ['ru', 'Russian'], ['tr', 'Turkish'], ['pl', 'Polish'], ['sv', 'Swedish'],
];

export function x(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
export function cdata(s: string): string {
  return `<![CDATA[${String(s || '').replace(/\]\]>/g, ']]]]><![CDATA[>')}]]>`;
}

export function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

export function parseDuration(v: string | null | undefined): number {
  if (!v) return 0;
  const t = v.trim();
  if (/^\d+$/.test(t)) return Number(t);
  const parts = t.split(':').map(Number);
  if (parts.some(isNaN)) return 0;
  return parts.reduce((a, p) => a * 60 + p, 0);
}

export interface FeedShow {
  title: string; description: string; author: string; owner_email: string | null; cover_url: string | null; language: string; category: string;
  subcategory: string | null; explicit: number; kind: string; copyright: string | null; redirect_url: string | null; link: string; selfUrl: string; guid: string;
}
export interface FeedEpisode {
  guid: string; title: string; description: string; enclosure: string; mime: string; size: number; duration: number; season: number | null; number: number | null;
  episode_type: string; explicit: number; image: string | null; published_at: number; link: string; transcriptUrl: string | null;
}

export function buildFeed(show: FeedShow, eps: FeedEpisode[], opts: { privateFeed?: boolean } = {}): string {
  const cat = show.subcategory
    ? `<itunes:category text="${x(show.category)}"><itunes:category text="${x(show.subcategory)}"/></itunes:category>`
    : `<itunes:category text="${x(show.category)}"/>`;
  const items = eps.map((e) => `
    <item>
      <title>${x(e.title)}</title>
      <link>${x(e.link)}</link>
      <description>${cdata(e.description)}</description>
      <content:encoded>${cdata(e.description)}</content:encoded>
      <itunes:summary>${x(stripTags(e.description).slice(0, 3900))}</itunes:summary>
      <guid isPermaLink="false">${x(e.guid)}</guid>
      <pubDate>${new Date(e.published_at).toUTCString()}</pubDate>
      <enclosure url="${x(e.enclosure)}" length="${e.size || 0}" type="${x(e.mime || 'audio/mpeg')}"/>
      <itunes:duration>${Math.round(e.duration || 0)}</itunes:duration>
      <itunes:episodeType>${x(e.episode_type || 'full')}</itunes:episodeType>${e.season ? `\n      <itunes:season>${e.season}</itunes:season>` : ''}${e.number ? `\n      <itunes:episode>${e.number}</itunes:episode>` : ''}
      <itunes:explicit>${e.explicit ? 'true' : 'false'}</itunes:explicit>${e.image ? `\n      <itunes:image href="${x(e.image)}"/>` : ''}${e.transcriptUrl ? `\n      <podcast:transcript url="${x(e.transcriptUrl)}" type="text/plain"/>` : ''}
    </item>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:podcast="https://podcastindex.org/namespace/1.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${x(show.title)}${opts.privateFeed ? ' (Premium)' : ''}</title>
    <link>${x(show.link)}</link>
    <atom:link href="${x(show.selfUrl)}" rel="self" type="application/rss+xml"/>
    <language>${x(show.language || 'en')}</language>
    <description>${cdata(show.description)}</description>
    <itunes:summary>${x(stripTags(show.description).slice(0, 3900))}</itunes:summary>
    <itunes:author>${x(show.author)}</itunes:author>
    <itunes:type>${show.kind === 'serial' ? 'serial' : 'episodic'}</itunes:type>
    <itunes:owner><itunes:name>${x(show.author)}</itunes:name>${show.owner_email ? `<itunes:email>${x(show.owner_email)}</itunes:email>` : ''}</itunes:owner>${show.cover_url ? `\n    <itunes:image href="${x(show.cover_url)}"/>\n    <image><url>${x(show.cover_url)}</url><title>${x(show.title)}</title><link>${x(show.link)}</link></image>` : ''}
    ${cat}
    <itunes:explicit>${show.explicit ? 'true' : 'false'}</itunes:explicit>${show.copyright ? `\n    <copyright>${x(show.copyright)}</copyright>` : ''}${show.redirect_url ? `\n    <itunes:new-feed-url>${x(show.redirect_url)}</itunes:new-feed-url>` : ''}
    <podcast:guid>${x(show.guid)}</podcast:guid>
    <podcast:locked>${opts.privateFeed ? 'yes' : 'no'}</podcast:locked>${opts.privateFeed ? '\n    <itunes:block>Yes</itunes:block>' : ''}
    <generator>OpenHive</generator>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>${items}
  </channel>
</rss>`;
}

// ───────── RSS import ─────────
function decode(s: string): string {
  const m = s.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  if (m) return m[1].trim();
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&').trim();
}
function reEsc(s: string) { return s.replace(/[:.]/g, (c) => '\\' + c); }
export function tagText(xml: string, name: string): string {
  const m = xml.match(new RegExp(`<${reEsc(name)}(?:\\s[^>]*)?>([\\s\\S]*?)</${reEsc(name)}>`, 'i'));
  return m ? decode(m[1]) : '';
}
export function tagAttr(xml: string, name: string, attr: string): string {
  const m = xml.match(new RegExp(`<${reEsc(name)}\\s[^>]*?${attr}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  return m ? decode(m[2] ?? m[3] ?? '') : '';
}

export interface ParsedFeed {
  title: string; description: string; author: string; owner_email: string; cover_url: string; language: string; category: string; subcategory: string;
  explicit: boolean; kind: string; copyright: string; link: string;
  items: Array<{ guid: string; title: string; description: string; audio_url: string; mime: string; size: number; duration: number; season: number | null; number: number | null; episode_type: string; explicit: boolean; image: string; published_at: number }>;
}

export function parseFeed(xml: string): ParsedFeed {
  const chanEnd = xml.search(/<item[\s>]/i);
  const head = chanEnd > 0 ? xml.slice(0, chanEnd) : xml;
  const cats = [...head.matchAll(/<itunes:category\s+text="([^"]*)"/gi)].map((m) => decode(m[1]));
  const items = (xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || []).map((it) => {
    const pub = Date.parse(tagText(it, 'pubDate'));
    return {
      guid: tagText(it, 'guid') || tagAttr(it, 'enclosure', 'url'),
      title: tagText(it, 'title') || 'Untitled episode',
      description: tagText(it, 'content:encoded') || tagText(it, 'description') || tagText(it, 'itunes:summary'),
      audio_url: tagAttr(it, 'enclosure', 'url'),
      mime: tagAttr(it, 'enclosure', 'type') || 'audio/mpeg',
      size: Number(tagAttr(it, 'enclosure', 'length')) || 0,
      duration: parseDuration(tagText(it, 'itunes:duration')),
      season: Number(tagText(it, 'itunes:season')) || null,
      number: Number(tagText(it, 'itunes:episode')) || null,
      episode_type: tagText(it, 'itunes:episodeType') || 'full',
      explicit: /^(yes|true|explicit)$/i.test(tagText(it, 'itunes:explicit')),
      image: tagAttr(it, 'itunes:image', 'href'),
      published_at: isNaN(pub) ? Date.now() : pub,
    };
  });
  return {
    title: tagText(head, 'title') || 'Imported podcast',
    description: tagText(head, 'description') || tagText(head, 'itunes:summary'),
    author: tagText(head, 'itunes:author'),
    owner_email: tagText(head, 'itunes:email'),
    cover_url: tagAttr(head, 'itunes:image', 'href') || tagText(tagText(head, 'image') ? head.match(/<image>[\s\S]*?<\/image>/i)?.[0] || '' : '', 'url'),
    language: (tagText(head, 'language') || 'en').slice(0, 2).toLowerCase(),
    category: cats[0] && APPLE_CATEGORIES[cats[0]] ? cats[0] : 'Technology',
    subcategory: cats[1] && APPLE_CATEGORIES[cats[0]]?.includes(cats[1]) ? cats[1] : '',
    explicit: /^(yes|true|explicit)$/i.test(tagText(head, 'itunes:explicit')),
    kind: tagText(head, 'itunes:type') === 'serial' ? 'serial' : 'episodic',
    copyright: tagText(head, 'copyright'),
    link: tagText(head, 'link'),
    items,
  };
}

// ───────── listener detection (IAB-style) ─────────
const APPS: Array<[RegExp, string]> = [
  [/Spotify/i, 'Spotify'], [/Overcast/i, 'Overcast'], [/Pocket ?Casts/i, 'Pocket Casts'], [/Castro/i, 'Castro'], [/CastBox/i, 'Castbox'],
  [/PodcastAddict/i, 'Podcast Addict'], [/Player ?FM/i, 'Player FM'], [/Podcast ?Republic/i, 'Podcast Republic'], [/AntennaPod/i, 'AntennaPod'],
  [/Podverse/i, 'Podverse'], [/Fountain/i, 'Fountain'], [/Deezer/i, 'Deezer'], [/iHeartRadio/i, 'iHeartRadio'], [/Amazon Music|AmazonMusic|Alexa|Echo/i, 'Amazon Music'],
  [/YouTube/i, 'YouTube Music'], [/Google-Podcast|GSA\//i, 'Google'], [/Podcasts\/\d|iTunes|AppleCoreMedia|Apple ?Podcasts|^Podcasts/i, 'Apple Podcasts'],
  [/Downcast/i, 'Downcast'], [/Stitcher/i, 'Stitcher'], [/Podbean/i, 'Podbean'], [/Audible/i, 'Audible'],
  [/Mozilla|Chrome|Safari|Firefox|Edg\//i, 'Web browser'],
];
export function detectApp(ua: string | null | undefined): string {
  if (!ua) return 'Unknown';
  for (const [re, name] of APPS) if (re.test(ua)) return name;
  return 'Other';
}
export function detectDevice(ua: string | null | undefined): string {
  const u = ua || '';
  if (/watch/i.test(u)) return 'Watch';
  if (/Alexa|Echo|HomePod|Sonos|Google-Home|CrKey/i.test(u)) return 'Smart speaker';
  if (/iPad|Tablet/i.test(u)) return 'Tablet';
  if (/iPhone|Android|Mobile|iOS/i.test(u)) return 'Mobile';
  if (/CarPlay|Android Auto/i.test(u)) return 'Car';
  if (/Windows|Macintosh|Mac OS X|Linux|X11/i.test(u)) return 'Desktop';
  return 'Other';
}
