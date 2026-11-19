// DOM-free PDF text extraction: pdf.js document in -> clean Sections out.
// Everything here is testable in Node (see scripts/test-pdf.mjs).
import { makeSection, normalize } from '../text';
import type { Section } from '../types';

// ─── minimal structural types of the pdf.js API we use ───
export interface TextItemLike { str: string; transform: number[]; width: number; height: number }
export interface PdfPageLike {
  view: number[];
  getTextContent(): Promise<{ items: unknown[] }>;
  cleanup?(): unknown;
}
export interface PdfDocLike {
  numPages: number;
  getPage(n: number): Promise<PdfPageLike>;
  getOutline(): Promise<OutlineNode[] | null>;
  getDestination(id: string): Promise<unknown[] | null>;
  getPageIndex(ref: unknown): Promise<number>;
}
export interface OutlineNode { title: string; dest?: unknown; items?: OutlineNode[] }

export interface Line {
  text: string;
  x: number; xEnd: number;
  /** distance of the baseline from the top of the page, in points */
  y: number;
  size: number;
  page: number; // 0-based
  // computed by computeFlags()
  para?: boolean; // starts a new paragraph
  short?: boolean; // ends noticeably before the right edge
}
export interface PageLines { index: number; width: number; height: number; lines: Line[] }

export interface ExtractOptions {
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  /** yield to the event loop every N pages (default 4) */
  yieldEvery?: number;
}
export interface ExtractResult {
  sections: Section[];
  totalChars: number;
  pageCount: number;
  method: 'outline' | 'headings' | 'pages';
}

const tick = () => new Promise<void>((r) => setTimeout(r));

// ─── 1. text items -> lines ───
export function pageToLines(tc: { items: unknown[] }, p: { index: number; width: number; height: number; originY?: number }): PageLines {
  type It = { str: string; x: number; y: number; w: number; size: number };
  const items: It[] = [];
  for (const raw of tc.items) {
    const it = raw as Partial<TextItemLike>;
    if (typeof it.str !== 'string' || !it.transform) continue;
    const t = it.transform;
    if (Math.abs(t[1]) > Math.abs(t[0])) continue; // rotated text (margin stamps etc.)
    if (!it.str.trim()) continue;
    const size = Math.hypot(t[2], t[3]) || it.height || Math.hypot(t[0], t[1]) || 10;
    items.push({ str: it.str, x: t[4], y: p.height - (t[5] - (p.originY ?? 0)), w: it.width ?? 0, size });
  }
  items.sort((a, b) => a.y - b.y || a.x - b.x);

  const clusters: It[][] = [];
  let cur: It[] = [];
  let ref = 0, refSize = 0;
  for (const it of items) {
    if (cur.length && Math.abs(it.y - ref) <= 0.45 * Math.max(refSize, it.size)) {
      cur.push(it);
      if (it.size > refSize) { refSize = it.size; ref = it.y; }
    } else {
      if (cur.length) clusters.push(cur);
      cur = [it]; ref = it.y; refSize = it.size;
    }
  }
  if (cur.length) clusters.push(cur);

  const lines: Line[] = [];
  for (const c of clusters) {
    c.sort((a, b) => a.x - b.x);
    let text = '';
    let prevEnd: number | null = null;
    const sizeChars = new Map<number, number>();
    for (const it of c) {
      if (prevEnd !== null && it.x - prevEnd > 0.15 * it.size && !text.endsWith(' ') && !it.str.startsWith(' ')) text += ' ';
      text += it.str;
      prevEnd = it.x + it.w;
      const k = Math.round(it.size * 2) / 2;
      sizeChars.set(k, (sizeChars.get(k) ?? 0) + it.str.length);
    }
    text = normalize(text);
    if (!text) continue;
    let size = c[0].size, best = -1;
    for (const [k, n] of sizeChars) if (n > best) { best = n; size = k; }
    lines.push({
      text, x: c[0].x, xEnd: Math.max(...c.map((i) => i.x + i.w)),
      y: c.reduce((m, i) => Math.max(m, i.y), 0) , size, page: p.index,
    });
  }
  lines.sort((a, b) => a.y - b.y);
  return { index: p.index, width: p.width, height: p.height, lines };
}

// ─── 2. running headers / footers / page numbers ───
const PAGE_NUM = /^(?:(?:page|p\.?)\s*)?[-–—[(]?\s*(?:\d{1,5}|[ivxlcdm]{1,7})\s*[-–—\])]?(?:\s*(?:of|\/)\s*\d{1,5})?$/i;
const digitsKey = (s: string) => s.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();

