// Small Markdown toolkit: markdown → editor blocks (API/MCP post drafting) and markdown → HTML (docs pages).
import type { Block } from './render';
import { esc, id } from './util';

/** Inline markdown → safe inline HTML (bold, italic, code, links, strikethrough, footnote-free). */
export function inlineMd(s: string): string {
  let out = esc(s);
  // code spans first (protect contents)
  const codes: string[] = [];
  out = out.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  out = out
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => `<img src="${src}" alt="${alt}">`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, href) => `<a href="${/^(https?:|mailto:|\/|#)/.test(href) ? href : '#'}">${t}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_([^_\s][^_]*)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>');
  out = out.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
  return out;
}

/** Convert Markdown into editor blocks. Supports headings, paragraphs, lists, quotes, code fences, images, hr, tables, `---paywall---`. */
export function markdownToBlocks(md: string): Block[] {
  const lines = (md || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ id: id(8), type: 'paragraph', data: { html: inlineMd(para.join(' ')) } });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (!t) { flush(); continue; }
    let m: RegExpMatchArray | null;
    if (/^(-{3,}|\*{3,})\s*paywall\s*(-{3,}|\*{3,})?$/i.test(t) || /^<!--\s*paywall\s*-->$/i.test(t)) { flush(); blocks.push({ id: id(8), type: 'paywall', data: {} }); continue; }
    if ((m = t.match(/^```(\w*)/))) {
      flush();
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) code.push(lines[i++]);
      blocks.push({ id: id(8), type: 'code', data: { lang: m[1] || '', code: code.join('\n') } });
      continue;
    }
    if ((m = t.match(/^(#{1,4})\s+(.*)$/))) { flush(); blocks.push({ id: id(8), type: 'heading', data: { level: m[1].length, html: inlineMd(m[2]) } }); continue; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { flush(); blocks.push({ id: id(8), type: 'divider', data: { style: 'line' } }); continue; }
    if ((m = t.match(/^!\[([^\]]*)\]\(([^)\s]+)\)$/))) { flush(); blocks.push({ id: id(8), type: 'image', data: { src: m[2], alt: m[1], caption: '' } }); continue; }
    if (t.startsWith('>')) {
      flush();
      const q: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) q.push(lines[i++].trim().replace(/^>\s?/, ''));
      i--;
      blocks.push({ id: id(8), type: 'quote', data: { html: inlineMd(q.join(' ')), style: { variant: 'line' } } });
      continue;
    }
    if (/^([-*+]|\d+[.)])\s+/.test(t)) {
      flush();
      const ordered = /^\d/.test(t);
      const items: string[] = [];
      const checks: Array<{ html: string; checked: boolean }> = [];
      while (i < lines.length && /^([-*+]|\d+[.)])\s+/.test(lines[i].trim())) {
        const it = lines[i++].trim().replace(/^([-*+]|\d+[.)])\s+/, '');
        const cm = it.match(/^\[([ xX])\]\s+(.*)$/);
        if (cm) checks.push({ html: inlineMd(cm[2]), checked: cm[1] !== ' ' });
        else items.push(inlineMd(it));
      }
      i--;
      if (checks.length && !items.length) blocks.push({ id: id(8), type: 'checklist', data: { items: checks } });
      else blocks.push({ id: id(8), type: 'list', data: { ordered, items: [...items, ...checks.map((c) => c.html)] } });
      continue;
    }
    if (t.startsWith('|') && i + 1 < lines.length && /^\|?\s*:?-{2,}/.test(lines[i + 1].trim())) {
      flush();
      const rows: string[][] = [];
      const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => inlineMd(c.trim()));
      rows.push(cells(t));
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(cells(lines[i++]));
      i--;
      blocks.push({ id: id(8), type: 'table', data: { rows, header: true } });
      continue;
    }
    para.push(t);
  }
  flush();
  return blocks;
}

/** Markdown → HTML for documentation pages (headings get anchors). */
export function markdownToHtml(md: string): { html: string; headings: Array<{ id: string; text: string; level: number }> } {
  const blocks = markdownToBlocks(md);
  const headings: Array<{ id: string; text: string; level: number }> = [];
  const used = new Set<string>();
  const html = blocks
    .map((b) => {
      const d = b.data;
      switch (b.type) {
        case 'heading': {
          const text = d.html.replace(/<[^>]+>/g, '');
          let hid = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'section';
          while (used.has(hid)) hid += '-2';
          used.add(hid);
          headings.push({ id: hid, text, level: d.level });
          return `<h${d.level} id="${hid}"><a class="anchor" href="#${hid}">#</a>${d.html}</h${d.level}>`;
        }
        case 'paragraph': return `<p>${d.html}</p>`;
        case 'list': { const tag = d.ordered ? 'ol' : 'ul'; return `<${tag}>${d.items.map((x: string) => `<li>${x}</li>`).join('')}</${tag}>`; }
        case 'checklist': return `<ul class="checks">${d.items.map((x: any) => `<li>${x.checked ? '☑' : '☐'} ${x.html}</li>`).join('')}</ul>`;
        case 'quote': return `<blockquote>${d.html}</blockquote>`;
        case 'code': return `<pre><code${d.lang ? ` class="lang-${esc(d.lang)}"` : ''}>${esc(d.code)}</code></pre>`;
        case 'divider': return '<hr>';
        case 'image': return `<p><img src="${esc(d.src)}" alt="${esc(d.alt)}"></p>`;
        case 'table': return `<div class="tw"><table>${d.rows.map((r: string[], ri: number) => `<tr>${r.map((c) => (ri === 0 ? `<th>${c}</th>` : `<td>${c}</td>`)).join('')}</tr>`).join('')}</table></div>`;
        default: return '';
      }
    })
    .join('\n');
  return { html, headings };
}
