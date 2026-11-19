// One entry point for adding books: dispatches by file type.
import { resumeStalled as resumePdfs, importPdfs } from './pdf/import';
import { importEpubs, isEpub, resumeStalledEpubs } from './epub/import';
import { toast } from './ui/dom';

const isPdf = (f: File) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);

/** Imports PDFs and EPUBs; shows a toast for anything else. Returns the new item ids. */
export async function importBooks(files: File[]): Promise<string[]> {
  const pdfs = files.filter(isPdf);
  const epubs = files.filter((f) => !isPdf(f) && isEpub(f));
  const bad = files.length - pdfs.length - epubs.length;
  if (bad) toast(bad === 1 && files.length === 1 ? 'Only PDF and EPUB files can be added' : `${bad} file${bad > 1 ? 's' : ''} skipped (only PDF and EPUB are supported)`);
  const ids: string[] = [];
  if (pdfs.length) ids.push(...await importPdfs(pdfs));
  if (epubs.length) ids.push(...await importEpubs(epubs));
  return ids;
}

/** Restarts background processing for books left half-done by a closed tab (each importer handles its own format). */
export async function resumeStalledBooks() {
  await resumePdfs();
  await resumeStalledEpubs();
}
