/**
 * Run: npm test  (from backend/)
 *
 * Paper content fidelity — scope §10.2-10.19.
 *
 * The report used to answer all eighteen of these features with one WARN saying the content "was
 * not compared" and that they "must be confirmed manually". That was never true of the STRUCTURE:
 * dropboxClient.exportPaper and driveClient.exportNativeFile both already existed — exportPaper's
 * own comment says it is "needed for any content comparison of scope §10" — and neither had ever
 * been called. Eighteen features sat at N/A on every run while the means to answer several of them
 * went unused.
 *
 * Two things are asserted here, and the first is the one that matters most:
 *
 *   1. The two counters AGREE on equivalent documents. They read different formats — Paper markdown
 *      and Google's HTML export — so a counter that measures a different unit on each side produces
 *      a false FAIL on a perfectly migrated document. That bug was live during development:
 *      markdown counted one bullet per LINE while HTML counts one <ul> per BLOCK, so a three-item
 *      list read 3 against 1. These tests exist so it cannot come back.
 *
 *   2. Loss fails, excess only warns, and the features the exports cannot separate are never given
 *      a verdict they haven't earned.
 */
const assert = require('assert');

const Agent = require('../src/validation/combinations/content/dropboxToGoogledrive');
const { paperMarkdownStructure, googleDocStructure } = Agent;

/**
 * The same document, expressed the way each side exports it.
 *
 * Deliberately includes the things that have broken counters before: digits and a '#' (an emoji
 * regex using \p{Emoji} matches both), a table with several rows (a row-counting matcher reports
 * one per row), multi-item lists (item vs block), an image beside a link (a link matcher that
 * ignores the leading '!' swallows the image), and a checklist item that must not be counted as an
 * ordinary bullet.
 */
const PAPER_MD = [
  '# Quarter notes',
  '',
  '| Item | Owner |',
  '|------|-------|',
  '| One  | Ben   |',
  '| Two  | Ada   |',
  '',
  '- alpha',
  '- beta',
  '- gamma',
  '',
  '1. first',
  '2. second',
  '',
  '- [x] shipped',
  '- [ ] pending',
  '',
  '![diagram](https://example.invalid/d.png)',
  '[the spec](https://example.invalid/spec)',
  '',
  'Totals 2 + 3 = 5 on page #4, and we shipped it 🎉',
].join('\n');

const DOC_HTML = [
  '<html><head><style>.c0{color:#000}</style></head><body>',
  '<h1>Quarter notes</h1>',
  '<table><tr><td>Item</td><td>Owner</td></tr><tr><td>One</td><td>Ben</td></tr>',
  '<tr><td>Two</td><td>Ada</td></tr></table>',
  '<ul><li>alpha</li><li>beta</li><li>gamma</li></ul>',
  '<ol><li>first</li><li>second</li></ol>',
  '<ul><li>shipped</li><li>pending</li></ul>',
  '<img src="https://example.invalid/d.png">',
  '<a href="https://example.invalid/spec">the spec</a>',
  '<p>Totals 2 + 3 = 5 on page #4, and we shipped it &#128233;&#127881;</p>',
  '</body></html>',
].join('');

/** The counters must agree on equivalent documents, or every comparison is a false failure. */
function testCountersAgreeOnEquivalentDocuments() {
  const src = paperMarkdownStructure(PAPER_MD);
  const dst = googleDocStructure(DOC_HTML);

  for (const key of ['tables', 'bulleted', 'numbered', 'images', 'links']) {
    assert.strictEqual(src[key], dst[key],
      `${key}: source counted ${src[key]} but destination counted ${dst[key]} on equivalent `
      + 'documents — the two counters measure different units, which fails a correct migration');
  }

  // Concrete values, so a change that breaks both counters identically still fails.
  assert.strictEqual(src.tables, 1, 'one table, not one per row');
  // Two unordered BLOCKS — the bulleted list and the checklist — not one per item. The checklist
  // is counted here on purpose: Google renders it as an ordinary <ul>, so excluding it on the
  // source side would leave the destination permanently higher on any document holding both.
  assert.strictEqual(src.bulleted, 2, 'two unordered blocks, not one per item');
  assert.strictEqual(src.numbered, 1, 'one numbered BLOCK');
  assert.strictEqual(src.images, 1, 'one image');
  assert.strictEqual(src.links, 1, 'one link — the image must not be counted as one');
  console.log('  counters agree on equivalent documents: ok');
}

