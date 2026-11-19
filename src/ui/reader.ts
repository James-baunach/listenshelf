// Full-document reading pane used by the player (books and articles).
// - Renders every section (lazily, as they scroll near) so you can browse the whole text.
// - Underlines the sentence being read and follows it, unless you've scrolled away.
// - Tap any word to start reading from that word.
import './reader.css';
import type { DocContent, SectionLink } from '../types';
import { onChange } from '../db';
import { bookmarkInfo } from './bookmarks';
import { h } from './dom';

export interface Reader {
  el: HTMLElement;
  /** Load a document (no-op if it's the same one). */
  setContent(key: string, content: DocContent): void;
  /** Move the underline; scrolls to it if following. */
  setPosition(section: number, sentence: number): void;
  /** Called when the pane becomes visible (needs layout to scroll). */
  shown(): void;
  destroy(): void;
}

interface Block { el: HTMLElement; body: HTMLElement; rendered: boolean; spans: HTMLElement[] }

export interface ReaderOptions {
  /** Tap a word: start reading at that word. */
  onPick: (section: number, sentence: number, char: number) => void;
  /** Long-press a sentence (e.g. add a bookmark with a note). */
  onLongPress?: (section: number, sentence: number) => void;
  /** Tap a link (articles): the link's target. */
  onLink?: (link: SectionLink) => void;
}

