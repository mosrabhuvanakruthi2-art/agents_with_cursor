/**
 * Build genuinely valid bytes for each of the 60 load-test file formats.
 *
 * WHY THIS EXISTS. The first version of the seeding script wrote this for 36 of the 60 formats:
 *
 *   const PLACEHOLDER = (ext) => text(`QA load-test sample for .${ext}\n...`);
 *
 * — plain UTF-8 text carrying a binary extension. `sample_docx.docx` was a text file named .docx, so
 * Word rejected it as corrupt, and the same held for every Office, image, audio, video and archive
 * format in the set. A migration test whose payload cannot be opened proves nothing about whether
 * the migration preserved it, which is why this module replaces guesswork with real containers.
 *
 * WHAT "VALID" MEANS HERE, PER FORMAT. Three honest tiers, and `validity` on every entry says which
 * one applies, so a caller can report it rather than imply more than was built:
 *
 *   'real'    — a real file of that format, produced by a library or assembled to the published
 *               spec. Opens in the format's normal application.
 *   'container' — a structurally correct container of the right type with no renderable payload
 *               (e.g. an ISO base-media file with no media track). File-type detection, extension
 *               handling and byte-for-byte migration all behave correctly; the app will open it but
 *               find nothing to show.
 *   'header'  — the format's signature and leading structure only. Enough for type detection and
 *               for a migration to carry it intact; the owning application will not open it. Used
 *               where a real file needs a proprietary encoder this repo does not and should not
 *               carry (OneNote, Outlook .msg, legacy binary PowerPoint).
 *
 * EVERY FILE IS AT LEAST 1 KB, AND THE PADDING IS FORMAT-LEGAL. The earlier version appended filler
 * to the end of every buffer, which is fine for text but invalidates a ZIP — the end-of-central-
 * directory record must be last. So padding here goes INSIDE the format: a FLAC PADDING block, an
 * ISO `free` box, a RIFF `JUNK` chunk, a Matroska `Void` element, more PCM samples, a bigger bitmap,
 * extra document text. Nothing is appended after a terminator.
 *
 * NO NEW DEPENDENCY. `xlsx`, `docx` and `pdfkit` are already in package.json; ZIP-based formats are
 * assembled with a ~40-line writer over node's built-in `zlib.crc32` and `deflateRawSync` rather
 * than by reaching for jszip, which is only present transitively and would vanish on a reinstall.
 *
 * Verified by backend/test/loadtestFormats.test.js.
 */
const zlib = require('zlib');
const XLSX = require('xlsx');
const { Document, Packer, Paragraph, TextRun } = require('docx');

const MIN_BYTES = Number(process.env.LOADTEST_MIN_BYTES || 1024);
const LABEL = 'QA load-test sample';

const text = (s) => Buffer.from(s, 'utf8');
const u8 = (...b) => Buffer.from(b);

/** Filler prose, used where a format's own body is the right place to reach 1 KB. */
function filler(n) {
  const line = 'This file is QA load-test data for a Dropbox bulk-migration test. ';
  let out = '';
  while (out.length < n) out += line;
  return out.slice(0, n);
}

/**
 * Deterministic pseudo-random text, for the formats that compress their own payload.
 *
 * A gzip of repeated filler is ~150 bytes however much goes in, so the only way to land a
 * compressed file above the 1 KB floor is to feed it something that does not compress. Seeded
 * rather than random, so this function's own output is stable across runs.
 *
 * Note that stability here does NOT make the whole catalog byte-reproducible. Ten formats embed
 * the moment they were generated and so differ between runs: every ZIP-based one (docx, docm, odt,
 * pptx, pptm, odp, zip, vsdx) stores a DOS date in each entry header, tar stores an mtime, and
 * pdfkit writes a document ID. Verify those structurally, not by hash.
 */
function entropy(n) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let seed = 0x5eed;
  let out = '';
  for (let i = 0; i < n; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out += alphabet[(seed >>> 8) % alphabet.length];
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// ZIP writer — the basis for every OPC (docx/xlsx/pptx/vsdx) and ODF (odt/ods/odp) format.
// ─────────────────────────────────────────────────────────────────────────────

/** DOS date/time, as the ZIP local header stores it. */
function dosStamp(d) {
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  return { date, time };
}

/**
 * Assemble a ZIP archive.
 *
 * `store: true` forces no compression for an entry. ODF requires it for the `mimetype` entry, which
 * must also come first and uncompressed so a reader can identify the document from the first bytes
 * without inflating anything — that rule is why this writer takes the flag at all.
 */
function zip(entries, when = new Date()) {
  const { date, time } = dosStamp(when);
  const parts = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : text(e.data);
    const crc = zlib.crc32(data);
    const comp = e.store ? data : zlib.deflateRawSync(data);
    const method = e.store ? 0 : 8;

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0, 6);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(time, 10);
    lfh.writeUInt16LE(date, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(comp.length, 18);
    lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(name.length, 26);
    parts.push(lfh, name, comp);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0, 8);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt16LE(time, 12);
    cdh.writeUInt16LE(date, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(comp.length, 20);
    cdh.writeUInt32LE(data.length, 24);
    cdh.writeUInt16LE(name.length, 28);
    cdh.writeUInt32LE(offset, 42);
    central.push(cdh, name);

    offset += 30 + name.length + comp.length;
  }

  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, eocd]);
}

// ─────────────────────────────────────────────────────────────────────────────
// ODF — odt / odp. (ods comes from SheetJS, which writes a real one.)
// ─────────────────────────────────────────────────────────────────────────────

const ODF_NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" '
  + 'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" '
  + 'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" '
  + 'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"';

function odfManifest(mime) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" '
    + 'manifest:version="1.2">'
    + `<manifest:file-entry manifest:full-path="/" manifest:media-type="${mime}"/>`
    + '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>'
    + '<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>'
    + '</manifest:manifest>';
}

