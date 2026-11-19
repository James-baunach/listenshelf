// DOM-free conversion of tesseract.js output into the structures the text-PDF pipeline uses.
import type { Line, PageLines } from './extract';

interface TBox { x0: number; y0: number; x1: number; y1: number }
interface TWord { text: string; confidence?: number; bbox: TBox }
interface TLine { text: string; confidence?: number; bbox: TBox; words?: TWord[]; rowAttributes?: { rowHeight?: number } }
interface TPara { lines?: TLine[]; text?: string }
export interface TBlock { paragraphs?: TPara[]; blocktype?: string }

/** [x0, y0, x1, y1, text] with coordinates as fractions of the page image. */
export type OcrWord = [number, number, number, number, string];

export interface OcrPage {
  page: PageLines;
  /** lines that tesseract says begin a paragraph */
  paraStarts: Set<Line>;
  words: OcrWord[];
}

const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] ?? 0; };
const r4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * @param blocks tesseract `data.blocks`
 * @param p page index (0-based), image size in px, and the px-per-point scale it was rendered at
 */
export function ocrPageToLines(blocks: TBlock[] | null | undefined, p: { index: number; pxW: number; pxH: number; scale: number }): OcrPage {
  const lines: Line[] = [];
  const paraStarts = new Set<Line>();
  const words: OcrWord[] = [];
  for (const b of blocks ?? []) {
    // skip non-text blocks if tesseract labels them (images, rules)
    if (b.blocktype && /^(FLOWING_IMAGE|HEADING_IMAGE|PULLOUT_IMAGE|HORZ_LINE|VERT_LINE|NOISE)$/.test(b.blocktype)) continue;
    for (const para of b.paragraphs ?? []) {
      const good = (para.lines ?? []).filter((l) => (l.text ?? '').trim() && /[\p{L}\p{N}]/u.test(l.text) && (l.confidence ?? 100) >= 35);
      if (!good.length) continue;
      const sizes = good.map((l) => (l.rowAttributes?.rowHeight || l.bbox.y1 - l.bbox.y0) / p.scale);
      const size = median(sizes) || 10;
      good.forEach((l, i) => {
        const text = l.text.replace(/\s+/g, ' ').trim();
        const line: Line = {
          text, x: l.bbox.x0 / p.scale, xEnd: l.bbox.x1 / p.scale, y: l.bbox.y1 / p.scale, size, page: p.index,
        };
        lines.push(line);
        if (i === 0) paraStarts.add(line);
        for (const w of l.words ?? []) {
          const t = (w.text ?? '').trim();
          if (!t) continue;
          words.push([r4(w.bbox.x0 / p.pxW), r4(w.bbox.y0 / p.pxH), r4(w.bbox.x1 / p.pxW), r4(w.bbox.y1 / p.pxH), t]);
        }
      });
    }
  }
  lines.sort((a, b) => a.y - b.y || a.x - b.x);
  return { page: { index: p.index, width: p.pxW / p.scale, height: p.pxH / p.scale, lines }, paraStarts, words };
}

/** Paragraph flags from tesseract (except a page's first line, which may continue the previous page). */
export function applyOcrParagraphs(flat: Line[], starts: Set<Line>) {
  flat.forEach((l, i) => {
    const firstOnPage = i === 0 || flat[i - 1].page !== l.page;
    if (starts.has(l) && !firstOnPage) l.para = true;
  });
}
