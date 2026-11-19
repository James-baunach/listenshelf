// Bookmarks & notes: add (with optional note), list/edit/delete sheet, and a lookup for the reader.
import './bookmarks.css';
import type { Bookmark, DocContent } from '../types';
import { deleteBookmark, getContent, listBookmarks, putBookmark, uid } from '../db';
import { confirmSheet, h, sheet } from './dom';

const QUOTE_MAX = 200;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function trimQuote(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > QUOTE_MAX ? t.slice(0, QUOTE_MAX - 1).trimEnd() + '…' : t;
}

/** A toast with an optional action button (e.g. Undo). */
function actionToast(msg: string, actionLabel?: string, onAction?: () => void, ms = 5000) {
  const btn = actionLabel ? h('button', { class: 'toast-act', type: 'button' }, actionLabel) : null;
  const el = h('div', { class: 'toast toast-with-act', role: 'status' }, h('span', null, msg), btn);
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  let done = false;
  const hide = () => { if (done) return; done = true; el.classList.remove('show'); setTimeout(() => el.remove(), 300); };
  btn?.addEventListener('click', () => { hide(); onAction?.(); });
  setTimeout(hide, ms);
}

/** Bookmark a sentence. withNote: prompt for a note first. Shows a toast with Undo. */
export async function addBookmarkAt(itemId: string, content: DocContent, section: number, sentence: number, opts?: { withNote?: boolean }): Promise<void> {
  const text = content.sections[section]?.sentences[sentence];
  if (text == null) return;
  const existing = (await listBookmarks(itemId)).filter((b) => b.section === section && b.sentence === sentence);

  if (!opts?.withNote) {
    if (existing.length) {
      actionToast('Already bookmarked', 'View', () => openBookmarksSheet(itemId, () => { /* list only */ }));
      return;
    }
    const bm: Bookmark = { id: uid('m_'), itemId, section, sentence, quote: trimQuote(text), createdAt: Date.now() };
    await putBookmark(bm);
    navigator.vibrate?.(10);
    actionToast('Bookmarked', 'Undo', () => { void deleteBookmark(bm.id); });
    return;
  }

  // With a note: if one exists here, edit its note instead of piling up duplicates.
  const target = existing[0];
  const note = await noteSheet(target ? 'Edit note' : 'Add note', target?.quote ?? trimQuote(text), target?.note ?? '');
  if (note === null) return;
  if (target) await putBookmark({ ...target, note: note || undefined });
  else await putBookmark({ id: uid('m_'), itemId, section, sentence, quote: trimQuote(text), note: note || undefined, createdAt: Date.now() });
  actionToast(note ? 'Note saved' : 'Bookmarked');
}

/** Sheet with the quote and a textarea. Resolves the trimmed note, or null if cancelled. */
function noteSheet(title: string, quote: string, initial: string): Promise<string | null> {
  return new Promise((resolve) => {
    let result: string | null = null;
    const ta = h('textarea', { class: 'input bm-ta', rows: 4, placeholder: 'Your note…' }) as HTMLTextAreaElement;
    ta.value = initial;
    const body = h('form', { onsubmit: (e: Event) => { e.preventDefault(); result = ta.value.trim(); close(); } },
      h('blockquote', { class: 'bm-quote' }, quote),
      ta,
      h('div', { class: 'row end gap', style: 'margin-top:12px' },
        h('button', { class: 'btn ghost', type: 'button', onclick: () => close() }, 'Cancel'),
        h('button', { class: 'btn primary', type: 'submit' }, 'Save')));
    const close = sheet(title, body, { onClose: () => resolve(result) });
    setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 120);
  });
}

/** Section → sentence → has a note. For marking bookmarked sentences in the reader. */
export async function bookmarkInfo(itemId: string): Promise<Map<number, Map<number, boolean>>> {
  const out = new Map<number, Map<number, boolean>>();
  for (const b of await listBookmarks(itemId)) {
    let m = out.get(b.section);
    if (!m) out.set(b.section, (m = new Map()));
    m.set(b.sentence, (m.get(b.sentence) ?? false) || !!b.note);
  }
  return out;
}

/** Section → bookmarked sentence indexes. */
export async function bookmarkedSentences(itemId: string): Promise<Map<number, Set<number>>> {
  const out = new Map<number, Set<number>>();
  for (const [s, m] of await bookmarkInfo(itemId)) out.set(s, new Set(m.keys()));
  return out;
}

/** Sheet listing this item's bookmarks/notes; tapping one calls onJump. Edit/delete inline. */
export function openBookmarksSheet(itemId: string, onJump: (section: number, sentence: number) => void): void {
  const list = h('div', { class: 'bm-list' });
  const body = h('div', null, list);
  let titles: string[] | null = null;
  const close = sheet('Bookmarks & notes', body);

  // Sheets share one history stack (any popstate closes every open sheet), so close this
  // one fully before opening the note/confirm sheet, then reopen the list afterwards.
  const closeFirst = async () => { close(); await sleep(300); };
  const fmt = (t: number) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

  async function render() {
    const bms = await listBookmarks(itemId);
    if (!titles) {
      const c = await getContent(itemId);
      titles = c ? c.sections.map((s, i) => s.title || `Section ${i + 1}`) : [];
    }
    if (!bms.length) {
      list.replaceChildren(h('p', { class: 'muted bm-empty' },
        'Tap the bookmark icon to save your place; hold it (or long-press a sentence in the text view) to add a note.'));
      return;
    }
    list.replaceChildren(...bms.map((b) => {
      const row = h('div', { class: 'bm-row' },
        h('button', { class: 'bm-main', type: 'button', onclick: () => { close(); onJump(b.section, b.sentence); } },
          h('span', { class: 'bm-sec' }, titles![b.section] ?? `Section ${b.section + 1}`),
          h('span', { class: 'bm-q' }, b.quote),
          b.note ? h('span', { class: 'bm-note' }, b.note) : null,
          h('span', { class: 'bm-date' }, fmt(b.createdAt))),
        h('div', { class: 'bm-acts' },
          h('button', { class: 'bm-act', type: 'button', 'aria-label': b.note ? 'Edit note' : 'Add note', onclick: async () => {
            await closeFirst();
            const n = await noteSheet(b.note ? 'Edit note' : 'Add note', b.quote, b.note ?? '');
            if (n !== null) await putBookmark({ ...b, note: n || undefined });
            await sleep(300);
            openBookmarksSheet(itemId, onJump);
          } }, b.note ? 'Edit' : 'Note'),
          h('button', { class: 'bm-act danger', type: 'button', 'aria-label': 'Delete bookmark', onclick: async () => {
            await closeFirst();
            if (await confirmSheet('Delete bookmark?', b.note ? 'This also deletes its note.' : 'Remove this bookmark?', 'Delete', true)) await deleteBookmark(b.id);
            await sleep(300);
            openBookmarksSheet(itemId, onJump);
          } }, 'Delete')));
      return row;
    }));
  }
  void render();
}
