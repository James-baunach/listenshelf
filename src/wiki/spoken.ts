// Spoken Wikipedia: find the human-read recording(s) of an article in its Parsoid HTML.
// Must run BEFORE htmlToSections (which strips the audio boxes from the document).

export interface SpokenInfo {
  /** Playable URLs, one per part, in order. */
  urls: string[];
  /** Date the recording is based on, ISO yyyy-mm-dd, if known. */
  date?: string;
  /** File names (no "File:" prefix) still needing URL resolution via the API when urls is empty. */
  files: string[];
}

const AUDIO_EXT = /\.(ogg|oga|opus|mp3|wav|flac|m4a)$/i;
const fixUrl = (u: string) => (u.startsWith('//') ? 'https:' + u : u);

function parseDate(s?: string | null): string | undefined {
  if (!s) return undefined;
  const iso = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return iso[0];
  const d = new Date(s.replace(/ /g, ' ') + ' UTC');
  return isNaN(+d) ? undefined : d.toISOString().slice(0, 10);
}

export function findSpoken(doc: Document): SpokenInfo | null {
  const files: string[] = [];
  const urls: string[] = [];
  let date: string | undefined;

  // 1. Rendered box: <audio resource="./File:X.ogg"><source src="…mp3 transcode">
  const box = doc.querySelector('.spoken-wikipedia');
  if (box) {
    for (const au of Array.from(box.querySelectorAll('audio'))) {
      const src = au.querySelector('source[type*="mpeg"]') ?? au.querySelector('source') ?? null;
      const s = src?.getAttribute('src') ?? au.getAttribute('src');
      const res = au.getAttribute('resource') ?? '';
      if (s) urls.push(fixUrl(s));
      else if (res) files.push(decodeURIComponent(res.replace(/^\.\/File:/, '')).replace(/_/g, ' '));
    }
    date = parseDate(box.querySelector('.bday')?.textContent);
  }

  // 2. Template parameters (works even when the box failed to render audio tags).
  if (!urls.length && !files.length) {
    for (const el of Array.from(doc.querySelectorAll('[typeof~="mw:Transclusion"][data-mw]'))) {
      let mw: any;
      try { mw = JSON.parse(el.getAttribute('data-mw') ?? ''); } catch { continue; }
      for (const part of mw?.parts ?? []) {
        const t = part?.template;
        if (!t || !/^spoken\s*(wikipedia|article)/i.test(String(t.target?.wt ?? '').trim())) continue;
        const params = t.params ?? {};
        date ??= parseDate(params.date?.wt);
        for (const k of Object.keys(params).filter((x) => /^\d+$/.test(x)).sort((a, b) => +a - +b)) {
          const f = String(params[k]?.wt ?? '').replace(/^(file|image):/i, '').trim();
          if (AUDIO_EXT.test(f)) files.push(f);
        }
      }
    }
  }
  if (!urls.length && !files.length) return null;
  return { urls, date, files };
}

/** Resolves file names to media URLs through the API (commons files are proxied by the local wiki). */
export async function resolveSpokenFiles(lang: string, files: string[], signal?: AbortSignal): Promise<string[]> {
  if (!files.length) return [];
  const titles = files.map((f) => 'File:' + f.replace(/_/g, ' ')).join('|');
  const r = await fetch(`https://${lang}.wikipedia.org/w/api.php?action=query&prop=imageinfo&iiprop=url&titles=${encodeURIComponent(titles)}&origin=*&format=json&formatversion=2`, { signal });
  if (!r.ok) return [];
  const j = await r.json() as any;
  const byTitle = new Map<string, string>();
  for (const p of j.query?.pages ?? []) { const u = p.imageinfo?.[0]?.url; if (u) byTitle.set(String(p.title).replace(/_/g, ' '), String(u).split('?')[0]); }
  const norm = new Map<string, string>(j.query?.normalized?.map((n: any) => [n.from, n.to]) ?? []);
  return files.map((f) => { const t = 'File:' + f.replace(/_/g, ' '); return byTitle.get(norm.get(t) ?? t) ?? ''; }).filter(Boolean);
}

// Multiple parts / the recording date are packed into the URL fragment, which browsers ignore for fetching:
//   https://…/Part1.mp3#parts=<url2>|<url3>&date=2026-07-03
export function packSpoken(urls: string[], date?: string): string | undefined {
  if (!urls.length) return undefined;
  const q = new URLSearchParams();
  if (urls.length > 1) q.set('parts', urls.slice(1).join('|'));
  if (date) q.set('date', date);
  const frag = q.toString();
  return urls[0] + (frag ? '#' + frag : '');
}

export function unpackSpoken(packed: string): { urls: string[]; date?: string } {
  const i = packed.indexOf('#');
  if (i < 0) return { urls: [packed] };
  const q = new URLSearchParams(packed.slice(i + 1));
  const rest = q.get('parts');
  return { urls: [packed.slice(0, i), ...(rest ? rest.split('|').filter(Boolean) : [])], date: q.get('date') ?? undefined };
}
