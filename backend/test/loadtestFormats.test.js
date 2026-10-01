/**
 * Every load-test format must be a real file of its own type, not text wearing the extension.
 *
 * The first seeding script produced this for 36 of the 60 formats:
 *
 *   const PLACEHOLDER = (ext) => text(`QA load-test sample for .${ext}\n...`);
 *
 * so `sample_docx.docx` was plain UTF-8 named .docx. Word called it corrupt, and the same held for
 * every image, audio, video, archive and Office format in the set — 34,000 copies of files that
 * could not be opened. A migration test proves nothing about preservation if the payload was never
 * a valid file to begin with.
 *
 * Checking the extension list is not enough, because that was already right. These assertions read
 * the BYTES: ZIP archives are parsed entry by entry and every CRC recomputed, ISO base-media files
 * are walked box by box and must account for the buffer exactly, the tar checksum is recomputed,
 * gzip is round-tripped, and the SheetJS workbooks are re-read and their cells compared. Anything
 * weaker would pass on a file that merely starts with the right four bytes.
 */
const assert = require('assert');
const zlib = require('zlib');
const XLSX = require('xlsx');
const { buildAll, MIN_BYTES } = require('../scripts/loadtest-formats');

/** Parse a ZIP from its end-of-central-directory record, the way a real reader does. */
function readZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from('504b0506', 'hex'));
  assert.ok(eocd >= 0, 'no end-of-central-directory record');
  assert.strictEqual(eocd + 22, buf.length,
    'EOCD must be the last record — trailing bytes after it are what appending padding to a ZIP does');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    assert.strictEqual(buf.readUInt32LE(p), 0x02014b50, 'central directory header signature');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const rawSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');

    assert.strictEqual(buf.readUInt32LE(local), 0x04034b50, `${name}: local header signature`);
    const lNameLen = buf.readUInt16LE(local + 26);
    const lExtraLen = buf.readUInt16LE(local + 28);
    const start = local + 30 + lNameLen + lExtraLen;
    const comp = buf.slice(start, start + compSize);
    const data = method === 0 ? comp : zlib.inflateRawSync(comp);
    assert.strictEqual(data.length, rawSize, `${name}: uncompressed size`);
    assert.strictEqual(zlib.crc32(data), crc, `${name}: CRC-32 must match, or the archive is corrupt`);

    entries.push({ name, data, method });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Walk ISO base-media boxes; they must tile the buffer exactly with no slack. */
function readBoxes(buf) {
  const types = [];
  let p = 0;
  while (p < buf.length) {
    assert.ok(p + 8 <= buf.length, 'truncated box header');
    const size = buf.readUInt32BE(p);
    const type = buf.slice(p + 4, p + 8).toString('ascii');
    assert.ok(size >= 8, `box ${type}: size ${size} is below the 8-byte header`);
    assert.ok(p + size <= buf.length, `box ${type}: runs past the end of the file`);
    types.push(type);
    p += size;
  }
  assert.strictEqual(p, buf.length, 'boxes must account for the whole file exactly');
  return types;
}

/** Walk RIFF chunks inside a container whose header declares its own length. */
function readRiff(buf, form) {
  assert.strictEqual(buf.slice(0, 4).toString('ascii'), 'RIFF', 'RIFF signature');
  const declared = buf.readUInt32LE(4);
  assert.strictEqual(declared + 8, buf.length, 'RIFF size field must match the real length');
  assert.strictEqual(buf.slice(8, 12).toString('ascii'), form, `RIFF form type ${form}`);
  const tags = [];
  let p = 12;
  while (p + 8 <= buf.length) {
    const tag = buf.slice(p, p + 4).toString('ascii');
    const size = buf.readUInt32LE(p + 4);
    tags.push(tag);
    p += 8 + size + (size % 2);
  }
  return tags;
}

