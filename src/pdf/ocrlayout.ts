// OCR word boxes, saved next to an OCR'd book so the page view can highlight sentences.
// Stored in the `kv` store under `ocrwords:<itemId>` (not removed by deleteItem; see ocrWordsKey).
import { db } from '../db';

/** pages[p-1] = words as [x0, y0, x1, y1, text]; coordinates are fractions (0..1) of the rendered page. */
export interface OcrLayout { pages: [number, number, number, number, string][][] }

export const ocrWordsKey = (id: string) => `ocrwords:${id}`;

export async function loadOcrWords(id: string): Promise<OcrLayout | null> {
  return ((await (await db()).get('kv', ocrWordsKey(id))) as OcrLayout | undefined) ?? null;
}
export async function saveOcrWords(id: string, layout: OcrLayout): Promise<void> {
  await (await db()).put('kv', layout, ocrWordsKey(id));
}
export async function deleteOcrWords(id: string): Promise<void> {
  await (await db()).delete('kv', ocrWordsKey(id));
}
