// Run: node --experimental-strip-types scripts/test-wiki.mjs
import { parseHTML } from 'linkedom';
import assert from 'node:assert/strict';
import { register } from 'node:module';
// Resolve the project's extensionless TS imports (../text) when running under node directly.
register('data:text/javascript,' + encodeURIComponent(`export async function resolve(s,c,n){try{return await n(s,c)}catch(e){if(s.startsWith('.'))return n(s+'.ts',c);throw e}}`));
const { htmlToSections } = await import('../src/wiki/parse.ts');

const SKIP = ['See also', 'References', 'External links', 'Further reading', 'Notes', 'Bibliography', 'Sources', 'Citations', 'Footnotes', 'Works cited', 'Gallery'];
const titles = ['Octopus', 'Apollo 11', 'Louisville, Kentucky'];
const bad = [/\[\s*\d+\s*\]/, /\[\s*[a-z]\s*\]/, /citation needed/i, /\(\s*[;,]?\s*\)/, /\{\displaystyle/, /Main article/i, /^\s*For other uses/i];

for (const t of titles) {
  const r = await fetch(`https://en.wikipedia.org/api/rest_v1/page/html/${encodeURIComponent(t.replace(/ /g, '_'))}?redirect=true`, { headers: { 'Api-User-Agent': 'ListenShelf/1.0' } });
  assert.ok(r.ok, `${t}: HTTP ${r.status}`);
  const { document } = parseHTML(await r.text());
  const secs = htmlToSections(document, SKIP);
  const total = secs.reduce((n, s) => n + s.charCount, 0);
  console.log(`\n=== ${t}: ${secs.length} sections, ${total} chars (~${Math.round(total / 15 / 60)} min)`);
  for (const s of secs) {
    console.log(`${'  '.repeat(s.level - 1)}- [${s.level}] ${s.title} (${s.sentences.length} sentences, ${s.charCount} chars)`);
    s.sentences.slice(0, 2).forEach((x) => console.log(`${'  '.repeat(s.level)}   > ${x.slice(0, 160)}`));
    for (const x of s.sentences) for (const re of bad) assert.ok(!re.test(x), `${t} / ${s.title}: junk ${re} in "${x}"`);
  }
  assert.ok(secs.length >= 3 && total > 5000, `${t}: too little content`);
  assert.ok(!secs.some((s) => SKIP.map((x) => x.toLowerCase()).includes(s.title.toLowerCase())), 'skipped section leaked');
}
console.log('\nAll assertions passed.');
