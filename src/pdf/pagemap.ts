// Backfills per-sentence page numbers for books imported before `Section.pages` existed.
import { getContent, getFile, getItem, notify, putContent, updateItem } from '../db';
import type { DocContent, Section } from '../types';
import { extractDocument, type PdfDocLike } from './extract';

const hasPages = (c: DocContent | undefined | null) =>
  !!c && c.sections.length > 0 && c.sections.every((s) => s.pages?.length === s.sentences.length);

const inflight = new Map<string, Promise<DocContent | null>>();

/**
 * Makes sure the stored content of a PDF book has `pages` (and `paragraphs`) on every section.
 * Re-extracts from the stored PDF. If the new sentences are identical to the stored ones (the usual
 * case) only the page data is added and the reading position is untouched. Otherwise the new content
 * replaces the old and the saved position is mapped by section index and clamped.
 *
 * `into`: optionally patch this (already loaded) DocContent object in place as well, so a player that
 * holds it in its state sees the pages without reloading.
 * Returns the content with pages, or null when impossible (no PDF file, EPUB/article, failure).
 */
export function ensurePageMap(itemId: string, into?: DocContent): Promise<DocContent | null> {
  let p = inflight.get(itemId);
  if (!p) {
    p = run(itemId).finally(() => inflight.delete(itemId));
    inflight.set(itemId, p);
  }
  return p.then((c) => {
    if (c && into && into.id === c.id) into.sections = c.sections;
    return c;
  });
}

async function run(itemId: string): Promise<DocContent | null> {
  const item = await getItem(itemId);
  if (!item || item.kind !== 'book' || item.format === 'epub' || item.status !== 'ready') return null;
  const stored = await getContent(itemId);
  if (!stored) return null;
  if (hasPages(stored)) return stored;
  const rec = await getFile(itemId);
  if (!rec) return null;

  let task: { destroy(): Promise<void> } | undefined;
  try {
    const { loadPdfjs } = await import('./loader');
    const pdfjs = await loadPdfjs();
    const t = pdfjs.getDocument({ data: new Uint8Array(await rec.blob.arrayBuffer()) });
    task = t;
    const doc = await t.promise;
    const r = await extractDocument(doc as unknown as PdfDocLike);
    if (!r.sections.length) return null;

    const same =
      r.sections.length === stored.sections.length &&
      r.sections.every((s, i) => {
        const o = stored.sections[i];
        return s.sentences.length === o.sentences.length && s.sentences.every((x, j) => x === o.sentences[j]);
      });

    if (same) {
      const sections: Section[] = stored.sections.map((o, i) => ({
        ...o, pages: r.sections[i].pages, paragraphs: o.paragraphs ?? r.sections[i].paragraphs,
      }));
      const content: DocContent = { id: itemId, sections };
      await putContent(content);
      notify('items');
      return content;
    }

    // Extraction changed since import: keep the new text, map the saved position by section index.
    const content: DocContent = { id: itemId, sections: r.sections };
    await putContent(content);
    const si = Math.min(item.position.section, r.sections.length - 1);
    const sj = Math.min(item.position.sentence, r.sections[si].sentences.length - 1);
    await updateItem(itemId, {
      totalChars: r.totalChars, sectionCount: r.sections.length,
      position: { section: si, sentence: Math.max(0, sj), updatedAt: item.position.updatedAt },
    });
    return content;
  } catch (e) {
    console.warn('ensurePageMap failed', e);
    return null;
  } finally {
    try { await task?.destroy(); } catch { /* ignore */ }
  }
}
