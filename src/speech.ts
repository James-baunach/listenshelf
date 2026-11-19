// Speech cleanup: turns a stored sentence into what should actually be spoken.
// Pure and fast (called per sentence). Applied at speak time (Live) and render time (Pocket);
// nothing is stored back into the content.
// NOTE: only a type import from './types' (erased) so this file can run directly under node --experimental-strip-types.
import type { Pronunciation, Settings } from './types';

type Opts = Pick<Settings, 'skipUrls' | 'skipReferences' | 'skipFootnoteMarkers' | 'skipParentheticals' | 'pronunciations'>;

// Same behaviour as text.ts stripParentheticals (duplicated to keep this module dependency-free).
const stripParens = (s: string) => s.replace(/\s*\([^()]*\)/g, '').replace(/\s+([,.;:])/g, '$1');

// ─── URLs & emails ───
const EMAIL = /[\w.+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const TLDS = 'com|org|net|edu|gov|mil|int|io|info|biz|us|uk|de|fr|ca|au|eu|ly|me|tv|ai|app|dev|wiki|gle';
const URL_SCHEME = /\b(?:https?:\/\/|www\.)[^\s<>"“”]+/gi;
const BARE_DOMAIN = new RegExp(`\\b(?:[a-z0-9-]+\\.)+(?:${TLDS})\\b(?:\\/[^\\s<>"“”]*)?`, 'gi');
const TRAIL = /[.,;:!?)\]'"”’]+$/;
/** Remove a matched URL but give back trailing punctuation. */
const dropUrl = (m: string) => {
  const t = m.match(TRAIL)?.[0] ?? '';
  // keep a closing paren only if the URL had no opening paren (it belongs to the sentence)
  return t;
};

// ─── References ───
const REF_WORD = 'fig(?:ure)?s?|tables?|plates?|maps?|charts?|boxe?s?|appendix|appendices|eq(?:uation)?s?|ch(?:apters?)?|sec(?:tions?)?|pages?|pp?|parts?|vol(?:ume)?s?|notes?|exhibits?|panels?|above|below|also|chapters?';
const REF_PATTERNS: RegExp[] = [
  // "(see Figure 3)", "(see also …)", "(See below)"
  new RegExp(`\\s*\\(\\s*see\\s+(?:${REF_WORD})\\b[^()]*\\)`, 'gi'),
  // "(cf. …)", "(ibid.)", "(op. cit.)", "(ibid., p. 4)"
  /\s*\(\s*(?:cf\.?\s[^()]*|ibid\.?[^()]*|op\.\s?cit\.?[^()]*|loc\.\s?cit\.?[^()]*|idem|id\.)\)/gi,
  // "(Fig. 2a)", "(Table 4)", "(Figures 3–5)", "(Table 2 and 3)"
  /\s*\(\s*(?:fig(?:ure)?s?|tables?|plates?|maps?|charts?|boxe?s?|eq(?:uation)?s?|appendix|ch(?:apters?)?|sec(?:tions?)?)\.?\s*[A-Z]?\d+[\w.]*(?:\s*(?:,|and|&|–|—|-)\s*[A-Z]?\d+[\w.]*)*\s*\)/gi,
  // "(p. 45)", "(pp. 12–14)", "(p. 4, 7)"
  /\s*\(\s*pp?\.\s*\d+\w?(?:\s*[–—-]\s*\d+\w?)?(?:\s*,\s*\d+\w?)*\s*\)/gi,
  // "[12]", "[3–5]", "[1, 2]", "[a]"
  /\s*\[\s*\d{1,3}(?:\s*[,–—-]\s*\d{1,3})*\s*\]/g,
  /\s*\[\s*[a-z]\s*\]/g,
  // "[citation needed]" and friends
  /\s*\[\s*(?:citation needed|clarification needed|when\?|who\?|where\?|why\?|which\?|according to whom\?|original research\?|dubious(?: [–—-] discuss)?|verification needed|failed verification|page needed|sic|note \d+)\s*\]/gi,
];

// ─── Footnote markers ───
const SUPERSCRIPTS = /[²³¹⁰-⁹]+/g;
// word (lowercase or Capitalized, 3+ letters) immediately followed by 1-3 digits, then a boundary
const GLUED = /(?<![\p{L}\p{N}])(\p{L}{3,})(\d{1,3})(?=[\s,;:.!?)\]”"'’]|$)(?!\.\d)/gu;
// sentence punctuation immediately followed by digits ("disease.12 The")
const PUNCT_DIGITS = /(\p{L}{2,})([.,;:!?)”"'’]+)(\d{1,3})(?=\s|$|[A-Z“"])/gu;
const NOT_NOTE_WORDS = new Set([
  'no', 'nos', 'fig', 'figs', 'vol', 'vols', 'pp', 'ch', 'sec', 'eq', 'art', 'ed', 'eds', 'op', 'cf',
  'tel', 'ext', 'ca', 'approx', 'cap', 'para', 'ver', 'rev', 'ref',
]);
const NOT_NOTE_GLUED = new Set([
  'covid', 'sars', 'mers', 'apollo', 'boeing', 'windows', 'xbox', 'playstation', 'ipv', 'utf', 'sha', 'html',
  'vitamin', 'omega', 'route', 'highway', 'interstate', 'flight', 'gemini', 'soyuz', 'sputnik', 'vostok',
  'voyager', 'model', 'type', 'stage', 'phase', 'level', 'grade', 'class', 'group', 'zone', 'mark', 'sector',
  'area', 'bluetooth', 'wifi', 'iphone', 'ipad', 'galaxy', 'mazda', 'audi', 'catch', 'proxima', 'trappist',
  'kepler', 'hubble', 'saturn', 'titan', 'mars', 'gliese', 'planet', 'channel', 'chapter', 'section',
  'figure', 'table', 'page', 'part', 'room', 'gate', 'terminal', 'exit', 'lane', 'unit', 'block', 'step',
  'version', 'edition', 'season', 'episode', 'week', 'day', 'month', 'year', 'age', 'grade', 'form', 'case',
]);
const NOTE_SYMBOLS = /(\p{L})[*†‡§¶]+(?=[\s.,;:!?)\]”"']|$)/gu;
const LONE_DAGGER = /(^|\s)[†‡]+(?=\s|$)/g;

