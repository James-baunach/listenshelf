// Runs the real extraction logic (src/pdf/extract.ts) in Node against the sample PDFs.
// Usage: node scripts/make-sample-pdf.mjs && node scripts/test-pdf.mjs [file.pdf ...]
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

// Let Node resolve extensionless relative imports in .ts files (the app uses bundler resolution).
register('data:text/javascript,' + encodeURIComponent(`
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export async function resolve(spec, ctx, next) {
  if (spec.startsWith('.') && !/\.[mc]?[jt]s$/.test(spec) && ctx.parentURL) {
    const u = new URL(spec + '.ts', ctx.parentURL);
    if (existsSync(fileURLToPath(u))) return next(u.href, ctx);
  }
  return next(spec, ctx);
}`), import.meta.url);

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { extractDocument, joinLines, buildSection, linesToParas, linesToParagraphs } = await import(pathToFileURL(join(root, 'src/pdf/extract.ts')).href);
const { buildPageText, layoutSentences, rectsFor, hitTest, wordStartAtKey } = await import(pathToFileURL(join(root, 'src/pdf/pagetext.ts')).href);
const { makeSection } = await import(pathToFileURL(join(root, 'src/text.ts')).href);
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

// ─── unit checks ───
assert.equal(joinLines(['an exam-', 'ple of it']), 'an example of it');
assert.equal(joinLines(['a well-', 'known fact']), 'a well-known fact');
assert.equal(joinLines(['the Anglo-', 'Saxon age']), 'the Anglo-Saxon age');
assert.equal(joinLines(['no hyphen', 'here']), 'no hyphen here');
console.log('joinLines unit checks OK');

// A paragraph that continues across a page break: a sentence spanning the break gets the page where it starts.
{
  const L = (text, page, para) => ({ text, page, para, x: 0, xEnd: 0, y: 0, size: 10 });
  const lines = [
    L('The first sentence ends here. The second sentence starts on', 3, true),
    L('page five and runs over. A third one follows it.', 4, false),
    L('A fresh paragraph on page five. Another one.', 4, true),
  ];
  const sec = buildSection('t', 1, linesToParas(lines));
  assert.deepEqual(sec.sentences, makeSection('t', 1, linesToParagraphs(lines)).sentences, 'buildSection must split like makeSection');
  assert.deepEqual(sec.paragraphs, [0, 3]);
  assert.deepEqual(sec.pages, [4, 4, 5, 5, 5]);
  console.log('buildSection page-break unit check OK');
}

const files = process.argv.slice(2).length ? process.argv.slice(2)
  : [join(root, 'scripts/fixtures/sample.pdf'), join(root, 'scripts/fixtures/sample-nooutline.pdf')];

