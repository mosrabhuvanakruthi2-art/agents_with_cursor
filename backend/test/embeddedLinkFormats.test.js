/**
 * Feature 8.1 must cover more than one file type.
 *
 * Scope 8.1 names no format, and the check rested entirely on a single .docx — so a product that
 * rewrote Word documents but not spreadsheets would have passed it. A .xlsx, a .pdf and a .txt are
 * now seeded beside it, each linking to its OWN in-scope target so one rewrite cannot stand in for
 * another and the report can name the format that was left alone.
 *
 * Every fixture here is built by the real seeding code and read by the real reader, so the test
 * cannot drift from what a run actually produces.
 */
const assert = require('assert');
const { extractLinks, plainTextLinks, pdfLinks } = require('../src/utils/embeddedLinks');
const Agent = require('../src/agents/dropbox/DropboxTestDataAgent');

const TARGET = 'https://www.dropbox.com/scl/fi/ABC123/link-target.txt?rlkey=zzz&dl=0';

(async () => {
  const agent = new Agent();

  // ── Each format embeds a REAL link, and the reader finds it ────────────────────────────
  for (const format of ['xlsx', 'pdf', 'txt']) {
    const buf = await agent._buildEmbeddedLinkFile(format, TARGET);
    assert.ok(Buffer.isBuffer(buf) && buf.length > 0, `.${format} produced bytes`);
    const res = extractLinks(buf, `embedded_link_doc.${format}`);
    assert.strictEqual(res.ok, true, `.${format} is readable, got: ${res.reason}`);
    assert.ok(res.links.includes(TARGET),
      `.${format} must carry the exact target, got: ${JSON.stringify(res.links)}`);
    assert.strictEqual(res.format, format);
  }

  // ── .txt is seeded but NOT judgeable: it cannot hold a hyperlink, only text ────────────
  const txt = extractLinks(await agent._buildEmbeddedLinkFile('txt', TARGET), 'x.txt');
  assert.strictEqual(txt.judgeable, false,
    'a .txt must never produce a verdict — failing it reports a defect nobody promised');
  for (const format of ['xlsx', 'pdf', 'docx']) {
    assert.strictEqual(extractLinks(Buffer.from('x'), `x.${format}`).judgeable, true,
      `.${format} is a supported rewrite target and IS judged`);
  }

  // ── "Could not look" must never read as "no links found" ──────────────────────────────
  const empty = extractLinks(Buffer.alloc(0), 'x.xlsx');
  assert.strictEqual(empty.ok, false, 'an empty download is a READ FAILURE, not zero links');
  assert.ok(/empty|could not/i.test(empty.reason), `the reason is stated, got: ${empty.reason}`);

  const notZip = extractLinks(Buffer.from('this is not a spreadsheet'), 'x.xlsx');
  assert.strictEqual(notZip.ok, false, 'a non-Office file is a read failure, not zero links');

  const notPdf = extractLinks(Buffer.from('nope'), 'x.pdf');
  assert.strictEqual(notPdf.ok, false, 'a file with no %PDF- header is a read failure');

  const unknown = extractLinks(Buffer.from('x'), 'x.rtf');
  assert.strictEqual(unknown.ok, false, 'a format with no reader says so');
  assert.ok(/no reader/.test(unknown.reason), `and names the gap, got: ${unknown.reason}`);

  // A genuinely link-free document of a readable format IS zero links, not a failure.
  const bare = await agent._buildEmbeddedLinkFile('txt', '');
  const bareRes = plainTextLinks(Buffer.from('no urls here at all\n'));
  assert.strictEqual(bareRes.ok, true, 'a readable file with no links is ok:true');
  assert.deepStrictEqual(bareRes.links, [], 'and reports zero links');
  assert.ok(Buffer.isBuffer(bare), 'an empty url still produces a file rather than throwing');

  // ── A rewritten link is detected as no longer pointing at Dropbox ──────────────────────
  const rewritten = await agent._buildEmbeddedLinkFile('pdf',
    'https://drive.google.com/file/d/XYZ/view');
  const rw = pdfLinks(rewritten);
  assert.strictEqual(rw.ok, true);
  assert.ok(rw.links.some((u) => /drive\.google\.com/.test(u)),
    'a rewritten target is read back as the DESTINATION address');
  assert.ok(!rw.links.some((u) => /dropbox\.com/.test(u)),
    'and carries no trace of the source address — which is what 8.1 passes on');

  console.log('embeddedLinkFormats: OK');
})().catch((err) => { console.error(err); process.exit(1); });