export function stripMargins(pages: PageLines[]): { removed: number } {
  const counts = new Map<string, number>();
  const inZone = (l: Line, h: number, f: number) => l.y < h * f || l.y > h * (1 - f);
  for (const p of pages) {
    const seen = new Set<string>();
    for (const l of p.lines) if (inZone(l, p.height, 0.08)) seen.add(digitsKey(l.text));
    for (const k of seen) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const threshold = Math.max(3, Math.ceil(pages.length * 0.08));
  let removed = 0;
  for (const p of pages) {
    const keep = p.lines.filter((l) => {
      const margin = inZone(l, p.height, 0.08);
      const wideMargin = inZone(l, p.height, 0.12);
      const bad =
        (margin && (counts.get(digitsKey(l.text)) ?? 0) >= threshold) ||
        (wideMargin && PAGE_NUM.test(l.text));
      if (bad) removed++;
      return !bad;
    });
    p.lines = keep;
  }
  return { removed };
}

// ─── 3. paragraphs ───
export function medianBodySize(pages: PageLines[]): number {
  const w = new Map<number, number>();
  for (const p of pages) for (const l of p.lines) w.set(l.size, (w.get(l.size) ?? 0) + l.text.length);
  let best = 10, n = -1;
  for (const [s, c] of w) if (c > n) { n = c; best = s; }
  return best;
}
const quantile = (a: number[], q: number) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const endsTerminal = (t: string) => /[.!?]["'”’)\]]*$/.test(t);

/** Flattens pages into one line stream and sets `para` / `short` flags. */
export function computeFlags(pages: PageLines[], body: number): Line[] {
  const flat: Line[] = [];
  for (const p of pages) {
    const ls = p.lines;
    if (!ls.length) continue;
    const bodyLines = ls.filter((l) => Math.abs(l.size - body) <= 0.15 * body);
    const left = quantile((bodyLines.length ? bodyLines : ls).map((l) => l.x), 0.25);
    const right = quantile((bodyLines.length ? bodyLines : ls).map((l) => l.xEnd), 0.9);
    const dys: number[] = [];
    for (let i = 1; i < ls.length; i++) {
      const dy = ls[i].y - ls[i - 1].y;
      if (dy > 0 && dy < ls[i].size * 2.2 && Math.abs(ls[i].size - body) <= 0.15 * body) dys.push(dy);
    }
    const pitch = quantile(dys, 0.5) || body * 1.25;
    for (let i = 0; i < ls.length; i++) {
      const l = ls[i];
      l.short = l.xEnd < right - 2.5 * l.size && bodyLines.length > 2;
      const prev = i > 0 ? ls[i - 1] : flat[flat.length - 1];
      const indent = l.x - left > 0.8 * l.size && l.x - left < 6 * l.size;
      if (!prev) l.para = true;
      else if (Math.abs(l.size - prev.size) > 0.18 * prev.size) l.para = true;
      else if (i === 0) l.para = (prev.short && endsTerminal(prev.text)) || (indent && endsTerminal(prev.text));
      else l.para = l.y - prev.y > 1.45 * pitch || indent || (!!prev.short && endsTerminal(prev.text));
      flat.push(l);
    }
  }
  return flat;
}

const KEEP_HYPHEN = new Set([
  'well', 'self', 'non', 'ex', 'all', 'half', 'high', 'low', 'long', 'short', 'old', 'new', 'full', 'ill',
  'cross', 'mid', 'vice', 'anti', 'quasi', 'semi', 'co', 'pro', 'multi', 'open', 'hard', 'soft', 'built',
  'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety', 'one', 'two', 'three', 'four',
  'five', 'six', 'seven', 'eight', 'nine', 'ten', 'first', 'second', 'third', 'state', 'right', 'left', 'real',
  'day', 'year', 'world', 'time', 'life', 'part', 'so', 'by', 'up', 'in', 'on', 'out',
]);

/** Joins the lines of one paragraph, repairing hyphenated line breaks. */
export function joinLines(texts: string[]): string {
  let out = '';
  for (const t of texts) {
    if (!out) { out = t; continue; }
    const m = out.match(/([A-Za-zÀ-ɏ]+)-$/);
    if (m && /^[a-zß-ɏ]/.test(t)) {
      out = KEEP_HYPHEN.has(m[1].toLowerCase()) ? out + t : out.slice(0, -1) + t;
    } else if (m && /^[A-Z0-9]/.test(t)) {
      out += t; // real hyphen before a capital / number: "Anglo-Saxon"
    } else if (/[—–]$/.test(out)) {
      out += t;
    } else out += ' ' + t;
  }
  return out;
}

export function linesToParagraphs(lines: Line[]): string[] {
  const paras: string[][] = [];
  lines.forEach((l, i) => {
    if (i === 0 || l.para) paras.push([l.text]);
    else paras[paras.length - 1].push(l.text);
  });
  return paras.map(joinLines);
}

// ─── 4. chapters ───
const NUMWORDS = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth';
export const CHAPTER_RE = new RegExp(`^(chapter|part|book|section|prologue|epilogue|preface|foreword|introduction|appendix)\\b(\\s+([0-9]+|[ivxlc]+|${NUMWORDS})\\b)?`, 'i');
const looseNum = new RegExp(`^(chapter|part|book|section|appendix)\\s+([0-9]+|[ivxlc]+|${NUMWORDS})\\b`, 'i');

interface Mark { lineIdx: number; drop: number; title: string; level: number; page: number }

const letters = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

export function detectHeadings(flat: Line[], body: number): Mark[] {
  const big = (l: Line) => l.size >= body * 1.22;
  const raw: { idx: number; pattern: boolean }[] = [];
  for (let i = 0; i < flat.length; i++) {
    const l = flat[i];
    if (!l.para) continue;
    const next = flat[i + 1];
    const standalone = !next || next.para || (big(l) && big(next) && next.page === l.page);
    if (!standalone) continue;
    const len = l.text.length;
    const pattern = looseNum.test(l.text) || (CHAPTER_RE.test(l.text) && len <= 40);
    if (len < 3 || len > 90 || !/\p{L}/u.test(l.text)) continue;
    if ((big(l) && !/[,;]$/.test(l.text)) || (pattern && len <= 70 && (big(l) || !endsTerminal(l.text) || len <= 20))) {
      raw.push({ idx: i, pattern });
    }
  }
  // merge adjacent heading lines (e.g. "Chapter 1" + "The Beginning")
  const marks: Mark[] = [];
  const anyPattern = raw.some((r) => r.pattern);
  for (let k = 0; k < raw.length; k++) {
    const start = raw[k].idx;
    let end = start;
    let title = flat[start].text;
    let pattern = raw[k].pattern;
    while (k + 1 < raw.length && raw[k + 1].idx === end + 1 && flat[end + 1].page === flat[start].page) {
      k++; end++;
      title += (/[:\-–—]$/.test(title) ? ' ' : ': ') + flat[end].text;
      pattern ||= raw[k].pattern;
    }
    marks.push({ lineIdx: start, drop: end - start + 1, title, level: anyPattern && !pattern ? 2 : 1, page: flat[start].page + 1 });
  }
  // In pattern mode, only keep non-pattern (level 2) marks if chapters exist
  return marks;
}

async function resolveOutline(doc: PdfDocLike): Promise<{ title: string; level: number; pageIndex: number }[]> {
  let outline: OutlineNode[] | null = null;
  try { outline = await doc.getOutline(); } catch { return []; }
  if (!outline?.length) return [];
  const out: { title: string; level: number; pageIndex: number }[] = [];
  const walk = async (nodes: OutlineNode[], level: number) => {
    for (const n of nodes) {
      if (out.length > 3000) return;
      try {
        let dest = n.dest as unknown;
        if (typeof dest === 'string') dest = await doc.getDestination(dest);
        if (Array.isArray(dest) && dest.length) {
          const ref = dest[0];
          const idx = typeof ref === 'number' ? ref : ref && typeof ref === 'object' ? await doc.getPageIndex(ref) : -1;
          const title = normalize(n.title || '');
          if (idx >= 0 && title) out.push({ title, level: Math.min(level, 2), pageIndex: idx });
        }
      } catch { /* unresolved destination: skip */ }
      if (n.items?.length) await walk(n.items, level + 1);
    }
  };
  await walk(outline, 1);
  return out;
}

function marksFromOutline(flat: Line[], entries: { title: string; level: number; pageIndex: number }[]): Mark[] {
  const pageStart = new Map<number, number>();
  const firstAtOrAfter = (page: number) => {
    if (pageStart.has(page)) return pageStart.get(page)!;
    let lo = 0, hi = flat.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (flat[mid].page < page) lo = mid + 1; else hi = mid; }
    pageStart.set(page, lo);
    return lo;
  };
  const marks: Mark[] = [];
  let floor = 0;
  for (const e of entries) {
    let idx = Math.max(firstAtOrAfter(e.pageIndex), floor);
    let drop = 0;
    const tN = letters(e.title);
    if (tN.length >= 2) {
      for (let j = idx; j < flat.length && flat[j].page === e.pageIndex; j++) {
        const lN = letters(flat[j].text);
        if (lN.length < 2 || lN.length > tN.length * 2 + 10) continue;
        const ok = tN.startsWith(lN) || lN.startsWith(tN) || (tN.length >= 4 && lN.includes(tN));
        if (!ok) continue;
        let acc = lN, k = j;
        while (acc.length < tN.length && k + 1 < flat.length && flat[k + 1].page === e.pageIndex && tN.startsWith(acc + letters(flat[k + 1].text))) {
          acc += letters(flat[k + 1].text); k++;
        }
        idx = j; drop = k - j + 1;
        break;
      }
    }
    marks.push({ lineIdx: idx, drop, title: e.title, level: e.level, page: e.pageIndex + 1 });
    floor = idx + drop;
  }
  return marks;
}

function sectionsFromMarks(flat: Line[], marks: Mark[]): Section[] {
  const out: Section[] = [];
  const mk = (title: string, level: number, lines: Line[], page?: number) => {
    if (!lines.length) return;
    const s = makeSection(title, level, linesToParagraphs(lines), page ?? lines[0].page + 1);
    if (s.sentences.length) out.push(s);
  };
  if (marks.length && marks[0].lineIdx > 0) mk('Beginning', 1, flat.slice(0, marks[0].lineIdx));
  if (!marks.length) mk('Text', 1, flat);
  marks.forEach((m, i) => {
    const from = m.lineIdx + m.drop;
    const to = i + 1 < marks.length ? Math.max(marks[i + 1].lineIdx, from) : flat.length;
    mk(m.title, m.level, flat.slice(from, to), m.page);
  });
  return out;
}

function sectionsByPages(flat: Line[], pageCount: number, per = 10): Section[] {
  const out: Section[] = [];
  for (let a = 0; a < pageCount; a += per) {
    const b = Math.min(pageCount, a + per);
    const lines = flat.filter((l) => l.page >= a && l.page < b);
    if (!lines.length) continue;
    const s = makeSection(`Pages ${a + 1}–${b}`, 1, linesToParagraphs(lines), a + 1);
    if (s.sentences.length) out.push(s);
  }
  return out;
}

/** Merges sections under `min` chars into the following one (or previous, for the last). */
export function mergeTiny(sections: Section[], min = 200): Section[] {
  const out: Section[] = [];
  let carry: string[] = [];
  const rebuild = (s: Section, sentences: string[]): Section => ({ ...s, sentences, charCount: sentences.reduce((n, x) => n + x.length, 0) });
  for (const s of sections) {
    if (!s.sentences.length) continue;
    const merged = carry.length ? rebuild(s, [...carry, ...s.sentences]) : s;
    carry = [];
    if (merged.charCount < min) carry = merged.sentences;
    else out.push(merged);
  }
  if (carry.length) {
    if (out.length) { const last = out[out.length - 1]; out[out.length - 1] = rebuild(last, [...last.sentences, ...carry]); }
    else out.push({ title: sections[0]?.title ?? 'Text', level: 1, sentences: carry, charCount: carry.reduce((n, x) => n + x.length, 0), page: sections[0]?.page });
  }
  return out;
}

// ─── driver ───
export async function extractDocument(doc: PdfDocLike, opts: ExtractOptions = {}): Promise<ExtractResult> {
  const n = doc.numPages;
  const every = opts.yieldEvery ?? 4;
  const pages: PageLines[] = [];
  for (let i = 1; i <= n; i++) {
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const page = await doc.getPage(i);
    const [x0, y0, x1, y1] = page.view;
    const tc = await page.getTextContent();
    pages.push(pageToLines(tc, { index: i - 1, width: x1 - x0, height: y1 - y0, originY: y0 }));
    page.cleanup?.();
    if (i % every === 0 || i === n) {
      opts.onProgress?.((i / n) * 0.9);
      await tick();
    }
  }

  stripMargins(pages);
  const body = medianBodySize(pages);
  const flat = computeFlags(pages, body);
  await tick();

  let sections: Section[] = [];
  let method: ExtractResult['method'] = 'pages';

  const entries = await resolveOutline(doc);
  if (entries.length >= 2) {
    const s = mergeTiny(sectionsFromMarks(flat, marksFromOutline(flat, entries)));
    if (s.length >= 2) { sections = s; method = 'outline'; }
  }
  if (!sections.length) {
    const marks = detectHeadings(flat, body);
    if (marks.length >= 2 && marks.length <= Math.max(6, n)) {
      const s = mergeTiny(sectionsFromMarks(flat, marks));
      if (s.length >= 2) { sections = s; method = 'headings'; }
    }
  }
  if (!sections.length) sections = mergeTiny(sectionsByPages(flat, n));

  opts.onProgress?.(1);
  return { sections, totalChars: sections.reduce((a, s) => a + s.charCount, 0), pageCount: n, method };
}