export function createReader(opts: ReaderOptions): Reader {
  const { onPick } = opts;
  const scroller = h('div', { class: 'rd-scroll' });
  const jump = h('button', { class: 'rd-jump', hidden: true, onclick: () => { follow = true; jump.hidden = true; scrollToCurrent(true); } }, 'Back to reading position');
  const el = h('div', { class: 'rd' }, scroller, jump);

  let key = '';
  let content: DocContent | null = null;
  let blocks: Block[] = [];
  let pos = { section: 0, sentence: 0 };
  let cur: HTMLElement | null = null;
  let follow = true;
  let programmaticUntil = 0;

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) renderBlock(Number((e.target as HTMLElement).dataset.s));
  }, { root: scroller, rootMargin: '1200px 0px' });

  function renderBlock(i: number) {
    const b = blocks[i];
    if (!b || b.rendered || !content) return;
    b.rendered = true;
    const sec = content.sections[i];
    const paras = new Set(sec.paragraphs ?? [0]);
    const linksBySent = new Map<number, SectionLink[]>();
    for (const l of sec.links ?? []) {
      const a = linksBySent.get(l.sentence);
      if (a) a.push(l); else linksBySent.set(l.sentence, [l]);
    }
    const frag = document.createDocumentFragment();
    let p = h('p');
    b.spans = sec.sentences.map((t, j) => {
      if (j > 0 && paras.has(j)) { frag.append(p); p = h('p'); }
      const s = h('span', { class: 'sent', 'data-s': i, 'data-i': j });
      fillSentence(s, t, linksBySent.get(j));
      p.append(s, ' ');
      return s;
    });
    frag.append(p);
    b.body.replaceChildren(frag);
    b.body.style.minHeight = '';
    io.unobserve(b.el);
    applyMarks(i);
    if (i === pos.section) mark();
  }

  function setContent(k: string, c: DocContent) {
    if (k === key) return;
    key = k; content = c; cur = null; follow = true; jump.hidden = true;
    io.disconnect();
    // Rough placeholder height so the scrollbar and lazy rendering behave before text is laid out.
    const charsPerLine = Math.max(20, Math.floor((scroller.clientWidth || 340) / 9.5));
    blocks = c.sections.map((sec, i) => {
      const body = h('div', { class: 'rd-body' });
      body.style.minHeight = `${Math.ceil(sec.charCount / charsPerLine) * 30}px`;
      const blockEl = h('section', { class: 'rd-sec', 'data-s': i },
        h('h2', { class: `rd-h lv${Math.min(sec.level, 2)}` }, sec.title || `Section ${i + 1}`), body);
      return { el: blockEl, body, rendered: false, spans: [] };
    });
    scroller.replaceChildren(...blocks.map((b) => b.el));
    blocks.forEach((b) => io.observe(b.el));
    marks = new Map();
    void loadMarks();
  }

  // Bookmark markers (section → sentence → has note).
  let marks = new Map<number, Map<number, boolean>>();
  let marksSeq = 0;
  async function loadMarks() {
    const seq = ++marksSeq, k = key;
    if (!k) return;
    let m: Map<number, Map<number, boolean>>;
    try { m = await bookmarkInfo(k); } catch { return; }
    if (seq !== marksSeq || k !== key) return;
    marks = m;
    blocks.forEach((_, i) => applyMarks(i));
  }
  function applyMarks(i: number) {
    const b = blocks[i];
    if (!b?.rendered) return;
    const m = marks.get(i);
    b.spans.forEach((sp, j) => {
      const has = m?.has(j) ?? false;
      sp.classList.toggle('bm', has);
      sp.classList.toggle('bm-n', has && !!m!.get(j));
    });
  }
  const offChange = onChange('bookmarks', () => { void loadMarks(); });

  function mark() {
    const b = blocks[pos.section];
    if (!b) return;
    if (!b.rendered) renderBlock(pos.section);
    const span = b.spans[pos.sentence];
    if (span === cur) return;
    cur?.classList.remove('cur');
    cur = span ?? null;
    cur?.classList.add('cur');
  }

  function scrollToCurrent(smooth: boolean) {
    // Render the target and its neighbours first so the layout above it is (mostly) final.
    for (const i of [pos.section - 1, pos.section, pos.section + 1]) renderBlock(i);
    mark();
    const target = cur ?? blocks[pos.section]?.el;
    if (!target || !scroller.clientHeight) return;
    const top = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    programmaticUntil = Date.now() + (smooth ? 900 : 100);
    scroller.scrollTo({ top: Math.max(0, top - scroller.clientHeight / 3), behavior: smooth ? 'smooth' : 'auto' });
  }

  function isVisible(node: HTMLElement) {
    const r = node.getBoundingClientRect(), v = scroller.getBoundingClientRect();
    return r.bottom > v.top && r.top < v.bottom;
  }

  function setPosition(section: number, sentence: number) {
    const moved = section !== pos.section || sentence !== pos.sentence;
    pos = { section, sentence };
    mark();
    if (!moved && cur && isVisible(cur)) return;
    if (follow) scrollToCurrent(true);
    else jump.hidden = !!cur && isVisible(cur);
  }

  // User scrolling stops auto-follow until they tap "Back to reading position" or a word.
  const userScrolled = () => {
    if (Date.now() < programmaticUntil) return;
    follow = false;
    jump.hidden = !!cur && isVisible(cur);
  };
  scroller.addEventListener('touchmove', userScrolled, { passive: true });
  scroller.addEventListener('wheel', userScrolled, { passive: true });
  scroller.addEventListener('scroll', () => { if (!follow) jump.hidden = !!cur && isVisible(cur); }, { passive: true });

  // Long-press a sentence → onLongPress (e.g. bookmark with note).
  let lp: { timer: number; x: number; y: number; span: HTMLElement } | null = null;
  let suppressClick = 0;
  const lpCancel = () => { if (lp) { clearTimeout(lp.timer); lp = null; } };
  scroller.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const span = (e.target as HTMLElement).closest('.sent') as HTMLElement | null;
    lpCancel();
    if (!span || !opts.onLongPress) return;
    const timer = window.setTimeout(() => {
      lp = null;
      suppressClick = Date.now() + 100000; // cleared on pointerup
      navigator.vibrate?.(15);
      opts.onLongPress?.(Number(span.dataset.s), Number(span.dataset.i));
    }, 500);
    lp = { timer, x: e.clientX, y: e.clientY, span };
  });
  scroller.addEventListener('pointermove', (e) => {
    if (lp && Math.hypot(e.clientX - lp.x, e.clientY - lp.y) > 10) lpCancel();
  });
  const lpEnd = () => { lpCancel(); if (suppressClick) suppressClick = Date.now() + 400; };
  scroller.addEventListener('pointerup', lpEnd);
  scroller.addEventListener('pointercancel', () => { lpCancel(); suppressClick = 0; });
  scroller.addEventListener('contextmenu', (e) => e.preventDefault());

  // Tap a word → start reading from that word; tap a link → onLink.
  scroller.addEventListener('click', (e) => {
    if (suppressClick) {
      const stillHeld = suppressClick - Date.now() > 1000;
      if (stillHeld || Date.now() < suppressClick) { e.preventDefault(); e.stopPropagation(); if (!stillHeld) suppressClick = 0; return; }
      suppressClick = 0;
    }
    const target = e.target as HTMLElement;
    const span = target.closest('.sent') as HTMLElement | null;
    if (!span) return;
    const section = Number(span.dataset.s), sentence = Number(span.dataset.i);
    const lk = target.closest('.lk') as HTMLElement | null;
    if (lk && opts.onLink) {
      const link = content?.sections[section]?.links?.find((l) => l.sentence === sentence && l.start === Number(lk.dataset.a) && l.end === Number(lk.dataset.b));
      if (link) { opts.onLink(link); return; }
    }
    const text = span.textContent ?? '';
    let char = 0;
    const hit = caretAt(e.clientX, e.clientY);
    if (hit && span.contains(hit.node)) {
      char = Math.min(charOffset(span, hit.node, hit.offset), text.length);
      while (char > 0 && !/\s/.test(text[char - 1])) char--; // snap to the start of the word
    }
    if (char > text.length - 2) char = 0;
    follow = true; jump.hidden = true;
    flashWord(span, char);
    onPick(section, sentence, char);
  });

  return {
    el, setContent, setPosition,
    shown() { follow = true; jump.hidden = true; requestAnimationFrame(() => scrollToCurrent(false)); setTimeout(() => scrollToCurrent(false), 60); },
    destroy() { io.disconnect(); offChange(); lpCancel(); },
  };
}

