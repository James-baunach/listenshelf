// Wikipedia client: search, URL parsing, and importing articles as queue items.
import { getItem, getQueue, putContent, putItem, setQueue, updateItem, getSettings } from '../db';
import type { Item } from '../types';
import { htmlToSections } from './parse';
import { findSpoken, packSpoken, resolveSpokenFiles } from './spoken';

export { htmlToSections } from './parse';
export { findSpoken, packSpoken, unpackSpoken } from './spoken';

export interface WikiHit { title: string; description?: string; thumbnailUrl?: string; key: string }
/** 'keep' = leave in place if already queued, else append (used for retries). */
export type QueuePosition = 'end' | 'next' | 'now' | 'keep';

const HEADERS = { 'Api-User-Agent': 'ListenShelf/1.0', Accept: 'application/json' };

export class WikiError extends Error {
  constructor(message: string, public offline = false) { super(message); }
}

async function wfetch(url: string, init?: RequestInit): Promise<Response> {
  let r: Response;
  try { r = await fetch(url, { ...init, headers: { ...HEADERS, ...(init?.headers ?? {}) } }); }
  catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    const off = typeof navigator !== 'undefined' && navigator.onLine === false;
    throw new WikiError(off ? "You're offline. Downloaded articles still play." : "Couldn't reach Wikipedia. Check your connection.", true);
  }
  if (r.status === 404) throw new WikiError('Article not found.');
  if (!r.ok) throw new WikiError(`Wikipedia returned an error (${r.status}).`);
  return r;
}

const fixUrl = (u?: string) => (u ? (u.startsWith('//') ? 'https:' + u : u) : undefined);
const langOk = (l: string) => /^[a-z]{2,3}(-[a-z0-9]+)?$/i.test(l);

export async function searchWiki(q: string, lang: string, signal?: AbortSignal): Promise<WikiHit[]> {
  q = q.trim();
  if (!q) return [];
  const r = await wfetch(`https://${lang}.wikipedia.org/w/rest.php/v1/search/title?q=${encodeURIComponent(q)}&limit=10`, { signal });
  const j = await r.json() as { pages?: { key: string; title: string; description?: string | null; thumbnail?: { url: string } | null }[] };
  return (j.pages ?? []).map((p) => ({
    title: p.title, key: p.key, description: p.description ?? undefined, thumbnailUrl: fixUrl(p.thumbnail?.url),
  }));
}

/** Accepts a plain title or any Wikipedia URL. Returns null for empty / non-Wikipedia URLs. */
export function parseWikiInput(s: string, defaultLang = 'en'): { lang: string; title: string } | null {
  s = s.trim();
  if (!s) return null;
  if (/^(https?:)?\/\//i.test(s) || /^[a-z.]*wikipedia\.org\//i.test(s)) {
    let u: URL;
    try { u = new URL(/^https?:/i.test(s) ? s : s.startsWith('//') ? 'https:' + s : 'https://' + s); } catch { return null; }
    const m = u.hostname.match(/^([a-z0-9-]+)(?:\.m)?\.wikipedia\.org$/i);
    if (!m) return null;
    let lang = m[1].toLowerCase();
    if (lang === 'www' || lang === 'm') lang = defaultLang;
    let title = u.searchParams.get('title');
    const pm = u.pathname.match(/^\/(?:wiki|api\/rest_v1\/page\/(?:html|summary))\/(.+)$/);
    if (pm) title = decodeURIComponent(pm[1]);
    if (!title) return null;
    title = title.replace(/_/g, ' ').trim();
    return title && langOk(lang) ? { lang, title } : null;
  }
  return { lang: defaultLang, title: s.replace(/_/g, ' ') };
}

export const looksLikeWikiUrl = (s: string) => /wikipedia\.org\//i.test(s.trim());

const norm = (t: string) => t.replace(/ /g, '_');
export const articleId = (lang: string, title: string) => 'w_' + lang + '_' + norm(title.trim());

interface Summary { canonical: string; title: string; description?: string; thumbnailUrl?: string; url: string; lang: string }

