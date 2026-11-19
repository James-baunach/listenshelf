// Generates scripts/fixtures/sample.pdf (with outline) and scripts/fixtures/sample-nooutline.pdf (no outline).
// Original prose; 3 chapters, running header, page numbers, hyphenated line breaks, one nested outline entry.
import { PDFDocument, StandardFonts, PDFName, PDFHexString, rgb } from 'pdf-lib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BOOK = 'The Lantern Keepers';
const H = '\u0001'; // forced hyphenation point inside a word

const chapters = [
  {
    title: 'Chapter One: The Harbor at Dusk',
    indent: true,
    sentences: [
      'The harbor town of Veldmouth had never been a place for hurried people.',
      'Every evening, as the light slid down behind the breakwater, the old keeper climbed the stairs of the lighthouse with a lamp in one hand and a thermos of tea in the other.',
      'He had done so for thirty-one years, and in that time he had missed exactly two nights.',
      'Mr. Alder liked to say that the sea kept better time than any clock in the village.',
      'The fishermen, who were not given to ceremony, nodded when they passed him on the quay.',
      'On this particular evening the wind came in from the north, smelling of salt and distant rain.',
      `It was an extra${H}ordinary change, because the forecast had promised nothing but calm.`,
      'A young woman stood at the foot of the lighthouse, holding a battered suitcase and a letter.',
      '"Are you Mr. Alder?" she asked, raising her voice over the gulls.',
      'He studied her for a moment (he was a careful man) before answering that he was.',
      'Her name, she said, was Nora Finch, and she had come about the position that nobody else wanted.',
      'The previous assistant, Dr. Marsh, had left in the spring without a word of explanation.',
      'Nora explained that she had trained as a mechanic, e.g. engines, pumps, and anything with a gasket.',
      'That seemed to please him more than a diploma would have done.',
      'Together they climbed the 142 steps, pausing at each landing so that she could look out over the water.',
      'At the top, the great lens waited like a sleeping animal, ringed with brass and glass.',
      'He showed her how the mechanism turned, and how the oil must be checked every three hours.',
      'By midnight the rain had arrived, drumming on the gallery rail in a steady, patient rhythm.',
      'Nora wrote her first entry in the logbook with a hand that was only slightly unsteady.',
      'Far out beyond the point, a single light blinked twice and was gone.',
    ],
  },
  {
    title: 'Chapter Two: What the Logbook Said',
    indent: false,
    sub: 'The Storm Warning',
    sentences: [
      'Morning revealed a harbor scrubbed clean by the storm.',
      'Boats that had been tied neatly the day before now leaned against each other like tired friends.',
      'Nora found the old logbooks in a cupboard beneath the stairs, forty volumes bound in green cloth.',
      'She read them over breakfast, turning the thin pages with the careful fingers of someone who repairs delicate things.',
      'The entries were brief, the way a keeper writes when the work is routine: wind, visibility, oil, lamp.',
      'But every few years, usually in autumn, there was a line that did not belong.',
      'One read simply, "Two flashes from the point; no vessel seen."',
      'Another, written in a different hand, said, "Answered the signal. Nothing came."',
      'She counted eleven such entries, spaced across more than sixty years.',
      'When she raised the matter, Mr. Alder became very interested in his tea.',
      'He admitted that the signal was real, and that he had answered it himself, twice.',
      'The light on the point, he said, belonged to no ship and to no station on any chart.',
      'The council had sent surveyors in 1987, who found only rock and a few indifferent seals.',
      'Nora asked whether anyone had ever gone out there at night.',
      'There was a long silence before he said that the current around the point was not kind to small boats.',
      'She thought about that for the rest of the afternoon while she cleaned the lens with a soft cloth.',
      'The sky in the west turned the color of a bruised peach.',
      'At dusk, they lit the lamp together and waited, neither of them admitting what for.',
      'Nothing happened until nearly three in the morning, and then it happened twice.',
      'This time, Nora was the one who wrote it down.',
    ],
  },
  {
    title: 'Chapter Three: The Light on the Point',
    indent: true,
    gap: true,
    sentences: [
      'The boat they borrowed belonged to a retired fisherman named Tobias Reed, who asked no questions and wanted no money.',
      'It smelled of diesel and old rope, and its engine coughed twice before settling into a dependable grumble.',
      'Nora fixed it in twenty minutes with a wrench and a stubborn kind of patience.',
      'They left at first light, when the water was flat and pale as pewter.',
      'Mr. Alder sat in the bow, wrapped in a coat that had seen better decades.',
      `The point rose slowly out of the mist, a ridge of black rock crowned with a tangle of wind${H}blown grass.`,
      'There was no landing, only a shelf of stone where the swell lifted and fell with a hollow sound.',
      'They tied up as best they could and climbed, hand over hand, toward the top.',
      'What they found there was not a ship, nor a station, nor a ghost.',
      'It was a lantern, small and old, hung from an iron hook driven into the rock.',
      'Its glass was clouded, its brass was green, and yet the wick inside was warm.',
      'Beneath it lay a notebook wrapped in oilcloth, its pages crowded with the handwriting of many different people.',
      'Each of them, it seemed, had been a keeper once, and had climbed here for the same reason.',
      'The last entry was dated only a week earlier, and it was in Dr. Marsh’s neat, slanting script.',
      'It said that the lantern must never go dark, and that someone must always come to tend it.',
      'Nora read the page aloud, and the wind seemed to listen.',
      'Mr. Alder took the small brass key from his pocket, the one he had carried for thirty-one years without knowing why.',
      'It fit the lantern’s little door exactly.',
      'They trimmed the wick together, refilled the oil, and sat in the thin sunlight until the flame steadied.',
      'On the way back, the harbor looked smaller and kinder, as if it too had been waiting to be understood.',
    ],
  },
];

