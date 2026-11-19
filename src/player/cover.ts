// Cover art helpers shared by the player and the mini player.
import type { Item } from '../types';
import { getCover } from '../db';

export interface CoverSource { url: string; revoke(): void }

/** Real cover for an item (book cover blob or article thumbnail), or null. Caller must revoke(). */
export async function coverSource(item: Item): Promise<CoverSource | null> {
  if (item.kind === 'book' && item.hasCover) {
    const blob = await getCover(item.id).catch(() => undefined);
    if (blob) { const url = URL.createObjectURL(blob); return { url, revoke: () => URL.revokeObjectURL(url) }; }
  }
  if (item.thumbnailUrl) return { url: item.thumbnailUrl, revoke() {} };
  return null;
}

function hue(s: string) { let n = 0; for (let i = 0; i < s.length; i++) n = (n * 31 + s.charCodeAt(i)) >>> 0; return n % 360; }

/** Generated typographic cover. compact = single big initial (for small tiles). */
export function typographicCover(item: Pick<Item, 'title' | 'author' | 'kind'>, compact = false): HTMLElement {
  const hu = hue(item.title);
  const el = document.createElement('div');
  el.className = 'tcover';
  el.style.cssText = `width:100%;height:100%;display:flex;flex-direction:column;justify-content:center;align-items:center;` +
    `text-align:center;padding:${compact ? 2 : 12}%;overflow:hidden;color:#fff;` +
    `background:linear-gradient(145deg,hsl(${hu} 45% 38%),hsl(${(hu + 40) % 360} 50% 22%));font-family:var(--serif);`;
  if (compact) {
    el.textContent = (item.title.match(/\p{L}/u)?.[0] ?? '•').toUpperCase();
    el.style.fontSize = '1.4em'; el.style.fontWeight = '700';
  } else {
    const t = document.createElement('div');
    t.textContent = item.title;
    t.style.cssText = 'font-size:clamp(18px,6vw,28px);font-weight:700;line-height:1.2;display:-webkit-box;-webkit-line-clamp:6;-webkit-box-orient:vertical;overflow:hidden;';
    el.append(t);
    if (item.author) {
      const a = document.createElement('div');
      a.textContent = item.author;
      a.style.cssText = 'margin-top:12px;font-size:14px;opacity:.8;';
      el.append(a);
    }
  }
  return el;
}
