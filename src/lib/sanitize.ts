// Allowlist HTML sanitizer that also balances tags (so a stray/unclosed tag can't break a post).

const INLINE = new Set(['a', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'code', 'br', 'span', 'mark', 'sub', 'sup', 'small', 'kbd', 'abbr']);
const BLOCK = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'hr', 'img', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'figure', 'figcaption', 'section', 'article', 'header', 'footer', 'center', 'font', 'caption', 'colgroup', 'col', 'dl', 'dt', 'dd', 'details', 'summary', 'picture', 'source', 'svg', 'path', 'circle', 'rect', 'g', 'line', 'polyline', 'polygon']);
const MEDIA = new Set(['iframe', 'video', 'audio', 'track']);
const VOID = new Set(['br', 'hr', 'img', 'col', 'source', 'track', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon']);
const DROP_WITH_CONTENT = new Set(['script', 'style', 'noscript', 'template', 'object', 'embed', 'applet', 'frame', 'frameset', 'meta', 'link', 'base', 'form', 'input', 'button', 'select', 'textarea', 'title', 'head']);

const GLOBAL_ATTRS = new Set(['class', 'style', 'id', 'title', 'dir', 'lang', 'align', 'valign', 'width', 'height', 'bgcolor', 'color', 'border', 'cellpadding', 'cellspacing', 'colspan', 'rowspan', 'role', 'aria-label', 'aria-hidden']);
const TAG_ATTRS: Record<string, string[]> = {
  a: ['href', 'target', 'rel', 'name'],
  img: ['src', 'alt', 'srcset', 'sizes', 'loading'],
  iframe: ['src', 'allow', 'allowfullscreen', 'frameborder', 'scrolling', 'loading'],
  video: ['src', 'controls', 'poster', 'muted', 'loop', 'playsinline', 'preload'],
  audio: ['src', 'controls', 'preload'],
  source: ['src', 'type', 'srcset', 'media'],
  track: ['src', 'kind', 'srclang', 'label'],
  font: ['face', 'size'],
  ol: ['start', 'type'],
  td: ['scope'], th: ['scope'],
  svg: ['viewbox', 'xmlns', 'fill', 'stroke', 'stroke-width'],
  path: ['d', 'fill', 'stroke', 'stroke-width'], circle: ['cx', 'cy', 'r', 'fill'], rect: ['x', 'y', 'rx', 'fill'],
  line: ['x1', 'x2', 'y1', 'y2', 'stroke'], polyline: ['points', 'fill', 'stroke'], polygon: ['points', 'fill'], g: ['fill', 'stroke'],
  span: ['data-footnote', 'data-cite', 'data-merge'],
  details: ['open'],
};

const SAFE_URL = /^(https?:|mailto:|tel:|#|\/|data:image\/(png|jpe?g|gif|webp);base64,)/i;
const IFRAME_HOSTS = /^https:\/\/(www\.)?(youtube\.com|youtube-nocookie\.com|player\.vimeo\.com|open\.spotify\.com|w\.soundcloud\.com|www\.tiktok\.com|www\.instagram\.com|embed\.bsky\.app|platform\.twitter\.com|stocktwits\.com|api\.stocktwits\.com|www\.loom\.com|codepen\.io|docs\.google\.com|calendar\.google\.com|lu\.ma|maps\.google\.com|www\.google\.com|player\.simplecast\.com|embed\.podcasts\.apple\.com|podcasters\.spotify\.com)\//i;

export interface SanitizeOpts {
  /** allow block-level tags (custom HTML blocks, pasted docs). Inline-only otherwise. */
  blocks?: boolean;
  /** allow iframes/video/audio from trusted hosts */
  media?: boolean;
  /** allow style attributes */
  styles?: boolean;
}

function cleanStyle(s: string): string {
  return s
    .replace(/expression\s*\(|javascript:|behavior\s*:|-moz-binding|@import|url\s*\(\s*['"]?\s*javascript:/gi, '')
    .replace(/position\s*:\s*fixed/gi, 'position:static')
    .slice(0, 2000);
}

export function sanitizeHtml(input: string, opts: SanitizeOpts = {}): string {
  if (!input) return '';
  const allowed = (tag: string) => INLINE.has(tag) || (opts.blocks && BLOCK.has(tag)) || (opts.media && MEDIA.has(tag));
  const out: string[] = [];
  const stack: string[] = [];
  let dropDepth = 0;
  let dropTag = '';
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<!doctype[^>]*>|<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s>"'=\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>|([^<]+)|(<)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input))) {
    const [whole, rawTag, attrs, text, lt] = m;
    if (text !== undefined || lt !== undefined) {
      if (!dropDepth) out.push(text !== undefined ? text.replace(/>/g, '&gt;') : '&lt;');
      continue;
    }
    if (!rawTag) continue; // comment / doctype
    const tag = rawTag.toLowerCase();
    const closing = whole.startsWith('</');
    if (DROP_WITH_CONTENT.has(tag)) {
      if (VOID.has(tag) || whole.endsWith('/>') || ['meta', 'link', 'base', 'input', 'embed'].includes(tag)) continue;
      if (!closing) { if (!dropDepth) dropTag = tag; if (tag === dropTag) dropDepth++; }
      else if (tag === dropTag && dropDepth) dropDepth--;
      continue;
    }
    if (dropDepth) continue;
    if (!allowed(tag)) continue;
    if (closing) {
      const idx = stack.lastIndexOf(tag);
      if (idx === -1) continue;
      while (stack.length > idx) out.push(`</${stack.pop()}>`);
      continue;
    }
    // attributes
    const keep: string[] = [];
    const permitted = new Set([...GLOBAL_ATTRS, ...(TAG_ATTRS[tag] || [])]);
    const are = /([^\s>"'=\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    let a: RegExpExecArray | null;
    let srcOk = true;
    while ((a = are.exec(attrs || ''))) {
      const name = a[1].toLowerCase();
      let value = a[2] ?? a[3] ?? a[4] ?? '';
      if (name.startsWith('on')) continue;
      if (!permitted.has(name) && !name.startsWith('data-')) continue;
      if (name === 'style') {
        if (opts.styles === false) continue;
        value = cleanStyle(value);
      }
      if (name === 'href' || name === 'src' || name === 'poster') {
        const v = value.trim().replace(/[\u0000-\u001f\s]+/g, '');
        if (!SAFE_URL.test(v)) { if (name === 'src') srcOk = false; continue; }
        if (tag === 'iframe' && name === 'src' && !IFRAME_HOSTS.test(v)) { srcOk = false; continue; }
        value = v;
      }
      if (name === 'srcset' && /javascript:/i.test(value)) continue;
      keep.push(value === '' && ['allowfullscreen', 'controls', 'muted', 'loop', 'playsinline', 'open'].includes(name) ? name : `${name}="${value.replace(/"/g, '&quot;').replace(/</g, '&lt;')}"`);
    }
    if (tag === 'iframe' && !srcOk) continue;
    if (tag === 'a') {
      if (!keep.some((k) => k.startsWith('rel='))) keep.push('rel="noopener noreferrer"');
    }
    const attrStr = keep.length ? ' ' + keep.join(' ') : '';
    if (VOID.has(tag)) out.push(`<${tag}${attrStr}>`);
    else {
      out.push(`<${tag}${attrStr}>`);
      stack.push(tag);
    }
  }
  while (stack.length) out.push(`</${stack.pop()}>`);
  return out.join('');
}

/** Inline rich text (paragraphs, captions): formatting + links + footnotes only. */
export function inline(html: string): string {
  return sanitizeHtml(html, { styles: true });
}