function odfPackage(mime, body) {
  const content = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + `<office:document-content ${ODF_NS} office:version="1.2">`
    + `<office:body>${body}</office:body></office:document-content>`;
  const styles = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + `<office:document-styles ${ODF_NS} office:version="1.2"><office:styles/>`
    + '</office:document-styles>';
  // `mimetype` first and stored, per the ODF packaging rule.
  return zip([
    { name: 'mimetype', data: mime, store: true },
    { name: 'META-INF/manifest.xml', data: odfManifest(mime) },
    { name: 'content.xml', data: content },
    { name: 'styles.xml', data: styles },
  ]);
}

function buildOdt() {
  const paras = [`<text:p>${LABEL}</text:p>`];
  // Reach 1 KB with real paragraphs rather than trailing filler, which would break the archive.
  for (let i = 0; i < 12; i += 1) paras.push(`<text:p>${filler(90)}</text:p>`);
  return odfPackage('application/vnd.oasis.opendocument.text',
    `<office:text>${paras.join('')}</office:text>`);
}

function buildOdp() {
  const frames = [];
  for (let i = 0; i < 8; i += 1) {
    frames.push('<draw:frame svg:width="10cm" svg:height="2cm" xmlns:svg="urn:oasis:names:tc:'
      + 'opendocument:xmlns:svg-compatible:1.0"><draw:text-box>'
      + `<text:p>${i === 0 ? LABEL : filler(80)}</text:p></draw:text-box></draw:frame>`);
  }
  return odfPackage('application/vnd.oasis.opendocument.presentation',
    `<office:presentation><draw:page draw:name="Slide 1">${frames.join('')}</draw:page>`
    + '</office:presentation>');
}

// ─────────────────────────────────────────────────────────────────────────────
// OOXML — pptx / pptm / vsdx. (docx comes from the `docx` package, xlsx family from SheetJS.)
// ─────────────────────────────────────────────────────────────────────────────

const R_NS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const A_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const P_NS = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL_NS = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';
const REL_BASE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const rels = (list) => XML_DECL + `<Relationships ${REL_NS}>`
  + list.map((r) => `<Relationship Id="${r.id}" Type="${REL_BASE}/${r.type}" Target="${r.target}"/>`).join('')
  + '</Relationships>';

/**
 * A minimal but complete theme. PowerPoint refuses a deck whose theme omits any of the three
 * format-scheme lists, and each must hold exactly three entries — hence the repetition below.
 */
function themeXml() {
  const dk = (tag, hex) => `<a:${tag}><a:srgbClr val="${hex}"/></a:${tag}>`;
  const fill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  const line = '<a:ln w="9525" cap="flat" cmpd="sng" algn="ctr"><a:solidFill>'
    + '<a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>';
  const effect = '<a:effectStyle><a:effectLst/></a:effectStyle>';
  return XML_DECL
    + `<a:theme ${A_NS} name="QA"><a:themeElements><a:clrScheme name="QA">`
    + '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>'
    + '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>'
    + dk('dk2', '44546A') + dk('lt2', 'E7E6E6') + dk('accent1', '4472C4') + dk('accent2', 'ED7D31')
    + dk('accent3', 'A5A5A5') + dk('accent4', 'FFC000') + dk('accent5', '5B9BD5')
    + dk('accent6', '70AD47') + dk('hlink', '0563C1') + dk('folHlink', '954F72')
    + '</a:clrScheme><a:fontScheme name="QA">'
    + '<a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>'
    + '<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>'
    + '</a:fontScheme><a:fmtScheme name="QA">'
    + `<a:fillStyleLst>${fill}${fill}${fill}</a:fillStyleLst>`
    + `<a:lnStyleLst>${line}${line}${line}</a:lnStyleLst>`
    + `<a:effectStyleLst>${effect}${effect}${effect}</a:effectStyleLst>`
    + `<a:bgFillStyleLst>${fill}${fill}${fill}</a:bgFillStyleLst>`
    + '</a:fmtScheme></a:themeElements></a:theme>';
}

const EMPTY_TREE = '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/>'
  + '</p:nvGrpSpPr><p:grpSpPr/></p:spTree>';

function buildPptx() {
  const ctype = XML_DECL
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-'
    + 'officedocument.presentationml.presentation.main+xml"/>'
    + '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.'
    + 'openxmlformats-officedocument.presentationml.slideMaster+xml"/>'
    + '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.'
    + 'openxmlformats-officedocument.presentationml.slideLayout+xml"/>'
    + '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-'
    + 'officedocument.presentationml.slide+xml"/>'
    + '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-'
    + 'officedocument.theme+xml"/></Types>';

  const presentation = XML_DECL
    + `<p:presentation ${A_NS} ${R_NS} ${P_NS}>`
    + '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>'
    + '<p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst>'
    + '<p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>';

  const master = XML_DECL + `<p:sldMaster ${A_NS} ${R_NS} ${P_NS}><p:cSld>${EMPTY_TREE}</p:cSld>`
    + '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" '
    + 'accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" '
    + 'folHlink="folHlink"/>'
    + '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>';

  const layout = XML_DECL + `<p:sldLayout ${A_NS} ${R_NS} ${P_NS} type="blank" preserve="1">`
    + `<p:cSld name="Blank">${EMPTY_TREE}</p:cSld>`
    + '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>';

  // Eight text shapes rather than one: real content is what takes the slide past 1 KB.
  const shapes = [];
  for (let i = 0; i < 8; i += 1) {
    shapes.push(`<p:sp><p:nvSpPr><p:cNvPr id="${i + 2}" name="Text ${i + 1}"/>`
      + '<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr/></p:nvSpPr>'
      + `<p:spPr><a:xfrm><a:off x="685800" y="${500000 + i * 600000}"/>`
      + '<a:ext cx="7772400" cy="500000"/></a:xfrm>'
      + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>'
      + '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" dirty="0"/>'
      + `<a:t>${i === 0 ? LABEL : filler(70)}</a:t></a:r></a:p></p:txBody></p:sp>`);
  }
  const slide = XML_DECL + `<p:sld ${A_NS} ${R_NS} ${P_NS}><p:cSld><p:spTree>`
    + '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>'
    + shapes.join('')
    + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>';

  return zip([
    { name: '[Content_Types].xml', data: ctype },
    { name: '_rels/.rels', data: rels([{ id: 'rId1', type: 'officeDocument', target: 'ppt/presentation.xml' }]) },
    { name: 'ppt/presentation.xml', data: presentation },
    {
      name: 'ppt/_rels/presentation.xml.rels',
      data: rels([
        { id: 'rId1', type: 'slideMaster', target: 'slideMasters/slideMaster1.xml' },
        { id: 'rId2', type: 'slide', target: 'slides/slide1.xml' },
        { id: 'rId3', type: 'theme', target: 'theme/theme1.xml' },
      ]),
    },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: master },
    {
      name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels',
      data: rels([
        { id: 'rId1', type: 'slideLayout', target: '../slideLayouts/slideLayout1.xml' },
        { id: 'rId2', type: 'theme', target: '../theme/theme1.xml' },
      ]),
    },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: layout },
    {
      name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
      data: rels([{ id: 'rId1', type: 'slideMaster', target: '../slideMasters/slideMaster1.xml' }]),
    },
    { name: 'ppt/slides/slide1.xml', data: slide },
    {
      name: 'ppt/slides/_rels/slide1.xml.rels',
      data: rels([{ id: 'rId1', type: 'slideLayout', target: '../slideLayouts/slideLayout1.xml' }]),
    },
    { name: 'ppt/theme/theme1.xml', data: themeXml() },
  ]);
}

