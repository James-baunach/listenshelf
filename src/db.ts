// IndexedDB storage. All persistence goes through this module.
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { DEFAULT_SETTINGS, type Bookmark, type DocContent, type Item, type Position, type RenderedAudio, type Settings } from './types';

interface ShelfDB extends DBSchema {
  items: { key: string; value: Item; indexes: { kind: string } };
  content: { key: string; value: DocContent };
  files: { key: string; value: { id: string; blob: Blob; name: string } };
  covers: { key: string; value: { id: string; blob: Blob } };
  audio: { key: string; value: RenderedAudio; indexes: { itemId: string } };
  kv: { key: string; value: unknown };
  bookmarks: { key: string; value: Bookmark; indexes: { itemId: string } };
}

let dbp: Promise<IDBPDatabase<ShelfDB>> | null = null;
export function db() {
  dbp ??= openDB<ShelfDB>('listenshelf', 2, {
    upgrade(d, oldVersion) {
      if (oldVersion < 1) {
        d.createObjectStore('items', { keyPath: 'id' }).createIndex('kind', 'kind');
        d.createObjectStore('content', { keyPath: 'id' });
        d.createObjectStore('files', { keyPath: 'id' });
        d.createObjectStore('covers', { keyPath: 'id' });
        d.createObjectStore('audio', { keyPath: 'key' }).createIndex('itemId', 'itemId');
        d.createObjectStore('kv');
      }
      if (oldVersion < 2) d.createObjectStore('bookmarks', { keyPath: 'id' }).createIndex('itemId', 'itemId');
    },
    // Another tab holding the old version must let go, or the upgrade blocks.
    blocking() { void dbp?.then((x) => x.close()); dbp = null; },
  });
  return dbp;
}

// ─── change notifications (same tab + other tabs) ───
type Topic = 'items' | 'queue' | 'settings' | 'audio' | 'bookmarks' | 'content';
const listeners = new Map<Topic, Set<() => void>>();
const bc = 'BroadcastChannel' in self ? new BroadcastChannel('listenshelf') : null;
bc?.addEventListener('message', (e) => fire(e.data as Topic, false));
function fire(t: Topic, broadcast = true) {
  listeners.get(t)?.forEach((f) => f());
  if (broadcast) bc?.postMessage(t);
}
/** Listen for changes to a store. Returns unsubscribe. */
export function onChange(topic: Topic, fn: () => void): () => void {
  if (!listeners.has(topic)) listeners.set(topic, new Set());
  listeners.get(topic)!.add(fn);
  return () => listeners.get(topic)!.delete(fn);
}
export const notify = (t: Topic) => fire(t);

// ─── items ───
export async function getItem(id: string) { return (await db()).get('items', id); }
export async function listItems(kind?: 'book' | 'article') {
  const d = await db();
  return kind ? d.getAllFromIndex('items', 'kind', kind) : d.getAll('items');
}
export async function putItem(item: Item) { await (await db()).put('items', item); fire('items'); }
/** Read-modify-write; returns the updated item (or undefined if missing). */
export async function updateItem(id: string, patch: Partial<Item> | ((i: Item) => Partial<Item>)) {
  const d = await db();
  const tx = d.transaction('items', 'readwrite');
  const cur = await tx.store.get(id);
  if (!cur) { await tx.done; return undefined; }
  const next = { ...cur, ...(typeof patch === 'function' ? patch(cur) : patch) };
  await tx.store.put(next);
  await tx.done;
  fire('items');
  return next;
}
/** Saves position without broadcasting a full 'items' change storm (called often). */
let posTimer: ReturnType<typeof setTimeout> | null = null;
export async function savePosition(id: string, pos: Omit<Position, 'updatedAt'>, immediate = false) {
  const write = async () => {
    await updateItem(id, { position: { ...pos, updatedAt: Date.now() }, lastPlayedAt: Date.now() });
  };
  if (posTimer) clearTimeout(posTimer);
  if (immediate) return write();
  posTimer = setTimeout(write, 1500);
}
/** Deletes an item and everything attached to it (file, cover, content, audio, queue entry). */
export async function deleteItem(id: string) {
  const d = await db();
  const tx = d.transaction(['items', 'content', 'files', 'covers', 'audio', 'bookmarks'], 'readwrite');
  await Promise.all([
    tx.objectStore('items').delete(id),
    tx.objectStore('content').delete(id),
    tx.objectStore('files').delete(id),
    tx.objectStore('covers').delete(id),
  ]);
  const audioKeys = await tx.objectStore('audio').index('itemId').getAllKeys(id);
  await Promise.all(audioKeys.map((k) => tx.objectStore('audio').delete(k)));
  const bmKeys = await tx.objectStore('bookmarks').index('itemId').getAllKeys(id);
  await Promise.all(bmKeys.map((k) => tx.objectStore('bookmarks').delete(k)));
  await tx.done;
  const q = await getQueue();
  if (q.includes(id)) await setQueue(q.filter((x) => x !== id));
  await d.delete('kv', `ocrwords:${id}`); // OCR word boxes (src/pdf/ocrlayout.ts)
  fire('items'); fire('audio'); fire('bookmarks');
}

