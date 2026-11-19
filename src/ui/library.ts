// Library page: bookshelf grid of imported PDFs.
import './library.css';
import { deleteItem, getCover, listItems, onChange, updateItem } from '../db';
import { importPdfs, resumeStalled } from '../pdf/import';
import { controller } from '../player/controller';
import type { Item } from '../types';
import { confirmSheet, go, h, promptSheet, sheet, toast } from './dom';
import { icons } from './icons';

type Sort = 'recent' | 'title' | 'added';
const SORT_KEY = 'listenshelf.sort';
const LONG_PRESS_MS = 500;

function hash(s: string) { let n = 5381; for (let i = 0; i < s.length; i++) n = ((n << 5) + n + s.charCodeAt(i)) >>> 0; return n; }

function generatedCover(it: Item): HTMLElement {
  const hu = hash(it.title) % 360;
  const hu2 = (hu + 40) % 360;
  return h('div', { class: 'lib-gen', style: `background: linear-gradient(155deg, hsl(${hu} 45% 34%), hsl(${hu2} 50% 20%))` },
    h('b', null, it.title), h('span', null, it.author ?? ''));
}

function progressOf(it: Item): number {
  if (it.finishedAt) return 1;
  if (!it.sectionCount) return 0;
  return Math.min(1, it.position.section / it.sectionCount);
}

