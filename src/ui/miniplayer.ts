// Compact now-playing bar above the tab bar. Empty root => CSS hides it.
import './miniplayer.css';
import type { Item, PlayerState } from '../types';
import { listItems, onChange } from '../db';
import { controller } from '../player/controller';
import { coverSource, typographicCover, type CoverSource } from '../player/cover';
import { charsBefore } from '../text';
import { h, go } from './dom';
import { icons } from './icons';

export function mountMiniPlayer(root: HTMLElement) {
  let last: Item | null = null; // most recently played ready item (when nothing is loaded)
  let state: PlayerState = controller.getState();
  let coverFor = '';
  let cover: CoverSource | null = null;

  const thumb = h('div', { class: 'mini-cover' });
  const title = h('div', { class: 'mini-title ellipsis' });
  const sub = h('div', { class: 'mini-sub ellipsis' });
  const bar = h('i');
  const btn = h('button', { class: 'icon-btn mini-play', 'aria-label': 'Play' });
  const el = h('div', { class: 'mini' },
    h('div', { class: 'mini-main', role: 'button', tabindex: '0', onclick: () => open() }, thumb, h('div', { class: 'grow' }, title, sub)),
    btn,
    h('div', { class: 'mini-progress' }, bar));
  btn.addEventListener('click', (e) => { e.stopPropagation(); onPlay(); });
  el.querySelector('.mini-main')!.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') open(); });

  const shownId = () => state.itemId ?? last?.id ?? null;
  function open() { const id = shownId(); if (id) go('#/play/' + id); }
  function onPlay() {
    if (state.itemId) { controller.toggle(); return; }
    if (last) { void controller.open(last.id, { autoplay: true }); }
  }

  async function setCover(item: Item) {
    if (coverFor === item.id + (item.hasCover ? 'c' : '')) return;
    coverFor = item.id + (item.hasCover ? 'c' : '');
    cover?.revoke(); cover = null;
    thumb.replaceChildren(typographicCover(item, true));
    const c = await coverSource(item).catch(() => null);
    if (!c) return;
    if (coverFor !== item.id + (item.hasCover ? 'c' : '')) { c.revoke(); return; }
    cover = c;
    const img = h('img', { src: c.url, alt: '' });
    img.onerror = () => thumb.replaceChildren(typographicCover(item, true));
    thumb.replaceChildren(img);
  }

  function render() {
    const item = state.itemId ? state.item : last;
    if (!item || item.status !== 'ready') { root.replaceChildren(); return; }
    if (!root.contains(el)) root.replaceChildren(el);
    void setCover(item);
    title.textContent = item.title;
    let secTitle = '';
    let frac = 0;
    if (state.itemId && state.content) {
      secTitle = state.content.sections[state.section]?.title ?? '';
      const total = item.totalChars || state.content.sections.reduce((n, s) => n + s.charCount, 0);
      frac = total ? charsBefore(state.content.sections, state.section, state.sentence) / total : 0;
    } else {
      secTitle = 'Resume';
      frac = item.sectionCount ? item.position.section / item.sectionCount : 0;
    }
    sub.textContent = state.error ? state.error : secTitle;
    bar.style.width = `${Math.min(100, Math.max(0, frac * 100)).toFixed(1)}%`;
    const playing = state.itemId && state.playing;
    btn.innerHTML = state.itemId && state.loading && state.playing ? '<span class="spinner"></span>' : playing ? icons.pause : icons.play;
    btn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }

  async function refreshLast() {
    const items = await listItems().catch(() => [] as Item[]);
    const played = items.filter((i) => i.status === 'ready' && i.lastPlayedAt).sort((a, b) => (b.lastPlayedAt ?? 0) - (a.lastPlayedAt ?? 0));
    last = played[0] ?? null;
    render();
  }

  controller.subscribe((s) => { state = s; render(); });
  onChange('items', () => { if (!state.itemId) void refreshLast(); });
  void refreshLast();
}