// ─── bookmarks & notes ───
/** Bookmarks for one item, in reading order. */
export async function listBookmarks(itemId: string): Promise<Bookmark[]> {
  const all = await (await db()).getAllFromIndex('bookmarks', 'itemId', itemId);
  return all.sort((a, b) => a.section - b.section || a.sentence - b.sentence || a.createdAt - b.createdAt);
}
export async function listAllBookmarks(): Promise<Bookmark[]> {
  return (await (await db()).getAll('bookmarks')).sort((a, b) => b.createdAt - a.createdAt);
}
export async function putBookmark(b: Bookmark) { await (await db()).put('bookmarks', b); fire('bookmarks'); }
export async function deleteBookmark(id: string) { await (await db()).delete('bookmarks', id); fire('bookmarks'); }

// ─── content / files / covers ───
export async function getContent(id: string) { return (await db()).get('content', id); }
export async function putContent(c: DocContent) { await (await db()).put('content', c); lastContentId = c.id; fire('content'); }
/** Id of the most recent putContent in this tab (lets listeners skip unrelated content changes). */
export let lastContentId = '';
export async function getFile(id: string) { return (await db()).get('files', id); }
export async function putFile(id: string, blob: Blob, name: string) { await (await db()).put('files', { id, blob, name }); }
export async function getCover(id: string) { return (await db()).get('covers', id).then((r) => r?.blob); }
export async function putCover(id: string, blob: Blob) { await (await db()).put('covers', { id, blob }); fire('items'); }

// ─── rendered audio (pocket mode) ───
export async function getAudio(key: string) { return (await db()).get('audio', key); }
export async function putAudio(a: RenderedAudio) { await (await db()).put('audio', a); fire('audio'); }
export async function listAudioKeys(itemId: string) {
  return (await db()).getAllKeysFromIndex('audio', 'itemId', itemId) as Promise<string[]>;
}
export async function deleteAudioForItem(itemId: string) {
  const d = await db();
  const keys = await d.getAllKeysFromIndex('audio', 'itemId', itemId);
  const tx = d.transaction('audio', 'readwrite');
  await Promise.all(keys.map((k) => tx.store.delete(k)));
  await tx.done;
  fire('audio');
}

// ─── key/value: settings + article queue ───
export async function getSettings(): Promise<Settings> {
  const s = (await (await db()).get('kv', 'settings')) as Partial<Settings> | undefined;
  return { ...DEFAULT_SETTINGS, ...(s ?? {}) };
}
export async function saveSettings(patch: Partial<Settings>) {
  const next = { ...(await getSettings()), ...patch };
  await (await db()).put('kv', next, 'settings');
  fire('settings');
  return next;
}
/** Ordered list of article item ids waiting to be played (current one first). */
export async function getQueue(): Promise<string[]> {
  return ((await (await db()).get('kv', 'queue')) as string[] | undefined) ?? [];
}
export async function setQueue(ids: string[]) {
  await (await db()).put('kv', [...new Set(ids)], 'queue');
  fire('queue');
}

// ─── backup ───
/** Exports item metadata, positions, settings and queue (not PDFs or audio). */
export async function exportBackup() {
  return {
    app: 'listenshelf', version: 1, exportedAt: new Date().toISOString(),
    items: await listItems(), settings: await getSettings(), queue: await getQueue(),
    bookmarks: await listAllBookmarks(),
  };
}

/**
 * Restores a backup made by exportBackup(): settings, queue, bookmarks, and reading
 * positions for items that exist on this device (matched by id). Wikipedia articles
 * missing here are re-created as 'error' placeholders the queue page can retry
 * (they need re-downloading). Books missing here are skipped (the PDF isn't in the backup).
 * Returns counts for a summary toast.
 */
export async function importBackup(data: unknown): Promise<{ positions: number; articles: number; bookmarks: number; skippedBooks: number }> {
  const b = data as Partial<Awaited<ReturnType<typeof exportBackup>>>;
  if (!b || b.app !== 'listenshelf' || !Array.isArray(b.items)) throw new Error('This is not a ListenShelf backup file.');
  const d = await db();
  let positions = 0, articles = 0, skippedBooks = 0;
  for (const it of b.items as Item[]) {
    const cur = await d.get('items', it.id);
    if (cur) {
      if ((it.position?.updatedAt ?? 0) > (cur.position?.updatedAt ?? 0)) {
        await d.put('items', { ...cur, position: it.position, lastPlayedAt: it.lastPlayedAt, finishedAt: it.finishedAt });
        positions++;
      }
    } else if (it.kind === 'article' && it.sourceUrl) {
      await d.put('items', { ...it, status: 'error', error: 'Restored from backup. Tap Retry to download.' });
      articles++;
    } else skippedBooks++;
  }
  if (b.settings) await d.put('kv', { ...DEFAULT_SETTINGS, ...(b.settings as Settings) }, 'settings');
  if (Array.isArray(b.queue)) await d.put('kv', b.queue, 'queue');
  let bookmarks = 0;
  for (const m of (b.bookmarks ?? []) as Bookmark[]) { if (await d.get('items', m.itemId)) { await d.put('bookmarks', m); bookmarks++; } }
  fire('items'); fire('settings'); fire('queue'); fire('bookmarks');
  return { positions, articles, bookmarks, skippedBooks };
}

export const uid = (prefix: string) =>
  prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/** Ask the browser not to evict our data under storage pressure. */
export async function requestPersistence() {
  try { if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist(); } catch { /* ignore */ }
}
