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
const { extractDocument, joinLines } = await import(pathToFileURL(join(root, 'src/pdf/extract.ts')).href);
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

// ─── unit checks ───
assert.equal(joinLines(['an exam-', 'ple of it']), 'an example of it');
assert.equal(joinLines(['a well-', 'known fact']), 'a well-known fact');
assert.equal(joinLines(['the Anglo-', 'Saxon age']), 'the Anglo-Saxon age');
assert.equal(joinLines(['no hyphen', 'here']), 'no hyphen here');
console.log('joinLines unit checks OK');

const files = process.argv.slice(2).length ? process.argv.slice(2)
  : [join(root, 'public/sample.pdf'), join(root, 'scripts/fixtures/sample-nooutline.pdf')];

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
