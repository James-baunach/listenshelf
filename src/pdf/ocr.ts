// OCR for scanned PDFs (status 'no-text'): renders each page, recognizes it with tesseract.js
// (worker + core are self-hosted, loaded lazily), then builds sections with the same logic as text PDFs.
import { getFile, getItem, putContent, updateItem } from '../db';
import type { Item } from '../types';
import { sectionsFromPages, type Line, type PageLines, type PdfDocLike } from './extract';
import { saveOcrWords, type OcrLayout } from './ocrlayout';
import { applyOcrParagraphs, ocrPageToLines, type OcrWord } from './ocrparse';

const SCALE = 2; // render scale in px per PDF point (~144 dpi for typical pages)
const MAX_SIDE = 3200; // px
const PAGE_RENDER_TIMEOUT = 45000;

const running = new Map<string, AbortController>();

/** True while OCR is running for this item (this tab). */
export const isOcrRunning = (itemId: string) => running.has(itemId);

/** Stops OCR for an item; it goes back to 'no-text' with a short message. */
export function cancelOcr(itemId: string) { running.get(itemId)?.abort(); }

const abortErr = () => new DOMException('OCR cancelled', 'AbortError');
const withTimeout = <T,>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${what} timed out`)), ms))]);

/** Creates a tesseract worker using same-origin worker + core files (works under COEP and offline after first use). */
async function createOcrWorker(onProgress: (p: number) => void) {
  const [{ createWorker }, workerUrl, coreUrl] = await Promise.all([
    import('tesseract.js'),
    import('tesseract.js/dist/worker.min.js?url').then((m) => m.default),
    // LSTM-only, SIMD, wasm embedded in the JS file: one same-origin file, no separate .wasm fetch.
    import('tesseract.js-core/tesseract-core-simd-lstm.wasm.js?url').then((m) => m.default),
  ]);
  return createWorker('eng', 1 /* OEM.LSTM_ONLY */, {
    workerPath: workerUrl,
    corePath: coreUrl, // ends in .js => loaded as-is
    workerBlobURL: false, // load the worker straight from our origin (a blob: worker can't importScripts a relative URL)
    // langPath left at tesseract.js' default (jsdelivr CDN, CORS-enabled); the traineddata is cached in IndexedDB.
    logger: (m: { status: string; progress: number }) => { if (m.status === 'recognizing text') onProgress(m.progress); },
  });
}

/**
 * Runs OCR on a scanned PDF book: sets status 'processing' with progress, then 'ready'
 * (item.ocr = true) or back to 'no-text' with an error message. Safe to call from anywhere;
 * resolves when finished (never rejects).
 */
export async function ocrBook(itemId: string): Promise<void> {
  if (running.has(itemId)) return;
  const ctl = new AbortController();
  running.set(itemId, ctl);
  const signal = ctl.signal;
  const fail = (msg: string) => updateItem(itemId, { status: 'no-text', error: msg, processingProgress: undefined });

  let task: { destroy(): Promise<void> } | undefined;
  let worker: Awaited<ReturnType<typeof createOcrWorker>> | undefined;
  try {
    const item = await getItem(itemId);
    if (!item || item.kind !== 'book') return;
    const rec = await getFile(itemId);
    if (!rec) { await fail('The PDF file is missing. Delete this book and add it again.'); return; }
    await updateItem(itemId, { status: 'processing', processingProgress: 0, error: undefined });

    const { loadPdfjs } = await import('./loader');
    const pdfjs = await loadPdfjs();
    const t = pdfjs.getDocument({ data: new Uint8Array(await rec.blob.arrayBuffer()) });
    task = t;
    const doc = await t.promise;
    const n = doc.numPages;
    if (signal.aborted) throw abortErr();

    let pageFrac = 0, done = 0, lastWrite = 0;
    const report = (force = false) => {
      const now = Date.now();
      if (!force && now - lastWrite < 500) return;
      lastWrite = now;
      void updateItem(itemId, { processingProgress: Math.min(0.97, ((done + pageFrac) / n) * 0.97) });
    };
    // Models/engine load counts for the first few percent.
    worker = await createOcrWorker((p) => { pageFrac = p; report(); });
    await worker.setParameters({ user_defined_dpi: String(72 * SCALE) });
    if (signal.aborted) throw abortErr();

    const renderPage = async (i: number): Promise<{ canvas: HTMLCanvasElement; scale: number } | null> => {
      const page = await doc.getPage(i);
      try {
        const v1 = page.getViewport({ scale: 1 });
        const scale = Math.min(SCALE, MAX_SIDE / Math.max(v1.width, v1.height));
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(viewport.width));
        canvas.height = Math.max(1, Math.round(viewport.height));
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        const rt = page.render({ canvas, canvasContext: ctx, viewport });
        try { await withTimeout(rt.promise, PAGE_RENDER_TIMEOUT, 'page render'); } catch (e) { try { rt.cancel(); } catch { /* ignore */ } throw e; }
        return { canvas, scale: canvas.width / v1.width };
      } catch (e) {
        console.warn('ocr: page render failed', i, e);
        return null;
      } finally { page.cleanup(); }
    };

    const pages: PageLines[] = [];
    const starts = new Set<Line>();
    const words: OcrWord[][] = [];
    let failedPages = 0;
    let next: Promise<Awaited<ReturnType<typeof renderPage>>> = renderPage(1);
    for (let i = 1; i <= n; i++) {
      if (signal.aborted) throw abortErr();
      const img = await next;
      next = i < n ? renderPage(i + 1) : Promise.resolve(null); // render the next page while this one is recognized
      pageFrac = 0;
      if (!img) { failedPages++; pages.push({ index: i - 1, width: 612, height: 792, lines: [] }); words.push([]); done = i; report(true); continue; }
      let blocks: Parameters<typeof ocrPageToLines>[0];
      try {
        const res = await worker.recognize(img.canvas, {}, { blocks: true });
        blocks = res.data.blocks as typeof blocks;
      } catch (e) {
        if (signal.aborted) throw abortErr();
        console.warn('ocr: recognize failed', i, e);
        failedPages++;
      }
      const op = ocrPageToLines(blocks, { index: i - 1, pxW: img.canvas.width, pxH: img.canvas.height, scale: img.scale });
      img.canvas.width = img.canvas.height = 0;
      pages.push(op.page);
      op.paraStarts.forEach((l) => starts.add(l));
      words.push(op.words);
      done = i; pageFrac = 0; report(true);
    }
    if (signal.aborted) throw abortErr();
    await worker.terminate(); worker = undefined;

    if (failedPages > n / 2) { await fail('Could not read the pages of this PDF (OCR failed).'); return; }

    const { sections } = await sectionsFromPages(doc as unknown as PdfDocLike, pages, (flat) => applyOcrParagraphs(flat, starts));
    const totalChars = sections.reduce((a, s) => a + s.charCount, 0);
    if (!sections.length || totalChars < Math.max(100, n * 5)) {
      await fail('OCR could not find readable text in this PDF.');
      return;
    }
    await putContent({ id: itemId, sections });
    const layout: OcrLayout = { pages: words };
    await saveOcrWords(itemId, layout).catch((e) => console.warn('ocr: could not save word boxes', e));
    const cur = await getItem(itemId);
    const patch: Partial<Item> = {
      status: 'ready', ocr: true, totalChars, sectionCount: sections.length,
      processingProgress: undefined, error: undefined,
      position: { section: 0, sentence: 0, updatedAt: cur?.position?.updatedAt ?? Date.now() },
    };
    await updateItem(itemId, patch);
  } catch (e) {
    const cancelled = signal.aborted || (e as { name?: string })?.name === 'AbortError';
    if (!cancelled) console.error('OCR failed', e);
    await fail(cancelled ? 'Text recognition was cancelled.' : 'Text recognition failed. Check your connection (the language data downloads once) and try again.');
  } finally {
    try { await worker?.terminate(); } catch { /* ignore */ }
    try { await task?.destroy(); } catch { /* ignore */ }
    running.delete(itemId);
  }
}
