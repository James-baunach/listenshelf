// Run: node --experimental-strip-types scripts/test-speech.mjs
import { prepareForSpeech } from '../src/speech.ts';

const ALL = { skipUrls: true, skipReferences: true, skipFootnoteMarkers: true, skipParentheticals: false, pronunciations: [] };
const OFF = { ...ALL, skipUrls: false, skipReferences: false, skipFootnoteMarkers: false };
const P = (o) => ({ ...ALL, ...o });

const cases = [
  // [input, settings, expected]
  ['The results (see Figure 3) were clear.12 Visit https://example.com, e.g. for details.', ALL, 'The results were clear. Visit, for example for details.'],
  // URLs / emails
  ['Go to https://example.com/a/b?x=1.', ALL, 'Go to.'],
  ['Read www.example.org today.', ALL, 'Read today.'],
  ['See example.com/path for more.', ALL, 'See for more.'],
  ['Mail me at john.doe@mail.example.com now.', ALL, 'Mail me at now.'],
  ['He said e.g. this and i.e. that.', OFF, 'He said for example this and that is that.'],
  ['The value was 3.14 exactly.', ALL, 'The value was 3.14 exactly.'],
  ['Node.js is fine.', ALL, 'Node.js is fine.'],
  ['Go to https://example.com now.', OFF, 'Go to https://example.com now.'],
  // references
  ['It grew (Fig. 2a) quickly.', ALL, 'It grew quickly.'],
  ['See (Table 4) here.', ALL, 'See here.'],
  ['As noted (p. 45) before.', ALL, 'As noted before.'],
  ['As noted (pp. 12–14) before.', ALL, 'As noted before.'],
  ['This holds (see Chapter 7) in general.', ALL, 'This holds in general.'],
  ['This holds (cf. Smith 2004) in general.', ALL, 'This holds in general.'],
  ['Said so (ibid.) twice.', ALL, 'Said so twice.'],
  ['Known fact [12] and more [3–5] here [citation needed].', ALL, 'Known fact and more here.'],
  ['He was born (born 1950) in Ohio.', ALL, 'He was born (born 1950) in Ohio.'],
  ['He was born (born 1950) in Ohio.', P({ skipParentheticals: true }), 'He was born in Ohio.'],
  ['A note (see below) here.', ALL, 'A note here.'],
  ['Keep (the old way) here.', ALL, 'Keep (the old way) here.'],
  ['Kept [12] as is.', OFF, 'Kept [12] as is.'],
  // footnote markers
  ['It was a disease.12 The next day.', ALL, 'It was a disease. The next day.'],
  ['This is true.3', ALL, 'This is true.'],
  ['The word12, spoken.', ALL, 'The word, spoken.'],
  ['Seen in disease¹² today.', ALL, 'Seen in disease today.'],
  ['The claim* was made.', ALL, 'The claim was made.'],
  ['The claim† and more‡.', ALL, 'The claim and more.'],
  ['Apollo 11 landed.', ALL, 'Apollo 11 landed.'],
  ['COVID-19 spread.', ALL, 'COVID-19 spread.'],
  ['COVID19 spread.', ALL, 'COVID19 spread.'],
  ['Water is H2O.', ALL, 'Water is H2O.'],
  ['A 3D model.', ALL, 'A 3D model.'],
  ['Music of the 1990s was loud.', ALL, 'Music of the 1990s was loud.'],
  ['The B-52 bomber.', ALL, 'The B-52 bomber.'],
  ['Born in 1990.', ALL, 'Born in 1990.'],
  ['In June 2016, it ended.', ALL, 'In June 2016, it ended.'],
  ['Version 3.5 is out.', ALL, 'Version 3.5 is out.'],
  ['See No.5 on the list.', ALL, 'See No.5 on the list.'],
  ['Vitamin B12 helps.', ALL, 'Vitamin B12 helps.'],
  ['Markers kept.12 Here.', OFF, 'Markers kept.12 Here.'],
  // pronunciations
  ['I live in Louisville.', P({ pronunciations: [{ from: 'Louisville', to: 'Lewie-vil' }] }), 'I live in Lewie-vil.'],
  ['LOUISVILLE and louisvilles.', P({ pronunciations: [{ from: 'Louisville', to: 'Lewie-vil' }] }), 'Lewie-vil and louisvilles.'],
  ['Louisville louisville.', P({ pronunciations: [{ from: 'Louisville', to: 'X', caseSensitive: true }] }), 'X louisville.'],
  ['Subpar cats.', P({ pronunciations: [{ from: 'par', to: 'X', wholeWord: false }] }), 'SubX cats.'],
  ['Price is $5 (a.b).', P({ pronunciations: [{ from: '$5', to: 'five bucks', wholeWord: false }] }), 'Price is five bucks (a.b).'],
  ['New York City.', P({ pronunciations: [{ from: 'New York', to: 'A' }, { from: 'New York City', to: 'B' }] }), 'B.'],
  ['Cost $1 here.', P({ pronunciations: [{ from: 'Cost', to: 'x$1' }] }), 'x$1 $1 here.'],
  ['Ångström units.', P({ pronunciations: [{ from: 'Ångström', to: 'angstrom' }] }), 'angstrom units.'],
  // built-ins
  ['Tea, coffee, etc. are drinks.', OFF, 'Tea, coffee, et cetera are drinks.'],
  ['Red vs. blue.', OFF, 'Red versus blue.'],
  ['Salt & pepper, AT&T.', OFF, 'Salt and pepper, AT and T.'],
  ['It rose 5% and 12.5 %.', OFF, 'It rose 5 percent and 12.5 percent.'],
  ['It was 20°C or 68 °F.', OFF, 'It was 20 degrees Celsius or 68 degrees Fahrenheit.'],
  ['Built c. 1850 by hand.', OFF, 'Built circa 1850 by hand.'],
  ['He moved to St. Louis.', OFF, 'He moved to Saint Louis.'],
  ['Mount St. Helens erupted.', OFF, 'Mount Saint Helens erupted.'],
  ['On Main St. Then he left.', OFF, 'On Main St. Then he left.'],
  ['Using &amp; entities.', OFF, 'Using &amp; entities.'],
  // empties
  ['(see Figure 3)', ALL, ''],
  ['[12]', ALL, ''],
  ['https://example.com', ALL, ''],
  ['', ALL, ''],
  ['...', ALL, ''],
];

let fail = 0;
for (const [input, s, want] of cases) {
  const got = prepareForSpeech(input, s);
  if (got !== want) { fail++; console.log(`FAIL\n  in:   ${input}\n  want: ${want}\n  got:  ${got}`); }
}
console.log(`${cases.length - fail}/${cases.length} passed`);
process.exit(fail ? 1 : 0);
