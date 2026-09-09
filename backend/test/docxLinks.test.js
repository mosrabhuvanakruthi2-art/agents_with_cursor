/**
 * Run: npm test  (from backend/)
 *
 * Feature 6.1 — links held INSIDE a migrated document.
 *
 * This was reported as un-automatable: a .docx is a ZIP, and the note said reading it "needs an
 * archive library this project does not use". It does not — DEFLATE ships with Node, so the
 * hyperlink targets can be read straight out of word/_rels/document.xml.rels.
 *
 * Two things are asserted, and the second matters as much as the first:
 *   1. The real hyperlink target is recovered from a genuine .docx.
 *   2. A file that CANNOT be read reports that fact, never "no links found". Those two must never
 *      reach a report as the same thing, or an unreadable document would pass as a clean one.
 */
const assert = require('assert');
const { Document, Packer, Paragraph, TextRun, ExternalHyperlink } = require('docx');
const { extractDocxLinks } = require('../src/utils/docxLinks');

const GOOGLE_URL = 'https://drive.google.com/file/d/1ABCdefGHIjkl/view';
const SP_URL = 'https://trydemos.sharepoint.com/sites/QA/Shared%20Documents/embedded_link_target.txt';

/** The document the seeder builds: a hyperlink, plus the URL repeated as visible text. */
async function buildDoc(link) {
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({ children: [new TextRun('Embedded link test document (feature 6.1).')] }),
        new Paragraph({
          children: [
            new TextRun('Open the target file here: '),
            new ExternalHyperlink({
              children: [new TextRun({ text: 'embedded_link_target.txt', style: 'Hyperlink' })],
              link,
            }),
          ],
        }),
        new Paragraph({ children: [new TextRun('Source link: ' + GOOGLE_URL)] }),
      ],
    }],
  });
  return Packer.toBuffer(doc);
}

async function testRecoversTheHyperlink() {
  const parsed = extractDocxLinks(await buildDoc(GOOGLE_URL));
  assert.strictEqual(parsed.ok, true, 'a real .docx is readable');
  assert.deepStrictEqual(parsed.targets, [GOOGLE_URL], 'the hyperlink target is recovered exactly');
  console.log('  hyperlink target recovered from a real .docx: ok');
}

/**
 * The visible text always contains the ORIGINAL Google URL, deliberately, so a human can compare.
 * A migrated document must therefore be judged on its relationship targets — judging the body would
 * report every correct migration as a failure.
 */
async function testRewrittenDocIsNotFailedByItsOwnText() {
  const parsed = extractDocxLinks(await buildDoc(SP_URL));
  assert.strictEqual(parsed.ok, true);
  assert.deepStrictEqual(parsed.targets, [SP_URL], 'the rewritten target is what is reported');
  assert.ok(parsed.text.includes('drive.google.com'),
    'the body still mentions the old URL — which is exactly why the body must not be the verdict');
  const isGoogle = (t) => /(drive|docs).google.com|googleapis.com/i.test(t);
  assert.strictEqual(parsed.targets.filter(isGoogle).length, 0,
    'a correctly rewritten document has no Google TARGET, whatever its text says');
  console.log('  rewritten document not failed by its own visible text: ok');
}

function testUnreadableIsNotEmpty() {
  for (const [buf, why] of [
    [Buffer.from('hello world, not a zip at all'), 'plain text'],
    [Buffer.alloc(0), 'empty buffer'],
    [Buffer.from('PK'), 'truncated signature'],
  ]) {
    const parsed = extractDocxLinks(buf);
    assert.strictEqual(parsed.ok, false, why + ' is reported as unreadable');
    assert.ok(parsed.reason, why + ' carries a reason');
    assert.deepStrictEqual(parsed.targets, [], why + ' yields no targets');
  }
  console.log('  unreadable file reports a reason, never a clean result: ok');
}

(async () => {
  await testRecoversTheHyperlink();
  await testRewrittenDocIsNotFailedByItsOwnText();
  testUnreadableIsNotEmpty();
  console.log('docxLinks.test.js: ok');
})().catch((err) => { console.error(err); process.exit(1); });
