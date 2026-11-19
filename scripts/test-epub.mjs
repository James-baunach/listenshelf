// Runs the real EPUB parser (src/epub/parse.ts) in Node under linkedom.
// Usage: node scripts/make-sample-epub.mjs && node --experimental-strip-types scripts/test-epub.mjs [file.epub ...]
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

register('data:text/javascript,' + encodeURIComponent(`
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export async function resolve(spec, ctx, next) {
  if (spec.startsWith('.') && !/\\.[mc]?[jt]s$/.test(spec) && ctx.parentURL) {
    const u = new URL(spec + '.ts', ctx.parentURL);
    if (existsSync(fileURLToPath(u))) return next(u.href, ctx);
  }
  return next(spec, ctx);
}`), import.meta.url);

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { parseEpub, unzipEpub } = await import(pathToFileURL(join(root, 'src/epub/parse.ts')).href);
const { DOMParser } = await import('linkedom');

const parseDoc = (src, kind) => new DOMParser().parseFromString(src, kind === 'xml' ? 'text/xml' : 'text/html');

const files = process.argv.slice(2).length ? process.argv.slice(2) : [join(root, 'scripts/fixtures/sample.epub')];
for (const file of files) {
  console.log('=== ' + file);
  const book = await parseEpub(unzipEpub(new Uint8Array(readFileSync(file))), parseDoc);
  console.log(`title=${book.title} author=${book.author} cover=${book.cover?.mime ?? 'none'} sections=${book.sections.length}`);
  for (const s of book.sections) console.log(`  [L${s.level}] ${s.title} — ${s.sentences.length} sentences, paragraphs@${s.paragraphs}`);
  if (!process.argv[2]) {
    assert.equal(book.title, 'The Sample Voyage');
    assert.equal(book.author, 'Ada Example');
    assert.equal(book.cover?.mime, 'image/png');
    assert.deepEqual(book.sections.map((s) => [s.title, s.level]),
      [['Departure', 1], ['The Open Sea', 1], ['A Storm Rises', 2], ['Landfall', 1]]);
    const text = book.sections.map((s) => s.sentences.join(' ')).join('\n');
    assert.ok(!/FOOTNOTE/.test(text), 'footnote text leaked');
    assert.ok(!/\bContents\b/.test(text), 'nav leaked');
    const [dep, sea, storm, land] = book.sections;
    assert.deepEqual(dep.paragraphs, [0, 3]);
    assert.equal(dep.sentences[0], 'The ship left the harbor at dawn.');
    assert.ok(!dep.sentences.join(' ').includes('Departure'), 'chapter heading duplicated in body');
    assert.ok(sea.sentences.join(' ').includes('wind held steady') && !sea.sentences.join(' ').includes('sky turned black'));
    assert.ok(storm.sentences.join(' ').includes('sky turned black'));
    assert.ok(land.sentences.join(' ').includes('plain div'));
    assert.ok(!book.drm);
    console.log('all assertions passed');
  }
}