let failures = 0;
for (const file of files) {
  console.log('\n=== ' + file);
  const data = new Uint8Array(readFileSync(file));
  const doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise;
  const t0 = Date.now();
  const r = await extractDocument(doc, { yieldEvery: 3 });
  console.log(`pages=${r.pageCount} method=${r.method} sections=${r.sections.length} chars=${r.totalChars} (${Date.now() - t0} ms)`);
  for (const s of r.sections) {
    console.log(`- [L${s.level}] p${s.page} "${s.title}"  ${s.sentences.length} sentences, ${s.charCount} chars`);
    for (const x of s.sentences.slice(0, 2)) console.log('     · ' + x.slice(0, 110));
  }
  const all = r.sections.flatMap((s) => s.sentences).join('\n');
  const check = (name, cond) => { if (!cond) { failures++; console.log('FAIL: ' + name); } else console.log('ok:   ' + name); };

  // ─── page view mapping: every sentence must be locatable on its page, with rectangles and a working tap hit-test ───
  {
    const byPage = new Map();
    r.sections.forEach((sec, si) => sec.sentences.forEach((x, j) => {
      const p = sec.pages[j];
      if (!byPage.has(p)) byPage.set(p, []);
      byPage.get(p).push({ si, j, x });
    }));
    let total = 0, found = 0, withRects = 0, tapOk = 0, tapTried = 0;
    for (const [p, list] of byPage) {
      const page = await doc.getPage(p);
      const vp = page.getViewport({ scale: 1 });
      const pt = buildPageText(await page.getTextContent());
      const lay = layoutSentences(pt, list.map((e) => e.x));
      lay.forEach((rg, k) => {
        total++;
        if (!rg) return;
        found++;
        const rects = rectsFor(pt, rg, vp.transform, vp.width, vp.height);
        if (rects.length && rects.every((q) => q.w > 0 && q.h > 0 && q.x >= -0.01 && q.y >= -0.01 && q.x + q.w <= 1.01 && q.y + q.h <= 1.01)) withRects++;
        if (rects.length && k % 3 === 0) {
          tapTried++;
          const q = rects[0];
          const hit = hitTest(pt, q.x + q.w * 0.5, q.y + q.h * 0.5, vp.transform, vp.width, vp.height);
          const owner = hit ? lay.findIndex((l) => l && hit.keyIndex >= l.start && hit.keyIndex < l.end) : -1;
          if (owner === k) tapOk++;
        }
      });
    }
    check(`page view: ${found}/${total} sentences located on their page (>=97%)`, found / total >= 0.97);
    check(`page view: ${withRects}/${found} located sentences have sane rectangles`, withRects === found);
    check(`page view: tap in the first rect maps back to the sentence (${tapOk}/${tapTried})`, tapOk / tapTried >= 0.95);
  }
  for (const sec of r.sections) {
    const n = sec.sentences.length;
    check(`pages parallel to sentences ("${sec.title}")`, Array.isArray(sec.pages) && sec.pages.length === n);
    check(`pages non-decreasing, within 1..${r.pageCount} ("${sec.title}")`, sec.pages.every((p, i) => Number.isInteger(p) && p >= 1 && p <= r.pageCount && (i === 0 || p >= sec.pages[i - 1])));
    check(`paragraphs sane ("${sec.title}")`, Array.isArray(sec.paragraphs) && sec.paragraphs[0] === 0 && sec.paragraphs.every((x, i) => x >= 0 && x < n && (i === 0 || x > sec.paragraphs[i - 1])));
  }
  check('sections progress through pages', r.sections.every((s, i) => i === 0 || s.pages[0] >= r.sections[i - 1].pages[r.sections[i - 1].pages.length - 1] - 1));
  check('page span > 1', new Set(r.sections.flatMap((s) => s.pages)).size > 1);
  check('running header removed', !/Lantern Keepers/.test(all));
  check('page numbers removed', !/^\d{1,2}$/m.test(all) && !/\b\d{1,2}\s+(The|A)\s/.test(all.split('\n').filter((l) => /^\d/.test(l)).join('\n')));
  check('no lone-digit sentences', !r.sections.some((s) => s.sentences.some((x) => /^\d{1,3}$/.test(x))));
  check('hyphenation repaired (extraordinary)', /extraordinary/.test(all) && !/extra-\s*ordinary/.test(all));
  check('real hyphen kept (thirty-one)', /thirty-one/.test(all));
  check('windblown joined', /windblown/.test(all));
  check('abbreviation not split ("Mr. Alder")', all.split('\n').some((s) => /Mr\. Alder/.test(s) && s.length > 12 && !/^Alder/.test(s)));
  check('3+ sections', r.sections.length >= 3);
  check('chapter titles', ['Harbor at Dusk', 'What the Logbook Said', 'Light on the Point'].every((t) => r.sections.some((s) => s.title.includes(t))));
  check('heading text not repeated in body', !r.sections.some((s) => s.sentences[0]?.startsWith('Chapter ')));
  if (r.method === 'outline') check('nested outline entry (level 2)', r.sections.some((s) => s.level === 2 && /Storm Warning/.test(s.title)));
}
console.log(failures ? `\n${failures} FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
