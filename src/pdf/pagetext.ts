// DOM-free helpers for the page view: map sentences <-> pdf.js text items on a page.
// Matching works on an "alnum key": lowercase letters+digits only (NFKC), so hyphenation joins,
// whitespace and punctuation differences between the extracted sentence and the page's raw
// text items don't matter. Testable in Node (scripts/test-pdf.mjs).

export interface PtItem { str: string; transform: number[]; width: number; height: number }
export interface PageText {
  /** concatenated alnum key of the whole page */
  key: string;
  /** key index -> index into `items` */
  itemOf: Int32Array;
  /** key index -> char index inside that item's `str` */
  charOf: Int32Array;
  items: PtItem[];
  /** first key index of each item (-1 when the item contributes no key chars) */
  itemKeyStart: number[];
}

const KEPT = /[\p{L}\p{N}]/u;

/** Appends the key chars for `ch` (one source char) to `out`. */
function keyChars(ch: string, out: string[]) {
  const n = ch.normalize('NFKC').toLowerCase();
  for (const c of n) if (KEPT.test(c)) out.push(c);
}

export function keyOf(s: string): string {
  const out: string[] = [];
  for (const ch of s) keyChars(ch, out);
  return out.join('');
}

export function buildPageText(tc: { items: unknown[] }): PageText {
  const items: PtItem[] = [];
  const itemKeyStart: number[] = [];
  const keyArr: string[] = [];
  const itemOf: number[] = [];
  const charOf: number[] = [];
  for (const raw of tc.items) {
    const it = raw as Partial<PtItem>;
    if (typeof it.str !== 'string' || !it.transform) continue;
    const idx = items.length;
    items.push({ str: it.str, transform: it.transform, width: it.width ?? 0, height: it.height ?? 0 });
    itemKeyStart.push(-1);
    let ci = 0;
    for (const ch of it.str) {
      const before = keyArr.length;
      keyChars(ch, keyArr);
      if (keyArr.length > before) {
        if (itemKeyStart[idx] < 0) itemKeyStart[idx] = before;
        for (let k = before; k < keyArr.length; k++) { itemOf.push(idx); charOf.push(ci); }
      }
      ci += ch.length;
    }
  }
  return { key: keyArr.join(''), itemOf: Int32Array.from(itemOf), charOf: Int32Array.from(charOf), items, itemKeyStart };
}

export interface KeyRange { start: number; end: number }

/** Finds `sKey` in the page key at or after `from`; falls back to prefixes (the sentence may run off the page). */
export function findKey(pt: PageText, sKey: string, from = 0): KeyRange | null {
  if (!sKey) return null;
  const hay = pt.key;
  let i = hay.indexOf(sKey, from);
  if (i >= 0) return { start: i, end: i + sKey.length };
  for (const n of [40, 20]) {
    if (sKey.length <= n) continue;
    const pre = sKey.slice(0, n);
    i = hay.indexOf(pre, from);
    if (i < 0) continue;
    // end: look for the sentence's tail nearby; else assume same length (clipped to the page)
    const tail = sKey.slice(-Math.min(24, sKey.length - n));
    const j = tail.length >= 6 ? hay.indexOf(tail, i + n) : -1;
    const end = j >= 0 && j - i < sKey.length * 1.6 + 40 ? j + tail.length : Math.min(hay.length, i + sKey.length);
    return { start: i, end };
  }
  return null;
}

/**
 * Locates sentences (which appear on this page in reading order) within the page key.
 * A moving cursor disambiguates repeated sentences; unmatched sentences give null.
 */
export function layoutSentences(pt: PageText, sentences: string[]): (KeyRange | null)[] {
  let cursor = 0;
  return sentences.map((s) => {
    const k = keyOf(s);
    const r = findKey(pt, k, cursor) ?? (cursor > 0 ? findKey(pt, k, 0) : null);
    if (r && r.start >= cursor) cursor = r.end;
    return r;
  });
}

export interface Rect { x: number; y: number; w: number; h: number } // fractions of the page (0..1)

/** Bounding box (in viewport fractions) + endpoints of the char range [c0, c1) of an item. */
function itemBox(it: PtItem, c0: number, c1: number, m: number[], vw: number, vh: number) {
  const [a, b, c, d, e, f] = it.transform;
  const len = Math.max(1, it.str.length);
  const du = Math.hypot(a, b) || 1, nu = Math.hypot(c, d) || 1;
  const ux = a / du, uy = b / du, nx = c / nu, ny = d / nu;
  const hgt = it.height || nu;
  const w = it.width || du * len * 0.5;
  const s0 = (c0 / len) * w, s1 = (c1 / len) * w;
  const pts = [[s0, -0.22 * hgt], [s1, -0.22 * hgt], [s1, 0.92 * hgt], [s0, 0.92 * hgt]].map(([s, t]) => {
    const x = e + ux * s + nx * t, y = f + uy * s + ny * t;
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  });
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const mid = (i: number, j: number) => [(pts[i][0] + pts[j][0]) / 2, (pts[i][1] + pts[j][1]) / 2];
  return {
    rect: { x: x0 / vw, y: y0 / vh, w: (x1 - x0) / vw, h: (y1 - y0) / vh } as Rect,
    a: mid(0, 3), z: mid(1, 2), // left / right mid-points in viewport units
  };
}