/**
 * Checklist items are counted separately for 10.11, while still counting as unordered blocks.
 *
 * Both are needed and they are not in conflict: `todo` answers "was the feature exercised at the
 * source", and `bulleted` has to include checklist blocks because the destination cannot tell them
 * from ordinary lists. Excluding them there was a live bug — the destination read permanently
 * higher on any document with both.
 */
function testChecklistIsNotABullet() {
  const s = paperMarkdownStructure('- plain\n\n- [x] done\n- [ ] todo');
  assert.strictEqual(s.todo, 2, 'both checklist ITEMS counted, for 10.11');
  assert.strictEqual(s.bulleted, 2,
    'two unordered BLOCKS — the checklist counts as one, matching how Google exports it');

  // The destination side cannot see a checkbox at all, and must say so with null rather than 0.
  // Zero would read as "none arrived" and fail the feature against a document that has them.
  assert.strictEqual(googleDocStructure('<ul><li>done</li></ul>').todo, null,
    "Google's HTML export cannot distinguish a checklist, so todo is null, never 0");
  console.log('  checklist counted apart from bullets, null at the destination: ok');
}

/**
 * The emoji matcher must not count digits, '#' or '*'.
 *
 * \p{Emoji} matches all of those, so a document with page numbers would report dozens of emojis and
 * feature 10.16 would fail on every run.
 */
function testEmojiMatcherIgnoresDigitsAndHash() {
  assert.strictEqual(paperMarkdownStructure('page #4, 2 + 3 = 5, item 7*').emojis, 0,
    'digits, # and * are not emojis');
  assert.strictEqual(paperMarkdownStructure('one 🎉 here').emojis, 1, 'a real emoji is counted');

  // A multi-codepoint emoji counts once, not once per part.
  assert.strictEqual(paperMarkdownStructure('family 👩‍👩‍👧 here').emojis, 1,
    'a ZWJ sequence counts as one emoji');
  console.log('  emoji matcher ignores digits and hashes: ok');
}

/** An empty or absent export must not read as "everything was lost". */
function testEmptyInputsAreZeroNotNegative() {
  for (const input of ['', null, undefined]) {
    const s = paperMarkdownStructure(input);
    const d = googleDocStructure(input);
    for (const key of ['tables', 'bulleted', 'numbered', 'images', 'links', 'emojis']) {
      assert.strictEqual(s[key], 0, `markdown ${key} is 0 for ${JSON.stringify(input)}`);
      assert.strictEqual(d[key], 0, `html ${key} is 0 for ${JSON.stringify(input)}`);
    }
  }
  console.log('  empty exports count zero, not undefined: ok');
}

/** Google's own <style> block must not be mined for text-level counts. */
function testStyleAndScriptAreStripped() {
  const withStyle = '<style>.c0{content:"🎉"}</style><p>plain</p>';
  assert.strictEqual(googleDocStructure(withStyle).emojis, 0,
    'an emoji inside a <style> block is not document content');
  console.log('  style and script content excluded: ok');
}

// ── Roll-up behaviour ────────────────────────────────────────────────────────────────────
function rollUpPaper(paperItems, sourcePaths) {
  const checks = [];
  const push = (status, name, detail) => checks.push({ name, status, detail });
  const agent = new Agent();
  const totals = agent._emptyTotals({});
  totals.paperItems = paperItems;
  const sourceTree = sourcePaths.map((p) => ({ path: p, isPaper: true, type: 'file' }));
  agent._checkPaper(push, sourceTree, { matched: new Set(sourcePaths) }, totals);
  return checks;
}

const find = (checks, prefix) => checks.find((c) => c.name.startsWith(prefix));

