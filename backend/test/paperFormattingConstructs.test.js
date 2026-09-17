/**
 * Paper constructs that were reported "not compared by API" while being perfectly comparable:
 * 10.2 text formatting, 10.11 to-do, 10.14 section break, 10.15 code block.
 *
 * Every fixture here is the REAL shape, taken from two measured round trips rather than from what
 * the formats are assumed to look like — the mistake that let the table and list bugs survive their
 * own tests:
 *
 *   source: files/export of /11-Paper/qa-paper-full-20260910070125.paper
 *   dest:   Drive export (text/html) of a Google Doc created from known HTML
 */
const assert = require('assert');
const {
  paperMarkdownStructure,
  googleDocStructure,
} = require('../src/validation/combinations/content/dropboxToGoogledrive');

// ── Source: exactly how Paper's markdown export writes these blocks ──────────────────────
//
// Note what Paper does to what it was GIVEN: `- [x] a checked item` comes back WITHOUT the
// dash, and a ``` fenced block comes back as 4-space indented lines.
const PAPER_EXPORT = [
  '# QA Paper — full feature document',
  '',
  '## 10.2 Text formatting',
  '',
  'This paragraph carries **bold**, *italic* and ~~strikethrough~~ text.',
  '',
  '### A third-level heading',
  '',
  '## 10.11 TO-DO list',
  '[x] a checked item',
  '[ ] an unchecked item',
  '',
  '## 10.12 Bulleted list',
  '- alpha',
  '- beta',
  '- gamma',
  '',
  '## 10.14 Section break',
  '----------',
  '',
  'Text after the section break.',
  '',
  '## 10.15 Code block',
  '    const answer = 42;',
  '    function identity(x) { return x; }',
  '',
  '## Tables',
  '| c1 | c2 |',
  '| - | - |',
  '| 1 | 2 |',
  '',
].join('\n');

const src = paperMarkdownStructure(PAPER_EXPORT);

// 10.11 — the bug this test exists for. The old regex demanded a leading `- `, so a document
// holding two to-do items counted 0 and the feature reported "not exercised" on every run.
assert.strictEqual(src.todo, 2, 'to-do items must be counted without a leading bullet');
assert.deepStrictEqual(src.todoTexts, ['a checked item', 'an unchecked item']);

// A markdown link must not be mistaken for a to-do item.
assert.strictEqual(
  paperMarkdownStructure('See [x](https://example.invalid/x) for details.').todo,
  0,
  'a markdown link starting with [x]( is not a to-do item'
);

// 10.15 — Paper drops the fences, so counting fences alone found no code block at all.
assert.strictEqual(src.codeBlocks, 1, 'a run of indented lines is ONE code block, not one per line');
assert.deepStrictEqual(src.codeLines, ['const answer = 42;', 'function identity(x) { return x; }']);

// 10.14 — and the table separator must not be swept up as a section break.
assert.strictEqual(src.sectionBreaks, 1, 'one section break, and the table separator is not one');
assert.strictEqual(src.tables, 1, 'the single-dash separator Paper emits is still a table');

// 10.2 — emphasis is a presence question, headings are a count.
assert.strictEqual(src.bold, true);
assert.strictEqual(src.italic, true);
assert.strictEqual(src.strike, true);
assert.strictEqual(src.headings, 8, 'every #-prefixed line is a heading, at any level');

// ── Destination: exactly how Google's HTML exporter writes them ─────────────────────────
//
// It emits NO <b>, <i>, <s> or <pre> tags — emphasis is an inline style on a <span>.
const GOOGLE_EXPORT = '<html><head><style type="text/css">.c1{color:#000}</style></head>'
  + '<body class="doc-content">'
  + '<h1 style="color:#000000;font-weight:700;font-size:24pt"><span style="font-weight:700">Heading one</span></h1>'
  + '<h2 style="color:#000000;font-weight:700;font-size:18pt"><span style="font-weight:700">Heading two</span></h2>'
  + '<p><span style="font-weight:700">bold text</span><span>&nbsp;</span>'
  + '<span style="font-style:italic">italic text</span><span>&nbsp;</span>'
  + '<span style="text-decoration:line-through">struck text</span></p>'
  + '<hr>'
  + '<p><span style="font-family:&quot;Courier&quot;">const answer = 42;</span></p>'
  + '<table><tr><td>a</td></tr></table>'
  + '<ul><li>alpha</li></ul><ol><li>first</li></ol>'
  + '</body></html>';

