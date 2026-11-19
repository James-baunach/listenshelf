// STUB — replaced by the bookmarks agent.
import type { DocContent } from '../types';

/** Bookmark a sentence. withNote: prompt for a note first. Shows a toast with Undo. */
export async function addBookmarkAt(itemId: string, content: DocContent, section: number, sentence: number, opts?: { withNote?: boolean }): Promise<void> {
  void itemId; void content; void section; void sentence; void opts;
}

/** Sheet listing this item's bookmarks/notes; tapping one calls onJump. Edit/delete inline. */
export function openBookmarksSheet(itemId: string, onJump: (section: number, sentence: number) => void): void {
  void itemId; void onJump;
}
