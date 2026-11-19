// Lazy pdf.js loader: keeps pdf.js out of the main bundle.
type PdfJs = typeof import('pdfjs-dist');
let p: Promise<PdfJs> | null = null;
export function loadPdfjs(): Promise<PdfJs> {
  p ??= (async () => {
    const [lib, worker] = await Promise.all([
      import('pdfjs-dist'),
      import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
    ]);
    lib.GlobalWorkerOptions.workerSrc = worker.default;
    return lib;
  })();
  return p;
}