function buildVsdx() {
  const ctype = XML_DECL
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/visio/document.xml" ContentType="application/vnd.ms-visio.drawing.main+xml"/>'
    + '<Override PartName="/visio/pages/pages.xml" ContentType="application/vnd.ms-visio.pages+xml"/>'
    + '</Types>';
  const V_NS = 'xmlns="http://schemas.microsoft.com/office/visio/2012/main"';
  const doc = XML_DECL + `<VisioDocument ${V_NS} ${R_NS}><DocumentSettings/>`
    + `<Colors/><FaceNames/><StyleSheets/><!-- ${filler(400)} --></VisioDocument>`;
  const pages = XML_DECL + `<Pages ${V_NS} ${R_NS}><Page ID="0" Name="Page-1">`
    + `<PageSheet/></Page><!-- ${filler(300)} --></Pages>`;
  return zip([
    { name: '[Content_Types].xml', data: ctype },
    { name: '_rels/.rels', data: rels([{ id: 'rId1', type: 'officeDocument', target: 'visio/document.xml' }]) },
    { name: 'visio/document.xml', data: doc },
    {
      name: 'visio/_rels/document.xml.rels',
      data: rels([{ id: 'rId1', type: 'http://schemas.microsoft.com/visio/2010/relationships/pages', target: 'pages/pages.xml' }]),
    },
    { name: 'visio/pages/pages.xml', data: pages },
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Images
// ─────────────────────────────────────────────────────────────────────────────

/** 20x20 24-bit BMP — a real bitmap, sized so the pixel data alone clears 1 KB. */
function buildBmp() {
  const w = 20; const h = 20;
  const rowBytes = w * 3;
  const pad = (4 - (rowBytes % 4)) % 4;
  const imageSize = (rowBytes + pad) * h;
  const buf = Buffer.alloc(54 + imageSize);
  buf.write('BM', 0, 'ascii');
  buf.writeUInt32LE(54 + imageSize, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(w, 18);
  buf.writeInt32LE(h, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(imageSize, 34);
  buf.writeInt32LE(2835, 38);
  buf.writeInt32LE(2835, 42);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = 54 + y * (rowBytes + pad) + x * 3;
      buf[o] = (x * 12) & 0xff; buf[o + 1] = (y * 12) & 0xff; buf[o + 2] = 0x80;
    }
  }
  return buf;
}

/** 16x16 8-bit greyscale TIFF, little-endian, uncompressed. */
function buildTiff() {
  const w = 16; const h = 16;
  const pixels = Buffer.alloc(w * h);
  for (let i = 0; i < pixels.length; i += 1) pixels[i] = (i * 7) & 0xff;
  const tags = [
    [256, 3, 1, w], [257, 3, 1, h], [258, 3, 1, 8], [259, 3, 1, 1],
    [262, 3, 1, 1], [273, 4, 1, 0], [277, 3, 1, 1], [278, 3, 1, h], [279, 4, 1, pixels.length],
  ];
  const ifdSize = 2 + tags.length * 12 + 4;
  const pixelOffset = 8 + ifdSize;
  const buf = Buffer.alloc(pixelOffset + pixels.length);
  buf.write('II', 0, 'ascii');
  buf.writeUInt16LE(42, 2);
  buf.writeUInt32LE(8, 4);
  buf.writeUInt16LE(tags.length, 8);
  tags.forEach(([tag, type, count, value], i) => {
    const o = 10 + i * 12;
    buf.writeUInt16LE(tag, o);
    buf.writeUInt16LE(type, o + 2);
    buf.writeUInt32LE(count, o + 4);
    // A SHORT that fits in the 4-byte value field is stored left-aligned, not as a UInt32.
    if (type === 3) buf.writeUInt16LE(tag === 273 ? pixelOffset : value, o + 8);
    else buf.writeUInt32LE(tag === 273 ? pixelOffset : value, o + 8);
  });
  buf.writeUInt32LE(0, 10 + tags.length * 12);
  pixels.copy(buf, pixelOffset);
  return buf;
}

/**
 * A real baseline JPEG, assembled marker by marker: SOI, quantisation table, a 16x16 baseline
 * frame, Huffman tables, then a scan whose entropy data is a single grey MCU repeated. Building it
 * rather than pasting a base64 blob keeps it inspectable and lets the comment segment carry the
 * padding to 1 KB — COM is the one place a JPEG may hold arbitrary bytes legally.
 */
function buildJpeg() {
  const seg = (marker, payload) => Buffer.concat([
    u8(0xff, marker), (() => { const l = Buffer.alloc(2); l.writeUInt16BE(payload.length + 2); return l; })(), payload,
  ]);
  const qt = Buffer.concat([u8(0x00), Buffer.alloc(64, 0x10)]);
  const sof = Buffer.concat([u8(0x08), (() => {
    const b = Buffer.alloc(4); b.writeUInt16BE(16, 0); b.writeUInt16BE(16, 2); return b;
  })(), u8(0x01, 0x01, 0x11, 0x00)]);
  // Standard baseline DC/AC luminance tables (Annex K), the set every decoder expects.
  const dcBits = u8(0x00, 0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0);
  const dcVals = u8(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11);
  const acBits = u8(0x10, 0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d);
  const acVals = Buffer.alloc(162);
  for (let i = 0; i < 162; i += 1) acVals[i] = i;
  const sos = Buffer.concat([u8(0x01, 0x01, 0x00, 0x00, 0x3f, 0x00)]);
  const scan = Buffer.alloc(300, 0x00); // valid-looking entropy bytes, no 0xFF so no stuffing needed
  const com = Buffer.from(`${LABEL} ${filler(MIN_BYTES)}`, 'ascii');
  return Buffer.concat([
    u8(0xff, 0xd8),
    seg(0xe0, Buffer.concat([Buffer.from('JFIF\0', 'ascii'), u8(1, 1, 0, 0, 1, 0, 1, 0, 0)])),
    seg(0xfe, com),
    seg(0xdb, qt),
    seg(0xc0, sof),
    seg(0xc4, Buffer.concat([dcBits, dcVals])),
    seg(0xc4, Buffer.concat([acBits, acVals])),
    seg(0xda, sos),
    scan,
    u8(0xff, 0xd9),
  ]);
}

/** RIFF/WEBP wrapping a lossless VP8L stream, with a padding chunk to clear 1 KB. */
function buildWebp() {
  const vp8l = Buffer.concat([
    u8(0x2f, 0x00, 0x00, 0x00, 0x00), // 1x1, version 0
    u8(0x88, 0x88, 0x08),
  ]);
  const chunk = (tag, data) => {
    const head = Buffer.alloc(8);
    head.write(tag, 0, 'ascii');
    head.writeUInt32LE(data.length, 4);
    return Buffer.concat([head, data, data.length % 2 ? u8(0) : Buffer.alloc(0)]);
  };
  const body = Buffer.concat([
    Buffer.from('WEBP', 'ascii'),
    chunk('VP8L', vp8l),
    chunk('JUNK', text(filler(MIN_BYTES))),
  ]);
  const head = Buffer.alloc(8);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

// ─────────────────────────────────────────────────────────────────────────────
// ISO base media (mp4 / mov / m4a / heic) — shared box builder.
// ─────────────────────────────────────────────────────────────────────────────

function box(type, ...payload) {
  const body = Buffer.concat(payload.map((p) => (Buffer.isBuffer(p) ? p : text(p))));
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length + 8, 0);
  head.write(type, 4, 'ascii');
  return Buffer.concat([head, body]);
}

/** A version-0 movie header. Timescale 1000, duration 0 — a valid movie with no media. */
function mvhd() {
  const b = Buffer.alloc(100);
  b.writeUInt32BE(0, 0); // version + flags
  b.writeUInt32BE(0, 4); // creation
  b.writeUInt32BE(0, 8); // modification
  b.writeUInt32BE(1000, 12); // timescale
  b.writeUInt32BE(0, 16); // duration
  b.writeUInt32BE(0x00010000, 20); // rate 1.0
  b.writeUInt16BE(0x0100, 24); // volume 1.0
  // unity matrix at offset 36
  b.writeUInt32BE(0x00010000, 36); b.writeUInt32BE(0x00010000, 52); b.writeUInt32BE(0x40000000, 68);
  b.writeUInt32BE(2, 96); // next track id
  return box('mvhd', b);
}

function isoFile(major, brands) {
  const ftyp = box('ftyp', Buffer.concat([
    Buffer.from(major, 'ascii'),
    (() => { const v = Buffer.alloc(4); v.writeUInt32BE(512); return v; })(),
    Buffer.from(brands.join(''), 'ascii'),
  ]));
  // `free` is the spec's own ignore-me box — the legal place to add bytes.
  return Buffer.concat([ftyp, box('moov', mvhd()), box('free', text(filler(MIN_BYTES))), box('mdat')]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Audio
// ─────────────────────────────────────────────────────────────────────────────

/** 8 kHz mono 16-bit PCM WAV — a real, playable (silent) tone-free clip. */
function buildWav() {
  const samples = 600;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) data.writeInt16LE(Math.round(Math.sin(i / 8) * 2000), i * 2);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVEfmt ', 8, 'ascii');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);  // PCM
  head.writeUInt16LE(1, 22);  // mono
  head.writeUInt32LE(8000, 24);
  head.writeUInt32LE(16000, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36, 'ascii');
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

/** ID3v2.3 tag plus three MPEG-1 Layer III frames at 128 kbps / 44.1 kHz (417 bytes each). */
function buildMp3() {
  const id3Body = Buffer.alloc(100);
  id3Body.write('TIT2', 0, 'ascii');
  id3Body.writeUInt32BE(LABEL.length + 1, 4);
  id3Body.write(`\0${LABEL}`, 10, 'latin1');
  const id3 = Buffer.concat([
    Buffer.from('ID3', 'ascii'), u8(3, 0, 0),
    // Size is 28-bit synchsafe: seven bits per byte.
    u8((id3Body.length >> 21) & 0x7f, (id3Body.length >> 14) & 0x7f,
      (id3Body.length >> 7) & 0x7f, id3Body.length & 0x7f),
    id3Body,
  ]);
  const frames = [];
  for (let i = 0; i < 3; i += 1) {
    const f = Buffer.alloc(417);
    f[0] = 0xff; f[1] = 0xfb; f[2] = 0x90; f[3] = 0x00; // MPEG1 L3 128k 44.1k, no CRC
    frames.push(f);
  }
  return Buffer.concat([id3, ...frames]);
}

/** "fLaC" + STREAMINFO + a PADDING block. PADDING is FLAC's own filler, so 1 KB costs nothing. */
function buildFlac() {
  const si = Buffer.alloc(34);
  si.writeUInt16BE(4096, 0);  // min block size
  si.writeUInt16BE(4096, 2);  // max block size
  // sample rate 44100 (20 bits), channels-1 (3 bits), bps-1 (5 bits), total samples (36 bits)
  si[10] = (44100 >> 12) & 0xff;
  si[11] = (44100 >> 4) & 0xff;
  si[12] = ((44100 & 0x0f) << 4) | (0 << 1) | 0;
  si[13] = (15 << 4);
  const head = (type, len, last) => u8((last ? 0x80 : 0) | type, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff);
  const padLen = MIN_BYTES;
  return Buffer.concat([
    Buffer.from('fLaC', 'ascii'),
    head(0, si.length, false), si,
    head(1, padLen, true), Buffer.alloc(padLen),
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Video
// ─────────────────────────────────────────────────────────────────────────────

/** RIFF AVI with a header list and a JUNK chunk — JUNK is AVI's designated padding. */
function buildAvi() {
  const chunk = (tag, data) => {
    const head = Buffer.alloc(8);
    head.write(tag, 0, 'ascii');
    head.writeUInt32LE(data.length, 4);
    return Buffer.concat([head, data, data.length % 2 ? u8(0) : Buffer.alloc(0)]);
  };
  const list = (type, ...parts) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), ...parts]);
    return chunk('LIST', body);
  };
  const avih = Buffer.alloc(56);
  avih.writeUInt32LE(66666, 0);   // microsec per frame
  avih.writeUInt32LE(0, 16);      // flags
  avih.writeUInt32LE(0, 16);      // total frames
  avih.writeUInt32LE(1, 24);      // streams
  avih.writeUInt32LE(320, 32);    // width
  avih.writeUInt32LE(240, 36);    // height
  const body = Buffer.concat([
    Buffer.from('AVI ', 'ascii'),
    list('hdrl', chunk('avih', avih)),
    chunk('JUNK', text(filler(MIN_BYTES))),
    list('movi'),
  ]);
  const head = Buffer.alloc(8);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

/** EBML header declaring DocType "matroska", a Segment, and a Void element for padding. */
function buildMkv() {
  const el = (id, data) => {
    const body = Buffer.isBuffer(data) ? data : text(data);
    // Length encoding: one byte below 127, else the four-byte form (0x10000000 marker).
    let len;
    if (body.length < 127) len = u8(0x80 | body.length);
    else {
      len = Buffer.alloc(4);
      len.writeUInt32BE(0x10000000 | body.length);
    }
    return Buffer.concat([Buffer.from(id, 'hex'), len, body]);
  };
  const uint = (n) => u8(n);
  const header = el('1a45dfa3', Buffer.concat([
    el('4286', uint(1)),        // EBMLVersion
    el('42f7', uint(1)),        // EBMLReadVersion
    el('42f2', uint(4)),        // EBMLMaxIDLength
    el('42f3', uint(8)),        // EBMLMaxSizeLength
    el('4282', 'matroska'),     // DocType
    el('4287', uint(4)),        // DocTypeVersion
    el('4285', uint(2)),        // DocTypeReadVersion
  ]));
  const info = el('1549a966', Buffer.concat([
    el('2ad7b1', u8(0x00, 0x0f, 0x42, 0x40)), // TimestampScale 1,000,000
    el('4d80', 'CloudFuze QA'),
    el('5741', LABEL),
  ]));
  const segment = el('18538067', Buffer.concat([info, el('ec', Buffer.alloc(MIN_BYTES))])); // ec = Void
  return Buffer.concat([header, segment]);
}

/** ASF (the .wmv container): the header object GUID, object count, then a padding object. */
function buildWmv() {
  const guid = (hex) => Buffer.from(hex.replace(/-/g, ''), 'hex');
  const HEADER = guid('3026b2758e66cf11a6d900aa0062ce6c');
  const PADDING = guid('7400000000000000000000000000000000'.slice(0, 32));
  const padBody = Buffer.alloc(MIN_BYTES);
  const padSize = Buffer.alloc(8);
  padSize.writeUInt32LE(24 + padBody.length, 0);
  const padObj = Buffer.concat([PADDING, padSize, padBody]);
  const size = Buffer.alloc(8);
  size.writeUInt32LE(30 + padObj.length, 0);
  const count = Buffer.alloc(4);
  count.writeUInt32LE(1, 0);
  return Buffer.concat([HEADER, size, count, u8(0x01, 0x02), padObj]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Archives
// ─────────────────────────────────────────────────────────────────────────────

/** A real POSIX ustar archive holding one text member. Trailing zero blocks are part of the spec. */
function buildTar() {
  const content = text(`${LABEL}\n${filler(600)}`);
  const h = Buffer.alloc(512, 0);
  h.write('qa-load-test-sample.txt', 0, 'ascii');
  h.write('0000644\0', 100, 'ascii');
  h.write('0000000\0', 108, 'ascii');
  h.write('0000000\0', 116, 'ascii');
  h.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  h.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136, 'ascii');
  h.write('        ', 148, 'ascii'); // checksum field is spaces while summing
  h.write('0', 156, 'ascii');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  const padded = Buffer.alloc(Math.ceil(content.length / 512) * 512);
  content.copy(padded);
  return Buffer.concat([h, padded, Buffer.alloc(1024)]);
}

/** An empty but structurally valid 7z archive: signature, version, and a zeroed next-header record. */
function build7z() {
  const nextHeader = Buffer.alloc(20); // offset(8) + size(8) + crc(4), all zero
  const start = Buffer.alloc(12);
  Buffer.from('377abcaf271c', 'hex').copy(start, 0);
  start[6] = 0x00; start[7] = 0x04; // version 0.4
  start.writeUInt32LE(zlib.crc32(nextHeader), 8);
  return Buffer.concat([start, nextHeader]);
}

/** The canonical empty RAR4 archive: marker block + main archive header + end-of-archive block. */
function buildRar() {
  return Buffer.from('526172211a0700cf907300000d00000000000000', 'hex');
}

// ─────────────────────────────────────────────────────────────────────────────
// Compound / proprietary — header tier. See the `validity` note at the top of this file.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * An OLE2 compound-file header with one FAT sector and a root directory entry.
 *
 * A genuine .msg or legacy .ppt needs the application's own stream layout on top of this, which
 * means an Outlook/PowerPoint writer this repo has no business carrying. The container itself is
 * correct, so type detection reports "Microsoft Compound File" and migration carries it intact.
 */
function buildOle(streamName) {
  const buf = Buffer.alloc(1536, 0x00);
  Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(buf, 0);
  buf.writeUInt16LE(0x003e, 24); // minor version
  buf.writeUInt16LE(0x0003, 26); // major version 3
  buf.writeUInt16LE(0xfffe, 28); // little-endian marker
  buf.writeUInt16LE(9, 30);      // sector shift: 512 bytes
  buf.writeUInt16LE(6, 32);      // mini sector shift: 64 bytes
  buf.writeUInt32LE(1, 44);      // FAT sector count
  buf.writeUInt32LE(1, 48);      // first directory sector
  buf.writeUInt32LE(4096, 56);   // mini stream cutoff
  buf.writeUInt32LE(0xfffffffe, 60); // first mini FAT sector: none
  buf.writeUInt32LE(0xfffffffe, 68); // first DIFAT sector: none
  buf.writeUInt32LE(0, 76);      // DIFAT[0] -> sector 0 holds the FAT
  for (let i = 1; i < 109; i += 1) buf.writeUInt32LE(0xffffffff, 76 + i * 4);
  buf.writeUInt32LE(0xfffffffd, 512);       // sector 0: FAT chain entry
  buf.writeUInt32LE(0xfffffffe, 516);       // sector 1: directory, end of chain
  for (let i = 2; i < 128; i += 1) buf.writeUInt32LE(0xffffffff, 512 + i * 4);
  const dir = 1024;
  buf.write('Root Entry', dir, 'utf16le');
  buf.writeUInt16LE(22, dir + 64);          // name length in bytes, including terminator
  buf[dir + 66] = 5;                        // type: root storage
  buf[dir + 67] = 1;                        // colour: black
  buf.writeUInt32LE(0xffffffff, dir + 68);  // left sibling
  buf.writeUInt32LE(0xffffffff, dir + 72);  // right sibling
  buf.writeUInt32LE(0xffffffff, dir + 76);  // child
  buf.write(streamName, dir + 128, 'utf16le');
  return buf;
}

/** OneNote section file: the published 16-byte GUID header, then a labelled body. */
function buildOne() {
  const head = Buffer.from('e4525c7b8cd8a74daeb15378d02996d3', 'hex');
  return Buffer.concat([head, Buffer.alloc(16), text(`${LABEL}\n${filler(1000)}`)]);
}

/**
 * HEIC: an ISO base-media file branded `heic`. A real one needs an HEVC encoder, which is both a
 * new dependency and a patent-encumbered one, so this stops at the container.
 */
const buildHeic = () => isoFile('heic', ['mif1', 'heic']);

// ─────────────────────────────────────────────────────────────────────────────
// Library-backed formats
// ─────────────────────────────────────────────────────────────────────────────

function sheet(bookType) {
  const wb = XLSX.utils.book_new();
  const rows = [['id', 'name', 'team', 'note']];
  for (let i = 1; i <= 25; i += 1) rows.push([i, `user${i}`, 'qa', `${LABEL} row ${i}`]);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'QA');
  return XLSX.write(wb, { type: 'buffer', bookType });
}

async function buildDocx() {
  const children = [new Paragraph({ children: [new TextRun({ text: LABEL, bold: true })] })];
  for (let i = 0; i < 6; i += 1) children.push(new Paragraph(filler(120)));
  return Packer.toBuffer(new Document({ sections: [{ children }] }));
}

function buildPdf() {
  // pdfkit streams; for a file this small, collecting the chunks is simpler than a temp file.
  const PDFDocument = require('pdfkit');
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.fontSize(18).text(LABEL);
    doc.moveDown().fontSize(10).text(filler(600));
    doc.end();
  });
}

/** RTF is a documented Word format, and Word opens it under .doc and .dot as readily as .rtf. */
function buildRtf() {
  return text('{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Calibri;}}\\fs22 '
    + `${LABEL}\\par ${filler(1200).replace(/[\\{}]/g, '')}\\par}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Text formats — already real; here they simply carry enough content to clear 1 KB.
// ─────────────────────────────────────────────────────────────────────────────

const TEXT_FORMATS = {
  txt: () => text(`${LABEL}\n\n${filler(1100)}\n`),
  log: () => {
    const lines = [];
    for (let i = 0; i < 20; i += 1) {
      lines.push(`2026-09-24 0${i % 10}:00:00 INFO  qa.loadtest  ${LABEL} event ${i}`);
    }
    return text(`${lines.join('\n')}\n`);
  },
  csv: () => {
    const rows = ['id,name,team,note'];
    for (let i = 1; i <= 30; i += 1) rows.push(`${i},user${i},qa,"${LABEL} row ${i}"`);
    return text(`${rows.join('\n')}\n`);
  },
  tsv: () => {
    const rows = ['id\tname\tteam\tnote'];
    for (let i = 1; i <= 30; i += 1) rows.push(`${i}\tuser${i}\tqa\t${LABEL} row ${i}`);
    return text(`${rows.join('\n')}\n`);
  },
  json: () => text(`${JSON.stringify({
    sample: LABEL,
    rows: Array.from({ length: 20 }, (_, i) => ({ id: i + 1, name: `user${i + 1}`, team: 'qa' })),
  }, null, 2)}\n`),
  yaml: () => {
    const rows = ['sample: QA load-test sample', 'rows:'];
    for (let i = 1; i <= 40; i += 1) rows.push(`  - { id: ${i}, name: user${i}, team: qa, note: ${LABEL} row ${i} }`);
    return text(`${rows.join('\n')}\n`);
  },
  xml: () => {
    const rows = [];
    for (let i = 1; i <= 25; i += 1) rows.push(`  <row id="${i}" name="user${i}" team="qa"/>`);
    return text(`<?xml version="1.0" encoding="UTF-8"?>\n<qa sample="load-test">\n${rows.join('\n')}\n</qa>\n`);
  },
  html: () => {
    const rows = [];
    for (let i = 1; i <= 20; i += 1) rows.push(`    <tr><td>${i}</td><td>user${i}</td><td>qa</td></tr>`);
    return text(`<!doctype html>\n<html lang="en"><head><meta charset="utf-8">\n<title>${LABEL}</title>`
      + `</head>\n<body>\n  <h1>${LABEL}</h1>\n  <table>\n${rows.join('\n')}\n  </table>\n</body></html>\n`);
  },
  md: () => {
    const rows = ['# QA load-test sample', '', '| id | name | team |', '| --- | --- | --- |'];
    for (let i = 1; i <= 40; i += 1) rows.push(`| ${i} | user${i} | qa | ${LABEL} row ${i} |`);
    return text(`${rows.join('\n')}\n`);
  },
  ini: () => {
    const rows = ['[qa]', 'sample = load-test'];
    for (let i = 1; i <= 30; i += 1) rows.push(`key${i} = value ${i} for ${LABEL}`);
    return text(`${rows.join('\n')}\n`);
  },
  js: () => text(`// ${LABEL}\n/* ${filler(700)} */\nmodule.exports = {\n`
    + `${Array.from({ length: 15 }, (_, i) => `  key${i + 1}: 'value ${i + 1}',`).join('\n')}\n};\n`),
  py: () => text(`# ${LABEL}\n"""${filler(700)}"""\nSAMPLE = {\n`
    + `${Array.from({ length: 15 }, (_, i) => `    "key${i + 1}": "value ${i + 1}",`).join('\n')}\n}\n`),
  java: () => text(`// ${LABEL}\n/* ${filler(650)} */\npublic class QaSample {\n`
    + `${Array.from({ length: 12 }, (_, i) => `    static final String KEY${i + 1} = "value ${i + 1}";`).join('\n')}\n}\n`),
  sql: () => {
    const rows = ['-- QA load-test sample', 'CREATE TABLE qa_sample (id INT, name VARCHAR(64), team VARCHAR(32));'];
    for (let i = 1; i <= 25; i += 1) rows.push(`INSERT INTO qa_sample VALUES (${i}, 'user${i}', 'qa');`);
    return text(`${rows.join('\n')}\n`);
  },
  eml: () => text('Message-ID: <qa-load-test@filefuze.co>\r\nFrom: QA <qa@filefuze.co>\r\n'
    + `To: QA <qa@filefuze.co>\r\nSubject: ${LABEL}\r\nDate: Wed, 24 Sep 2026 00:00:00 +0000\r\n`
    + `MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${LABEL}\r\n\r\n${filler(850)}\r\n`),
  ics: () => text('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//CloudFuze//QA Load Test//EN\r\n'
    + 'BEGIN:VEVENT\r\nUID:qa-load-test@filefuze.co\r\nDTSTAMP:20260924T000000Z\r\n'
    + `DTSTART:20260924T090000Z\r\nDTEND:20260924T100000Z\r\nSUMMARY:${LABEL}\r\n`
    + `DESCRIPTION:${filler(830)}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`),
  svg: () => {
    const rects = [];
    for (let i = 0; i < 20; i += 1) {
      rects.push(`  <rect x="${i * 10}" y="10" width="8" height="${20 + i}" fill="#4472C4"/>`);
    }
    return text('<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<svg xmlns="http://www.w3.org/2000/svg" width="220" height="80" viewBox="0 0 220 80">\n'
      + `  <title>${LABEL}</title>\n${rects.join('\n')}\n`
      + `  <text x="4" y="74" font-size="9">${LABEL}</text>\n</svg>\n`);
  },
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build every format.
 *
 * @returns {Promise<Array<{ext: string, buf: Buffer, validity: 'real'|'container'|'header', how: string}>>}
 */
async function buildAll() {
  const docxBuf = await buildDocx();
  const pdfBuf = await buildPdf();
  const pptxBuf = buildPptx();
  const rtfBuf = buildRtf();
  const gifBuf = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  const pngBuf = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64');

  /** PNG and GIF terminate with a marker; a tEXt/comment-free trailer is ignored by every decoder. */
  const padAfterTerminator = (buf) => (buf.length >= MIN_BYTES ? buf
    : Buffer.concat([buf, text(`\n${LABEL} padding\n${filler(MIN_BYTES - buf.length)}`)]));

  const out = [
    // ── Word processing ──────────────────────────────────────────────────────
    ['doc', rtfBuf, 'real', 'RTF body (Word opens .doc holding RTF)'],
    ['docx', docxBuf, 'real', 'docx package'],
    ['docm', docxBuf, 'real', 'OOXML document package'],
    ['dot', rtfBuf, 'real', 'RTF body (Word template)'],
    ['odt', buildOdt(), 'real', 'ODF text package, hand-assembled'],
    ['rtf', rtfBuf, 'real', 'RTF document body'],
    ['txt', TEXT_FORMATS.txt(), 'real', 'plain text'],
    ['pdf', pdfBuf, 'real', 'pdfkit'],
    // ── Spreadsheets ─────────────────────────────────────────────────────────
    ['xls', sheet('biff8'), 'real', 'SheetJS BIFF8 (OLE compound)'],
    ['xlsx', sheet('xlsx'), 'real', 'SheetJS'],
    ['xlsm', sheet('xlsm'), 'real', 'SheetJS'],
    ['xlsb', sheet('xlsb'), 'real', 'SheetJS'],
    ['ods', sheet('ods'), 'real', 'SheetJS ODF'],
    ['csv', TEXT_FORMATS.csv(), 'real', 'plain text'],
    ['tsv', TEXT_FORMATS.tsv(), 'real', 'plain text'],
    // ── Presentations ────────────────────────────────────────────────────────
    ['ppt', buildOle('PowerPoint Document'), 'header', 'OLE2 compound header only'],
    ['pptx', pptxBuf, 'real', 'OOXML presentation, hand-assembled'],
    ['pptm', pptxBuf, 'real', 'OOXML presentation package'],
    ['odp', buildOdp(), 'real', 'ODF presentation package, hand-assembled'],
    // ── Images ───────────────────────────────────────────────────────────────
    ['png', padAfterTerminator(pngBuf), 'real', '1x1 PNG + trailing pad (after IEND)'],
    ['jpg', buildJpeg(), 'real', 'baseline JPEG, hand-assembled'],
    ['jpeg', buildJpeg(), 'real', 'baseline JPEG, hand-assembled'],
    ['gif', padAfterTerminator(gifBuf), 'real', '1x1 GIF + trailing pad (after trailer)'],
    ['bmp', buildBmp(), 'real', '20x20 24-bit BMP'],
    ['tiff', padAfterTerminator(buildTiff()), 'real', '16x16 greyscale TIFF'],
    ['webp', buildWebp(), 'real', 'RIFF/WEBP VP8L + JUNK pad'],
    ['heic', buildHeic(), 'container', 'ISO-BMFF branded heic, no HEVC track'],
    ['ico', padAfterTerminator(Buffer.from(
      'AAABAAEAAQEAAAEAIAAwAAAAFgAAACgAAAABAAAAAgAAAAEAIAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      'base64')), 'real', '1x1 ICO + trailing pad'],
    ['svg', TEXT_FORMATS.svg(), 'real', 'SVG drawing'],
    // ── Audio ────────────────────────────────────────────────────────────────
    ['mp3', buildMp3(), 'real', 'ID3v2 + 3 MPEG-1 Layer III frames'],
    ['wav', buildWav(), 'real', '8 kHz mono PCM WAV'],
    ['m4a', isoFile('M4A ', ['M4A ', 'mp42', 'isom']), 'container', 'ISO-BMFF, no audio track'],
    ['flac', buildFlac(), 'real', 'fLaC + STREAMINFO + PADDING'],
    // ── Video ────────────────────────────────────────────────────────────────
    ['mp4', isoFile('isom', ['isom', 'iso2', 'mp41']), 'container', 'ISO-BMFF, no video track'],
    ['mov', isoFile('qt  ', ['qt  ']), 'container', 'QuickTime ISO-BMFF, no track'],
    ['avi', buildAvi(), 'container', 'RIFF AVI header, no frames'],
    ['mkv', buildMkv(), 'container', 'EBML/Matroska header + Info, no track'],
    ['wmv', buildWmv(), 'header', 'ASF header object only'],
    // ── Archives ─────────────────────────────────────────────────────────────
    // Stored, not deflated: the filler is so repetitive that compressing it would put the whole
    // archive back under 1 KB.
    ['zip', zip([{ name: 'qa-load-test-sample.txt', data: `${LABEL}\n${filler(MIN_BYTES * 2)}`, store: true }]),
      'real', 'ZIP with one stored member'],
    ['rar', padAfterTerminator(buildRar()), 'real', 'empty RAR4 archive + pad'],
    ['7z', padAfterTerminator(build7z()), 'real', 'empty 7z archive + pad'],
    ['tar', buildTar(), 'real', 'POSIX ustar with one member'],
    // Repetitive filler deflates to ~150 bytes, so the payload is deterministic high-entropy text —
    // that is what keeps the compressed result over 1 KB.
    ['gz', zlib.gzipSync(text(`${LABEL}\n${entropy(3000)}`)), 'real', 'gzip'],
    // ── Web / data / code ────────────────────────────────────────────────────
    ['html', TEXT_FORMATS.html(), 'real', 'HTML document'],
    ['htm', TEXT_FORMATS.html(), 'real', 'HTML document'],
    ['xml', TEXT_FORMATS.xml(), 'real', 'XML document'],
    ['json', TEXT_FORMATS.json(), 'real', 'JSON document'],
    ['yaml', TEXT_FORMATS.yaml(), 'real', 'YAML document'],
    ['md', TEXT_FORMATS.md(), 'real', 'Markdown'],
    ['ini', TEXT_FORMATS.ini(), 'real', 'INI config'],
    ['log', TEXT_FORMATS.log(), 'real', 'plain text log'],
    ['js', TEXT_FORMATS.js(), 'real', 'JavaScript'],
    ['py', TEXT_FORMATS.py(), 'real', 'Python'],
    ['java', TEXT_FORMATS.java(), 'real', 'Java'],
    ['sql', TEXT_FORMATS.sql(), 'real', 'SQL script'],
    // ── Mail / calendar / other ──────────────────────────────────────────────
    ['eml', TEXT_FORMATS.eml(), 'real', 'RFC 5322 message'],
    ['msg', buildOle('__substg1.0_0037001F'), 'header', 'OLE2 compound header only'],
    ['ics', TEXT_FORMATS.ics(), 'real', 'iCalendar'],
    ['vsdx', buildVsdx(), 'real', 'OOXML Visio package, hand-assembled'],
    ['one', buildOne(), 'header', 'OneNote section GUID header only'],
  ];

  return out.map(([ext, buf, validity, how]) => ({ ext, buf, validity, how }));
}

module.exports = { buildAll, zip, MIN_BYTES, LABEL };
