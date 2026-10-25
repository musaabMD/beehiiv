// Regenerates landing/index.html (static sales page for hosting at Lnkbase.com/beehiiv) from a running dev server.
// Usage: npx wrangler dev &  then  node scripts/build-landing.mjs [http://localhost:8787]
import { writeFileSync } from 'node:fs';
const base = process.argv[2] || 'http://localhost:8787';
const html = await (await fetch(base + '/?static=1')).text();
writeFileSync('landing/index.html', html);
console.log('wrote landing/index.html', html.length, 'bytes');