// ─── Built-in fixes ───
const cap = (orig: string, repl: string) => (/^[A-Z]/.test(orig) ? repl[0].toUpperCase() + repl.slice(1) : repl);
const ST_BEFORE_OK = new Set(['mount', 'mt', 'cape', 'fort', 'port', 'lake', 'university', 'church', 'cathedral', 'hospital', 'island', 'isle', 'point']);

function builtins(t: string): string {
  t = t.replace(/(?<![\p{L}\p{N}.])e\.g\.(?![\p{L}\p{N}])/giu, (m) => cap(m, 'for example'));
  t = t.replace(/(?<![\p{L}\p{N}.])i\.e\.(?![\p{L}\p{N}])/giu, (m) => cap(m, 'that is'));
  t = t.replace(/(?<![\p{L}\p{N}])etc\./giu, 'et cetera');
  t = t.replace(/(?<![\p{L}\p{N}])vs\.?(?=\s)/giu, (m) => cap(m, 'versus'));
  t = t.replace(/\s*&(?![a-z]+;|#\d+;)\s*/gi, ' and ');
  t = t.replace(/(\d)\s?%/g, '$1 percent');
  t = t.replace(/(\d)\s?°\s?C\b/g, '$1 degrees Celsius');
  t = t.replace(/(\d)\s?°\s?F\b/g, '$1 degrees Fahrenheit');
  t = t.replace(/(\d)\s?°(?![\p{L}])/gu, '$1 degrees');
  t = t.replace(/(?<![\p{L}\p{N}.])c\.\s?(?=\d{3,4}\b)/gu, 'circa ');
  t = t.replace(/(?<![\p{L}\p{N}.])St\.\s+(?=[A-Z][a-z]{2,})/gu, (m, off: number) => {
    const before = t.slice(0, off).match(/(\p{L}+)[\s]*$/u)?.[1];
    if (before && /^\p{Lu}/u.test(before) && !ST_BEFORE_OK.has(before.toLowerCase())) return m; // "Main St. Louis"? leave
    return 'Saint ';
  });
  return t;
}

// ─── Pronunciations ───
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const compiled = new WeakMap<Pronunciation[], { re: RegExp; to: string }[]>();
function compilePron(list: Pronunciation[]) {
  let c = compiled.get(list);
  if (c) return c;
  c = [...list]
    .filter((p) => p && p.from)
    .sort((a, b) => b.from.length - a.from.length)
    .map((p) => {
      const whole = p.wholeWord !== false;
      const src = escapeRe(p.from);
      const body = whole ? `(?<![\\p{L}\\p{N}_])${src}(?![\\p{L}\\p{N}_])` : src;
      return { re: new RegExp(body, p.caseSensitive ? 'gu' : 'giu'), to: p.to };
    });
  compiled.set(list, c);
  return c;
}

/** Final tidy: spaces, space-before-punctuation, empty brackets. */
function tidy(t: string): string {
  t = t.replace(/\(\s*\)|\[\s*\]/g, '')
    .replace(/\(\s+/g, '(').replace(/\s+\)/g, ')')
    .replace(/\s+([,;:!?]|\.(?!\d))/g, '$1')
    .replace(/[ \t ]{2,}/g, ' ')
    .replace(/^[\s,;:]+/, '')
    .trim();
  return t;
}

/** Applies all enabled cleanups and pronunciations. Returns '' if nothing speakable is left. */
export function prepareForSpeech(text: string, s: Opts): string {
  if (!text) return '';
  let t = text;

  if (s.skipUrls) {
    t = t.replace(EMAIL, '').replace(URL_SCHEME, dropUrl).replace(BARE_DOMAIN, dropUrl);
  }

  if (s.skipReferences) {
    for (const re of REF_PATTERNS) t = t.replace(re, '');
  }

  if (s.skipFootnoteMarkers) {
    t = t.replace(SUPERSCRIPTS, '');
    t = t.replace(PUNCT_DIGITS, (m, w: string, p: string) => (NOT_NOTE_WORDS.has(w.toLowerCase()) ? m : w + p));
    t = t.replace(GLUED, (m, w: string) => {
      if (NOT_NOTE_GLUED.has(w.toLowerCase())) return m;
      if (!/^\p{Lu}?\p{Ll}{2,}$/u.test(w)) return m; // ALLCAPS / mixed case (COVID19, mRNA1) stay
      return w;
    });
    t = t.replace(NOTE_SYMBOLS, '$1').replace(LONE_DAGGER, '$1');
  }

  if (s.skipParentheticals) t = stripParens(t);

  if (s.pronunciations?.length) {
    for (const { re, to } of compilePron(s.pronunciations)) t = t.replace(re, () => to);
  }

  t = builtins(t);
  t = tidy(t);
  return /[\p{L}\p{N}]/u.test(t) ? t : '';
}

/** Same as prepareForSpeech; used by the settings preview. */
export const explainCleanup = (text: string, s: Opts): string => prepareForSpeech(text, s);
