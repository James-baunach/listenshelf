// Original-PDF page view: pdf.js canvases in a vertical scroller with the current sentence
// highlighted (rectangles computed from pdf.js text items) and tap-to-start-here.
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';
import { getFile, getItem } from '../db';
import { loadOcrWords, type OcrLayout } from '../pdf/ocrlayout';
import { ensurePageMap } from '../pdf/pagemap';
import {
  buildPageText, hitTest, layoutSentences, rectsFor, wordRect, wordStartAtKey,
  type KeyRange, type PageText, type Rect,
} from '../pdf/pagetext';
import type { DocContent, Item } from '../types';
import { h } from './dom';
import './pageview.css';

export interface PageView {
  el: HTMLElement;
  /** Load the item's PDF (no-op if same item). Only used for PDF books whose sections have `pages`. */
  setItem(item: Item, content: DocContent): void;
  /** Show the page containing this sentence and highlight the sentence on it (follow mode). */
  setPosition(section: number, sentence: number): void;
  /** Pane became visible. */
  shown(): void;
  destroy(): void;
}

interface PageSlot {
  n: number; // 1-based
  wrap: HTMLElement;
  hl: HTMLElement;
  ratio: number; // height / width
  canvas?: HTMLCanvasElement;
  renderedW?: number; // css width the canvas was rendered for
  failedAt?: number;
}
interface Entry { sec: number; sen: number }
interface PageInfo { pt: PageText; vp: number[]; vw: number; vh: number; entries: Entry[]; ranges: (KeyRange | null)[] }

const ZOOMS = [0.75, 1, 1.25, 1.5, 2, 2.5, 3];
const ZOOM_KEY = 'ls-pv-zoom';
const MAX_PIXELS = 14e6;
const RENDER_TIMEOUT = 20000;
const tick = () => new Promise<void>((r) => setTimeout(r));
const withTimeout = <T,>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

