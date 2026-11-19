// Incoming shares: files/links sent from Android's share sheet (via the service worker's share-target
// inbox) and files opened through the desktop file-handler (launchQueue).
import { addArticle, looksLikeWikiUrl, parseWikiInput } from './wiki';
import { importBooks } from './import';
import { go, toast } from './ui/dom';

interface InboxManifest { title: string; text: string; url: string; files: { name: string; type: string; key: string }[] }

declare global {
  interface Window {
    launchQueue?: { setConsumer(fn: (p: { files: { getFile(): Promise<File> }[] }) => void): void };
  }
}

const INBOX = 'share-inbox';

async function readInbox(): Promise<{ m: InboxManifest; files: File[] } | null> {
  if (!('caches' in self) || !(await caches.has(INBOX))) return null;
  try {
    const cache = await caches.open(INBOX);
    const mres = await cache.match(new URL('share-inbox/manifest', document.baseURI).href);
    if (!mres) return null;
    const m = (await mres.json()) as InboxManifest;
    const files: File[] = [];
    for (const f of m.files) {
      const r = await cache.match(new URL('share-inbox/' + f.key, document.baseURI).href);
      if (r) files.push(new File([await r.blob()], f.name, { type: f.type }));
    }
    return { m, files };
  } finally {
    await caches.delete(INBOX);
  }
}

/** First Wikipedia URL found in the given strings (a bare URL, or inside shared text). */
function findWikiUrl(...parts: string[]): string | null {
  for (const p of parts) {
    for (const u of p.match(/https?:\/\/[^\s<>"']+/gi) ?? []) {
      if (looksLikeWikiUrl(u) && parseWikiInput(u)) return u.replace(/[).,;]+$/, '');
    }
  }
  return null;
}
const hasAnyUrl = (...parts: string[]) => parts.some((p) => /https?:\/\//i.test(p));

async function shareArticle(url: string) {
  go('#/queue');
  try {
    await addArticle(url, { position: 'end', onCreated: () => toast('Added to queue') });
  } catch (e) {
    toast((e as Error)?.message || 'Could not add that article');
  }
}

/** On startup: picks up files/links shared to the app (Android share sheet) and imports them. */
export async function handleIncomingShare(): Promise<void> {
  // Desktop "Open with": files arrive via launchQueue.
  window.launchQueue?.setConsumer(async (params) => {
    try {
      const files = await Promise.all(params.files.map((h) => h.getFile()));
      if (files.length) { go('#/library'); await importBooks(files); }
    } catch (e) { console.error(e); toast('Could not open that file'); }
  });

  const flagged = new URLSearchParams(location.search).has('shared');
  let inbox: Awaited<ReturnType<typeof readInbox>> = null;
  try { inbox = await readInbox(); } catch (e) { console.error('share inbox', e); }
  if (flagged) history.replaceState(null, '', location.pathname + location.hash);
  if (!inbox) { if (flagged) toast('Nothing to add'); return; }

  const { m, files } = inbox;
  if (files.length) { go('#/library'); await importBooks(files); }
  const wiki = findWikiUrl(m.url, m.text, m.title);
  if (wiki) await shareArticle(wiki);
  else if (!files.length) toast(hasAnyUrl(m.url, m.text, m.title) ? 'Only Wikipedia links can be added for now' : 'Nothing to add: share a PDF, EPUB, or Wikipedia link');
}