// deterministic shuffle
function rng(seed) { let s = seed; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; }
function makeParagraphs(sentences, seed) {
  const r = rng(seed);
  const paras = [];
  for (let pass = 0; pass < 5; pass++) {
    const arr = sentences.slice();
    if (pass > 0) for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
    for (let i = 0; i < arr.length;) { const n = 4 + Math.floor(r() * 3); paras.push(arr.slice(i, i + n).join(' ')); i += n; }
  }
  return paras;
}

async function build(withOutline) {
  const pdf = await PDFDocument.create();
  const body = await pdf.embedFont(StandardFonts.TimesRoman);
  const bold = await pdf.embedFont(StandardFonts.TimesRomanBold);
  pdf.setTitle(BOOK); pdf.setAuthor('Imogen Hartley'); pdf.setCreator('make-sample-pdf');
  const W = 612, Hh = 792, M = 76, size = 12, lead = 17.5, maxW = W - 2 * M;
  const pages = [];
  const outlineTargets = []; // {title, level, page}
  let page, y;
  const newPage = () => { page = pdf.addPage([W, Hh]); pages.push(page); y = Hh - 100; };

  const wrapLines = (text, indent) => {
    const out = []; let line = ''; let first = true;
    const avail = () => maxW - (first && indent ? 22 : 0);
    const fits = (s) => body.widthOfTextAtSize(s, size) <= avail();
    for (const word of text.split(/\s+/)) {
      if (word.includes(H)) {
        const [a, b] = word.split(H);
        const head = (line ? line + ' ' : '') + a + '-';
        if (fits(head)) { out.push({ text: head, indent: first && indent }); first = false; line = b; continue; }
        out.push({ text: line, indent: first && indent }); first = false; line = a + b; continue;
      }
      const t = line ? line + ' ' + word : word;
      if (fits(t)) line = t; else { out.push({ text: line, indent: first && indent }); first = false; line = word; }
    }
    if (line) out.push({ text: line, indent: first && indent });
    return out;
  };

  for (const [ci, ch] of chapters.entries()) {
    newPage();
    outlineTargets.push({ title: ch.title, level: 1, page: pages.length - 1 });
    page.drawText(ch.title, { x: M, y: y, size: 24, font: bold });
    y -= 52;
    const paras = makeParagraphs(ch.sentences, 7 + ci);
    let subDone = !ch.sub;
    for (const [pi, p] of paras.entries()) {
      if (!subDone && pi === 6) {
        if (y < 140) newPage();
        y -= 10;
        page.drawText(ch.sub, { x: M, y, size: 15, font: bold });
        outlineTargets.push({ title: ch.sub, level: 2, page: pages.length - 1 });
        y -= 28; subDone = true;
      }
      for (const l of wrapLines(p, ch.indent)) {
        if (y < 90) newPage();
        page.drawText(l.text, { x: M + (l.indent ? 22 : 0), y, size, font: body });
        y -= lead;
      }
      if (ch.gap) y -= 9;
    }
  }
  // running header + footer on every page
  pages.forEach((pg, i) => {
    const hw = body.widthOfTextAtSize(BOOK, 9);
    pg.drawText(BOOK, { x: (W - hw) / 2, y: Hh - 38, size: 9, font: body, color: rgb(0.35, 0.35, 0.35) });
    const f = `${i + 1}`;
    pg.drawText(f, { x: (W - body.widthOfTextAtSize(f, 10)) / 2, y: 34, size: 10, font: body });
  });

  if (withOutline) {
    const ctx = pdf.context;
    const outlinesRef = ctx.nextRef();
    const refs = outlineTargets.map(() => ctx.nextRef());
    const top = outlineTargets.map((t, i) => i).filter((i) => outlineTargets[i].level === 1);
    const children = (i) => { const out = []; for (let j = i + 1; j < outlineTargets.length && outlineTargets[j].level === 2; j++) out.push(j); return out; };
    const dictFor = (i, parent, prev, next, kids) => {
      const t = outlineTargets[i];
      const d = ctx.obj({ Title: PDFHexString.fromText(t.title), Parent: parent, Dest: [pages[t.page].ref, 'XYZ', null, null, null] });
      if (prev) d.set(PDFName.of('Prev'), prev);
      if (next) d.set(PDFName.of('Next'), next);
      if (kids.length) { d.set(PDFName.of('First'), refs[kids[0]]); d.set(PDFName.of('Last'), refs[kids[kids.length - 1]]); d.set(PDFName.of('Count'), ctx.obj(kids.length)); }
      return d;
    };
    top.forEach((i, k) => {
      const kids = children(i);
      ctx.assign(refs[i], dictFor(i, outlinesRef, top[k - 1] != null ? refs[top[k - 1]] : null, top[k + 1] != null ? refs[top[k + 1]] : null, kids));
      kids.forEach((j, kk) => ctx.assign(refs[j], dictFor(j, refs[i], kids[kk - 1] != null ? refs[kids[kk - 1]] : null, kids[kk + 1] != null ? refs[kids[kk + 1]] : null, [])));
    });
    ctx.assign(outlinesRef, ctx.obj({ Type: 'Outlines', First: refs[top[0]], Last: refs[top[top.length - 1]], Count: outlineTargets.length }));
    pdf.catalog.set(PDFName.of('Outlines'), outlinesRef);
  }
  return { bytes: await pdf.save(), pages: pages.length };
}

mkdirSync(join(root, 'public'), { recursive: true });
mkdirSync(join(root, 'scripts', 'fixtures'), { recursive: true });
const a = await build(true);
writeFileSync(join(root, 'scripts', 'fixtures', 'sample.pdf'), a.bytes);
const b = await build(false);
writeFileSync(join(root, 'scripts', 'fixtures', 'sample-nooutline.pdf'), b.bytes);
console.log(`wrote scripts/fixtures/sample.pdf (${a.pages} pages, ${a.bytes.length} bytes) and scripts/fixtures/sample-nooutline.pdf`);
