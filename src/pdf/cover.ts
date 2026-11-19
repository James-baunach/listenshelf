// Renders page 1 of a pdf.js document to a small JPEG (needs a DOM).
import type { PDFPageProxy } from 'pdfjs-dist';

export async function renderCoverBlob(page: PDFPageProxy, width = 360): Promise<Blob | null> {
  const v0 = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: width / v0.width });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.82));
  canvas.width = canvas.height = 0;
  return blob;
}
