// EPUB parsing, free of browser-only APIs so it also runs under linkedom in Node (scripts/test-epub.mjs).
// The caller supplies `parseDoc` (a DOMParser wrapper) and the unzipped file map.
import { unzipSync } from 'fflate';
import { makeSection, normalize } from '../text';
import type { Section } from '../types';

/** 'xml' for container/OPF/NCX; 'xhtml' for content docs and the nav document. */
export type ParseDoc = (src: string, kind: 'xml' | 'xhtml') => Document;
export type Files = Record<string, Uint8Array>;

export interface ParsedEpub {
  title?: string;
  author?: string;
  sections: Section[];
  cover?: { bytes: Uint8Array; mime: string };
  /** True when the package has encryption.xml (other than font obfuscation) — likely DRM. */
  drm: boolean;
}

interface TocEntry { path: string; frag?: string; title: string; level: number }
interface Block { heading: boolean; text: string; ids: string[] }

const dec = new TextDecoder('utf-8');
const str = (b: Uint8Array) => dec.decode(b).replace(/^﻿/, '');

/** Unzips an EPUB, skipping fonts / audio / video / very large files. */
export function unzipEpub(data: Uint8Array): Files {
  return unzipSync(data, {
    filter: (f) => !/\.(otf|ttf|woff2?|mp3|mp4|m4a|m4v|ogg|wav|webm)$/i.test(f.name) && f.originalSize < 12 * 1024 * 1024,
  });
}

const ln = (el: Element) => (el.localName || el.tagName || '').replace(/^.*:/, '').toLowerCase();
function descendants(root: Node, out: Element[] = []): Element[] {
  for (const c of Array.from(root.childNodes)) if (c.nodeType === 1) { out.push(c as Element); descendants(c, out); }
  return out;
}
const all = (root: Document | Element, name: string): Element[] => descendants(root).filter((e) => ln(e) === name);
const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

export function resolvePath(baseFile: string, href: string): string {
  const dir = baseFile.includes('/') ? baseFile.slice(0, baseFile.lastIndexOf('/') + 1) : '';
  const parts = (href.startsWith('/') ? href.slice(1) : dir + href).split('/');
  const out: string[] = [];
  for (const p of parts) { if (p === '..') out.pop(); else if (p && p !== '.') out.push(p); }
  return out.join('/');
}

function splitHref(base: string, href: string): { path: string; frag?: string } {
  const [p, f] = href.split('#');
  let path = p;
  try { path = decodeURIComponent(p); } catch { /* keep raw */ }
  let frag = f;
  if (frag) { try { frag = decodeURIComponent(frag); } catch { /* keep raw */ } }
  return { path: path ? resolvePath(base, path) : base, frag: frag || undefined };
}

function getFile(files: Files, path: string): Uint8Array | undefined {
  if (files[path]) return files[path];
  const lower = path.toLowerCase();
  const k = Object.keys(files).find((n) => n.toLowerCase() === lower);
  return k ? files[k] : undefined;
}

// ─── content extraction ───
const SKIP = new Set(['script', 'style', 'nav', 'svg', 'img', 'image', 'head', 'title', 'audio', 'video', 'object', 'math', 'rt', 'rp', 'canvas', 'iframe', 'noscript']);
const BLOCK = new Set(['p', 'div', 'li', 'ul', 'ol', 'blockquote', 'section', 'article', 'aside', 'header', 'footer', 'figure', 'figcaption',
  'table', 'tr', 'td', 'th', 'dl', 'dt', 'dd', 'pre', 'hr', 'body', 'main', 'caption', 'html', 'address', 'details', 'summary']);
const HEADING = /^h[1-6]$/;
const DROP_TYPE = /(noteref|footnote|endnote|rearnote|pagebreak)/i;

function dropped(el: Element): boolean {
  const t = (el.getAttribute('epub:type') ?? '') + ' ' + (el.getAttribute('role') ?? '');
  return DROP_TYPE.test(t);
}