function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const d = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const p = d.caretPositionFromPoint?.(x, y);
  if (p) return { node: p.offsetNode, offset: p.offset };
  const r = d.caretRangeFromPoint?.(x, y);
  return r ? { node: r.startContainer, offset: r.startOffset } : null;
}

/** Fills a sentence span with text, wrapping link ranges in .lk spans. */
function fillSentence(span: HTMLElement, text: string, links?: SectionLink[]) {
  if (!links?.length) { span.textContent = text; return; }
  const sorted = [...links].sort((a, b) => a.start - b.start);
  let at = 0;
  for (const l of sorted) {
    const start = Math.max(l.start, at), end = Math.min(l.end, text.length);
    if (end <= start) continue;
    if (start > at) span.append(text.slice(at, start));
    span.append(h('span', { class: 'lk', 'data-a': l.start, 'data-b': l.end }, text.slice(start, end)));
    at = end;
  }
  if (at < text.length) span.append(text.slice(at));
}

/** Character offset within span's text for a (node, offset) caret position, across child text nodes. */
function charOffset(span: HTMLElement, node: Node, offset: number): number {
  const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
  let sum = 0;
  if (node.nodeType !== Node.TEXT_NODE) {
    // Element position: offset counts child nodes before the caret.
    const before = document.createRange();
    before.setStart(span, 0);
    try { before.setEnd(node, offset); } catch { return 0; }
    return before.toString().length;
  }
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n === node) return sum + offset;
    sum += n.textContent?.length ?? 0;
  }
  return 0;
}

/** Finds the text node + local offset holding character `char` of the span's text. */
function locate(span: HTMLElement, char: number): { node: Text; offset: number } | null {
  const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
  let sum = 0, last: Text | null = null;
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const len = n.data.length;
    if (char < sum + len) return { node: n, offset: char - sum };
    sum += len; last = n;
  }
  return last ? { node: last, offset: last.data.length } : null;
}

/** Briefly highlights the tapped word so it's clear where reading starts. */
function flashWord(span: HTMLElement, char: number) {
  const text = span.textContent ?? '';
  const end = Math.max(char + 1, text.slice(char).search(/\s|$/) + char);
  const a = locate(span, char), z = locate(span, end - 1);
  if (!a || !z) return;
  try {
    const range = document.createRange();
    range.setStart(a.node, a.offset); range.setEnd(z.node, Math.min(z.node.data.length, z.offset + 1));
    const rect = range.getBoundingClientRect();
    const host = span.closest('.rd') as HTMLElement | null;
    if (!host || !rect.width) return;
    const hr = host.getBoundingClientRect();
    const f = h('div', { class: 'rd-flash' });
    Object.assign(f.style, { left: `${rect.left - hr.left - 3}px`, top: `${rect.top - hr.top - 2}px`, width: `${rect.width + 6}px`, height: `${rect.height + 4}px` });
    host.append(f);
    setTimeout(() => f.remove(), 700);
  } catch { /* ignore */ }
}