const dst = googleDocStructure(GOOGLE_EXPORT);

assert.strictEqual(dst.bold, true);
assert.strictEqual(dst.italic, true);
assert.strictEqual(dst.strike, true);
assert.strictEqual(dst.headings, 2);
assert.strictEqual(dst.sectionBreaks, 1, 'Google does emit <hr>, so a section break is readable');
assert.strictEqual(dst.codeMonospace, true, 'Google keeps the monospace family even without <pre>');

// THE TRAP: Google puts font-weight:700 on every heading AND on the span inside it. A document
// whose only "bold" is its headings must NOT report bold, or 10.2 passes on evidence that is
// really just a title.
const HEADINGS_ONLY = '<body>'
  + '<h1 style="font-weight:700"><span style="font-weight:700">Just a title</span></h1>'
  + '<p><span>ordinary text</span></p></body>';
const headingsOnly = googleDocStructure(HEADINGS_ONLY);
assert.strictEqual(headingsOnly.bold, false, 'a heading is not bold text');
assert.strictEqual(headingsOnly.headings, 1);

// A style block defining font-weight:700 for some class must not count as emphasis either.
const STYLE_ONLY = '<html><head><style>.c3{font-weight:700;font-style:italic}</style></head>'
  + '<body><p><span>plain</span></p></body></html>';
assert.strictEqual(googleDocStructure(STYLE_ONLY).bold, false, 'a CSS rule is not a bold run');
assert.strictEqual(googleDocStructure(STYLE_ONLY).italic, false, 'a CSS rule is not an italic run');

console.log('paperFormattingConstructs: OK');

// ── 10.3 / 10.6 attribution: by DOCUMENT, and only at one image per document ─────────────
//
// Google gives every image a bare <img> with an empty alt, so two images in one document are
// indistinguishable. The seeding puts the animated GIF in its own qa-paper-gif-*.paper and leaves
// the referenced JPEG in the main document, which is the only thing that makes each count belong
// to one feature. Verified against real Dropbox: main images=1, gif images=1.
const Agent = require('../src/validation/combinations/content/dropboxToGoogledrive');

function rollUp(paperItems) {
  const checks = [];
  const push = (status, name, detail) => checks.push({ name, status, detail });
  const agent = new Agent();
  const totals = agent._emptyTotals({});
  totals.paperItems = paperItems;
  totals.paperSourceCount = paperItems.length;
  const paths = paperItems.map((x) => x.path);
  const tree = paths.map((p) => ({ path: p, isPaper: true, type: 'file' }));
  agent._checkPaper(push, tree, { matched: new Set(paths) }, totals);
  return (id) => checks.find((c) => c.name.startsWith(id));
}

const base = {
  tables: 0, bulleted: 0, numbered: 0, todo: 0, links: 0, emojis: 0, headings: 0,
  sectionBreaks: 0, codeLines: [], todoTexts: [], dropboxLinks: [],
};
// Each document carries a link as well as its image — which is what the real seeding does,
// and what keeps a document from counting as 'empty at the destination' when its image is lost.
const doc = (path, srcImages, dstImages) => ({
  path,
  content: {
    compared: true,
    source: { ...base, images: srcImages, links: 1 },
    dest: { ...base, images: dstImages, links: 1, codeLinesFound: 0 },
  },
});

// One image each, both arrived → each feature passes on its OWN document.
let f = rollUp([doc('/11-Paper/qa-paper-full-1.paper', 1, 1), doc('/11-Paper/qa-paper-gif-1.paper', 1, 1)]);
assert.strictEqual(f('10.3').status, 'PASS', '10.3 is attributable from the non-GIF document');
assert.strictEqual(f('10.6').status, 'PASS', '10.6 is attributable from the GIF document');

