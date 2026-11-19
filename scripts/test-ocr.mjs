// Proves the OCR pipeline pieces in Node: image-only PDF fixture -> tesseract.js recognition ->
// paragraphs/lines (src/pdf/ocrparse.ts) -> sections with per-sentence pages (src/pdf/extract.ts).
// Usage: node scripts/test-ocr.mjs   (needs network the first time to fetch eng.traineddata; cached after)
import { register } from 'node:module';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { Resvg } from '@resvg/resvg-js';
import { PDFDocument } from 'pdf-lib';
import { createWorker } from 'tesseract.js';

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
const { ocrPageToLines, applyOcrParagraphs } = await import(pathToFileURL(join(root, 'src/pdf/ocrparse.ts')).href);
const { buildPageText, layoutSentences, rectsFor } = await import(pathToFileURL(join(root, 'src/pdf/pagetext.ts')).href);
const { sectionsFromPages } = await import(pathToFileURL(join(root, 'src/pdf/extract.ts')).href);

// ─── 1. fixture: two "scanned" pages (letter size at 2x = 1224x1584 px), image-only PDF ───
const W = 1224, H = 1584;
const pageParas = [
  [
    'Chapter One: The Harbor at Dusk',
    'The harbor town of Veldmouth had never been a place for hurried people. Every evening, as the light slid down behind the breakwater, the old keeper climbed the stairs of the lighthouse with a lamp in one hand and a thermos of tea in the other. He had done so for thirty-one years, and in that time he had missed exactly two nights.',
    'The fishermen, who were not given to ceremony, nodded when they passed him on the quay. On this particular evening the wind came in from the north, smelling of salt and distant rain. It was an extraordinary change, because the forecast had promised nothing but calm.',
  ],
  [
    'A young woman stood at the foot of the lighthouse, holding a battered suitcase and a letter. She asked whether he was the keeper, raising her voice over the gulls. He studied her for a moment before answering that he was.',
    'Her name, she said, was Nora Finch, and she had come about the position that nobody else wanted. That seemed to please him more than a diploma would have done. Together they climbed the 142 steps, pausing at each landing so that she could look out over the water.',
  ],
];
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
function wrap(text, max) {
  const out = []; let line = '';
  for (const w of text.split(' ')) { if ((line + ' ' + w).trim().length > max) { out.push(line); line = w; } else line = (line + ' ' + w).trim(); }
  if (line) out.push(line);
  return out;
}
function pagePng(paras) {
  let y = 200; const parts = [];
  paras.forEach((p, i) => {
    const heading = i === 0 && pageParas[0] === paras;
    const size = heading ? 44 : 27;
    const ls = wrap(p, heading ? 40 : 72);
    ls.forEach((l, k) => {
      const indent = !heading && k === 0 ? 40 : 0;
      parts.push(`<text x="${150 + indent}" y="${y}" font-family="Times New Roman, Georgia, serif" font-size="${size}" font-weight="${heading ? 700 : 400}" fill="#1a1a1a">${esc(l)}</text>`);
      y += heading ? 60 : 40;
    });
    y += heading ? 40 : 10;
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#fdfcf8"/>${parts.join('')}</svg>`;
  return new Resvg(svg, { fitTo: { mode: 'width', value: W } }).render().asPng();
}
const pngs = pageParas.map(pagePng);
// a degraded copy of page 1: skewed 0.9 degrees, grey-on-tan, with film grain, to approximate a mediocre scan
function degradedPng(paras) {
  let y = 200; const parts = [];
  paras.forEach((p, i) => {
    const heading = i === 0;
    const size = heading ? 44 : 27;
    wrap(p, heading ? 40 : 72).forEach((l, k) => {
      parts.push(`<text x="${150 + (!heading && k === 0 ? 40 : 0)}" y="${y}" font-family="Times New Roman, Georgia, serif" font-size="${size}" font-weight="${heading ? 700 : 400}" fill="#4a4a48">${esc(l)}</text>`);
      y += heading ? 60 : 40;
    });
    y += heading ? 40 : 10;
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" result="t"/><feColorMatrix in="t" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.22 0"/><feComposite in2="SourceGraphic" operator="over"/></filter></defs><rect width="100%" height="100%" fill="#e6dfcc"/><g transform="rotate(0.9 612 792)">${parts.join('')}</g><rect width="100%" height="100%" filter="url(#n)" fill="none"/></svg>`;
  return new Resvg(svg, { fitTo: { mode: 'width', value: W } }).render().asPng();
}
const degraded = degradedPng(pageParas[0]);
writeFileSync(join(tmpdir(), 'listenshelf-degraded.png'), degraded);
const pdf = await PDFDocument.create();
for (const png of pngs) {
  const img = await pdf.embedPng(png);
  const pg = pdf.addPage([612, 792]);
  pg.drawImage(img, { x: 0, y: 0, width: 612, height: 792 });
}
mkdirSync(join(root, 'scripts/fixtures'), { recursive: true });
writeFileSync(join(root, 'scripts/fixtures/scanned.pdf'), await pdf.save());
console.log('fixture: scripts/fixtures/scanned.pdf (2 image-only pages)');

// the fixture must have no text layer (that is what routes a book to OCR)
{
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const d = await pdfjs.getDocument({ data: new Uint8Array(await pdf.save()), verbosity: 0 }).promise;
  const tc = await (await d.getPage(1)).getTextContent();
  assert.equal(tc.items.length, 0, 'fixture has a text layer');
  console.log('ok:   fixture has no text layer');
}

// ─── 2. recognize ───
const cache = join(tmpdir(), 'listenshelf-tess-cache');
mkdirSync(cache, { recursive: true });
const t0 = Date.now();
const worker = await createWorker('eng', 1, { cachePath: cache, logger: () => {} });
console.log(`worker ready (${Date.now() - t0} ms)`);
const ocrPages = [];
for (let i = 0; i < pngs.length; i++) {
  const t1 = Date.now();
  const { data } = await worker.recognize(Buffer.from(pngs[i]), {}, { blocks: true });
  console.log(`page ${i + 1}: ${Date.now() - t1} ms, confidence ${data.confidence}, blocks ${data.blocks?.length}`);
  ocrPages.push(ocrPageToLines(data.blocks, { index: i, pxW: W, pxH: H, scale: 2 }));
}
const dd = await worker.recognize(Buffer.from(degraded), {}, { blocks: true });
const degLines = ocrPageToLines(dd.data.blocks, { index: 0, pxW: W, pxH: H, scale: 2 }).page.lines.map((l) => l.text).join(' ');
await worker.terminate();

// ─── 3. checks ───
let failures = 0;
const check = (name, cond) => { if (!cond) { failures++; console.log('FAIL: ' + name); } else console.log('ok:   ' + name); };
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function lev(a, b) {
  const m = a.length, n = b.length; let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
  return prev[n];
}
const truth = norm(pageParas.flat().join(' '));
const got = norm(ocrPages.flatMap((p) => p.page.lines.map((l) => l.text)).join(' '));
const cerr = lev(truth, got) / truth.length;
const wt = truth.split(' '), wg = got.split(' ');
const werr = lev(wt, wg) / wt.length;
console.log(`character accuracy ${(100 * (1 - cerr)).toFixed(2)}%  word accuracy ${(100 * (1 - werr)).toFixed(2)}%`);
check('char accuracy >= 97%', 1 - cerr >= 0.97);
check('lines found on both pages', ocrPages.every((p) => p.page.lines.length >= 5));
check('word boxes recorded as page fractions', ocrPages.every((p) => p.words.length > 20 && p.words.every((w) => w[0] >= 0 && w[2] <= 1.001 && w[1] >= 0 && w[3] <= 1.001 && w[2] > w[0])));
const paraCount = ocrPages[0].paraStarts.size;
console.log(`page 1 paragraph starts reported by tesseract: ${paraCount} (truth 3: heading + 2; tesseract often merges, so computeFlags indent/spacing heuristics also apply)`);
check('tesseract reports >= 1 paragraph on page 1', paraCount >= 1);

const dTruth = norm(pageParas[0].join(' ')), dGot = norm(degLines);
const dAcc = 1 - lev(dTruth, dGot) / dTruth.length;
console.log(`degraded scan (skew 0.9 deg, low contrast, grain): character accuracy ${(100 * dAcc).toFixed(2)}%`);
check('degraded char accuracy >= 90%', dAcc >= 0.9);

// ─── 4. sections with per-sentence pages (same pipeline as text PDFs) ───
const starts = new Set(ocrPages.flatMap((p) => [...p.paraStarts]));
const res = await sectionsFromPages(null, ocrPages.map((p) => p.page), (flat) => applyOcrParagraphs(flat, starts));
const secs = res.sections;
console.log(`method=${res.method} sections=${secs.length}`);
for (const s of secs) console.log(`- "${s.title}" ${s.sentences.length} sentences pages ${[...new Set(s.pages)].join(',')} paragraphs ${s.paragraphs}`);
check('has sections', secs.length >= 1);
check('pages parallel + non-decreasing', secs.every((s) => s.pages.length === s.sentences.length && s.pages.every((p, i) => i === 0 || p >= s.pages[i - 1])));
check('paragraph starts recorded (heading + 4 paragraphs)', secs.reduce((n, s) => n + s.paragraphs.length, 0) >= 4);
check('both pages represented', new Set(secs.flatMap((s) => s.pages)).size === 2);
check('sentences speakable', secs.flatMap((s) => s.sentences).some((x) => /extraordinary change/.test(x)));
console.log(failures ? `\n${failures} FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