async function fetchSummary(lang: string, title: string, signal?: AbortSignal): Promise<Summary> {
  const r = await wfetch(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(norm(title))}?redirect=true`, { signal });
  const j = await r.json() as any;
  const canonical: string = j.titles?.canonical ? String(j.titles.canonical).replace(/_/g, ' ') : j.title ?? title;
  return {
    title: j.title ?? canonical, description: j.description, lang,
    thumbnailUrl: fixUrl(j.thumbnail?.source),
    url: j.content_urls?.desktop?.page ?? `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(norm(canonical))}`,
    canonical,
  };
}

async function queueInsert(id: string, position: QueuePosition) {
  const old = await getQueue();
  if (position === 'keep' && old.includes(id)) return;
  const q = old.filter((x) => x !== id);
  if (position === 'end' || position === 'keep') q.push(id);
  else if (position === 'now') q.unshift(id);
  else {
    // 'next': after the item currently playing (queue head), if any
    const { controller } = await import('../player/controller');
    const cur = controller.getState().itemId;
    q.splice(cur && q[0] === cur ? 1 : 0, 0, id);
  }
  await setQueue(q);
}

export interface AddOptions {
  position?: QueuePosition;
  /** Called as soon as the item exists in the queue (before the download finishes). */
  onCreated?: (id: string) => void;
  signal?: AbortSignal;
}

/**
 * Adds an article to the queue and downloads it. Resolves with the item id once it is
 * ready; rejects (WikiError) if it failed. The item is visible in the queue as
 * 'processing' meanwhile and ends in status 'error' on failure.
 */
export async function addArticle(titleOrUrl: string, opts: AddOptions = {}): Promise<string> {
  const position = opts.position ?? 'end';
  const settings = await getSettings();
  const parsed = parseWikiInput(titleOrUrl, settings.wikiLang);
  if (!parsed) throw new WikiError('That does not look like a Wikipedia article.');
  const { lang } = parsed;

  // Fast path: already downloaded under the requested title.
  const quickId = articleId(lang, parsed.title);
  const quick = await getItem(quickId);
  if (quick?.status === 'ready') return reuse(quick, position, opts);

  // Resolve the canonical title (follows redirects) — also needed for description/thumbnail.
  const sum = await fetchSummary(lang, parsed.title, opts.signal);
  const id = articleId(lang, sum.canonical);
  const existing = id === quickId ? quick : await getItem(id);
  if (existing?.status === 'ready') return reuse(existing, position, opts);

  const item: Item = {
    id, kind: 'article', title: sum.title, description: sum.description, sourceUrl: sum.url,
    thumbnailUrl: sum.thumbnailUrl, status: 'processing', addedAt: existing?.addedAt ?? Date.now(),
    position: { section: 0, sentence: 0, updatedAt: Date.now() }, totalChars: 0, sectionCount: 0,
  };
  await putItem(item);
  await queueInsert(id, position);
  opts.onCreated?.(id);

  try {
    const r = await wfetch(`https://${lang}.wikipedia.org/api/rest_v1/page/html/${encodeURIComponent(norm(sum.canonical))}?redirect=true`,
      { signal: opts.signal, headers: { Accept: 'text/html' } });
    const html = await r.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    // Spoken Wikipedia box must be read before htmlToSections strips it.
    let spokenAudioUrl: string | undefined;
    try {
      const sp = findSpoken(doc);
      if (sp) {
        const urls = sp.urls.length ? sp.urls : await resolveSpokenFiles(lang, sp.files, opts.signal).catch(() => []);
        spokenAudioUrl = packSpoken(urls, sp.date);
      }
    } catch { /* optional feature */ }
    const sections = htmlToSections(doc, settings.wikiSkipSections, sum.canonical);
    const totalChars = sections.reduce((n, s) => n + s.charCount, 0);
    if (!totalChars) throw new WikiError('This article has no readable text.');
    await putContent({ id, sections });
    await updateItem(id, { status: 'ready', error: undefined, totalChars, sectionCount: sections.length, spokenAudioUrl });
    return id;
  } catch (e) {
    await updateItem(id, { status: 'error', error: (e as Error).message || 'Download failed' });
    throw e;
  }
}

async function reuse(item: Item, position: QueuePosition, opts: AddOptions) {
  if (item.finishedAt) {
    await updateItem(item.id, { finishedAt: undefined, position: { section: 0, sentence: 0, updatedAt: Date.now() } });
  }
  await queueInsert(item.id, position);
  opts.onCreated?.(item.id);
  return item.id;
}

/** Title of a random article (REST /page/random/summary). */
export async function randomArticle(lang: string): Promise<WikiHit> {
  const r = await wfetch(`https://${lang}.wikipedia.org/api/rest_v1/page/random/summary`);
  const j = await r.json() as any;
  return { title: j.title, key: norm(j.title), description: j.description, thumbnailUrl: fixUrl(j.thumbnail?.source) };
}
