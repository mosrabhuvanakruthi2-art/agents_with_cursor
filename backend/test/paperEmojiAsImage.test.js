/**
 * Run: npm test  (from backend/)
 *
 * Google does not export an emoji as a character. It rasterises each one to a 64x64 PNG and emits
 * an <img> whose alt is the emoji's CLDR name in words. So reading the destination emoji count
 * from the stripped text returns 0 however well the migration ran, and the same images inflate the
 * image count.
 *
 * Run e6bdd529 (dropbox -> googleshareddrive) showed both halves at once, and the arithmetic was
 * exact in all three documents:
 *
 *   qa-paper-v2         emoji 2 -> 0   images 0 -> 2
 *   qa-paper-full       emoji 3 -> 0   images 1 -> 4
 *   qa-paper-full (1)   emoji 3 -> 0   images 1 -> 4
 *
 * Feature 10.16 read "8 in the source but only 0 at the destination — 8 lost in the conversion"
 * and FAILED, while 10.3/10.4/10.5 read "2 image(s) in the source, 10 at the destination" and
 * warned. Nothing was lost and nothing was added: one exporter behaviour, two wrong verdicts.
 *
 * Verified end to end after the fix by exporting all three seeded documents from Dropbox and
 * their converted counterparts from the destination Shared Drive. Every counter then agreed:
 *
 *   qa-paper-v2        bulleted 3->3  numbered 2->2  tables 1->1  emoji 2->2  images 0->0
 *   qa-paper-full      bulleted 3->3  numbered 3->3  tables 3->3  emoji 3->3  images 1->1
 *   qa-paper-full (1)  bulleted 3->3  numbered 3->3  tables 3->3  emoji 3->3  images 1->1
 *
 * The fixtures below carry the REAL base64 prefixes taken from the actual export of
 * /11-Paper/qa-paper-full.html, not hand-written stand-ins. A previous fix in this area used a
 * hand-authored fixture that happened to agree with the bug it was meant to catch, so the bytes
 * here come from the file Google produced.
 */
const assert = require('assert');

const v = require('../src/validation/combinations/content/dropboxToGoogledrive');

// Real base64 prefixes from the export. A 64x64 RGBA PNG IHDR, then the one real photo (JPEG).
const PNG_64 = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAASzklEQVR4Xu1bB1SU';
const PNG_64_B = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAWPklEQVR4Xt1aCVxO';
const PNG_64_C = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAMD0lEQVR4Xu1baUxc';
const JPEG = '/9j/4AAQSkZJRgABAgAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkS';

const img = (alt, mime, b64) => `<img alt="${alt}" src="data:image/${mime};base64,${b64}">`;

/** The exact shape of the real document: three rasterised emoji and one inserted photo. */
function testTheRealExport() {
  const html = '<p>Release notes '
    + img('party popper', 'png', PNG_64)
    + img('rocket', 'png', PNG_64_B)
    + img('thumbs up', 'png', PNG_64_C)
    + '</p><p>' + img('', 'jpeg', JPEG) + '</p>';

  assert.deepStrictEqual(v.splitImages(html), { emojiImages: 3, images: 1 },
    'three rasterised emoji and one real image');

  const s = v.googleDocStructure(html);
  assert.strictEqual(s.emojis, 3, 'the emoji are counted, not reported as lost');
  assert.strictEqual(s.images, 1, 'and they do not inflate the image count');
  console.log('  the real export: 3 emoji + 1 image, not 0 emoji + 4 images: ok');
}

/**
 * A real image must never be mistaken for an emoji. Each case below breaks exactly one of the
 * three required signals, so it also proves that no single signal is doing the work alone.
 */
function testRealImagesAreNotEmoji() {
  const cases = [
    ['a JPEG, whatever its alt', img('holiday snap', 'jpeg', JPEG)],
    ['a PNG with no alt', img('', 'png', PNG_64)],
    ['a PNG with whitespace-only alt', img('   ', 'png', PNG_64)],
    // 800x600: a real screenshot. IHDR width 0x320, height 0x258.
    ['a large PNG with alt text',
      img('screenshot', 'png', Buffer.concat([
        Buffer.from('89504E470D0A1A0A0000000D49484452', 'hex'),
        (() => { const b = Buffer.alloc(8); b.writeUInt32BE(800, 0); b.writeUInt32BE(600, 4); return b; })(),
        Buffer.alloc(8),
      ]).toString('base64'))],
    ['an external image URL', '<img alt="logo" src="https://example.com/logo.png">'],
  ];
  for (const [label, html] of cases) {
    const r = v.splitImages(html);
    assert.strictEqual(r.emojiImages, 0, `${label} is not an emoji`);
    assert.strictEqual(r.images, 1, `${label} still counts as an image`);
  }
  console.log(`  ${cases.length} real-image shapes stay images: ok`);
}