export function mount(root: HTMLElement, _params: Record<string, string>) {
  let sort: Sort = (localStorage.getItem(SORT_KEY) as Sort) || 'recent';
  if (!['recent', 'title', 'added'].includes(sort)) sort = 'recent';
  let items: Item[] = [];
  let disposed = false;
  let seq = 0;

  const coverUrls = new Map<string, string>();
  const coverLoading = new Set<string>();
  const cards = new Map<string, Card>();

  // ─── static skeleton ───
  const input = h('input', { type: 'file', accept: 'application/pdf,.pdf', multiple: true, hidden: true, onchange: () => {
    const files = Array.from(input.files ?? []);
    input.value = '';
    addFiles(files);
  } });
  const addBtn = h('button', { class: 'icon-btn', 'aria-label': 'Add PDFs', html: icons.plus, onclick: () => input.click() });
  const hero = h('div');
  const chips = h('div', { class: 'lib-sort' });
  const grid = h('div', { class: 'lib-grid' });
  const empty = h('div', { class: 'empty' },
    h('div', { html: icons.books }),
    h('h2', null, 'Your shelf is empty'),
    h('p', null, 'Add a PDF book and ListenShelf will read it aloud, chapter by chapter. Your books stay on this device and work offline.'),
    h('button', { class: 'btn primary', onclick: () => input.click() }, 'Add PDFs'));
  const drop = h('div', { class: 'lib-drop' }, 'Drop PDFs to add them');
  const page = h('div', { class: 'lib' },
    h('div', { class: 'page-head' }, h('h1', null, 'Books'), addBtn),
    hero, chips, grid, empty, input, drop);
  root.appendChild(page);

  function renderChips() {
    chips.replaceChildren(...(['recent', 'title', 'added'] as Sort[]).map((s) =>
      h('button', { class: 'chip' + (s === sort ? ' active' : ''), onclick: () => {
        sort = s; localStorage.setItem(SORT_KEY, s); renderChips(); layout();
      } }, s === 'recent' ? 'Recent' : s === 'title' ? 'Title' : 'Added')));
  }

  async function addFiles(files: File[]) {
    const pdfs = files.filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
    if (!pdfs.length) { if (files.length) toast('Only PDF files can be added'); return; }
    toast(pdfs.length === 1 ? 'Adding book…' : `Adding ${pdfs.length} books…`);
    try { await importPdfs(pdfs); } catch (e) { console.error(e); toast('Could not add that file'); }
  }

  // ─── drag & drop (desktop) ───
  let dragDepth = 0;
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  const onDragEnter = (e: DragEvent) => { if (hasFiles(e)) { dragDepth++; drop.classList.add('on'); } };
  const onDragOver = (e: DragEvent) => { if (hasFiles(e)) e.preventDefault(); };
  const onDragLeave = (e: DragEvent) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; drop.classList.remove('on'); } };
  const onDrop = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; drop.classList.remove('on');
    addFiles(Array.from(e.dataTransfer?.files ?? []));
  };
  window.addEventListener('dragenter', onDragEnter);
  window.addEventListener('dragover', onDragOver);
  window.addEventListener('dragleave', onDragLeave);
  window.addEventListener('drop', onDrop);

  // ─── item actions ───
  function openItem(it: Item) { if (it.status === 'ready') go('#/play/' + it.id); else if (it.status !== 'processing') openMenu(it); }

  async function playItem(it: Item) {
    if (it.status !== 'ready') return;
    try { await controller.open(it.id, { autoplay: true }); } catch (e) { console.error(e); }
    go('#/play/' + it.id);
  }

  function openMenu(it: Item) {
    let close: () => void = () => {};
    const later = (fn: () => void) => { close(); setTimeout(fn, 320); }; // let the sheet's history.back() settle
    const btn = (label: string, fn: () => void, cls = '') => h('button', { class: cls, onclick: fn }, label);
    const body = h('div', { class: 'lib-menu' },
      it.status === 'ready' ? btn('Rename', () => later(async () => {
        const t = await promptSheet('Rename book', it.title);
        if (t) await updateItem(it.id, { title: t });
      })) : null,
      it.status === 'ready' && !it.finishedAt ? btn('Mark as finished', () => { close(); updateItem(it.id, { finishedAt: Date.now() }); }) : null,
      it.status === 'ready' && (it.finishedAt || it.position.section > 0 || it.position.sentence > 0) ? btn('Reset progress', () => {
        close();
        updateItem(it.id, { position: { section: 0, sentence: 0, updatedAt: Date.now() }, finishedAt: undefined });
        if (controller.getState().itemId === it.id) controller.goTo(0, 0);
      }) : null,
      btn('Delete', () => later(async () => {
        const ok = await confirmSheet('Delete this book?', `“${it.title}” and its saved position will be removed from this device.`, 'Delete', true);
        if (!ok) return;
        if (controller.getState().itemId === it.id) controller.close();
        await deleteItem(it.id);
        const u = coverUrls.get(it.id); if (u) { URL.revokeObjectURL(u); coverUrls.delete(it.id); }
        toast('Book deleted');
      }), 'danger'));
    close = sheet(it.title, body);
  }

  // ─── cards ───
  class Card {
    el: HTMLElement;
    cover: HTMLElement;
    overlay: HTMLElement | null = null;
    titleEl: HTMLElement; authorEl: HTMLElement; bar: HTMLElement;
    badge: HTMLElement | null = null;
    item: Item;
    coverKey = '';
    private pressTimer = 0;
    private pressed = false;

    constructor(it: Item) {
      this.item = it;
      this.cover = h('div', { class: 'lib-cover', role: 'button', tabindex: '0', onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') openItem(this.item); } });
      this.titleEl = h('div', { class: 'lib-title' });
      this.authorEl = h('div', { class: 'lib-author ellipsis' });
      this.bar = h('i');
      const more = h('button', { class: 'icon-btn lib-more', 'aria-label': 'Book options', html: icons.more, onclick: (e: Event) => { e.stopPropagation(); openMenu(this.item); } });
      this.el = h('div', { class: 'lib-card' }, this.cover,
        h('div', { class: 'lib-info' }, h('div', { class: 'txt' }, this.titleEl, this.authorEl, h('div', { class: 'progress' }, this.bar)), more));
      // tap vs long-press
      this.cover.addEventListener('pointerdown', (e) => {
        this.pressed = false;
        const x = e.clientX, y = e.clientY;
        clearTimeout(this.pressTimer);
        this.pressTimer = window.setTimeout(() => { this.pressed = true; if (navigator.vibrate) navigator.vibrate(15); openMenu(this.item); }, LONG_PRESS_MS);
        const move = (ev: PointerEvent) => { if (Math.hypot(ev.clientX - x, ev.clientY - y) > 10) cancel(); };
        const cancel = () => { clearTimeout(this.pressTimer); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', cancel); window.removeEventListener('pointercancel', cancel); };
        window.addEventListener('pointermove', move); window.addEventListener('pointerup', cancel); window.addEventListener('pointercancel', cancel);
      });
      this.cover.addEventListener('click', () => { if (this.pressed) { this.pressed = false; return; } openItem(this.item); });
      this.cover.addEventListener('contextmenu', (e) => e.preventDefault());
      this.update(it);
    }

    setOverlay(node: HTMLElement | null) {
      this.overlay?.remove();
      this.overlay = node;
      if (node) this.cover.appendChild(node);
    }

    update(it: Item) {
      const prev = this.item;
      this.item = it;
      this.titleEl.textContent = it.title;
      this.authorEl.textContent = it.author ?? '';
      this.authorEl.style.display = it.author ? '' : 'none';
      this.bar.style.width = Math.round(progressOf(it) * 100) + '%';

      // cover image / generated cover
      const url = it.hasCover ? coverUrls.get(it.id) : undefined;
      const key = url ? 'img:' + url : 'gen:' + it.title + '|' + (it.author ?? '');
      if (key !== this.coverKey) {
        this.coverKey = key;
        const art = url ? h('img', { src: url, alt: '', draggable: 'false' }) : generatedCover(it);
        const old = this.cover.querySelector(':scope > img, :scope > .lib-gen');
        if (old) old.replaceWith(art); else this.cover.prepend(art);
      }
      if (it.hasCover && !url) loadCover(it.id);

      // status overlay
      if (it.status === 'processing') {
        const pct = Math.round((it.processingProgress ?? 0) * 100);
        if (prev.status !== 'processing' || !this.overlay) {
          this.setOverlay(h('div', { class: 'lib-over' }, h('div', { class: 'spinner' }), h('strong', null, pct + '%'), h('span', null, 'Preparing…')));
        } else this.overlay.querySelector('strong')!.textContent = pct + '%';
      } else if (it.status === 'error' || it.status === 'no-text') {
        if (prev.status === it.status && prev.error === it.error && this.overlay) { /* unchanged */ } else {
          this.setOverlay(h('div', { class: 'lib-over err' }, h('span', null, it.error ?? (it.status === 'no-text' ? 'No readable text found.' : 'Could not read this PDF.')),
            h('button', { class: 'btn danger', style: 'min-height:44px', onclick: (e: Event) => { e.stopPropagation(); openMenu(this.item); } }, 'Delete…')));
        }
      } else if (this.overlay) this.setOverlay(null);

      // finished badge
      if (it.finishedAt && it.status === 'ready') {
        if (!this.badge) { this.badge = h('div', { class: 'lib-badge' }, 'Finished'); this.cover.appendChild(this.badge); }
      } else if (this.badge) { this.badge.remove(); this.badge = null; }
    }
  }

  async function loadCover(id: string) {
    if (coverLoading.has(id) || coverUrls.has(id)) return;
    coverLoading.add(id);
    try {
      const blob = await getCover(id);
      if (blob && !disposed) {
        coverUrls.set(id, URL.createObjectURL(blob));
        const c = cards.get(id); if (c) c.update(c.item);
        renderHero();
      }
    } finally { coverLoading.delete(id); }
  }

  // ─── layout ───
  function sorted(): Item[] {
    const a = items.slice();
    if (sort === 'title') a.sort((x, y) => x.title.localeCompare(y.title, undefined, { sensitivity: 'base', numeric: true }));
    else if (sort === 'added') a.sort((x, y) => y.addedAt - x.addedAt);
    else a.sort((x, y) => (y.lastPlayedAt ?? 0) - (x.lastPlayedAt ?? 0) || y.addedAt - x.addedAt);
    return a;
  }

  function renderHero() {
    const last = items.filter((i) => i.status === 'ready' && i.lastPlayedAt && !i.finishedAt)
      .sort((a, b) => b.lastPlayedAt! - a.lastPlayedAt!)[0];
    if (!last) { hero.replaceChildren(); return; }
    const url = last.hasCover ? coverUrls.get(last.id) : undefined;
    const sec = last.sectionCount ? `Chapter ${Math.min(last.position.section + 1, last.sectionCount)} of ${last.sectionCount}` : '';
    const cover = h('div', { class: 'lib-cover' }, url ? h('img', { src: url, alt: '' }) : generatedCover(last));
    hero.replaceChildren(h('div', { class: 'card lib-hero', onclick: () => go('#/play/' + last.id) },
      cover,
      h('div', { class: 'meta' },
        h('div', { class: 'kicker' }, 'Continue listening'),
        h('div', { class: 't' }, last.title),
        h('div', { class: 'progress' }, h('i', { style: `width:${Math.round(progressOf(last) * 100)}%` })),
        sec ? h('div', { class: 'small muted', style: 'margin-top:6px' }, sec) : null),
      h('button', { class: 'icon-btn big', 'aria-label': 'Play ' + last.title, html: icons.play, onclick: (e: Event) => { e.stopPropagation(); playItem(last); } })));
  }

  function layout() {
    const list = sorted();
    const ids = new Set(list.map((i) => i.id));
    for (const [id, c] of cards) if (!ids.has(id)) {
      c.el.remove(); cards.delete(id);
      const u = coverUrls.get(id); if (u) { URL.revokeObjectURL(u); coverUrls.delete(id); }
    }
    for (const it of list) {
      let c = cards.get(it.id);
      if (!c) { c = new Card(it); cards.set(it.id, c); } else c.update(it);
    }
    const want = list.map((i) => cards.get(i.id)!.el);
    const have = Array.from(grid.children);
    if (want.length !== have.length || want.some((el, i) => el !== have[i])) grid.replaceChildren(...want);
    empty.style.display = list.length ? 'none' : '';
    chips.style.display = list.length > 1 ? '' : 'none';
    grid.style.display = list.length ? '' : 'none';
    renderHero();
  }

  async function refresh() {
    const my = ++seq;
    const all = (await listItems('book')).filter((i) => i.kind === 'book');
    if (disposed || my !== seq) return;
    items = all;
    layout();
  }

  renderChips();
  refresh().then(() => { if (!disposed) resumeStalled().catch(console.error); });
  const off = onChange('items', refresh);

  return () => {
    disposed = true;
    off();
    window.removeEventListener('dragenter', onDragEnter);
    window.removeEventListener('dragover', onDragOver);
    window.removeEventListener('dragleave', onDragLeave);
    window.removeEventListener('drop', onDrop);
    for (const u of coverUrls.values()) URL.revokeObjectURL(u);
    coverUrls.clear();
  };
}
