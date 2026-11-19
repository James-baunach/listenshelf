// Pure HTML -> Section[] conversion for Wikipedia (Parsoid) HTML.
// Depends only on the basic DOM API (querySelectorAll, textContent, remove, cloneNode, children)
// so it runs in browsers and in linkedom (tests).
import { makeSection } from '../text';
import type { Section } from '../types';

/** Elements removed outright before reading text. */
const REMOVE = [
  'style', 'script', 'link', 'meta', 'noscript', 'table', 'figure', 'figcaption', 'img', 'audio', 'video',
  'sup.reference', 'sup.mw-ref', '.mw-ref', 'sup[typeof~="mw:Extension/ref"]', '[typeof~="mw:Extension/ref"]',
  '[typeof~="mw:Extension/references"]', '.reflist', '.references', '.mw-references-wrap', '.refbegin',
  '.mw-cite-backlink', '.cite-bracket', '.mw-editsection', '.mw-editsection-bracket',
  '.infobox', '.vcard', '.navbox', '.vertical-navbox', '.navbox-styles', '.sidebar', '.toc', '#toc',
  '.gallery', '.thumb', '.thumbinner', '.tmulti', '.mw-file-element', '[typeof~="mw:File"]',
  '[typeof~="mw:Error"]', '.hatnote', '.dablink', '.rellink', '.mainarticle', '.seealso',
  '.geo', '.geo-default', '.geo-dms', '.geo-dec', '.coordinates', '#coordinates', '.plainlinks.noexcerpt',
  '.IPA', '.rt-commentedText', '.haudio', '.listen', '.unicode.audio', 'span.nowrap .IPA', '[title*="pronunciation"]',
  '.metadata', '.mbox', '.mbox-small', '.ambox', '.tmbox', '.cmbox', '.imbox', '.ombox', '.sistersitebox',
  '.side-box', '.noprint', '.mw-empty-elt', '[role="navigation"]', '.shortdescription', '.printonly',
  '.noviewer', '.mw-authority-control', '.portal', '.citation-needed-content', '.Inline-Template', '.noexcerpt',
  '[style*="display:none"]', '[style*="display: none"]', '.error', '.mw-collapsible-toggle', '.hlist-separated-x',
  '.sr-only', '.reference-text-hidden',
];

function strip(doc: Document) {
  for (const sel of REMOVE) {
    let nodes: Element[] = [];
    try { nodes = Array.from(doc.querySelectorAll(sel)); } catch { continue; }
    for (const n of nodes) n.remove();
  }
  // Math: keep short alt text, drop otherwise.
  const maths = Array.from(doc.querySelectorAll('.mwe-math-element, [typeof~="mw:Extension/math"], math'));
  for (const m of maths) {
    if (!m.parentNode) continue;
    const mathEl = m.tagName.toLowerCase() === 'math' ? m : m.querySelector('math');
    const alt = (mathEl?.getAttribute('alttext') ?? '').replace(/\{\\displaystyle\s*|\}\s*$/g, '').trim();
    if (alt && alt.length <= 25 && !/\\[a-zA-Z]/.test(alt)) m.replaceWith(doc.createTextNode(` ${alt} `));
    else m.remove();
  }
}

/** Cleans leftover markers and punctuation debris from extracted text. */
export function cleanText(s: string): string {
  let t = s
    .replace(/\[\s*(?:\d{1,4}|[a-z]|note\s*\d*|nb\s*\d*)\s*\]/gi, '')
    .replace(/\[[^\]]{0,60}\b(?:citation needed|clarification needed|when\?|who\?|according to whom\?|verification needed|dubious|original research\?|better source needed|failed verification|page needed|specify|vague|neutrality is disputed|update needed|irrelevant|why\?|which\?|where\?|by whom\?|how\?)[^\]]{0,40}\]/gi, '')
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ');
  // Debris left from removed IPA / dates: "( ; )", "(, born …", "( )"
  for (let i = 0; i < 3; i++) {
    t = t
      .replace(/\(\s*[;,:–-]*\s*\)/g, '')
      .replace(/\(\s*[;,:]\s*/g, '(')
      .replace(/\s*[;,:]\s*\)/g, ')')
      .replace(/\s+([,.;:!?])/g, '$1')
      .replace(/\s{2,}/g, ' ');
  }
  return t.trim();
}

function textOf(el: Element): string { return cleanText(el.textContent ?? ''); }

function ownListItemText(li: Element): string {
  const c = li.cloneNode(true) as Element;
  for (const sub of Array.from(c.querySelectorAll('ul, ol, dl'))) sub.remove();
  return textOf(c);
}

function collect(el: Element, out: string[]) {
  for (const child of Array.from(el.children)) {
    const tag = child.tagName.toLowerCase();
    if (tag === 'section' || /^h[1-6]$/.test(tag) || child.classList?.contains('mw-heading')) continue;
    if (tag === 'p') { const t = textOf(child); if (t) out.push(t); }
    else if (tag === 'ul' || tag === 'ol') {
      for (const li of Array.from(child.querySelectorAll('li'))) { const t = ownListItemText(li); if (t) out.push(t); }
    } else if (tag === 'dl') {
      for (const d of Array.from(child.querySelectorAll('dd, dt'))) { const t = ownListItemText(d); if (t) out.push(t); }
    } else if (tag === 'div' || tag === 'blockquote' || tag === 'center') collect(child, out);
  }
}

function headingOf(sec: Element): { title: string; level: number } | null {
  for (const child of Array.from(sec.children)) {
    const tag = child.tagName.toLowerCase();
    let hEl: Element | null = null;
    if (/^h[1-6]$/.test(tag)) hEl = child;
    else if (tag === 'div' && child.classList?.contains('mw-heading')) hEl = child.querySelector('h1, h2, h3, h4, h5, h6');
    if (hEl) {
      const n = Number(hEl.tagName[1]);
      return { title: textOf(hEl), level: n <= 2 ? 1 : 2 };
    }
  }
  return null;
}

/**
 * Converts Parsoid article HTML into speakable sections.
 * @param skipTitles section titles (case-insensitive) to drop, including their subsections
 */
export function htmlToSections(doc: Document, skipTitles: string[]): Section[] {
  strip(doc);
  const skip = new Set(skipTitles.map((s) => s.trim().toLowerCase()));
  const out: Section[] = [];

  const walk = (sec: Element, isLead: boolean) => {
    const head = headingOf(sec);
    const title = head?.title || (isLead ? 'Introduction' : '');
    if (head && skip.has(head.title.toLowerCase())) return; // skip incl. subsections
    const paras: string[] = [];
    collect(sec, paras);
    if (paras.length) {
      const s = makeSection(title || 'Section', head?.level ?? 1, paras);
      if (s.sentences.length) out.push(s);
    }
    for (const child of Array.from(sec.children)) {
      if (child.tagName.toLowerCase() === 'section') walk(child, false);
    }
  };

  const body = doc.body ?? doc.documentElement;
  const tops = Array.from(body.children).filter((c) => c.tagName.toLowerCase() === 'section');
  if (tops.length) tops.forEach((s, i) => walk(s, i === 0));
  else { // no <section> wrappers: treat the whole body as the lead
    const paras: string[] = [];
    collect(body, paras);
    const s = makeSection('Introduction', 1, paras);
    if (s.sentences.length) out.push(s);
  }
  return out;
}