/** Rectangles (page fractions) covering key range [start, end), merged per line. `m` = viewport.transform at scale 1. */
export function rectsFor(pt: PageText, r: KeyRange, m: number[], vw: number, vh: number): Rect[] {
  if (r.end <= r.start || r.start >= pt.itemOf.length) return [];
  const last = Math.min(r.end, pt.itemOf.length) - 1;
  const i0 = pt.itemOf[r.start], i1 = pt.itemOf[last];
  const raw: Rect[] = [];
  for (let i = i0; i <= i1; i++) {
    const it = pt.items[i];
    if (!it.str.trim()) continue;
    const c0 = i === i0 ? pt.charOf[r.start] : 0;
    const c1 = i === i1 ? pt.charOf[last] + 1 : it.str.length;
    raw.push(itemBox(it, c0, Math.max(c1, c0 + 1), m, vw, vh).rect);
  }
  const out: Rect[] = [];
  for (const q of raw) {
    const p = out[out.length - 1];
    const overlap = p ? Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y) : 0;
    const gap = p ? q.x - (p.x + p.w) : 0;
    if (p && overlap > 0.5 * Math.min(p.h, q.h) && gap < Math.max(q.h * 1.2, 0.012) && gap > -0.2) {
      const x0 = Math.min(p.x, q.x), x1 = Math.max(p.x + p.w, q.x + q.w), y0 = Math.min(p.y, q.y), y1 = Math.max(p.y + p.h, q.y + q.h);
      out[out.length - 1] = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    } else out.push({ ...q });
  }
  return out;
}

export interface Hit { item: number; char: number; rect: Rect; keyIndex: number }

/** Text item under the point (page fractions), the char offset within it, and its key index. */
export function hitTest(pt: PageText, fx: number, fy: number, m: number[], vw: number, vh: number): Hit | null {
  let best: { i: number; d: number } | null = null;
  for (let i = 0; i < pt.items.length; i++) {
    const it = pt.items[i];
    if (!it.str.trim() || pt.itemKeyStart[i] < 0) continue;
    const { rect: r } = itemBox(it, 0, it.str.length, m, vw, vh);
    const padY = r.h * 0.35, padX = r.h * (vh / vw) * 0.5;
    const dx = fx < r.x - padX ? r.x - padX - fx : fx > r.x + r.w + padX ? fx - (r.x + r.w + padX) : 0;
    const dy = fy < r.y - padY ? r.y - padY - fy : fy > r.y + r.h + padY ? fy - (r.y + r.h + padY) : 0;
    if (dx > 0 || dy > 0) continue;
    const d = Math.abs(fy - (r.y + r.h / 2)) + Math.abs(fx - (r.x + r.w / 2)) * 0.1;
    if (!best || d < best.d) best = { i, d };
  }
  if (!best) return null;
  const it = pt.items[best.i];
  const { rect, a, z } = itemBox(it, 0, it.str.length, m, vw, vh);
  const vx = fx * vw, vy = fy * vh;
  const dx = z[0] - a[0], dy = z[1] - a[1];
  const L2 = dx * dx + dy * dy || 1;
  const frac = Math.max(0, Math.min(1, ((vx - a[0]) * dx + (vy - a[1]) * dy) / L2));
  const char = Math.min(it.str.length - 1, Math.floor(frac * it.str.length));
  // key index: first key char of the item + kept chars before `char`
  const before: string[] = [];
  let ci = 0;
  for (const ch of it.str) { if (ci >= char) break; keyChars(ch, before); ci += ch.length; }
  return { item: best.i, char, rect, keyIndex: pt.itemKeyStart[best.i] + before.length };
}

/** Char offset inside `sentence` of the word containing the n-th key char (n = offset from the sentence start). */
export function wordStartAtKey(sentence: string, n: number): number {
  let count = 0, idx = 0;
  const tmp: string[] = [];
  for (const ch of sentence) {
    tmp.length = 0; keyChars(ch, tmp);
    if (count + tmp.length > n) break;
    count += tmp.length; idx += ch.length;
  }
  idx = Math.min(idx, Math.max(0, sentence.length - 1));
  while (idx > 0 && !/\s/.test(sentence[idx - 1])) idx--;
  return idx;
}

/** Rect (page fractions) of the word around `char` in an item — for the tap flash. */
export function wordRect(it: PtItem, char: number, m: number[], vw: number, vh: number): Rect {
  const s = it.str;
  let a = char, b = char + 1;
  while (a > 0 && !/\s/.test(s[a - 1])) a--;
  while (b < s.length && !/\s/.test(s[b])) b++;
  return itemBox(it, a, b, m, vw, vh).rect;
}
