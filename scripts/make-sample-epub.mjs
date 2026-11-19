// Generates scripts/fixtures/sample.epub: a small valid EPUB3 (3 chapters, nav, cover, one footnote).
// Usage: node scripts/make-sample-epub.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const xhtml = (title, body) => `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${title}</title></head><body>${body}</body></html>`;

const png = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));

const files = {
  mimetype: [strToU8('application/epub+zip'), { level: 0 }],
  'META-INF/container.xml': strToU8(`<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles>
<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`),
  'OEBPS/content.opf': strToU8(`<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="uid">urn:uuid:12345678-aaaa-bbbb-cccc-000000000001</dc:identifier>
<dc:title>The Sample Voyage</dc:title><dc:creator>Ada Example</dc:creator><dc:language>en</dc:language>
<meta property="dcterms:modified">2026-01-01T00:00:00Z</meta></metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="cover" href="images/cover.png" media-type="image/png" properties="cover-image"/>
<item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
<item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
<item id="c3" href="text/ch3.xhtml" media-type="application/xhtml+xml"/>
</manifest>
<spine><itemref idref="c1"/><itemref idref="c2"/><itemref idref="c3"/></spine></package>`),
  'OEBPS/nav.xhtml': strToU8(xhtml('Contents', `<nav epub:type="toc"><h1>Contents</h1><ol>
<li><a href="text/ch1.xhtml">Departure</a></li>
<li><a href="text/ch2.xhtml">The Open Sea</a><ol><li><a href="text/ch2.xhtml#storm">A Storm Rises</a></li></ol></li>
<li><a href="text/ch3.xhtml">Landfall</a></li></ol></nav>`)),
  'OEBPS/images/cover.png': png,
  'OEBPS/text/ch1.xhtml': strToU8(xhtml('Departure', `<h1>Departure</h1>
<p>The ship left the harbor at dawn. Gulls wheeled overhead.<a epub:type="noteref" href="#fn1"><sup>1</sup></a> Nobody on the dock spoke.</p>
<p>Captain Reyes counted the crew twice. All twenty were aboard.</p>
<aside epub:type="footnote" id="fn1"><p>FOOTNOTE TEXT should never be read aloud.</p></aside>`)),
  'OEBPS/text/ch2.xhtml': strToU8(xhtml('The Open Sea', `<h1>The Open Sea</h1>
<p>For nine days the wind held steady. The crew grew restless in the heat.</p>
<h2 id="storm">A Storm Rises</h2>
<p>On the tenth day the sky turned black. Waves climbed over the rail.</p>
<p>By midnight the mast was gone.</p>`)),
  'OEBPS/text/ch3.xhtml': strToU8(xhtml('Landfall', `<h1>Landfall</h1>
<p>At last a green coast appeared on the horizon. The survivors wept openly.</p>
<div>A plain div with direct text also counts as a paragraph here.</div>`)),
};

mkdirSync(join(root, 'scripts/fixtures'), { recursive: true });
const out = join(root, 'scripts/fixtures/sample.epub');
writeFileSync(out, zipSync(files));
console.log('wrote', out);
