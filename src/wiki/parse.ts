// Pure HTML -> Section[] conversion for Wikipedia (Parsoid) HTML.
// Depends only on the basic DOM API (querySelectorAll, textContent, remove, cloneNode, children)
// so it runs in browsers and in linkedom (tests).
import { makeSection, normalize, splitSentences } from '../text';
import type { Section, SectionLink } from '../types';

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

/** A wikilink found while collecting a paragraph: visible text + target article title. */
interface RawLink { text: string; title: string }
interface Para { text: string; links: RawLink[] }

const NON_ARTICLE_NS = new Set([
  'file', 'image', 'media', 'category', 'help', 'special', 'wikipedia', 'wp', 'project', 'template', 'portal', 'talk',
  'user', 'user talk', 'module', 'draft', 'mediawiki', 'book', 'timedtext', 'topic', 'commons', 'wikt', 'wiktionary',
  'datei', 'bild', 'kategorie', 'hilfe', 'spezial', 'vorlage', 'fichier', 'catégorie', 'aide', 'spécial', 'modèle',
  'archivo', 'categoría', 'ayuda', 'especial', 'plantilla', 'file talk', 'category talk', 'template talk', 'wikipedia talk',
]);

/** "./Foo_bar#x" -> "Foo bar"; null for fragment-only, non-article namespaces, external or odd targets. */
export function linkTitle(href: string): string | null {
  if (!href || href.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return null;
  let t = href.replace(/^\.\//, '').replace(/^\/wiki\//, '');
  t = t.split('#')[0].split('?')[0];
  try { t = decodeURIComponent(t); } catch { /* keep raw */ }
  t = t.replace(/_/g, ' ').trim();
  if (!t) return null;
  const c = t.indexOf(':');
  if (c > 0 && NON_ARTICLE_NS.has(t.slice(0, c).trim().toLowerCase())) return null;
  return t;
}

function textAndLinks(el: Element, selfTitle: string): Para {
  const links: RawLink[] = [];
  for (const a of Array.from(el.querySelectorAll('a'))) {
    const rel = a.getAttribute('rel') ?? '';
    if (!/mw:WikiLink/.test(rel)) continue;
    const cls = ' ' + (a.getAttribute('class') ?? '') + ' ';
    if (/ (new|selflink|mw-selflink) /.test(cls)) continue;
    const title = linkTitle(a.getAttribute('href') ?? '');
    if (!title || title.toLowerCase() === selfTitle) continue;
    const text = normalize(cleanText(a.textContent ?? ''));
    if (text.length < 2) continue;
    links.push({ text, title });
  }
  return { text: textOf(el), links };
}

function ownListItem(li: Element, selfTitle: string): Para {
  const c = li.cloneNode(true) as Element;
  for (const sub of Array.from(c.querySelectorAll('ul, ol, dl'))) sub.remove();
  return textAndLinks(c, selfTitle);
}

function collect(el: Element, out: Para[], self: string) {
  const push = (p: Para) => { if (p.text) out.push(p); };
  for (const child of Array.from(el.children)) {
    const tag = child.tagName.toLowerCase();
    if (tag === 'section' || /^h[1-6]$/.test(tag) || child.classList?.contains('mw-heading')) continue;
    if (tag === 'p') push(textAndLinks(child, self));
    else if (tag === 'ul' || tag === 'ol') {
      for (const li of Array.from(child.querySelectorAll('li'))) push(ownListItem(li, self));
    } else if (tag === 'dl') {
      for (const d of Array.from(child.querySelectorAll('dd, dt'))) push(ownListItem(d, self));
    } else if (tag === 'div' || tag === 'blockquote' || tag === 'center') collect(child, out, self);
  }
}

const isWordCh = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);

/** Builds a Section (via makeSection) and maps each paragraph's links onto final sentence ranges. */
function buildSection(title: string, level: number, paras: Para[]): Section {
  const sec = makeSection(title, level, paras.map((p) => p.text));
  const links: SectionLink[] = [];
  let base = 0;
  for (const p of paras) {
    const ss = splitSentences(p.text);
    if (!ss.length) continue;
    let si = 0, ci = 0;
    const seen = new Set<string>();
    for (const l of p.links) {
      let found = false;
      for (let s = si; s < ss.length && !found; s++) {
        let from = s === si ? ci : 0;
        for (;;) {
          const idx = ss[s].indexOf(l.text, from);
          if (idx < 0) break;
          const end = idx + l.text.length;
          if (isWordCh(ss[s][idx - 1]) && isWordCh(l.text[0]) || isWordCh(ss[s][end]) && isWordCh(l.text[l.text.length - 1])) { from = idx + 1; continue; }
          si = s; ci = end; found = true;
          const key = s + '|' + l.title;
          if (!seen.has(key)) { seen.add(key); links.push({ sentence: base + s, start: idx, end, title: l.title }); }
          break;
        }
      }
    }
    base += ss.length;
  }
  if (links.length) sec.links = links.slice(0, 600);
  return sec;
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
export function htmlToSections(doc: Document, skipTitles: string[], pageTitle?: string): Section[] {
  const self = (pageTitle ?? doc.querySelector('title')?.textContent ?? '').replace(/_/g, ' ').trim().toLowerCase();
  strip(doc);
  const skip = new Set(skipTitles.map((s) => s.trim().toLowerCase()));
  const out: Section[] = [];

  // A heading with no prose of its own (e.g. "Characteristics" followed only by
  // sub-sections) is carried into its first emitted child as "Parent: Child".
  let pendingParent: { title: string; level: number } | null = null;
  const walk = (sec: Element, isLead: boolean) => {
    const head = headingOf(sec);
    const title = head?.title || (isLead ? 'Introduction' : '');
    if (head && skip.has(head.title.toLowerCase())) return; // skip incl. subsections
    const paras: Para[] = [];
    collect(sec, paras, self);
    let s = paras.length ? buildSection(title || 'Section', head?.level ?? 1, paras) : null;
    if (s && s.sentences.length) {
      if (pendingParent && s.level > pendingParent.level) {
        s = { ...s, title: `${pendingParent.title}: ${s.title}`, level: pendingParent.level };
      }
      pendingParent = null;
      out.push(s);
    } else if (head) {
      pendingParent = head;
    }
    for (const child of Array.from(sec.children)) {
      if (child.tagName.toLowerCase() === 'section') walk(child, false);
    }
  };

  const body = doc.body ?? doc.documentElement;
  const tops = Array.from(body.children).filter((c) => c.tagName.toLowerCase() === 'section');
  if (tops.length) tops.forEach((s, i) => walk(s, i === 0));
  else { // no <section> wrappers: treat the whole body as the lead
    const paras: Para[] = [];
    collect(body, paras, self);
    const s = buildSection('Introduction', 1, paras);
    if (s.sentences.length) out.push(s);
  }
  return out;
}
