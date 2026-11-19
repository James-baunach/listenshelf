// Shared text helpers used by both the PDF and Wikipedia importers.
import type { Section } from './types';

const ABBREV = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'e.g', 'i.e', 'fig', 'no', 'vol',
  'ch', 'pp', 'p', 'ed', 'eds', 'approx', 'ca', 'cf', 'al', 'gen', 'gov', 'lt', 'col', 'capt', 'mt',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec', 'inc', 'ltd', 'co', 'u.s',
]);

/** Normalizes whitespace, quotes and ligatures into plain speakable text. */
export function normalize(s: string): string {
  return s
    .replace(/ﬀ/g, 'ff').replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl')
    .replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl')
    .replace(/[­​-‍﻿]/g, '') // soft hyphen, zero-width
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Splits a paragraph into sentences. Long sentences (> maxLen chars) are broken
 * at commas/semicolons, then at spaces, so TTS engines never get huge chunks.
 */
export function splitSentences(paragraph: string, maxLen = 280): string[] {
  const text = normalize(paragraph);
  if (!text) return [];
  const out: string[] = [];
  let start = 0;
  const re = /[.!?…]+["')\]]*\s+(?=["'(\[]?[A-Z0-9])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const end = m.index + m[0].length;
    const before = text.slice(start, m.index + 1);
    const lastWord = before.match(/([A-Za-z.]+)\.$/)?.[1]?.toLowerCase() ?? '';
    // Skip abbreviations and single initials ("J. R. R. Tolkien")
    if (ABBREV.has(lastWord.replace(/\.$/, '')) || /^[a-z]$/i.test(lastWord)) continue;
    out.push(text.slice(start, end).trim());
    start = end;
  }
  if (start < text.length) out.push(text.slice(start).trim());
  return out.flatMap((s) => chunk(s, maxLen)).filter((s) => /[\p{L}\p{N}]/u.test(s));
}

function chunk(s: string, maxLen: number): string[] {
  if (s.length <= maxLen) return [s];
  const parts: string[] = [];
  let rest = s;
  while (rest.length > maxLen) {
    const window = rest.slice(0, maxLen);
    let cut = Math.max(window.lastIndexOf('; '), window.lastIndexOf(', '), window.lastIndexOf(' — '));
    if (cut < maxLen * 0.4) cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = maxLen;
    parts.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

/** Builds a Section from a title and a list of paragraphs. */
export function makeSection(title: string, level: number, paragraphs: string[], page?: number): Section {
  const sentences: string[] = [];
  const starts: number[] = [];
  for (const p of paragraphs) {
    const ss = splitSentences(p);
    if (!ss.length) continue;
    starts.push(sentences.length);
    sentences.push(...ss);
  }
  return { title, level, sentences, charCount: sentences.reduce((n, s) => n + s.length, 0), page, paragraphs: starts };
}

/** Removes parenthetical asides, used when settings.skipParentheticals is on. */
export function stripParentheticals(s: string): string {
  return s.replace(/\s*\([^()]*\)/g, '').replace(/\s+([,.;:])/g, '$1');
}

/** Rough speaking speed of TTS at rate 1.0, in characters per second. */
export const CHARS_PER_SEC = 15;

/** Formats seconds as h:mm:ss or m:ss. */
export function fmtTime(sec: number): string {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

/** Characters before the given position — for progress bars. */
export function charsBefore(sections: Section[], section: number, sentence: number): number {
  let n = 0;
  for (let i = 0; i < section && i < sections.length; i++) n += sections[i].charCount;
  const sec = sections[section];
  if (sec) for (let j = 0; j < sentence && j < sec.sentences.length; j++) n += sec.sentences[j].length;
  return n;
}
