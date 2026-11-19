// Renders public/icon.svg to the PNG sizes the web manifest needs.
import { Resvg } from '@resvg/resvg-js';
import { readFileSync, writeFileSync } from 'node:fs';
const svg = readFileSync('public/icon.svg', 'utf8');
for (const size of [192, 512]) {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
  writeFileSync(`public/icon-${size}.png`, png);
  console.log(`public/icon-${size}.png`, png.length, 'bytes');
}
// Maskable variant: full-bleed background, artwork shrunk into the 80% safe zone.
const inner = svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/<rect width="512" height="512" rx="112" fill="#14161c"\/>/, '');
const maskable = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#14161c"/><g transform="translate(64 64) scale(0.75)">${inner}</g></svg>`;
writeFileSync('public/icon-maskable-512.png', new Resvg(maskable, { fitTo: { mode: 'width', value: 512 } }).render().asPng());
console.log('public/icon-maskable-512.png');
