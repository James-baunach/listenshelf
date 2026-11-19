// Run: node --experimental-strip-types scripts/test-wiki.mjs
import { parseHTML } from 'linkedom';
import assert from 'node:assert/strict';
import { register } from 'node:module';
// Resolve the project's extensionless TS imports (../text) when running under node directly.
register('data:text/javascript,' + encodeURIComponent(`export async function resolve(s,c,n){try{return await n(s,c)}catch(e){if(s.startsWith('.'))return n(s+'.ts',c);throw e}}`));
const { htmlToSections } = await import('../src/wiki/parse.ts');
const { findSpoken, packSpoken, unpackSpoken } = await import('../src/wiki/spoken.ts');

const SKIP = ['See also', 'References', 'External links', 'Further reading', 'Notes', 'Bibliography', 'Sources', 'Citations', 'Footnotes', 'Works cited', 'Gallery'];
const titles = ['Octopus', 'Apollo 11', 'Louisville, Kentucky'];
const bad = [/\[\s*\d+\s*\]/, /\[\s*[a-z]\s*\]/, /citation needed/i, /\(\s*[;,]?\s*\)/, /\{\displaystyle/, /Main article/i, /^\s*For other uses/i];

for (const t of titles) {
  const r = await fetch(`https://en.wikipedia.org/api/rest_v1/page/html/${encodeURIComponent(t.replace(/ /g, '_'))}?redirect=true`, { headers: { 'Api-User-Agent': 'ListenShelf/1.0' } });
  assert.ok(r.ok, `${t}: HTTP ${r.status}`);
  const { document } = parseHTML(await r.text());
  const spoken = findSpoken(document);
  const secs = htmlToSections(document, SKIP, t);
  const total = secs.reduce((n, s) => n + s.charCount, 0);
  console.log(`\n=== ${t}: ${secs.length} sections, ${total} chars (~${Math.round(total / 15 / 60)} min)`);
  for (const s of secs) {
    console.log(`${'  '.repeat(s.level - 1)}- [${s.level}] ${s.title} (${s.sentences.length} sentences, ${s.charCount} chars)`);
    s.sentences.slice(0, 2).forEach((x) => console.log(`${'  '.repeat(s.level)}   > ${x.slice(0, 160)}`));
    for (const x of s.sentences) for (const re of bad) assert.ok(!re.test(x), `${t} / ${s.title}: junk ${re} in "${x}"`);
  }
  // Links: ranges must land inside the sentence on real text, no self/namespace/duplicate links.
  const links = secs.flatMap((s) => (s.links ?? []).map((l) => ({ s, l })));
  for (const { s, l } of links) {
    const sent = s.sentences[l.sentence];
    assert.ok(sent != null && l.start >= 0 && l.end > l.start && l.end <= sent.length, `${t}: bad link range ${JSON.stringify(l)}`);
    assert.ok(!/^(file|category|help|special|wikipedia|template|portal|talk):/i.test(l.title), `${t}: namespace link ${l.title}`);
    assert.notEqual(l.title.toLowerCase(), t.toLowerCase(), `${t}: self link`);
    assert.ok(!l.title.includes('_') && !l.title.includes('%'), `${t}: undecoded title ${l.title}`);
  }
  assert.ok(links.length > 20, `${t}: too few links (${links.length})`);
  const sample = links.slice(0, 5).map(({ s, l }) => `${s.sentences[l.sentence].slice(l.start, l.end)} -> ${l.title}`);
  console.log(`  links: ${links.length}; sample: ${sample.join(' | ')}`);
  console.log(`  spoken: ${spoken ? JSON.stringify({ urls: spoken.urls.length, files: spoken.files.length, date: spoken.date }) : 'none'}`);
  assert.ok(secs.length >= 3 && total > 5000, `${t}: too little content`);
  assert.ok(!secs.some((s) => SKIP.map((x) => x.toLowerCase()).includes(s.title.toLowerCase())), 'skipped section leaked');
}
// Known anchors: Octopus intro should link "cephalopod" -> Cephalopod, text must match exactly.
{
  const r = await fetch('https://en.wikipedia.org/api/rest_v1/page/html/Octopus', { headers: { 'Api-User-Agent': 'ListenShelf/1.0' } });
  const { document } = parseHTML(await r.text());
  const secs = htmlToSections(document, SKIP, 'Octopus');
  const l = secs[0].links.find((x) => x.title === 'Cephalopod');
  assert.ok(l, 'Octopus: Cephalopod link missing');
  assert.equal(secs[0].sentences[l.sentence].slice(l.start, l.end).toLowerCase(), 'cephalopoda');
  console.log('Octopus intro link ok:', JSON.stringify(secs[0].sentences[l.sentence].slice(l.start, l.end)));
}
// Spoken Wikipedia (multi-part article)
{
  const r = await fetch('https://en.wikipedia.org/api/rest_v1/page/html/Barack_Obama', { headers: { 'Api-User-Agent': 'ListenShelf/1.0' } });
  const { document } = parseHTML(await r.text());
  const sp = findSpoken(document);
  assert.ok(sp && sp.urls.length >= 1, 'Obama: no spoken recording found');
  const packed = packSpoken(sp.urls, sp.date);
  assert.deepEqual(unpackSpoken(packed).urls, sp.urls);
  const head = await fetch(sp.urls[0], { method: 'HEAD' });
  console.log('Spoken example:', packed, '| HEAD', head.status, head.headers.get('content-type'), 'CORP:', head.headers.get('cross-origin-resource-policy'), 'ACAO:', head.headers.get('access-control-allow-origin'));
  assert.ok(head.ok, 'spoken url not reachable');
}
console.log('\nAll assertions passed.');
