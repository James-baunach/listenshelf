// Wikipedia discovery: today's featured article and "more like this". Fetch-only, fails silently.
import type { WikiHit } from './index';

export interface FeaturedArticle extends WikiHit { extract?: string; lang: string }

const HEADERS = { 'Api-User-Agent': 'ListenShelf/1.0', Accept: 'application/json' };
const fixUrl = (u?: string) => (u ? (u.startsWith('//') ? 'https:' + u : u) : undefined);

const pad = (n: number) => String(n).padStart(2, '0');
const dayPath = (d: Date) => `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`;

function readCache<T>(key: string): T | null {
  try { const s = localStorage.getItem(key); return s ? JSON.parse(s) as T : null; } catch { return null; }
}

/** Today's featured article. Cached in localStorage per day (and language), so it shows offline. */
export async function getFeatured(lang: string, signal?: AbortSignal): Promise<FeaturedArticle | null> {
  const today = new Date();
  const key = `ls_tfa_${lang}_${dayPath(today)}`;
  const cached = readCache<FeaturedArticle>(key);
  if (cached) return cached;
  try {
    // Today's UTC feed can be missing for a short while after midnight: fall back to yesterday.
    for (const d of [today, new Date(+today - 86400000)]) {
      const r = await fetch(`https://${lang}.wikipedia.org/api/rest_v1/feed/featured/${dayPath(d)}`, { signal, headers: HEADERS });
      if (!r.ok) continue;
      const j = await r.json() as any;
      const t = j.tfa;
      if (!t) continue;
      const art: FeaturedArticle = {
        title: String(t.titles?.normalized ?? t.title).replace(/_/g, ' '), key: String(t.title ?? t.titles?.canonical).replace(/ /g, '_'),
        description: t.description, extract: t.extract, thumbnailUrl: fixUrl(t.thumbnail?.source), lang,
      };
      try {
        for (let i = localStorage.length - 1; i >= 0; i--) { const k = localStorage.key(i); if (k?.startsWith('ls_tfa_') && k !== key) localStorage.removeItem(k); }
        localStorage.setItem(key, JSON.stringify(art));
      } catch { /* storage full */ }
      return art;
    }
  } catch (e) { if ((e as Error).name === 'AbortError') throw e; }
  return null;
}

/** Up to `limit` articles related to `title` (CirrusSearch morelike), with descriptions and thumbnails. */
export async function getMoreLike(lang: string, title: string, limit = 5, signal?: AbortSignal): Promise<WikiHit[]> {
  const q = new URLSearchParams({
    action: 'query', generator: 'search', gsrsearch: 'morelike:' + title, gsrnamespace: '0', gsrlimit: String(limit),
    prop: 'pageimages|description', piprop: 'thumbnail', pithumbsize: '120', format: 'json', formatversion: '2', origin: '*',
  });
  try {
    const r = await fetch(`https://${lang}.wikipedia.org/w/api.php?${q}`, { signal, headers: HEADERS });
    if (!r.ok) return [];
    const j = await r.json() as any;
    const pages: any[] = (j.query?.pages ?? []).slice().sort((a: any, b: any) => (a.index ?? 0) - (b.index ?? 0));
    const self = title.replace(/_/g, ' ').toLowerCase();
    return pages.filter((p) => String(p.title).toLowerCase() !== self).map((p) => ({
      title: p.title, key: String(p.title).replace(/ /g, '_'), description: p.description, thumbnailUrl: fixUrl(p.thumbnail?.source),
    }));
  } catch (e) { if ((e as Error).name === 'AbortError') throw e; return []; }
}
