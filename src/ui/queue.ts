// "Wikipedia" tab: search/add articles, reorderable "Up next" queue, finished list.
import './queue.css';
import { h, toast, confirmSheet, go } from './dom';
import { icons } from './icons';
import {
  getQueue, setQueue, listItems, onChange, updateItem, deleteItem, getContent, getSettings,
} from '../db';
import { controller } from '../player/controller';
import { CHARS_PER_SEC, charsBefore } from '../text';
import type { Item } from '../types';
import { getFeatured, getMoreLike, type FeaturedArticle } from '../wiki/discover';
import { addArticle, searchWiki, parseWikiInput, looksLikeWikiUrl, randomArticle, WikiError, type WikiHit } from '../wiki';

const fmtDur = (sec: number) => {
  const m = Math.max(1, Math.round(sec / 60));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
};
const ago = (t: number) => {
  const d = (Date.now() - t) / 1000;
  if (d < 3600) return 'just now';
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  if (d < 86400 * 30) return `${Math.floor(d / 86400)} d ago`;
  return new Date(t).toLocaleDateString();
};
const errMsg = (e: unknown) => (e instanceof WikiError ? e.message : (e as Error)?.message || 'Something went wrong');

export function mount(root: HTMLElement, _params: Record<string, string>) {
  let items = new Map<string, Item>();
  let queue: string[] = [];
  let rate = 1;
  let lang = 'en';
  let nowId: string | null = controller.getState().itemId;
  let dragging = false;
  let dirty = false;
  let finOpen = false;
  let disposed = false;
  const progressCache = new Map<string, number>();

  // ── skeleton ──
  const note = h('div', { class: 'q-note err', hidden: true });
  const input = h('input', {
    class: 'input', type: 'search', placeholder: 'Search Wikipedia or paste a link', enterkeyhint: 'search',
    autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Search Wikipedia',
  });
  const clearBtn = h('button', { class: 'icon-btn q-clear', html: icons.close, 'aria-label': 'Clear search', hidden: true, onclick: () => { input.value = ''; onInput(true); input.focus(); } });
  const resultsEl = h('div', { class: 'q-results', hidden: true });
  const randomChip = h('button', { class: 'chip q-chip', onclick: () => doRandom() }, 'Random article');
  const discoverEl = h('div', { class: 'q-disc' });
  const queueEl = h('div');
  const finEl = h('div');

  root.append(
    h('div', { class: 'page-head' }, h('h1', null, 'Wikipedia')),
    note,
    h('div', { class: 'q-search' }, h('span', { html: icons.search }), input, clearBtn),
    h('div', { class: 'q-chips' }, randomChip),
    resultsEl, discoverEl, queueEl, finEl,
  );

  // ── offline banner ──
  const showNote = (msg: string | null) => { note.hidden = !msg; if (msg) note.textContent = msg; };
  const syncOnline = () => showNote(navigator.onLine ? null : "You're offline. Search and new downloads need a connection, but articles already in your queue still play.");
  addEventListener('online', syncOnline); addEventListener('offline', syncOnline);
  syncOnline();

  // ── data ──
  async function load() {
    const [all, q, s] = await Promise.all([listItems('article'), getQueue(), getSettings()]);
    if (disposed) return;
    items = new Map(all.map((i) => [i.id, i]));
    queue = q; rate = s.rate || 1; lang = s.wikiLang || 'en';
    if (dragging) { dirty = true; return; }
    renderQueue(); renderFinished();
    refreshDiscover();
  }
  const offs = [onChange('queue', load), onChange('items', load), onChange('settings', load)];
  const unsub = controller.subscribe((s) => {
    if (s.itemId === nowId) return;
    nowId = s.itemId;
    if (!dragging) renderQueue(); else dirty = true;
    refreshDiscover();
  });

  // ── actions ──
  async function openItem(id: string) {
    const it = items.get(id);
    if (!it || it.status !== 'ready') return;
    const q = await getQueue();
    if (q.includes(id) && q[0] !== id) await setQueue([id, ...q.filter((x) => x !== id)]);
    controller.open(id, { autoplay: true });
    go('#/play/' + id);
  }
  async function playQueue() {
    const first = queue.find((id) => items.get(id)?.status === 'ready');
    if (first) openItem(first); else toast('Nothing ready to play yet');
  }
  async function removeItem(id: string, ask: boolean) {
    const it = items.get(id);
    if (!it) { await setQueue((await getQueue()).filter((x) => x !== id)); return true; }
    if (ask && (progressCache.get(id) ?? 0) > 0.01 &&
      !(await confirmSheet('Remove article?', `"${it.title}" will be removed and you'll lose your place.`, 'Remove', true))) return false;
    if (controller.getState().itemId === id) controller.close();
    await deleteItem(id);
    return true;
  }
  async function clearQueue() {
    if (!queue.length) return;
    if (!(await confirmSheet('Clear queue?', `Remove ${queue.length} article${queue.length > 1 ? 's' : ''} from your queue? Downloads are deleted too.`, 'Clear', true))) return;
    for (const id of [...queue]) await removeItem(id, false);
  }
  async function retry(it: Item) {
    try { await addArticle(it.sourceUrl ?? it.title, { position: 'keep' }); }
    catch (e) { toast(errMsg(e)); }
  }
  async function listenAgain(it: Item) {
    await updateItem(it.id, { finishedAt: undefined, position: { section: 0, sentence: 0, updatedAt: Date.now() } });
    progressCache.delete(it.id);
    const q = await getQueue();
    if (!q.includes(it.id)) await setQueue([...q, it.id]);
    toast('Added to queue');
  }
  async function deleteFinished(it: Item) {
    if (await confirmSheet('Delete article?', `Remove "${it.title}" from this device?`, 'Delete', true)) {
      if (controller.getState().itemId === it.id) controller.close();
      await deleteItem(it.id);
    }
  }

  // ── search ──
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ctl: AbortController | undefined;
  let seq = 0;
  const thumb = (url?: string) => {
    const box = h('div', { class: 'q-thumb' });
    box.innerHTML = icons.wiki;
    if (url) {
      const img = h('img', { src: url, alt: '', referrerpolicy: 'no-referrer' });
      img.addEventListener('load', () => box.replaceChildren(img));
    }
    return box;
  };
  function onInput(immediate = false) {
    clearBtn.hidden = !input.value;
    clearTimeout(timer);
    const q = input.value.trim();
    syncDiscover();
    if (!q) { ctl?.abort(); seq++; resultsEl.hidden = true; resultsEl.replaceChildren(); syncDiscover(); return; }
    if (looksLikeWikiUrl(q)) { showUrlResult(q); return; }
    timer = setTimeout(() => doSearch(q), immediate ? 0 : 300);
  }
  async function doSearch(q: string) {
    ctl?.abort(); ctl = new AbortController();
    const my = ++seq;
    resultsEl.hidden = false; syncDiscover();
    resultsEl.replaceChildren(h('div', { class: 'row gap', style: 'padding:12px 4px' }, h('div', { class: 'spinner' }), h('span', { class: 'muted' }, 'Searching…')));
    try {
      const hits = await searchWiki(q, lang, ctl.signal);
      if (my !== seq || disposed) return;
      showNote(null);
      renderResults(hits, hits.length ? '' : `No articles found for "${q}".`);
    } catch (e) {
      if (my !== seq || (e as Error).name === 'AbortError') return;
      resultsEl.replaceChildren(h('div', { class: 'q-note err' }, errMsg(e)));
    }
  }
  function showUrlResult(url: string) {
    const p = parseWikiInput(url, lang);
    resultsEl.hidden = false; syncDiscover();
    if (!p) { resultsEl.replaceChildren(h('div', { class: 'q-note err' }, 'That link is not a Wikipedia article.')); return; }
    renderResults([{ title: p.title, key: url, description: `Wikipedia (${p.lang})` }], '', 'Add this article');
  }
  async function doRandom() {
    randomChip.setAttribute('disabled', '');
    try {
      const hit = await randomArticle(lang);
      input.value = ''; clearBtn.hidden = true; ctl?.abort(); seq++;
      resultsEl.hidden = false; syncDiscover();
      renderResults([hit], '', undefined, 'Random pick');
    } catch (e) { toast(errMsg(e)); }
    finally { randomChip.removeAttribute('disabled'); }
  }
  function renderResults(hits: WikiHit[], empty: string, labelOverride?: string, heading?: string) {
    resultsEl.replaceChildren(...([
      heading ? h('p', { class: 'q-sub' }, heading) : null,
      empty ? h('p', { class: 'muted', style: 'padding:8px 4px' }, empty) : null,
      h('ul', { class: 'list q-list q-res' }, hits.map((hit) => h('li', null,
        h('div', { class: 'q-row' },
          h('button', { class: 'q-main', 'aria-label': `Add ${hit.title} to queue`, onclick: () => addToQueue(hit) },
            thumb(hit.thumbnailUrl),
            h('div', { class: 'q-text' },
              h('div', { class: 'q-title' }, labelOverride ? `${labelOverride}: ${hit.title}` : hit.title),
              hit.description ? h('div', { class: 'q-meta' }, hit.description) : null)),
          h('button', { class: 'icon-btn q-act', html: icons.plus, 'aria-label': 'Add to queue', onclick: () => addToQueue(hit) }),
          h('button', { class: 'icon-btn q-act', html: icons.play, 'aria-label': 'Play now', onclick: () => playNow(hit) })))))].filter((x) => x != null) as Node[]));
  }
  async function addToQueue(hit: WikiHit) {
    try { await addArticle(hit.key, { position: 'end', onCreated: () => toast('Added to queue') }); }
    catch (e) { toast(errMsg(e)); }
  }
  async function playNow(hit: WikiHit) {
    toast('Loading article…');
    try {
      const id = await addArticle(hit.key, { position: 'now' });
      await controller.open(id, { autoplay: true });
      go('#/play/' + id);
    } catch (e) { toast(errMsg(e)); }
  }
  input.addEventListener('input', () => onInput());
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); onInput(true); input.blur(); } });

  // ── discovery (background; never blocks the queue) ──
  let discOpen = localStorage.getItem('ls_discover_open') !== '0';
  let featured: FeaturedArticle | null = null;
  let featTried = '';
  let likeSeed = '';
  let likeHits: WikiHit[] = [];
  let likeCtl: AbortController | undefined;
  let discCtl: AbortController | undefined;
  const syncDiscover = () => { discoverEl.hidden = !resultsEl.hidden || !!input.value.trim() || (!featured && !likeHits.length); };
  function seedItem(): Item | undefined {
    const cur = nowId ? items.get(nowId) : undefined;
    if (cur && cur.kind === 'article') return cur;
    const all = [...items.values()];
    return all.filter((i) => i.finishedAt).sort((a, b) => b.finishedAt! - a.finishedAt!)[0]
      ?? all.filter((i) => i.lastPlayedAt).sort((a, b) => b.lastPlayedAt! - a.lastPlayedAt!)[0];
  }
  function refreshDiscover() {
    if (disposed) return;
    const day = new Date().toISOString().slice(0, 10) + lang;
    if (featTried !== day) {
      featTried = day; discCtl?.abort(); discCtl = new AbortController();
      getFeatured(lang, discCtl.signal).then((f) => { if (!disposed && f) { featured = f; renderDiscover(); } }).catch(() => {});
    }
    const seed = seedItem();
    if (seed && seed.title !== likeSeed) {
      likeSeed = seed.title; likeCtl?.abort(); likeCtl = new AbortController();
      getMoreLike(lang, seed.title, 5, likeCtl.signal)
        .then((hits) => { if (disposed || likeSeed !== seed.title) return; likeHits = hits.filter((x) => !items.has(articleKey(x))); renderDiscover(); })
        .catch(() => {});
    }
  }
  const articleKey = (x: WikiHit) => 'w_' + lang + '_' + x.title.replace(/ /g, '_');
  function discRow(hit: WikiHit) {
    return h('li', null, h('div', { class: 'q-row' },
      h('button', { class: 'q-main', 'aria-label': `Add ${hit.title} to queue`, onclick: () => addToQueue(hit) },
        thumb(hit.thumbnailUrl),
        h('div', { class: 'q-text' }, h('div', { class: 'q-title' }, hit.title), hit.description ? h('div', { class: 'q-meta' }, hit.description) : null)),
      h('button', { class: 'icon-btn q-act', html: icons.plus, 'aria-label': `Add ${hit.title} to queue`, onclick: () => addToQueue(hit) }),
      h('button', { class: 'icon-btn q-act', html: icons.play, 'aria-label': `Play ${hit.title} now`, onclick: () => playNow(hit) })));
  }
  function renderDiscover() {
    if (disposed) return;
    syncDiscover();
    if (!featured && !likeHits.length) { discoverEl.replaceChildren(); return; }
    const toggle = h('button', { class: 'q-fin-toggle q-disc-toggle', 'aria-expanded': String(discOpen),
      onclick: () => { discOpen = !discOpen; localStorage.setItem('ls_discover_open', discOpen ? '1' : '0'); renderDiscover(); } },
      h('span', null, 'Discover'), h('span', { class: 'chev', html: icons.nextSentence }));
    const kids: (Node | null)[] = [toggle];
    if (discOpen) {
      if (featured) {
        const f = featured;
        kids.push(h('div', { class: 'q-feat' },
          h('p', { class: 'q-sub' }, "Today's featured article"),
          h('div', { class: 'q-feat-body' }, thumb(f.thumbnailUrl),
            h('div', { class: 'q-text' }, h('div', { class: 'q-title' }, f.title),
              f.description ? h('div', { class: 'q-meta' }, f.description) : null)),
          f.extract ? h('p', { class: 'q-feat-extract' }, f.extract) : null,
          h('div', { class: 'row end gap' },
            h('button', { class: 'btn', onclick: () => addToQueue(f) }, 'Add'),
            h('button', { class: 'btn primary', onclick: () => playNow(f) }, 'Play'))));
      }
      if (likeHits.length) kids.push(h('p', { class: 'q-sub', style: 'margin-top:14px' }, `More like ${likeSeed}`), h('ul', { class: 'list q-list' }, likeHits.map(discRow)));
    }
    discoverEl.replaceChildren(...(kids.filter(Boolean) as Node[]));
  }

  // ── queue rendering ──
  async function computeProgress(it: Item, bar: HTMLElement, meta: HTMLElement) {
    const { section, sentence } = it.position;
    if (!section && !sentence) { progressCache.set(it.id, 0); return; }
    const key = `${it.id}|${section}|${sentence}`;
    let f = progressCache.get(key);
    if (f == null) {
      const c = await getContent(it.id);
      if (!c || !it.totalChars) return;
      f = Math.min(1, charsBefore(c.sections, section, sentence) / it.totalChars);
      progressCache.set(key, f);
    }
    progressCache.set(it.id, f);
    if (disposed) return;
    bar.style.width = `${Math.round(f * 100)}%`;
    bar.parentElement!.hidden = f < 0.01;
    meta.textContent = metaText(it, f);
  }
  function metaText(it: Item, f = 0): string {
    const secs = (it.totalChars / CHARS_PER_SEC) / rate;
    const parts = [`${it.sectionCount} section${it.sectionCount === 1 ? '' : 's'}`];
    parts.push(f >= 0.01 ? `${fmtDur(secs * (1 - f))} left` : fmtDur(secs));
    return parts.join(' · ');
  }

  function queueRow(id: string): HTMLElement | null {
    const it = items.get(id);
    if (!it) return null;
    const playing = nowId === id;
    const ready = it.status === 'ready';
    const bar = h('i');
    const barWrap = h('div', { class: 'progress', hidden: true }, bar);
    const metaTxt = h('span', null, ready ? metaText(it) : '');
    const meta = h('div', { class: 'q-meta' },
      playing ? h('span', { class: 'q-now' }, 'Now playing') : null,
      it.status === 'processing' ? [h('div', { class: 'spinner' }), h('span', null, 'Downloading…')] : null,
      it.status === 'error' ? h('span', { class: 'q-err' }, it.error ?? 'Download failed') : null,
      it.status === 'no-text' ? h('span', { class: 'q-err' }, 'No readable text') : null,
      ready ? metaTxt : null);

    const main = h('button', { class: 'q-main', onclick: () => { if (!swiped && ready) openItem(id); } },
      thumb(it.thumbnailUrl),
      h('div', { class: 'q-text' }, h('div', { class: 'q-title' }, it.title), meta, ready ? barWrap : null));

    const handle = h('button', { class: 'icon-btn q-handle', html: icons.drag, 'aria-label': `Reorder ${it.title}` });
    const row = h('div', { class: 'q-row' + (playing ? ' q-playing' : '') },
      handle, main,
      it.status === 'error' ? h('button', { class: 'btn q-act', onclick: () => retry(it) }, 'Retry') : null,
      h('button', { class: 'icon-btn q-act', html: icons.close, 'aria-label': `Remove ${it.title}`, onclick: () => removeItem(id, true) }));
    const li = h('li', { 'data-id': id }, h('div', { class: 'q-del' }, 'Remove'), row);

    // swipe left to remove
    let swiped = false;
    let sx = 0, sy = 0, dx = 0, mode: 'none' | 'h' | 'v' = 'none', pid = -1;
    main.addEventListener('pointerdown', (e) => { sx = e.clientX; sy = e.clientY; dx = 0; mode = 'none'; pid = e.pointerId; swiped = false; });
    main.addEventListener('pointermove', (e) => {
      if (e.pointerId !== pid || mode === 'v') return;
      const mx = e.clientX - sx, my = e.clientY - sy;
      if (mode === 'none') {
        if (Math.abs(mx) < 10 && Math.abs(my) < 10) return;
        mode = Math.abs(mx) > Math.abs(my) ? 'h' : 'v';
        if (mode === 'h') { try { main.setPointerCapture(e.pointerId); } catch { /* ignore */ } swiped = true; }
        else return;
      }
      dx = Math.min(0, mx);
      row.style.transform = `translateX(${dx}px)`;
    });
    const endSwipe = (e: PointerEvent) => {
      if (e.pointerId !== pid) return;
      pid = -1;
      if (mode === 'h') {
        const w = li.clientWidth;
        if (dx < -Math.min(110, w * 0.3)) {
          row.style.transition = 'transform .15s'; row.style.transform = `translateX(${-w}px)`;
          setTimeout(async () => { if (!(await removeItem(id, true))) { row.style.transform = ''; } }, 120);
        } else { row.style.transition = 'transform .15s'; row.style.transform = ''; setTimeout(() => (row.style.transition = ''), 160); }
        setTimeout(() => (swiped = false), 50);
      }
      mode = 'none';
    };
    main.addEventListener('pointerup', endSwipe);
    main.addEventListener('pointercancel', endSwipe);

    attachDrag(handle, li);
    if (ready) computeProgress(it, bar, metaTxt);
    return li;
  }

  function attachDrag(handle: HTMLElement, li: HTMLElement) {
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const ul = li.parentElement as HTMLElement;
      handle.setPointerCapture(e.pointerId);
      dragging = true;
      li.classList.add('q-dragging');
      let startY = e.clientY, lastY = e.clientY;
      const startScroll = scrollY;
      let raf = 0;
      const apply = () => {
        const dy = lastY - startY + (scrollY - startScroll);
        li.style.transform = `translateY(${dy}px)`;
        // swap with neighbours when crossing their midpoints
        const r = li.getBoundingClientRect(), c = r.top + r.height / 2;
        const next = li.nextElementSibling as HTMLElement | null, prev = li.previousElementSibling as HTMLElement | null;
        let moved = false;
        const before = li.offsetTop;
        if (next) { const nr = next.getBoundingClientRect(); if (c > nr.top + nr.height / 2) { ul.insertBefore(next, li); moved = true; } }
        if (!moved && prev) { const pr = prev.getBoundingClientRect(); if (c < pr.top + pr.height / 2) { ul.insertBefore(li, prev); moved = true; } }
        if (moved) { startY += li.offsetTop - before; li.style.transform = `translateY(${lastY - startY + (scrollY - startScroll)}px)`; }
      };
      const tick = () => {
        const edge = 70;
        if (lastY < edge + 60) scrollBy(0, -Math.ceil((edge + 60 - lastY) / 6));
        else if (lastY > innerHeight - edge - 60) scrollBy(0, Math.ceil((lastY - (innerHeight - edge - 60)) / 6));
        apply();
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      const move = (ev: PointerEvent) => { lastY = ev.clientY; };
      const up = async () => {
        cancelAnimationFrame(raf);
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        li.classList.remove('q-dragging');
        li.style.transform = '';
        const order = Array.from(ul.children).map((c) => (c as HTMLElement).dataset.id!).filter(Boolean);
        dragging = false; dirty = false;
        const hidden = queue.filter((id) => !order.includes(id)); // queued ids without items
        queue = [...order, ...hidden];
        await setQueue(queue);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
  }

  function renderQueue() {
    if (disposed) return;
    const rows = queue.map(queueRow).filter((x): x is HTMLElement => !!x);
    if (!rows.length) {
      queueEl.replaceChildren(h('div', { class: 'empty' }, h('div', { html: icons.queue }),
        h('p', null, 'Your queue is empty.'), h('p', { class: 'small faint' }, 'Search above to add articles. They download for offline listening.')));
      return;
    }
    queueEl.replaceChildren(
      h('div', { class: 'q-head' }, h('h2', null, `Up next (${rows.length})`),
        h('button', { class: 'btn ghost', onclick: clearQueue }, 'Clear'),
        h('button', { class: 'btn primary', onclick: playQueue }, h('span', { html: icons.play, style: 'display:flex;width:18px' }), 'Play queue')),
      h('ul', { class: 'list q-list' }, rows));
  }

  function renderFinished() {
    if (disposed) return;
    const fin = [...items.values()].filter((i) => i.finishedAt).sort((a, b) => b.finishedAt! - a.finishedAt!).slice(0, 30);
    if (!fin.length) { finEl.replaceChildren(); return; }
    const toggle = h('button', { class: 'q-fin-toggle', 'aria-expanded': String(finOpen), onclick: () => { finOpen = !finOpen; renderFinished(); } },
      h('span', null, `Finished (${fin.length})`), h('span', { class: 'chev', html: icons.nextSentence }));
    finEl.replaceChildren(...([toggle, finOpen ? h('ul', { class: 'list q-list' }, fin.map((it) => h('li', null,
      h('div', { class: 'q-row' },
        h('div', { class: 'q-main', style: 'cursor:default' }, thumb(it.thumbnailUrl),
          h('div', { class: 'q-text' }, h('div', { class: 'q-title' }, it.title), h('div', { class: 'q-meta' }, `Finished ${ago(it.finishedAt!)}`))),
        h('button', { class: 'btn q-act', onclick: () => listenAgain(it) }, 'Listen again'),
        h('button', { class: 'icon-btn q-act', html: icons.trash, 'aria-label': `Delete ${it.title}`, onclick: () => deleteFinished(it) }))))) : null].filter((x) => x != null) as Node[]));
  }

  load();
  return () => {
    disposed = true;
    clearTimeout(timer); ctl?.abort(); likeCtl?.abort(); discCtl?.abort();
    offs.forEach((f) => f()); unsub();
    removeEventListener('online', syncOnline); removeEventListener('offline', syncOnline);
  };
}