/** Flattens a content document into paragraph / heading blocks, remembering which anchor ids precede each. */
export function extractBlocks(doc: Document): Block[] {
  const blocks: Block[] = [];
  let buf = '';
  let ids: string[] = [];
  let headDepth = 0;
  const flush = () => {
    const t = normalize(buf);
    buf = '';
    if (t) { blocks.push({ heading: headDepth > 0, text: t, ids }); ids = []; }
  };
  const walk = (node: Node) => {
    for (const c of Array.from(node.childNodes)) {
      if (c.nodeType === 3) { buf += c.nodeValue ?? ''; continue; }
      if (c.nodeType !== 1) continue;
      const el = c as Element;
      const n = ln(el);
      const isHead = HEADING.test(n);
      const isBlock = isHead || BLOCK.has(n);
      if (isBlock) flush();
      const id = el.getAttribute('id') ?? (n === 'a' ? el.getAttribute('name') : null);
      if (id) ids.push(id);
      if (SKIP.has(n) || dropped(el)) continue;
      if (n === 'br') { buf += ' '; continue; }
      if (isHead) headDepth++;
      walk(el);
      if (isBlock) flush();
      if (isHead) headDepth--;
    }
  };
  const body = all(doc, 'body')[0] ?? doc.documentElement ?? doc;
  walk(body);
  flush();
  return blocks;
}

// ─── TOC ───
function parseNav(doc: Document, navPath: string): TocEntry[] {
  const navs = all(doc, 'nav');
  const nav = navs.find((n) => /\btoc\b/.test(n.getAttribute('epub:type') ?? '')) ?? navs[0];
  if (!nav) return [];
  const out: TocEntry[] = [];
  const walkList = (list: Element, depth: number) => {
    for (const li of Array.from(list.children).filter((c) => ln(c) === 'li')) {
      const kids = Array.from(li.children);
      const label = kids.find((c) => ln(c) === 'a') ?? kids.find((c) => ln(c) === 'span');
      if (label) {
        const href = label.getAttribute('href');
        const title = clean(label.textContent);
        if (href && title) { const { path, frag } = splitHref(navPath, href); out.push({ path, frag, title, level: depth }); }
      }
      for (const sub of kids.filter((c) => ln(c) === 'ol' || ln(c) === 'ul')) walkList(sub, depth + 1);
    }
  };
  const top = Array.from(nav.children).filter((c) => ln(c) === 'ol' || ln(c) === 'ul');
  for (const l of top) walkList(l, 1);
  return out;
}

function parseNcx(doc: Document, ncxPath: string): TocEntry[] {
  const out: TocEntry[] = [];
  const walkPoints = (parent: Element, depth: number) => {
    for (const np of Array.from(parent.children).filter((c) => ln(c) === 'navpoint')) {
      const label = clean(all(np, 'text')[0]?.textContent);
      const src = Array.from(np.children).find((c) => ln(c) === 'content')?.getAttribute('src');
      if (src && label) { const { path, frag } = splitHref(ncxPath, src); out.push({ path, frag, title: label, level: depth }); }
      walkPoints(np, depth + 1);
    }
  };
  const map = all(doc, 'navmap')[0];
  if (map) walkPoints(map, 1);
  return out;
}

