// Bottom sheets for Wikipedia items: tapped links in article text, and the Spoken Wikipedia recording.
import '../ui/queue.css';
import { h, sheet, toast } from '../ui/dom';
import type { Item, SectionLink } from '../types';
import { addArticle, WikiError } from './index';
import { unpackSpoken } from './spoken';

/** Language code of an article item: id 'w_{lang}_…', else the host of its source URL. */
function itemLang(item: Item): string {
  const m = item.id.match(/^w_([a-z0-9-]+?)_/i);
  if (m) return m[1].toLowerCase();
  try { const x = new URL(item.sourceUrl ?? '').hostname.match(/^([a-z0-9-]+)(?:\.m)?\.wikipedia\.org$/i); if (x) return x[1].toLowerCase(); } catch { /* ignore */ }
  return 'en';
}
const wikiUrl = (lang: string, title: string) => `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_')).replace(/%2F/g, '/').replace(/%3A/g, ':')}`;

/** Tapped a link in an article's text: sheet with "Play next", "Add to queue", "Open on Wikipedia". */
export function openLinkActions(item: Item, link: SectionLink): void {
  const lang = itemLang(item);
  const url = wikiUrl(lang, link.title);
  const info = h('div', { class: 'wa-info' }, h('div', { class: 'spinner' }));
  let close: () => void = () => {};

  const add = async (position: 'next' | 'end') => {
    close();
    try {
      await addArticle(url, { position, onCreated: () => toast(position === 'next' ? 'Playing next' : 'Added to queue') });
    } catch (e) { toast(e instanceof WikiError ? e.message : (e as Error)?.message || 'Could not add article'); }
  };
  const body = h('div', { class: 'wa' },
    info,
    h('div', { class: 'wa-actions' },
      h('button', { class: 'btn primary', onclick: () => add('next') }, 'Play next'),
      h('button', { class: 'btn', onclick: () => add('end') }, 'Add to queue'),
      h('a', { class: 'btn', href: url, target: '_blank', rel: 'noopener noreferrer', onclick: () => setTimeout(() => close(), 50) }, 'Open on Wikipedia'),
      h('button', { class: 'btn ghost', onclick: () => close() }, 'Cancel')));
  close = sheet(link.title, body);

  const ctl = new AbortController();
  const timeout = setTimeout(() => ctl.abort(), 8000);
  fetch(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(link.title.replace(/ /g, '_'))}?redirect=true`,
    { signal: ctl.signal, headers: { 'Api-User-Agent': 'ListenShelf/1.0', Accept: 'application/json' } })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error('summary'))))
    .then((j: any) => {
      const thumb = j.thumbnail?.source as string | undefined;
      const text = (j.description as string | undefined) || (j.extract as string | undefined)?.slice(0, 160);
      info.replaceChildren(...[
        thumb ? h('img', { class: 'wa-thumb', src: thumb, alt: '', referrerpolicy: 'no-referrer' }) : null,
        text ? h("p", { class: "muted wa-desc" }, text) : null].filter(Boolean) as Node[]);
      if (!text && !thumb) info.remove();
    })
    .catch(() => info.remove()) // offline / not found: just the title
    .finally(() => clearTimeout(timeout));
}

/** Play the article's human-read Spoken Wikipedia recording (item.spokenAudioUrl) in a sheet player. */
export function openSpokenRecording(item: Item): void {
  if (!item.spokenAudioUrl) { toast('No recording for this article'); return; }
  const { urls, date } = unpackSpoken(item.spokenAudioUrl);
  const audio = h('audio', { controls: true, preload: 'none', class: 'wa-audio', src: urls[0] }) as HTMLAudioElement;
  let part = 0;
  const err = h('p', { class: 'q-note err', hidden: true }, "Couldn't play the recording. Check your connection.");
  audio.addEventListener('error', () => { err.hidden = false; });
  audio.addEventListener('playing', () => { err.hidden = true; });
  const parts = urls.length > 1 ? h('div', { class: 'wa-parts' }, urls.map((u, i) =>
    h('button', {
      class: 'chip' + (i === 0 ? ' active' : ''),
      onclick: (e: Event) => {
        part = i; audio.src = u; audio.play().catch(() => {});
        (e.currentTarget as HTMLElement).parentElement!.querySelectorAll('.chip').forEach((c, k) => c.classList.toggle('active', k === i));
      },
    }, `Part ${i + 1}`))) : null;
  audio.addEventListener('ended', () => {
    if (part + 1 < urls.length) { part++; audio.src = urls[part]; audio.play().catch(() => {}); parts?.querySelectorAll('.chip').forEach((c, k) => c.classList.toggle('active', k === part)); }
  });
  const when = date ? new Date(date + 'T00:00:00').toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : '';
  const body = h('div', { class: 'wa' },
    h('p', { class: 'muted wa-desc' }, 'Read aloud by a Spoken Wikipedia volunteer.'
      + (when ? ` Recorded from the article as of ${when}.` : '')
      + ' It may be older than the text you have downloaded.'),
    parts, audio, err,
    h('div', { class: 'wa-actions' }, h('button', { class: 'btn', onclick: () => close() }, 'Close')));
  const close = sheet(item.title + ' – spoken', body, { onClose: () => { audio.pause(); audio.removeAttribute('src'); audio.load(); } });
}