// The GIF is dropped, the JPEG survives → only 10.6 fails. This is the whole point of the split:
// one feature's loss must not tarnish the other's verdict.
f = rollUp([doc('/11-Paper/qa-paper-full-1.paper', 1, 1), doc('/11-Paper/qa-paper-gif-1.paper', 1, 0)]);
assert.strictEqual(f('10.3').status, 'PASS', 'a lost GIF must not fail 10.3');
assert.strictEqual(f('10.6').status, 'FAIL', 'a lost GIF fails 10.6 by itself');

// Two images in ONE document → attribution is impossible again, so NO verdict is claimed.
f = rollUp([doc('/11-Paper/qa-paper-full-1.paper', 2, 2)]);
assert.strictEqual(f('10.3').status, 'WARN',
  'two images in one document cannot be attributed — never a pass');
assert.ok(/more than one image/.test(f('10.3').detail),
  `the reason is stated, got: ${f('10.3').detail}`);

// 10.4 and 10.5 are never seeded, and must not borrow the image count as evidence.
f = rollUp([doc('/11-Paper/qa-paper-full-1.paper', 1, 1)]);
for (const id of ['10.4', '10.5']) {
  assert.strictEqual(f(id).status, 'WARN', `${id} cannot be seeded, so it is never a pass`);
  assert.ok(/NOT seeded/.test(f(id).detail), `${id} says it is a seeding gap`);
}

console.log('paperFormattingConstructs: image attribution OK');

// ── False-FAIL guards on the new checks ─────────────────────────────────────────────────
//
// Google splits a text run across <span>s wherever it likes, sometimes mid-word, and stripTags
// leaves a space where each tag was. Without a whitespace-insensitive fallback, "a checked item"
// arriving as "a check ed item" would be reported LOST — a false FAIL on 10.11 and 10.15.
const split = rollUp([{
  path: '/11-Paper/qa-paper-full-1.paper',
  content: {
    compared: true,
    source: { ...base, images: 1, links: 1, todo: 1, todoTexts: ['a checked item'] },
    // dest.todo is what _comparePaperContent computes; 1 means the text WAS located despite the
    // split. This asserts the roll-up trusts that number rather than re-deriving it.
    dest: { ...base, images: 1, links: 1, todo: 1, codeLinesFound: 0 },
  },
}]);
assert.strictEqual(split('10.11').status, 'PASS',
  'a to-do item located at the destination passes even when the exporter split the run');

// 10.2: fewer heading ELEMENTS is not a defect — Google renders some levels as styled paragraphs.
// Only a total loss of headings fails.
const fewerHeadings = rollUp([{
  path: '/11-Paper/qa-paper-full-1.paper',
  content: {
    compared: true,
    source: { ...base, images: 1, links: 1, headings: 15, bold: true, strike: true },
    dest: { ...base, images: 1, links: 1, headings: 2, bold: true, strike: true, codeLinesFound: 0 },
  },
}]);
assert.strictEqual(fewerHeadings('10.2').status, 'PASS',
  '15 source headings arriving as 2 <hN> elements is markup choice, not a lost feature');
assert.ok(/not failed/.test(fewerHeadings('10.2').detail),
  `the detail explains why it is not failed, got: ${fewerHeadings('10.2').detail}`);

const noHeadings = rollUp([{
  path: '/11-Paper/qa-paper-full-1.paper',
  content: {
    compared: true,
    source: { ...base, images: 1, links: 1, headings: 15, bold: true },
    dest: { ...base, images: 1, links: 1, headings: 0, bold: true, codeLinesFound: 0 },
  },
}]);
assert.strictEqual(noHeadings('10.2').status, 'FAIL',
  'losing EVERY heading is a real defect and must still fail');

// Bold present in the source but gone at the destination is a real 10.2 failure.
const lostBold = rollUp([{
  path: '/11-Paper/qa-paper-full-1.paper',
  content: {
    compared: true,
    source: { ...base, images: 1, links: 1, headings: 2, bold: true },
    dest: { ...base, images: 1, links: 1, headings: 2, bold: false, codeLinesFound: 0 },
  },
}]);
assert.strictEqual(lostBold('10.2').status, 'FAIL', 'lost bold is a real 10.2 defect');

console.log('paperFormattingConstructs: false-FAIL guards OK');