const endPunct = (s: string) => (/[.!?…:;"')\]]$/.test(s) ? s : s + '.');
const sameTitle = (a: string, b: string) => normalize(a).toLowerCase() === normalize(b).toLowerCase();

interface RawSection { title: string; level: number; blocks: Block[] }

/** Parses an unzipped EPUB into book metadata, sections, and cover bytes. */
export async function parseEpub(
  files: Files,
  parseDoc: ParseDoc,
  opts: { onProgress?: (f: number) => void; yieldFn?: () => Promise<void> } = {},
): Promise<ParsedEpub> {
  const read = (p: string) => { const b = getFile(files, p); return b ? str(b) : undefined; };

  const containerSrc = read('META-INF/container.xml');
  let opfPath = containerSrc
    ? all(parseDoc(containerSrc, 'xml'), 'rootfile')[0]?.getAttribute('full-path') ?? undefined
    : undefined;
  if (!opfPath) opfPath = Object.keys(files).find((n) => /\.opf$/i.test(n));
  const opfSrc = opfPath ? read(opfPath) : undefined;
  if (!opfPath || !opfSrc) throw new Error('not an epub');
  const opf = parseDoc(opfSrc, 'xml');

  // metadata
  const title = clean(all(opf, 'title')[0]?.textContent) || undefined;
  const creators = all(opf, 'creator').map((e) => clean(e.textContent)).filter(Boolean);
  const author = creators.length ? creators.slice(0, 3).join(', ') : undefined;

  // manifest + spine
  interface Item { id: string; path: string; type: string; props: string }
  const manifest = new Map<string, Item>();
  for (const it of all(opf, 'item')) {
    const id = it.getAttribute('id'), href = it.getAttribute('href');
    if (!id || !href) continue;
    manifest.set(id, { id, path: splitHref(opfPath, href).path, type: it.getAttribute('media-type') ?? '', props: it.getAttribute('properties') ?? '' });
  }
  const spineEl = all(opf, 'spine')[0];
  const spine = spineEl ? all(spineEl, 'itemref').map((r) => manifest.get(r.getAttribute('idref') ?? '')).filter((x): x is Item => !!x) : [];
  const navItemPath = [...manifest.values()].find((m) => /\bnav\b/.test(m.props))?.path;
  const content = spine.filter((s) => /html|xml/i.test(s.type) && s.path !== navItemPath);

  // cover
  let coverItem = [...manifest.values()].find((m) => /\bcover-image\b/.test(m.props));
  if (!coverItem) {
    const metaCover = all(opf, 'meta').find((m) => m.getAttribute('name') === 'cover')?.getAttribute('content');
    if (metaCover) coverItem = manifest.get(metaCover);
  }
  if (!coverItem) coverItem = [...manifest.values()].find((m) => /^image\//.test(m.type) && /cover/i.test(m.id + m.path));
  const coverBytes = coverItem && /^image\//.test(coverItem.type) ? getFile(files, coverItem.path) : undefined;
  const cover = coverItem && coverBytes ? { bytes: coverBytes, mime: coverItem.type } : undefined;

  // TOC: EPUB3 nav, else NCX
  let toc: TocEntry[] = [];
  if (navItemPath && read(navItemPath)) toc = parseNav(parseDoc(read(navItemPath)!, 'xhtml'), navItemPath);
  if (!toc.length) {
    const ncxId = spineEl?.getAttribute('toc');
    const ncx = (ncxId && manifest.get(ncxId)) || [...manifest.values()].find((m) => /dtbncx/.test(m.type) || /\.ncx$/i.test(m.path));
    if (ncx && read(ncx.path)) toc = parseNcx(parseDoc(read(ncx.path)!, 'xml'), ncx.path);
  }
  const tocByDoc = new Map<string, TocEntry[]>();
  for (const e of toc) { if (!tocByDoc.has(e.path)) tocByDoc.set(e.path, []); tocByDoc.get(e.path)!.push(e); }

  // content → raw sections
  const raw: RawSection[] = [];
  for (let i = 0; i < content.length; i++) {
    const src = read(content[i].path);
    opts.onProgress?.(i / content.length);
    if (opts.yieldFn) await opts.yieldFn();
    if (!src) continue;
    let blocks: Block[];
    try { blocks = extractBlocks(parseDoc(src, 'xhtml')); } catch { continue; }
    const entries = tocByDoc.get(content[i].path) ?? [];
    const firstHeading = blocks.find((b) => b.heading)?.text;

    if (!toc.length || (!entries.length && !raw.length)) {
      raw.push({ title: firstHeading ?? `Section ${raw.length + 1}`, level: 1, blocks });
      continue;
    }
    if (!entries.length) { raw[raw.length - 1].blocks.push(...blocks); continue; }

    const cuts = entries
      .map((e, order) => ({ e, order, idx: e.frag ? Math.max(0, blocks.findIndex((b) => b.ids.includes(e.frag!))) : 0 }))
      .sort((a, b) => a.idx - b.idx || a.order - b.order);
    if (cuts[0].idx > 0) {
      const pre = blocks.slice(0, cuts[0].idx);
      if (raw.length) raw[raw.length - 1].blocks.push(...pre);
      else raw.push({ title: firstHeading ?? 'Introduction', level: 1, blocks: pre });
    }
    cuts.forEach((c, k) => {
      const end = k + 1 < cuts.length ? cuts[k + 1].idx : blocks.length;
      raw.push({ title: c.e.title, level: c.e.level > 1 ? 2 : 1, blocks: blocks.slice(c.idx, end) });
    });
  }
  opts.onProgress?.(1);

  const sections: Section[] = [];
  for (const r of raw) {
    let blocks = r.blocks;
    // The leading heading usually repeats the section title: it is the title, not body text.
    if (blocks[0]?.heading && (sameTitle(blocks[0].text, r.title) || r.title.startsWith('Section '))) blocks = blocks.slice(1);
    const paras = blocks.map((b) => (b.heading ? endPunct(b.text) : b.text));
    const s = makeSection(r.title, r.level, paras);
    if (s.sentences.length) sections.push(s);
  }

  const enc = read('META-INF/encryption.xml');
  const algs = enc ? [...enc.matchAll(/EncryptionMethod[^>]*Algorithm="([^"]+)"/g)].map((m) => m[1]) : [];
  const drm = algs.some((a) => !/idpf\.org\/2008\/embedding|ns\.adobe\.com\/pdf\/enc#RC/.test(a));
  return { title, author, sections, cover, drm };
}
