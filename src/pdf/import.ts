// PDF import: creates shelf items immediately, then processes them one at a time in the background.
import { getFile, getItem, listItems, putContent, putCover, putFile, putItem, uid, updateItem } from '../db';
import type { Item } from '../types';
import { extractDocument, type PdfDocLike } from './extract';

const isPdf = (f: File) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);

export function titleFromFilename(name: string): string {
  return name.replace(/\.pdf$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Untitled';
}

function saneMeta(s: unknown, max: number): string | undefined {
  if (typeof s !== 'string') return undefined;
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length < 3 || t.length > max) return undefined;
  if (/^(untitled|microsoft word|slide \d|document\d*|unknown|none|null)\b/i.test(t)) return undefined;
  if (/\.(docx?|pdf|indd|tex|qxd|rtf|txt)$/i.test(t) || /^[\w-]+\.\w{2,4}$/.test(t)) return undefined;
  if (!/\p{L}{2}/u.test(t)) return undefined;
  return t;
}

const active = new Set<string>();
let queue: Promise<unknown> = Promise.resolve();

function enqueue(id: string) {
  if (active.has(id)) return;
  active.add(id);
  queue = queue.then(() => processBook(id)).catch((e) => console.error(e)).finally(() => active.delete(id));
}

/** Adds PDFs to the shelf (visible immediately) and processes them in the background. Returns the new ids. */
export async function importPdfs(files: File[]): Promise<string[]> {
  const ids: string[] = [];
  for (const f of files) {
    if (!isPdf(f)) continue;
    const id = uid('b_');
    const item: Item = {
      id, kind: 'book', status: 'processing', processingProgress: 0,
      title: titleFromFilename(f.name), addedAt: Date.now(),
      position: { section: 0, sentence: 0, updatedAt: Date.now() }, totalChars: 0, sectionCount: 0,
    };
    await putFile(id, f, f.name);
    await putItem(item);
    ids.push(id);
    enqueue(id);
  }
  return ids;
}

/** Restarts processing for books left in 'processing' by a closed tab. Call on library mount. */
export async function resumeStalled() {
  for (const it of await listItems('book')) if (it.status === 'processing' && !active.has(it.id)) enqueue(it.id);
}

async function processBook(id: string) {
  const fail = (msg: string) => updateItem(id, { status: 'error', error: msg, processingProgress: undefined });
  const rec = await getFile(id);
  if (!rec) { await fail('The PDF file is missing. Delete this book and add it again.'); return; }
  let task: { destroy(): Promise<void> } | undefined;
  let doc: Awaited<ReturnType<Awaited<ReturnType<typeof import('./loader').loadPdfjs>>['getDocument']>['promise']> | undefined;
  try {
    const { loadPdfjs } = await import('./loader');
    const pdfjs = await loadPdfjs();
    const data = new Uint8Array(await rec.blob.arrayBuffer());
    try {
      const t = pdfjs.getDocument({ data });
      task = t;
      doc = await t.promise;
    } catch (e) {
      const name = (e as { name?: string })?.name;
      await fail(name === 'PasswordException' ? 'This PDF is password-protected.' : 'Could not read this file. It may be damaged.');
      return;
    }

    // Metadata
    try {
      const meta = await doc.getMetadata();
      const info = (meta?.info ?? {}) as Record<string, unknown>;
      const title = saneMeta(info.Title, 140), author = saneMeta(info.Author, 100);
      const cur = await getItem(id);
      await updateItem(id, { ...(author ? { author } : {}), ...(title && cur && cur.title === titleFromFilename(rec.name) ? { title } : {}) });
    } catch { /* optional */ }

    // Cover (best effort)
    try {
      const { renderCoverBlob } = await import('./cover');
      const page = await doc.getPage(1);
      const blob = await renderCoverBlob(page);
      page.cleanup();
      if (blob) { await putCover(id, blob); await updateItem(id, { hasCover: true }); }
    } catch (e) { console.warn('cover failed', e); }

    // Text
    let last = 0;
    const result = await extractDocument(doc as unknown as PdfDocLike, {
      onProgress: (f) => {
        const now = Date.now();
        if (now - last > 400 && f < 1) { last = now; void updateItem(id, { processingProgress: f }); }
      },
    });

    if (!result.sections.length || result.totalChars < Math.max(200, result.pageCount * 10)) {
      await updateItem(id, { status: 'no-text', error: 'No readable text found. This looks like a scanned PDF.', processingProgress: undefined });
      return;
    }
    await putContent({ id, sections: result.sections });
    await updateItem(id, {
      status: 'ready', totalChars: result.totalChars, sectionCount: result.sections.length,
      processingProgress: undefined, error: undefined,
    });
  } catch (e) {
    console.error(e);
    await fail('Something went wrong while reading this PDF.');
  } finally {
    try { await task?.destroy(); } catch { /* ignore */ }
  }
}