(async () => {
  const all = await buildAll();
  const byExt = new Map(all.map((f) => [f.ext, f]));
  const get = (ext) => {
    const f = byExt.get(ext);
    assert.ok(f, `format ${ext} is missing from the set`);
    return f;
  };

  // ── The set itself ───────────────────────────────────────────────────────────────────
  assert.strictEqual(all.length, 60, 'the catalog is 60 formats');
  assert.strictEqual(byExt.size, 60, 'every extension appears exactly once');

  for (const f of all) {
    assert.ok(Buffer.isBuffer(f.buf), `${f.ext}: must build a Buffer`);
    assert.ok(f.buf.length >= MIN_BYTES,
      `${f.ext}: ${f.buf.length} bytes is under the ${MIN_BYTES}-byte floor`);
    assert.ok(['real', 'container', 'header'].includes(f.validity), `${f.ext}: validity tier`);
    assert.ok(f.how && f.how.length > 3, `${f.ext}: must say how it was built`);
  }

  // No format may still be the old plain-text placeholder.
  for (const f of all) {
    const head = f.buf.slice(0, 40).toString('latin1');
    assert.ok(!/^QA load-test sample for \./.test(head),
      `${f.ext}: still the text placeholder — this is the bug the module exists to fix`);
  }

  // ── ZIP-based: OOXML, ODF, and plain .zip ────────────────────────────────────────────
  for (const ext of ['docx', 'docm', 'xlsx', 'xlsm', 'xlsb', 'ods', 'odt', 'odp', 'pptx', 'pptm', 'vsdx', 'zip']) {
    const entries = readZip(get(ext).buf);
    assert.ok(entries.length > 0, `${ext}: archive has entries`);
  }

  // OOXML packages must carry the content-type map and their main part.
  const mainPart = {
    docx: 'word/document.xml',
    docm: 'word/document.xml',
    xlsx: 'xl/workbook.xml',
    xlsm: 'xl/workbook.xml',
    pptx: 'ppt/presentation.xml',
    pptm: 'ppt/presentation.xml',
    vsdx: 'visio/document.xml',
  };
  for (const [ext, part] of Object.entries(mainPart)) {
    const names = readZip(get(ext).buf).map((e) => e.name);
    assert.ok(names.includes('[Content_Types].xml'), `${ext}: [Content_Types].xml`);
    assert.ok(names.includes('_rels/.rels'), `${ext}: package relationships`);
    assert.ok(names.includes(part), `${ext}: main part ${part} (has ${names.join(', ')})`);
  }

  // A deck PowerPoint will open needs the master, layout and theme, not just a slide.
  {
    const names = readZip(get('pptx').buf).map((e) => e.name);
    for (const part of [
      'ppt/slides/slide1.xml', 'ppt/slideMasters/slideMaster1.xml',
      'ppt/slideLayouts/slideLayout1.xml', 'ppt/theme/theme1.xml',
      'ppt/slides/_rels/slide1.xml.rels', 'ppt/slideMasters/_rels/slideMaster1.xml.rels',
    ]) {
      assert.ok(names.includes(part), `pptx: missing ${part} — PowerPoint rejects the deck without it`);
    }
    const theme = readZip(get('pptx').buf).find((e) => e.name === 'ppt/theme/theme1.xml').data.toString('utf8');
    for (const list of ['fillStyleLst', 'lnStyleLst', 'effectStyleLst', 'bgFillStyleLst']) {
      assert.ok(theme.includes(list), `pptx theme: ${list} is required by the schema`);
    }
  }

  // ODF: `mimetype` must be the FIRST entry and STORED, so a reader can identify the document
  // from the opening bytes without inflating anything.
  for (const [ext, mime] of [
    ['odt', 'application/vnd.oasis.opendocument.text'],
    ['odp', 'application/vnd.oasis.opendocument.presentation'],
  ]) {
    const entries = readZip(get(ext).buf);
    assert.strictEqual(entries[0].name, 'mimetype', `${ext}: mimetype must be first`);
    assert.strictEqual(entries[0].method, 0, `${ext}: mimetype must be stored uncompressed`);
    assert.strictEqual(entries[0].data.toString('utf8'), mime, `${ext}: media type`);
    const names = entries.map((e) => e.name);
    assert.ok(names.includes('META-INF/manifest.xml'), `${ext}: manifest`);
    assert.ok(names.includes('content.xml'), `${ext}: content`);
    assert.ok(get(ext).buf.slice(30, 38).toString('ascii'), 'mimetype');
  }

  // ── Spreadsheets round-trip through a real reader ────────────────────────────────────
  for (const ext of ['xlsx', 'xlsm', 'xlsb', 'ods', 'xls']) {
    const wb = XLSX.read(get(ext).buf, { type: 'buffer' });
    assert.ok(wb.SheetNames.length >= 1, `${ext}: workbook has a sheet`);
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
    assert.deepStrictEqual(rows[0], ['id', 'name', 'team', 'note'], `${ext}: header row survives a re-read`);
    assert.ok(rows.length >= 20, `${ext}: ${rows.length} rows read back`);
  }
  // .xls is the legacy OLE compound container, not a ZIP.
  assert.strictEqual(get('xls').buf.slice(0, 8).toString('hex'), 'd0cf11e0a1b11ae1', 'xls: OLE2 signature');

  // ── Documents ────────────────────────────────────────────────────────────────────────
  {
    const pdf = get('pdf').buf;
    assert.strictEqual(pdf.slice(0, 5).toString('ascii'), '%PDF-', 'pdf: header');
    assert.ok(pdf.slice(-1024).toString('latin1').includes('%%EOF'), 'pdf: trailer');
    assert.ok(pdf.toString('latin1').includes('/Type /Catalog') || pdf.toString('latin1').includes('/Catalog'),
      'pdf: document catalog');
  }
  for (const ext of ['rtf', 'doc', 'dot']) {
    assert.strictEqual(get(ext).buf.slice(0, 5).toString('ascii'), '{\\rtf', `${ext}: RTF header`);
    assert.strictEqual(get(ext).buf.slice(-1).toString('ascii'), '}', `${ext}: RTF group closes`);
  }

  // ── Images ───────────────────────────────────────────────────────────────────────────
  assert.strictEqual(get('png').buf.slice(0, 8).toString('hex'), '89504e470d0a1a0a', 'png: signature');
  assert.ok(get('png').buf.includes(Buffer.from('IEND')), 'png: IEND chunk');
  assert.strictEqual(get('gif').buf.slice(0, 6).toString('ascii'), 'GIF89a', 'gif: signature');
  assert.strictEqual(get('ico').buf.slice(0, 4).toString('hex'), '00000100', 'ico: signature');

  for (const ext of ['jpg', 'jpeg']) {
    const b = get(ext).buf;
    assert.strictEqual(b.slice(0, 2).toString('hex'), 'ffd8', `${ext}: SOI`);
    assert.strictEqual(b.slice(-2).toString('hex'), 'ffd9', `${ext}: EOI`);
    // Walk the marker segments up to the scan; a decoder needs frame and Huffman tables present.
    const seen = [];
    let p = 2;
    while (p < b.length - 2) {
      assert.strictEqual(b[p], 0xff, `${ext}: marker at ${p}`);
      const marker = b[p + 1];
      seen.push(marker);
      if (marker === 0xda) break; // start of scan; entropy data follows
      const len = b.readUInt16BE(p + 2);
      p += 2 + len;
    }
    assert.ok(seen.includes(0xc0), `${ext}: SOF0 baseline frame header`);
    assert.ok(seen.filter((m) => m === 0xc4).length >= 2, `${ext}: DC and AC Huffman tables`);
    assert.ok(seen.includes(0xdb), `${ext}: quantisation table`);
    assert.ok(seen.includes(0xda), `${ext}: start of scan`);
  }

  {
    const bmp = get('bmp').buf;
    assert.strictEqual(bmp.slice(0, 2).toString('ascii'), 'BM', 'bmp: signature');
    assert.strictEqual(bmp.readUInt32LE(2), bmp.length, 'bmp: file size field matches');
    assert.strictEqual(bmp.readUInt32LE(14), 40, 'bmp: BITMAPINFOHEADER');
    assert.strictEqual(bmp.readUInt16LE(28), 24, 'bmp: 24 bits per pixel');
    assert.strictEqual(bmp.readUInt32LE(10) + bmp.readUInt32LE(34), bmp.length, 'bmp: pixel data fills the file');
  }
  {
    const tiff = get('tiff').buf;
    assert.strictEqual(tiff.slice(0, 2).toString('ascii'), 'II', 'tiff: little-endian');
    assert.strictEqual(tiff.readUInt16LE(2), 42, 'tiff: magic 42');
    const ifd = tiff.readUInt32LE(4);
    const tagCount = tiff.readUInt16LE(ifd);
    assert.ok(tagCount >= 8, 'tiff: the mandatory baseline tags are present');
    const tags = [];
    for (let i = 0; i < tagCount; i += 1) tags.push(tiff.readUInt16LE(ifd + 2 + i * 12));
    for (const required of [256, 257, 258, 259, 262, 273, 279]) {
      assert.ok(tags.includes(required), `tiff: baseline tag ${required}`);
    }
  }
  assert.deepStrictEqual(readRiff(get('webp').buf, 'WEBP').slice(0, 1), ['VP8L'], 'webp: VP8L stream');

  // ── ISO base media ───────────────────────────────────────────────────────────────────
  for (const [ext, brand] of [['mp4', 'isom'], ['mov', 'qt  '], ['m4a', 'M4A '], ['heic', 'heic']]) {
    const b = get(ext).buf;
    const types = readBoxes(b);
    assert.strictEqual(types[0], 'ftyp', `${ext}: ftyp comes first`);
    assert.strictEqual(b.slice(8, 12).toString('ascii'), brand, `${ext}: major brand`);
    assert.ok(types.includes('moov'), `${ext}: movie box`);
    // The movie header must itself be a well-formed child box.
    const moovStart = b.indexOf(Buffer.from('moov', 'ascii')) - 4;
    const inner = readBoxes(b.slice(moovStart + 8, moovStart + b.readUInt32BE(moovStart)));
    assert.deepStrictEqual(inner, ['mvhd'], `${ext}: moov contains mvhd`);
  }

  // ── Audio ────────────────────────────────────────────────────────────────────────────
  {
    const tags = readRiff(get('wav').buf, 'WAVE');
    assert.ok(tags.includes('fmt '), 'wav: format chunk');
    assert.ok(tags.includes('data'), 'wav: data chunk');
    const w = get('wav').buf;
    assert.strictEqual(w.readUInt16LE(20), 1, 'wav: PCM');
    assert.strictEqual(w.readUInt32LE(24), 8000, 'wav: 8 kHz');
    assert.strictEqual(w.readUInt32LE(40) + 44, w.length, 'wav: data size matches the file');
  }
  {
    const mp3 = get('mp3').buf;
    assert.strictEqual(mp3.slice(0, 3).toString('ascii'), 'ID3', 'mp3: ID3v2 tag');
    const tagSize = ((mp3[6] & 0x7f) << 21) | ((mp3[7] & 0x7f) << 14) | ((mp3[8] & 0x7f) << 7) | (mp3[9] & 0x7f);
    const first = 10 + tagSize;
    assert.strictEqual(mp3[first], 0xff, 'mp3: frame sync byte 1');
    assert.strictEqual(mp3[first + 1] & 0xe0, 0xe0, 'mp3: frame sync byte 2');
    assert.strictEqual((mp3[first + 1] >> 3) & 0x03, 0x03, 'mp3: MPEG version 1');
    assert.strictEqual((mp3[first + 1] >> 1) & 0x03, 0x01, 'mp3: Layer III');
    // 144 * 128000 / 44100 = 417 bytes per frame; three of them must fit exactly.
    assert.strictEqual(mp3.length - first, 3 * 417, 'mp3: three whole frames');
  }
  {
    const flac = get('flac').buf;
    assert.strictEqual(flac.slice(0, 4).toString('ascii'), 'fLaC', 'flac: signature');
    let p = 4;
    const blocks = [];
    for (;;) {
      const last = (flac[p] & 0x80) !== 0;
      const type = flac[p] & 0x7f;
      const len = (flac[p + 1] << 16) | (flac[p + 2] << 8) | flac[p + 3];
      blocks.push(type);
      p += 4 + len;
      if (last) break;
      assert.ok(p < flac.length, 'flac: metadata blocks run past the end');
    }
    assert.strictEqual(blocks[0], 0, 'flac: STREAMINFO must come first');
    assert.ok(blocks.includes(1), 'flac: PADDING block carries the size, not trailing junk');
    assert.strictEqual(p, flac.length, 'flac: metadata accounts for the whole file');
  }

  // ── Video containers ─────────────────────────────────────────────────────────────────
  {
    const tags = readRiff(get('avi').buf, 'AVI ');
    assert.ok(tags.includes('LIST'), 'avi: header list');
    assert.ok(tags.includes('JUNK'), 'avi: JUNK is the format-legal padding');
  }
  {
    const mkv = get('mkv').buf;
    assert.strictEqual(mkv.slice(0, 4).toString('hex'), '1a45dfa3', 'mkv: EBML header id');
    assert.ok(mkv.includes(Buffer.from('matroska', 'ascii')), 'mkv: DocType matroska');
    assert.ok(mkv.includes(Buffer.from('18538067', 'hex')), 'mkv: Segment element');
  }
  assert.strictEqual(get('wmv').buf.slice(0, 16).toString('hex'), '3026b2758e66cf11a6d900aa0062ce6c',
    'wmv: ASF header object GUID');

  // ── Archives ─────────────────────────────────────────────────────────────────────────
  {
    const tar = get('tar').buf;
    assert.strictEqual(tar.length % 512, 0, 'tar: whole 512-byte blocks');
    assert.strictEqual(tar.slice(257, 262).toString('ascii'), 'ustar', 'tar: ustar magic');
    const stored = tar.slice(148, 156).toString('ascii');
    const declared = parseInt(stored.trim().replace(/\0.*$/, ''), 8);
    let sum = 0;
    for (let i = 0; i < 512; i += 1) sum += (i >= 148 && i < 156) ? 0x20 : tar[i];
    assert.strictEqual(sum, declared, 'tar: header checksum must recompute — this is what tar verifies');
    const size = parseInt(tar.slice(124, 135).toString('ascii'), 8);
    assert.ok(size > 0, 'tar: member has content');
    assert.ok(tar.slice(512, 512 + size).toString('utf8').includes('QA load-test sample'),
      'tar: member content is readable');
    assert.ok(tar.slice(-1024).every((b) => b === 0), 'tar: two zero blocks terminate the archive');
  }
  {
    const z = get('7z').buf;
    assert.strictEqual(z.slice(0, 6).toString('hex'), '377abcaf271c', '7z: signature');
    assert.strictEqual(z.readUInt32LE(8), zlib.crc32(z.slice(12, 32)),
      '7z: start-header CRC must cover the next-header record');
  }
  assert.strictEqual(get('rar').buf.slice(0, 7).toString('hex'), '526172211a0700', 'rar: RAR4 signature');
  {
    const gz = get('gz').buf;
    assert.strictEqual(gz.slice(0, 3).toString('hex'), '1f8b08', 'gz: gzip magic + deflate');
    const out = zlib.gunzipSync(gz).toString('utf8');
    assert.ok(out.includes('QA load-test sample'), 'gz: round-trips back to its content');
  }

  // ── Text formats parse as their own type ─────────────────────────────────────────────
  JSON.parse(get('json').buf.toString('utf8'));
  for (const ext of ['xml', 'svg']) {
    const s = get(ext).buf.toString('utf8');
    assert.ok(s.startsWith('<?xml'), `${ext}: XML declaration`);
    const opens = (s.match(/<[a-zA-Z]/g) || []).length;
    const closes = (s.match(/<\//g) || []).length + (s.match(/\/>/g) || []).length;
    assert.strictEqual(opens, closes, `${ext}: every element is closed`);
  }
  assert.ok(get('html').buf.toString('utf8').startsWith('<!doctype html>'), 'html: doctype');
  assert.ok(get('eml').buf.toString('utf8').includes('\r\n\r\n'), 'eml: header/body separator');
  assert.ok(/^BEGIN:VCALENDAR\r\n/.test(get('ics').buf.toString('utf8')), 'ics: opens VCALENDAR');
  assert.ok(/END:VCALENDAR\r\n$/.test(get('ics').buf.toString('utf8')), 'ics: closes VCALENDAR');
  for (const ext of ['csv', 'tsv']) {
    const lines = get(ext).buf.toString('utf8').trim().split('\n');
    const sep = ext === 'csv' ? ',' : '\t';
    assert.ok(lines.length > 20, `${ext}: has rows`);
    assert.strictEqual(lines[0].split(sep).length, 4, `${ext}: four columns`);
  }

  // ── The honesty check on the tiers ───────────────────────────────────────────────────
  const tiers = all.reduce((acc, f) => { acc[f.validity] = (acc[f.validity] || 0) + 1; return acc; }, {});
  assert.strictEqual(tiers.header, 4,
    'only ppt, msg, wmv and one are header-tier; anything else claiming that tier needs a reason');
  assert.ok(tiers.real >= 48, `expected at least 48 fully real formats, got ${tiers.real}`);

  console.log(`loadtestFormats: OK — 60 formats, ${tiers.real} real, `
    + `${tiers.container || 0} container, ${tiers.header} header`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