/** A construct LOST in the conversion is a defect; one GAINED is a warning, not a defect. */
function testLossFailsAndExcessWarns() {
  const lost = rollUpPaper([{
    path: '/a.paper',
    content: { compared: true, source: { tables: 3, links: 0 }, dest: { tables: 1, links: 0 } },
  }], ['/a.paper']);
  const lostRow = find(lost, '10.9');
  assert.strictEqual(lostRow.status, 'FAIL', 'two tables lost is a defect');
  assert.ok(/2 lost/.test(lostRow.detail), `the detail says how many, got: ${lostRow.detail}`);

  const gained = rollUpPaper([{
    path: '/a.paper',
    content: { compared: true, source: { tables: 0, links: 1 }, dest: { tables: 0, links: 3 } },
  }], ['/a.paper']);
  const gainedRow = find(gained, '10.7');
  assert.strictEqual(gainedRow.status, 'WARN',
    "an excess is not a defect — Google's exporter adds anchors of its own");
  assert.ok(/Nothing was lost/.test(gainedRow.detail),
    `the detail must say nothing was lost, got: ${gainedRow.detail}`);
  console.log('  loss fails, excess warns: ok');
}

/** A failed export is NOT ASSESSED, never a content defect. */
function testFailedExportIsNotADefect() {
  const checks = rollUpPaper([{
    path: '/a.paper',
    content: { compared: false, reason: 'source Paper export failed: 409 conflict' },
  }], ['/a.paper']);

  const fidelity = find(checks, '10.2-10.19');
  assert.ok(fidelity, 'a single not-assessed check is reported when nothing could be exported');
  assert.strictEqual(fidelity.status, 'WARN',
    'an export that could not run is not evidence the migration lost anything');
  assert.ok(/409 conflict/.test(fidelity.detail),
    `the underlying reason is carried through, got: ${fidelity.detail}`);
  assert.ok(!checks.some((c) => c.status === 'FAIL' && /^10\.(3|4|5|7|9|1[123]|16)/.test(c.name)),
    'no content feature is failed on the strength of a failed export');
  console.log('  failed export reported as not assessed: ok');
}

/**
 * 10.3, 10.4 and 10.5 must NOT be given separate verdicts.
 *
 * All three arrive as an <img>, so the count is measurable but its origin is not. Handing each the
 * same count would repeat the defect the 2.x permission split just corrected: one piece of evidence
 * answering several features.
 */
function testImageOriginIsNotGuessed() {
  const checks = rollUpPaper([{
    path: '/a.paper',
    content: { compared: true, source: { images: 4 }, dest: { images: 4 } },
  }], ['/a.paper']);

  for (const id of ['10.3', '10.4', '10.5']) {
    const row = find(checks, id);
    assert.ok(row, `${id} is reported`);
    assert.strictEqual(row.status, 'WARN',
      `${id} must not be passed — the export cannot attribute an image's origin`);
    assert.ok(/4 image\(s\)/.test(row.detail),
      `${id} still reports the measured count, got: ${row.detail}`);
  }
  console.log('  image origin reported, never guessed: ok');
}

/** The six features the scope document disputes keep their INFO treatment, unruled. */
function testDisputedFeaturesAreNotRuledOn() {
  const disputed = Object.keys(Agent.PAPER_DISPUTED);
  assert.deepStrictEqual(disputed.sort(), ['10.14', '10.15', '10.17', '10.18', '10.2', '10.6'].sort(),
    'the disputed set is unchanged');

  const checks = rollUpPaper([{
    path: '/a.paper',
    content: { compared: true, source: { tables: 1 }, dest: { tables: 1 } },
  }], ['/a.paper']);

  for (const id of disputed) {
    const own = checks.find((c) => c.name.startsWith(`${id} `));
    assert.ok(!own || own.status !== 'PASS',
      `${id} is disputed in the scope document and must not be reported as passing`);
  }
  console.log('  disputed features left unruled: ok');
}

testCountersAgreeOnEquivalentDocuments();
testChecklistIsNotABullet();
testEmojiMatcherIgnoresDigitsAndHash();
testEmptyInputsAreZeroNotNegative();
testStyleAndScriptAreStripped();
testLossFailsAndExcessWarns();
testFailedExportIsNotADefect();
testImageOriginIsNotGuessed();
testDisputedFeaturesAreNotRuledOn();
console.log('paperContentFidelity.test.js: ok');
