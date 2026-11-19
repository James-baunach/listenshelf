// Full-document reading pane used by the player (books and articles).
// - Renders every section (lazily, as they scroll near) so you can browse the whole text.
// - Underlines the sentence being read and follows it, unless you've scrolled away.
// - Tap any word to start reading from that word.
import type { DocContent } from '../types';
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

export function createReader(onPick: (section: number, sentence: number, char: number) => void): Reader {
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
    const p = h('p');
    b.spans = sec.sentences.map((t, j) => {
      const s = h('span', { class: 'sent', 'data-s': i, 'data-i': j }, t);
      p.append(s, ' ');
      return s;
    });
    b.body.replaceChildren(p);
    b.body.style.minHeight = '';
    io.unobserve(b.el);
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
  }

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

  // Tap a word → start reading from that word.
  scroller.addEventListener('click', (e) => {
    const span = (e.target as HTMLElement).closest('.sent') as HTMLElement | null;
    if (!span) return;
    const section = Number(span.dataset.s), sentence = Number(span.dataset.i);
    const text = span.textContent ?? '';
    let char = 0;
    const hit = caretAt(e.clientX, e.clientY);
    if (hit && span.contains(hit.node)) {
      char = Math.min(hit.offset, text.length);
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
    destroy() { io.disconnect(); },
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

/** Briefly highlights the tapped word so it's clear where reading starts. */
function flashWord(span: HTMLElement, char: number) {
  const node = span.firstChild;
  if (!node || node.nodeType !== Node.TEXT_NODE) return;
  const text = node.textContent ?? '';
  const end = text.slice(char).search(/\s|$/) + char;
  try {
    const range = document.createRange();
    range.setStart(node, char); range.setEnd(node, Math.max(char + 1, end));
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