/** Emoji still present as CHARACTERS must be counted — the text path is not replaced. */
function testTextEmojiStillCounted() {
  const s = v.googleDocStructure('<p>done \u{1F389} and \u{1F680}</p>');
  assert.strictEqual(s.emojis, 2, 'characters in the text are still counted');
  assert.strictEqual(s.images, 0);

  // Both paths at once: one rasterised, one left as a character.
  const mixed = v.googleDocStructure('<p>a \u{1F389} b ' + img('rocket', 'png', PNG_64_B) + '</p>');
  assert.strictEqual(mixed.emojis, 2, 'the text emoji and the rasterised one are both counted');
  assert.strictEqual(mixed.images, 0, 'and the rasterised one is not also an image');
  console.log('  text emoji and rasterised emoji both counted, never double-counted: ok');
}

/** Malformed input must not throw — a validator that crashes reports nothing. */
function testMalformedInput() {
  for (const html of ['', null, undefined, '<img>', '<img alt="x" src="data:image/png;base64,!!!">',
    '<img alt="x" src="data:image/png;base64,aGk=">']) {
    const r = v.splitImages(html);
    assert.ok(Number.isFinite(r.emojiImages) && Number.isFinite(r.images),
      `malformed input returns numbers, not a throw: ${String(html).slice(0, 30)}`);
  }
  // A truncated base64 that cannot carry an IHDR is an image, not an emoji.
  assert.strictEqual(v.splitImages('<img alt="x" src="data:image/png;base64,aGk=">').emojiImages, 0);
  console.log('  malformed input handled without throwing: ok');
}

/** The other counters must be untouched by this change. */
function testOtherCountersUnchanged() {
  const html = '<table><tr><td>a</td></tr></table><ul><li>x</li></ul><ol><li>y</li></ol>'
    + '<a href="https://example.com">link</a>' + img('rocket', 'png', PNG_64_B);
  const s = v.googleDocStructure(html);
  assert.strictEqual(s.tables, 1);
  assert.strictEqual(s.bulleted, 1);
  assert.strictEqual(s.numbered, 1);
  assert.strictEqual(s.links, 1);
  assert.strictEqual(s.todo, null, 'todo stays null — a checklist is indistinguishable in HTML');
  console.log('  tables, lists, links and todo unaffected: ok');
}

/**
 * Lists are compared as ITEMS, because Google emits one list element per item.
 *
 * The destination side used to count <ul>/<ol> ELEMENTS on the stated premise that Google emits
 * one per block. Read off the real export of /11-Paper/qa-paper-full.html, it does not:
 *
 *   <ul> 1 item: ["alpha"]     <ol> 1 item: ["first"]
 *   <ul> 1 item: ["beta"]      <ol> 1 item: ["second"]
 *   <ul> 1 item: ["gamma"]     <ol> 1 item: ["third"]
 *
 * all six siblings at nesting depth 0. So a 1-block source was compared against 3 destination
 * elements and run e6bdd529 warned "3 in the source but 9 at the destination" across three
 * perfectly migrated documents.
 *
 * The numbers asserted below are the REAL ones, measured by exporting all three seeded documents
 * from Dropbox and their converted counterparts from the destination Shared Drive. That matters
 * here: a hand-written fixture with one <ul> holding three <li> children made the old block
 * counting look correct, which is how the bug survived.
 */
function testListsCountItemsNotElements() {
  // Google, one list per item.
  const perItem = '<ul><li>alpha</li></ul><ul><li>beta</li></ul><ul><li>gamma</li></ul>'
    + '<ol><li>first</li></ol><ol><li>second</li></ol><ol><li>third</li></ol>';
  let s = v.googleDocStructure(perItem);
  assert.strictEqual(s.bulleted, 3, 'three bulleted items, however many <ul> elements carry them');
  assert.strictEqual(s.numbered, 3, 'three numbered items');

  // The same items in one list each. Item counting must give the same answer either way — which
  // is exactly why it is used: it survives both exporter shapes, where element counting breaks.
  s = v.googleDocStructure('<ul><li>alpha</li><li>beta</li><li>gamma</li></ul>'
    + '<ol><li>first</li><li>second</li><li>third</li></ol>');
  assert.strictEqual(s.bulleted, 3, 'grouped into one <ul>, still three items');
  assert.strictEqual(s.numbered, 3, 'grouped into one <ol>, still three items');

  // A nested list of the other type is attributed to the type that directly encloses it.
  s = v.googleDocStructure('<ul><li>outer<ol><li>inner</li></ol></li></ul>');
  assert.strictEqual(s.bulleted, 1, 'the <li> inside the <ol> is not counted as a bullet');
  assert.strictEqual(s.numbered, 1, 'and it is counted as numbered');

  assert.strictEqual(v.googleDocStructure('<p>no lists</p>').bulleted, 0, 'no lists, no items');
  console.log('  lists compared as items, on either exporter shape: ok');
}

testTheRealExport();
testRealImagesAreNotEmoji();
testTextEmojiStillCounted();
testMalformedInput();
testOtherCountersUnchanged();
testListsCountItemsNotElements();
console.log('paperEmojiAsImage.test.js: ok');