export function createPageView(opts: { onPick: (section: number, sentence: number, char?: number) => void }): PageView {
  const scroller = h('div', { class: 'pv-scroll' });
  const pagesBox = h('div', { class: 'pv-pages' });
  scroller.append(pagesBox);
  const zoomLabel = h('span', { class: 'pv-zl' });
  const pageLabel = h('span', { class: 'pv-pg' });
  const bMinus = h('button', { class: 'pv-btn', 'aria-label': 'Zoom out', onclick: () => stepZoom(-1) }, '−');
  const bPlus = h('button', { class: 'pv-btn', 'aria-label': 'Zoom in', onclick: () => stepZoom(1) }, '+');
  const bar = h('div', { class: 'pv-bar' }, pageLabel, bMinus, zoomLabel, bPlus);
  const msg = h('div', { class: 'pv-msg', hidden: true });
  const jump = h('button', { class: 'pv-jump', hidden: true, onclick: () => { follow = true; jump.hidden = true; scrollToHL(true); } }, 'Back to reading position');
  const el = h('div', { class: 'pv' }, scroller, bar, msg, jump);

  // ─── state ───
  let item: Item | null = null;
  let content: DocContent | null = null;
  let loadSeq = 0;
  let curId = '';
  let task: { destroy(): Promise<void> } | null = null;
  let doc: PDFDocumentProxy | null = null;
  let slots: PageSlot[] = [];
  let ocrLayout: OcrLayout | null = null;
  let pos = { section: 0, sentence: 0 };
  let follow = true;
  let programmaticUntil = 0;
  let zoom = Math.max(0.75, Math.min(3, Number(localStorage.getItem(ZOOM_KEY)) || 1));
  let cssW = 0;
  let destroyed = false;
  let pageIndex = new Map<number, Entry[]>();
  const infoCache = new Map<number, Promise<PageInfo | null>>();
  let hlState: { page: number; top: number; bottom: number } | null = null;
  let hlSeq = 0;

  // ─── layout ───
  const paneWidth = () => scroller.clientWidth;
  function computeWidth() { return Math.max(120, Math.floor((paneWidth() - 16) * zoom)); }

  function layout(keepScroll = true) {
    const pw = paneWidth();
    if (!pw || !slots.length) return;
    const w = computeWidth();
    if (w === cssW && slots[0].wrap.style.width) return;
    const old = cssW;
    cssW = w;
    const ratioScroll = old ? w / old : 1;
    const st = scroller.scrollTop * ratioScroll;
    pagesBox.style.width = `${w}px`;
    for (const s of slots) { s.wrap.style.width = `${w}px`; s.wrap.style.height = `${Math.round(w * s.ratio)}px`; }
    if (keepScroll && old) scroller.scrollTop = st;
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    reobserve();
  }
  function setSlotRatio(s: PageSlot, ratio: number) {
    if (!isFinite(ratio) || ratio <= 0 || Math.abs(ratio - s.ratio) < 0.004) return;
    s.ratio = ratio;
    if (cssW) s.wrap.style.height = `${Math.round(cssW * ratio)}px`;
  }
  function stepZoom(d: number) {
    const i = ZOOMS.reduce((best, z, k) => (Math.abs(z - zoom) < Math.abs(ZOOMS[best] - zoom) ? k : best), 0);
    const z = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, i + d))];
    if (z === zoom) return;
    zoom = z;
    localStorage.setItem(ZOOM_KEY, String(z));
    const cx = scroller.scrollWidth ? (scroller.scrollLeft + scroller.clientWidth / 2) / scroller.scrollWidth : 0.5;
    layout(true);
    scroller.scrollLeft = cx * scroller.scrollWidth - scroller.clientWidth / 2;
    bMinus.disabled = zoom <= ZOOMS[0];
    bPlus.disabled = zoom >= ZOOMS[ZOOMS.length - 1];
    if (follow) scrollToHL(false);
  }

  // ─── lazy rendering ───
  const want = new Set<number>();
  let renderIO: IntersectionObserver | null = null;
  let releaseIO: IntersectionObserver | null = null;
  let rendering = false;
  let pumpTimer = 0;

  function makeObservers() {
    renderIO?.disconnect(); releaseIO?.disconnect();
    renderIO = new IntersectionObserver((es) => {
      for (const e of es) {
        const n = Number((e.target as HTMLElement).dataset.n);
        if (e.isIntersecting) want.add(n); else want.delete(n);
      }
      pump();
    }, { root: scroller, rootMargin: '100% 0px 100% 0px' });
    releaseIO = new IntersectionObserver((es) => {
      for (const e of es) if (!e.isIntersecting) release(Number((e.target as HTMLElement).dataset.n));
    }, { root: scroller, rootMargin: '250% 0px 250% 0px' });
  }
  function reobserve() {
    want.clear();
    if (!renderIO || !releaseIO) return;
    renderIO.disconnect(); releaseIO.disconnect();
    for (const s of slots) { renderIO.observe(s.wrap); releaseIO.observe(s.wrap); }
  }
  function release(n: number) {
    const s = slots[n - 1];
    if (!s?.canvas) return;
    s.canvas.width = s.canvas.height = 0;
    s.canvas.remove();
    s.canvas = undefined; s.renderedW = undefined;
  }
  function visible() { return !destroyed && !document.hidden && el.isConnected && scroller.clientWidth > 0; }

  function pump() {
    if (rendering || !doc || !visible()) return;
    const mid = scroller.scrollTop + scroller.clientHeight / 2;
    let best: PageSlot | null = null, bd = Infinity;
    for (const n of want) {
      const s = slots[n - 1];
      if (!s || (s.canvas && s.renderedW === cssW)) continue;
      if (s.failedAt && Date.now() - s.failedAt < 4000) continue;
      const d = Math.abs(s.wrap.offsetTop + s.wrap.offsetHeight / 2 - mid);
      if (d < bd) { bd = d; best = s; }
    }
    if (!best) return;
    rendering = true;
    const s = best;
    void renderSlot(s).finally(() => {
      rendering = false;
      if (s.failedAt) { clearTimeout(pumpTimer); pumpTimer = window.setTimeout(pump, 4200); }
      setTimeout(pump, 0);
    });
  }

  async function renderSlot(s: PageSlot) {
    const d = doc;
    if (!d) return;
    let rt: RenderTask | null = null;
    try {
      const page = await d.getPage(s.n);
      const base = page.getViewport({ scale: 1 });
      setSlotRatio(s, base.height / base.width);
      const w = cssW;
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      let scale = (w / base.width) * dpr;
      scale = Math.min(scale, Math.sqrt(MAX_PIXELS / (base.width * base.height)), 4096 / Math.max(base.width, base.height));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.className = 'pv-cv';
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no canvas');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      rt = page.render({ canvas, canvasContext: ctx, viewport });
      await withTimeout(rt.promise, RENDER_TIMEOUT);
      if (destroyed || d !== doc) { canvas.width = canvas.height = 0; return; }
      s.canvas?.remove();
      if (s.canvas) s.canvas.width = s.canvas.height = 0;
      s.wrap.insertBefore(canvas, s.hl);
      s.canvas = canvas; s.renderedW = w; s.failedAt = undefined;
      page.cleanup();
      if (!want.has(s.n) && !releaseVisible(s)) release(s.n);
    } catch (e) {
      try { rt?.cancel(); } catch { /* ignore */ }
      if (!destroyed && d === doc) { s.failedAt = Date.now(); console.warn('page render failed', s.n, e); }
    }
  }
  const releaseVisible = (s: PageSlot) => {
    const r = s.wrap.getBoundingClientRect(), v = scroller.getBoundingClientRect();
    return r.bottom > v.top - v.height * 2.5 && r.top < v.bottom + v.height * 2.5;
  };

  // ─── page text, sentence layout ───
  function buildIndex() {
    pageIndex = new Map();
    infoCache.clear();
    if (!content) return;
    content.sections.forEach((sec, si) => {
      sec.pages?.forEach((p, j) => {
        let l = pageIndex.get(p);
        if (!l) pageIndex.set(p, (l = []));
        l.push({ sec: si, sen: j });
      });
    });
  }

  async function textFor(n: number): Promise<{ tc: { items: unknown[] }; vp: number[]; vw: number; vh: number } | null> {
    const d = doc;
    if (!d) return null;
    const page: PDFPageProxy = await d.getPage(n);
    const v = page.getViewport({ scale: 1 });
    if (ocrLayout) {
      const o = ocrLayout.pages[n - 1];
      if (!o) return null;
      const pdfPt = (fx: number, fy: number) => v.convertToPdfPoint(fx * v.width, fy * v.height);
      const items = o.map(([x0, y0, x1, y1, str]) => {
        const O = pdfPt(x0, y1), R = pdfPt(x1, y1), U = pdfPt(x0, y0);
        const width = Math.hypot(R[0] - O[0], R[1] - O[1]) || 1;
        const up = [U[0] - O[0], U[1] - O[1]];
        const height = Math.hypot(up[0], up[1]) || 1;
        const dx = (R[0] - O[0]) / width, dy = (R[1] - O[1]) / width;
        return { str, transform: [dx * height, dy * height, up[0], up[1], O[0], O[1]], width, height };
      });
      return { tc: { items }, vp: v.transform, vw: v.width, vh: v.height };
    }
    const tc = await page.getTextContent();
    page.cleanup();
    return { tc, vp: v.transform, vw: v.width, vh: v.height };
  }

  function pageInfo(n: number): Promise<PageInfo | null> {
    let p = infoCache.get(n);
    if (!p) {
      const seq = loadSeq;
      p = (async () => {
        const t = await textFor(n);
        if (!t || seq !== loadSeq || !content) return null;
        const pt = buildPageText(t.tc);
        const entries = pageIndex.get(n) ?? [];
        const ranges = layoutSentences(pt, entries.map((e) => content!.sections[e.sec].sentences[e.sen]));
        return { pt, vp: t.vp, vw: t.vw, vh: t.vh, entries, ranges };
      })().catch(() => null);
      infoCache.set(n, p);
      if (infoCache.size > 40) infoCache.delete(infoCache.keys().next().value as number);
    }
    return p;
  }

  // ─── highlight ───
  async function locateCurrent(): Promise<{ page: number; rects: Rect[] } | null> {
    if (!content) return null;
    const sec = content.sections[pos.section];
    const page = sec?.pages?.[pos.sentence];
    if (!sec || !page) return null;
    const target = `${pos.section}:${pos.sentence}`;
    for (const n of [page, page + 1, page - 1]) {
      if (n < 1 || n > slots.length) continue;
      const info = await pageInfo(n);
      if (!info) continue;
      const k = info.entries.findIndex((e) => `${e.sec}:${e.sen}` === target);
      let r = k >= 0 ? info.ranges[k] : null;
      if (!r && n !== page) {
        // the page map may be a little off; search this sentence alone
        const only = layoutSentences(info.pt, [sec.sentences[pos.sentence]])[0];
        r = only;
      }
      if (r) {
        const rects = rectsFor(info.pt, r, info.vp, info.vw, info.vh);
        if (rects.length) return { page: n, rects };
      }
    }
    return { page, rects: [] };
  }

  function clearHL() { for (const s of slots) if (s.hl.firstChild) s.hl.replaceChildren(); }

  async function updateHighlight(scroll: boolean) {
    const seq = ++hlSeq;
    const res = await locateCurrent();
    if (seq !== hlSeq || destroyed) return;
    clearHL();
    if (!res) { hlState = null; return; }
    const s = slots[res.page - 1];
    if (!s) return;
    if (res.rects.length) {
      for (const r of res.rects) {
        const b = h('div', { class: 'pv-hlbox' });
        Object.assign(b.style, { left: `${(r.x * 100).toFixed(3)}%`, top: `${(r.y * 100).toFixed(3)}%`, width: `${(r.w * 100).toFixed(3)}%`, height: `${(r.h * 100).toFixed(3)}%` });
        s.hl.append(b);
      }
      hlState = { page: res.page, top: Math.min(...res.rects.map((r) => r.y)), bottom: Math.max(...res.rects.map((r) => r.y + r.h)) };
    } else hlState = { page: res.page, top: 0, bottom: 0 };
    if (scroll) scrollToHL(true); else updateJump();
  }

  /** y range of the highlight in scroller content coordinates */
  function hlSpan(): { top: number; bottom: number } | null {
    if (!hlState) return null;
    const s = slots[hlState.page - 1];
    if (!s) return null;
    const r = s.wrap.getBoundingClientRect(), v = scroller.getBoundingClientRect();
    const base = r.top - v.top + scroller.scrollTop;
    return { top: base + hlState.top * r.height, bottom: base + hlState.bottom * r.height };
  }
  function scrollToHL(smooth: boolean) {
    const sp = hlSpan();
    if (!sp || !scroller.clientHeight) return;
    // no rects: just bring the page's top near the top
    const top = hlState && hlState.bottom === 0 ? sp.top - 8 : sp.top - scroller.clientHeight / 3;
    programmaticUntil = Date.now() + (smooth ? 900 : 150);
    scroller.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' });
  }
  function hlVisible() {
    const sp = hlSpan();
    if (!sp) return true;
    return sp.bottom > scroller.scrollTop && sp.top < scroller.scrollTop + scroller.clientHeight;
  }
  function updateJump() { jump.hidden = follow || hlVisible(); }

  function setPosition(section: number, sentence: number) {
    const moved = section !== pos.section || sentence !== pos.sentence;
    pos = { section, sentence };
    if (!moved && hlState) return;
    void updateHighlight(follow);
  }

  const userScrolled = () => {
    if (Date.now() < programmaticUntil) return;
    follow = false;
    updateJump();
  };
  scroller.addEventListener('touchmove', userScrolled, { passive: true });
  scroller.addEventListener('wheel', userScrolled, { passive: true });
  scroller.addEventListener('keydown', userScrolled);
  let labelTimer = 0;
  scroller.addEventListener('scroll', () => {
    if (!follow) updateJump();
    if (!labelTimer) labelTimer = window.setTimeout(() => { labelTimer = 0; updatePageLabel(); }, 120);
  }, { passive: true });

  function updatePageLabel() {
    if (!slots.length || !scroller.clientHeight) return;
    const mid = scroller.scrollTop + scroller.clientHeight / 2 - pagesBox.offsetTop;
    let lo = 0, hi = slots.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (slots[m].wrap.offsetTop <= mid) lo = m; else hi = m - 1;
    }
    pageLabel.textContent = `${lo + 1} / ${slots.length}`;
  }

  // ─── tap ───
  scroller.addEventListener('click', (ev) => {
    const wrap = (ev.target as HTMLElement).closest<HTMLElement>('.pv-page');
    if (!wrap || !content) return;
    const n = Number(wrap.dataset.n);
    const r = wrap.getBoundingClientRect();
    const fx = (ev.clientX - r.left) / r.width, fy = (ev.clientY - r.top) / r.height;
    void (async () => {
      const info = await pageInfo(n);
      if (!info || !info.entries.length) return;
      const hit = hitTest(info.pt, fx, fy, info.vp, info.vw, info.vh);
      if (!hit) return;
      let k = info.ranges.findIndex((x) => x && hit.keyIndex >= x.start && hit.keyIndex < x.end);
      if (k < 0) {
        // between sentences: nearest located one
        let bd = Infinity;
        info.ranges.forEach((x, i) => {
          if (!x) return;
          const d = hit.keyIndex < x.start ? x.start - hit.keyIndex : hit.keyIndex - x.end + 1;
          if (d < bd) { bd = d; k = i; }
        });
      }
      const range = info.ranges[k];
      if (k < 0 || !range) return;
      const e = info.entries[k];
      const sentence = content!.sections[e.sec].sentences[e.sen];
      const ch = wordStartAtKey(sentence, Math.max(0, hit.keyIndex - range.start));
      flash(n, wordRect(info.pt.items[hit.item], hit.char, info.vp, info.vw, info.vh));
      follow = true; jump.hidden = true;
      opts.onPick(e.sec, e.sen, ch);
    })();
  });
  function flash(n: number, r: Rect) {
    const s = slots[n - 1];
    if (!s) return;
    const f = h('div', { class: 'pv-flash' });
    Object.assign(f.style, { left: `${(r.x * 100).toFixed(3)}%`, top: `${(r.y * 100).toFixed(3)}%`, width: `${(r.w * 100).toFixed(3)}%`, height: `${(r.h * 100).toFixed(3)}%` });
    s.hl.append(f);
    setTimeout(() => f.remove(), 700);
  }

  // ─── document lifecycle ───
  function showMsg(t: string | null) { msg.hidden = !t; msg.textContent = t ?? ''; }

  async function closeDoc() {
    loadSeq++;
    const t = task, d = doc;
    task = null; doc = null;
    renderIO?.disconnect(); releaseIO?.disconnect();
    want.clear();
    for (const s of slots) if (s.canvas) { s.canvas.width = s.canvas.height = 0; }
    slots = [];
    pagesBox.replaceChildren();
    infoCache.clear(); pageIndex = new Map();
    hlState = null; cssW = 0; ocrLayout = null; rendering = false;
    try { await d?.cleanup?.(); } catch { /* ignore */ }
    try { await t?.destroy(); } catch { /* ignore */ }
  }

  async function openDoc(it: Item, seq: number) {
    showMsg('Loading pages…');
    try {
      const rec = await getFile(it.id);
      if (seq !== loadSeq) return;
      if (!rec) { showMsg('The original PDF is not stored on this device.'); return; }
      const { loadPdfjs } = await import('../pdf/loader');
      const pdfjs = await loadPdfjs();
      if (seq !== loadSeq) return;
      const data = new Uint8Array(await rec.blob.arrayBuffer());
      const t = pdfjs.getDocument({ data });
      task = t;
      const d = await t.promise;
      if (seq !== loadSeq) { void t.destroy(); return; }
      doc = d;
      if (it.ocr) ocrLayout = await loadOcrLayout(it.id);
      const first = await d.getPage(1);
      const v1 = first.getViewport({ scale: 1 });
      const ratio0 = v1.height / v1.width;
      first.cleanup();
      if (seq !== loadSeq) return;
      slots = [];
      const frag = document.createDocumentFragment();
      for (let n = 1; n <= d.numPages; n++) {
        const hl = h('div', { class: 'pv-hl' });
        const wrap = h('div', { class: 'pv-page', 'data-n': n, 'aria-label': `Page ${n}` }, hl);
        slots.push({ n, wrap, hl, ratio: ratio0 });
        frag.append(wrap);
      }
      pagesBox.replaceChildren(frag);
      showMsg(null);
      makeObservers();
      cssW = 0;
      layout(false);
      updatePageLabel();
      buildIndex();
      void updateHighlight(true);
      void refineSizes(d, seq);
    } catch (e) {
      console.warn('page view load failed', e);
      if (seq === loadSeq) showMsg('Could not open the original PDF.');
    }
  }

  /** Gets each page's real aspect ratio in the background (scroll anchoring keeps the view steady). */
  async function refineSizes(d: PDFDocumentProxy, seq: number) {
    for (let n = 2; n <= d.numPages; n++) {
      if (seq !== loadSeq || destroyed) return;
      try {
        const p = await d.getPage(n);
        const v = p.getViewport({ scale: 1 });
        const s = slots[n - 1];
        if (s) setSlotRatio(s, v.height / v.width);
        p.cleanup();
      } catch { /* skip */ }
      if (n % 20 === 0) { await tick(); if (follow && hlState) scrollToHL(false); }
    }
    if (seq === loadSeq && follow && hlState) scrollToHL(false);
  }

  function setItem(it: Item, c: DocContent) {
    const prev = content;
    content = c;
    if (curId === it.id) {
      item = it;
      if (prev !== c && doc && c.sections.every((x) => x.pages?.length === x.sentences.length)) { buildIndex(); void updateHighlight(follow); }
      return;
    }
    curId = it.id;
    item = it;
    const seq = ++loadSeq;
    void (async () => {
      await closeDoc();
      loadSeq = seq;
      if (destroyed) return;
      if (!c.sections.every((s) => s.pages?.length === s.sentences.length)) {
        showMsg('Preparing page view…');
        const fixed = await ensurePageMap(it.id, c);
        if (seq !== loadSeq) return;
        if (!fixed) { showMsg('Page view is not available for this book.'); return; }
        content = c;
      }
      if (seq !== loadSeq) return;
      // pick up the freshest item flags (e.g. ocr) in case the passed one is stale
      const fresh = await getItem(it.id).catch(() => undefined);
      if (fresh) item = fresh;
      await openDoc(item ?? it, seq);
    })();
  }

  // ─── visibility / resize ───
  const ro = new ResizeObserver(() => {
    if (!scroller.clientWidth) return;
    layout(true);
    pump();
    if (follow && hlState) scrollToHL(false);
  });
  ro.observe(scroller);
  const onVis = () => { if (!document.hidden) { layout(true); reobserve(); pump(); } };
  document.addEventListener('visibilitychange', onVis);

  bMinus.disabled = zoom <= ZOOMS[0];
  bPlus.disabled = zoom >= ZOOMS[ZOOMS.length - 1];
  zoomLabel.textContent = `${Math.round(zoom * 100)}%`;

  return {
    el,
    setItem,
    setPosition,
    shown() {
      follow = true; jump.hidden = true;
      const go = () => { layout(true); reobserve(); pump(); scrollToHL(false); updatePageLabel(); };
      requestAnimationFrame(go);
      setTimeout(go, 80);
      setTimeout(go, 400);
    },
    destroy() {
      destroyed = true;
      ro.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      clearTimeout(pumpTimer);
      void closeDoc();
    },
  };
}

async function loadOcrLayout(id: string): Promise<OcrLayout | null> {
  try {
    return await loadOcrWords(id);
  } catch { return null; }
}
