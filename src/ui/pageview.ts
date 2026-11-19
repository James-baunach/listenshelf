// STUB — replaced by the PDF agent. Original-PDF page view with the current sentence highlighted.
import type { DocContent, Item } from '../types';
import { h } from './dom';

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

export function createPageView(opts: { onPick: (section: number, sentence: number, char?: number) => void }): PageView {
  void opts;
  const el = h('div', { class: 'pv' }, 'Page view coming soon');
  return { el, setItem() {}, setPosition() {}, shown() {}, destroy() {} };
}
