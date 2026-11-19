// EPUB import: same lifecycle as PDF import (item appears immediately, processed in the background).
import { getFile, getItem, listItems, putContent, putCover, putFile, putItem, uid, updateItem } from '../db';
import type { Item } from '../types';
import { parseEpub, unzipEpub, type ParseDoc } from './parse';

const isEpub = (f: { name: string; type?: string }) => f.type === 'application/epub+zip' || /\.epub$/i.test(f.name);
export { isEpub };
export const isEpubActive = (id: string) => active.has(id);

export function titleFromFilename(name: string): string {
  return name.replace(/\.epub$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Untitled';
}

const parseDoc: ParseDoc = (src, kind) => {
  const dp = new DOMParser();
  if (kind === 'xml') return dp.parseFromString(src, 'application/xml');
  const x = dp.parseFromString(src, 'application/xhtml+xml');
  if (x.getElementsByTagName('parsererror').length || !x.documentElement) return dp.parseFromString(src, 'text/html');
  return x;
};

const active = new Set<string>();
let queue: Promise<unknown> = Promise.resolve();

function enqueue(id: string) {
  if (active.has(id)) return;
  active.add(id);
  queue = queue.then(() => processBook(id)).catch((e) => console.error(e)).finally(() => active.delete(id));
}

/** Adds EPUBs to the shelf (visible immediately) and processes them in the background. Returns the new ids. */
export async function importEpubs(files: File[]): Promise<string[]> {
  const ids: string[] = [];
  for (const f of files) {
    if (!isEpub(f)) continue;
    const id = uid('b_');
    const item: Item = {
      id, kind: 'book', format: 'epub', status: 'processing', processingProgress: 0,
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

/** Restarts processing for EPUBs left in 'processing' by a closed tab. */
export async function resumeStalledEpubs() {
  for (const it of await listItems('book')) {
    if (it.format === 'epub' && it.status === 'processing' && !active.has(it.id)) enqueue(it.id);
  }
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

async function processBook(id: string) {
  const fail = (msg: string) => updateItem(id, { status: 'error', error: msg, processingProgress: undefined });
  const rec = await getFile(id);
  if (!rec) { await fail('The EPUB file is missing. Delete this book and add it again.'); return; }
  try {
    let parsed;
    try {
      const files = unzipEpub(new Uint8Array(await rec.blob.arrayBuffer()));
      let last = 0;
      parsed = await parseEpub(files, parseDoc, {
        yieldFn: tick,
        onProgress: (f) => { const now = Date.now(); if (now - last > 400 && f < 1) { last = now; void updateItem(id, { processingProgress: f }); } },
      });
    } catch (e) {
      console.warn('epub parse failed', e);
      await fail('Could not read this file. It may be damaged or not a real EPUB.');
      return;
    }
    if (parsed.cover) { try { await putCover(id, new Blob([parsed.cover.bytes as BlobPart], { type: parsed.cover.mime })); } catch (e) { console.warn('cover failed', e); } }
    const totalChars = parsed.sections.reduce((n, s) => n + s.charCount, 0);
    if (!parsed.sections.length || totalChars < 100) {
      await fail(parsed.drm ? 'This EPUB is copy-protected (DRM) and cannot be read.' : 'No readable text found in this EPUB.');
      return;
    }
    await putContent({ id, sections: parsed.sections });
    const cur = await getItem(id);
    const metaTitle = parsed.title && parsed.title.length <= 160 ? parsed.title : undefined;
    await updateItem(id, {
      status: 'ready', totalChars, sectionCount: parsed.sections.length, processingProgress: undefined, error: undefined,
      ...(parsed.cover ? { hasCover: true } : {}),
      ...(parsed.author ? { author: parsed.author } : {}),
      ...(metaTitle && cur && cur.title === titleFromFilename(rec.name) ? { title: metaTitle } : {}),
    });
  } catch (e) {
    console.error(e);
    await fail('Something went wrong while reading this EPUB.');
  }
}
