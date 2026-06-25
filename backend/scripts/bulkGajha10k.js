/**
 * bulkGajha10k.js
 *
 * Creates 10,000 emails in alex@gajha.com Inbox:
 *   - 9,900 with old timestamps (2019–2024)
 *   - 100  with new timestamps (2025–2026, this year's data)
 *
 * Covers every possible scenario:
 *   attachments (PDF/DOCX/XLSX/PPTX/ZIP/PNG/CSV/TXT/multi),
 *   HTML rich bodies (tables, lists, colours, blockquotes, inline code),
 *   plain text, emojis, stickers (inline emoji images), unicode, links/URLs,
 *   flagged/follow-up/complete, high/low/normal importance,
 *   categories (Red/Blue/Green/Orange/Purple),
 *   thread chains (5–10 levels deep, multiple users),
 *   read/unread, CC/BCC, multiple TO, reply-to, subject variety.
 *
 * Users: alex@gajha.com + granger mia harry Taylor Martin Wilson Clark kim @gajha.com
 *
 * Usage: cd backend && node scripts/bulkGajha10k.js
 */

'use strict';

require('../src/config/env');
const outlookClient = require('../src/clients/outlookClient');
const XLSX = require('xlsx');
const zlib = require('zlib');

const TARGET      = 'alex@gajha.com';
const FOLDER      = 'inbox';
const TOTAL_OLD   = 9900;
const TOTAL_NEW   = 100;
const CONCURRENCY = 2;

// ─── Users ────────────────────────────────────────────────────────────────────
const U = {
  alex:    { address: 'alex@gajha.com',    name: 'Alex Gajha' },
  granger: { address: 'granger@gajha.com', name: 'Granger' },
  mia:     { address: 'mia@gajha.com',     name: 'Mia' },
  harry:   { address: 'harry@gajha.com',   name: 'Harry' },
  taylor:  { address: 'Taylor@gajha.com',  name: 'Taylor' },
  martin:  { address: 'Martin@gajha.com',  name: 'Martin' },
  wilson:  { address: 'Wilson@gajha.com',  name: 'Wilson' },
  clark:   { address: 'Clark@gajha.com',   name: 'Clark' },
  kim:     { address: 'kim@gajha.com',     name: 'Kim' },
};
const ALL_USERS = Object.values(U);
const SENDERS   = ALL_USERS.filter((u) => u.address !== TARGET);
const ea  = (u) => ({ emailAddress: u });
const pick = (arr, i) => arr[((i % arr.length) + arr.length) % arr.length];

// ─── Timestamp helpers ────────────────────────────────────────────────────────
function rndTs(startMs, endMs) {
  const ms = startMs + Math.random() * (endMs - startMs);
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
const OLD_START = new Date('2019-01-01').getTime();
const OLD_END   = new Date('2024-12-31').getTime();
const NEW_START = new Date('2025-01-01').getTime();
const NEW_END   = new Date('2026-05-22').getTime();
const oldTs = () => rndTs(OLD_START, OLD_END);
const newTs = () => rndTs(NEW_START, NEW_END);
function sentFromReceived(received) {
  return new Date(new Date(received).getTime() - 2 * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ─── CRC32 + ZIP ──────────────────────────────────────────────────────────────
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i; for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[i] = c;
  }
  return t;
})();
function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC32_TABLE[(c ^ buf[i]) & 0xFF]; return (c ^ 0xFFFFFFFF) >>> 0; }
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n >>> 0, 0); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; };
function buildZip(files) {
  const parts = [], central = []; let off = 0;
  for (const { name, data } of files) {
    const nb = Buffer.from(name, 'utf8'), crc = crc32(data);
    const lh = Buffer.concat([Buffer.from([0x50, 0x4B, 0x03, 0x04]), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(nb.length), u16(0), nb]);
    central.push(Buffer.concat([Buffer.from([0x50, 0x4B, 0x01, 0x02]), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(nb.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(off), nb]));
    parts.push(lh, data); off += lh.length + data.length;
  }
  const cd = Buffer.concat(central);
  return Buffer.concat([...parts, cd, Buffer.concat([Buffer.from([0x50, 0x4B, 0x05, 0x06]), u16(0), u16(0), u16(files.length), u16(files.length), u32(cd.length), u32(off), u16(0)])]);
}
function buildDocx(title) {
  const e = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return buildZip([
    { name: '[Content_Types].xml', data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>', 'utf8') },
    { name: '_rels/.rels', data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>', 'utf8') },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>', 'utf8') },
    { name: 'word/document.xml', data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>' + e(title) + '</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Document for QA migration/archive testing. Validates DOCX structure survives mailbox migration.</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>', 'utf8') },
  ]);
}
function buildRawPdf(title) {
  const esc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)').replace(/[^\x20-\x7E]/g, ' ');
  const lines = ['Gajha QA migration test.', 'Attachment preserved: YES', 'Validates PDF survives mailbox migration.'];
  const ops = ['BT', '/F1 14 Tf', '18 TL', '72 720 Td', `(${esc(title)}) Tj`, '/F1 10 Tf', '14 TL', 'T*'];
  for (const l of lines) ops.push(`(${esc(l)}) Tj`, 'T*');
  ops.push('ET');
  const s = ops.join('\n') + '\n';
  const objs = new Map([[1, '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'], [2, '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n'], [3, '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n'], [4, `4 0 obj\n<< /Length ${Buffer.byteLength(s, 'ascii')} >>\nstream\n${s}endstream\nendobj\n`], [5, '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n']]);
  const hdr = '%PDF-1.4\n'; let off = Buffer.byteLength(hdr, 'ascii');
  const offs = new Map(); for (const n of [1, 2, 3, 4, 5]) { offs.set(n, off); off += Buffer.byteLength(objs.get(n), 'ascii'); }
  const pad = (n) => String(n).padStart(10, '0');
  const xref = ['xref', '0 6', '0000000000 65535 f ', ...[1, 2, 3, 4, 5].map((n) => `${pad(offs.get(n))} 00000 n `)].join('\n') + '\n';
  return Buffer.concat([Buffer.from(hdr, 'ascii'), ...[1, 2, 3, 4, 5].map((n) => Buffer.from(objs.get(n), 'ascii')), Buffer.from(xref, 'ascii'), Buffer.from(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${off}\n%%EOF\n`, 'ascii')]);
}
function buildXlsx() {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['User', 'Folder', 'Messages', 'Status'], ['Alex', 'Inbox', 47, 'OK'], ['Granger', 'Sent', 23, 'OK'], ['Mia', 'Custom', 15, 'OK']]), 'Data');
  return XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
}

/** Minimal solid-colour 16×16 PNG */
function makeSolidColorPng(r, g, b, size = 16) {
  const crcTable = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); return c; });
  const crc32png = (buf) => { let crc = 0xFFFFFFFF; for (const byte of buf) crc = crcTable[(crc ^ byte) & 0xFF] ^ (crc >>> 8); return (crc ^ 0xFFFFFFFF) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const typeB = Buffer.from(type, 'ascii'); const crcB = Buffer.alloc(4); crcB.writeUInt32BE(crc32png(Buffer.concat([typeB, data]))); return Buffer.concat([len, typeB, data, crcB]); };
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdrData = Buffer.alloc(13); ihdrData.writeUInt32BE(size, 0); ihdrData.writeUInt32BE(size, 4); ihdrData[8] = 8; ihdrData[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat())]);
  const rows = Buffer.concat(Array.from({ length: size }, () => row));
  const idat = zlib.deflateSync(rows);
  return Buffer.concat([sig, chunk('IHDR', ihdrData), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

const b64 = (buf) => Buffer.from(buf).toString('base64');

function buildPptx(title) {
  const e = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const NS = 'http://schemas.openxmlformats.org/';
  const CT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="${NS}package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`;
  const themeXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="${NS}drawingml/2006/main" name="Office Theme"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr lastClr="000000" val="windowText"/></a:dk1><a:lt1><a:sysClr lastClr="FFFFFF" val="window"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A9D18E"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:lumMod val="110000"/><a:satMod val="105000"/><a:tint val="67000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:lumMod val="105000"/><a:satMod val="109000"/><a:tint val="81000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:satMod val="103000"/><a:lumMod val="102000"/><a:tint val="94000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:lumMod val="99000"/><a:satMod val="120000"/><a:shade val="78000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln><a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln><a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst><a:outerShdw blurRad="57150" dist="19050" dir="5400000" algn="ctr" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="63000"/></a:srgbClr></a:outerShdw></a:effectLst></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/><a:satMod val="170000"/></a:schemeClr></a:solidFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="93000"/><a:satMod val="150000"/><a:shade val="98000"/><a:lumMod val="102000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="63000"/><a:satMod val="120000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="16200000" scaled="0"/></a:gradFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;
  const presXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:p="${NS}presentationml/2006/main" xmlns:a="${NS}drawingml/2006/main" xmlns:r="${NS}officeDocument/2006/relationships"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>`;
  const masterXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster xmlns:p="${NS}presentationml/2006/main" xmlns:a="${NS}drawingml/2006/main" xmlns:r="${NS}officeDocument/2006/relationships"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lstStyle/></p:titleStyle><p:bodyStyle><a:lstStyle/></p:bodyStyle><p:otherStyle><a:lstStyle/></p:otherStyle></p:txStyles></p:sldMaster>`;
  const layoutXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout xmlns:p="${NS}presentationml/2006/main" xmlns:a="${NS}drawingml/2006/main" xmlns:r="${NS}officeDocument/2006/relationships" type="blank"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMapOvr><a:masterClr/></p:clrMapOvr></p:sldLayout>`;
  const slideXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:p="${NS}presentationml/2006/main" xmlns:a="${NS}drawingml/2006/main" xmlns:r="${NS}officeDocument/2006/relationships"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="2" name="TextBox 1"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="274638"/><a:ext cx="8229600" cy="1143000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>${e(title)}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClr/></p:clrMapOvr></p:sld>`;
  const R = `${NS}officeDocument/2006/relationships`;
  return b64(buildZip([
    { name: '[Content_Types].xml',                        data: Buffer.from(CT, 'utf8') },
    { name: '_rels/.rels',                                data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${NS}package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`, 'utf8') },
    { name: 'ppt/presentation.xml',                       data: Buffer.from(presXml, 'utf8') },
    { name: 'ppt/_rels/presentation.xml.rels',            data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${NS}package/2006/relationships"><Relationship Id="rId1" Type="${R}/slideMaster" Target="slideMasters/slideMaster1.xml"/><Relationship Id="rId2" Type="${R}/slide" Target="slides/slide1.xml"/></Relationships>`, 'utf8') },
    { name: 'ppt/theme/theme1.xml',                       data: Buffer.from(themeXml, 'utf8') },
    { name: 'ppt/slideMasters/slideMaster1.xml',          data: Buffer.from(masterXml, 'utf8') },
    { name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${NS}package/2006/relationships"><Relationship Id="rId1" Type="${R}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="${R}/theme" Target="../theme/theme1.xml"/></Relationships>`, 'utf8') },
    { name: 'ppt/slideLayouts/slideLayout1.xml',          data: Buffer.from(layoutXml, 'utf8') },
    { name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${NS}package/2006/relationships"><Relationship Id="rId1" Type="${R}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`, 'utf8') },
    { name: 'ppt/slides/slide1.xml',                      data: Buffer.from(slideXml, 'utf8') },
    { name: 'ppt/slides/_rels/slide1.xml.rels',           data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${NS}package/2006/relationships"><Relationship Id="rId1" Type="${R}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`, 'utf8') },
  ]));
}

// ─── Pre-build attachment blobs once ─────────────────────────────────────────
console.log('Building attachment blobs…');
const BLOBS = {
  pdf:  b64(buildRawPdf('Gajha QA Migration Report')),
  docx: b64(buildDocx('Gajha QA Migration Document')),
  xlsx: buildXlsx(),
  pptx: buildPptx('Gajha QA Migration Deck'),
  zip: b64(buildZip([
    { name: 'migration-log.txt', data: Buffer.from('Gajha migration log\nStep 1: pre-scan\nStep 2: migrate\nStep 3: validate\n', 'utf8') },
    { name: 'user-map.csv', data: Buffer.from('Source,Dest\nalex@gajha.com,alex@newdomain.com\ngranger@gajha.com,granger@newdomain.com\n', 'utf8') },
  ])),
  png:  makeSolidColorPng(0, 120, 212),   // Microsoft blue
  png2: makeSolidColorPng(16, 124, 16),   // green
  png3: makeSolidColorPng(196, 49, 75),   // red
  txt:  Buffer.from('Gajha QA bulk test text file.\nLine 2: migration validation.\nLine 3: archive QA.\nLine 4: verify text content preserved.\n').toString('base64'),
  csv:  Buffer.from('Name,Email,Status\nAlex,alex@gajha.com,Active\nGranger,granger@gajha.com,Active\nMia,mia@gajha.com,Active\nHarry,harry@gajha.com,Active\nTaylor,Taylor@gajha.com,Active\n').toString('base64'),
  ics:  Buffer.from('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Gajha QA//EN\r\nBEGIN:VEVENT\r\nUID:qa-gajha-meet-001@gajha.com\r\nDTSTART:20230915T100000Z\r\nDTEND:20230915T110000Z\r\nSUMMARY:QA Migration Review\r\nDESCRIPTION:Monthly migration status review\r\nORGANIZER:mailto:granger@gajha.com\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n').toString('base64'),
};
console.log('Attachments ready.\n');

// ─── Subject templates ────────────────────────────────────────────────────────
const PROJECTS  = ['Phoenix', 'Thunderbird', 'Atlas', 'Orion', 'Nexus', 'Vertex', 'Horizon', 'Apex', 'Delta', 'Zephyr', 'Titan', 'Helios', 'Vega', 'Nova', 'Pulsar'];
const SYSTEMS   = ['Exchange Online', 'Azure AD', 'SharePoint', 'OneDrive', 'Teams', 'Power BI', 'Defender', 'Intune', 'Entra ID', 'CloudFuze'];
const TOPICS    = ['Migration', 'Archive', 'Validation', 'Compliance', 'Security', 'Backup', 'Sync', 'Provisioning', 'Deployment', 'Integration', 'Audit', 'Reporting'];
const DEPTS     = ['Engineering', 'Finance', 'Legal', 'HR', 'Sales', 'Marketing', 'Ops', 'Infra', 'Security', 'DevOps'];
const YEARS     = ['2019', '2020', '2021', '2022', '2023', '2024', '2025'];
const QUARTERS  = ['Q1', 'Q2', 'Q3', 'Q4'];
const MONTHS    = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKS     = Array.from({ length: 52 }, (_, i) => String(i + 1));
const EMOJIS    = ['🚀', '📧', '✅', '❌', '⚠️', '🔔', '📊', '📈', '💼', '🏆', '🎯', '🔥', '💡', '📌', '⏰', '🔄', '🛡️', '📋', '🗓️', '💬', '🎉', '👋', '💪', '🌟', '🍕', '🎊', '🥂', '🏅', '🎂', '😊'];
const FLAGS_TXT = ['[ACTION REQUIRED]', '[URGENT]', '[FYI]', '[EXTERNAL]', '[REMINDER]', '[FOLLOW UP]', '[IMPORTANT]', '[CONFIDENTIAL]', '[HIGH PRIORITY]', '[REVIEW NEEDED]', '[DEADLINE TODAY]', '[PLEASE READ]'];
const SUBJECT_TEMPLATES = [
  (i) => `${pick(PROJECTS, i)} Migration — Week ${pick(WEEKS, i)} Status Update`,
  (i) => `${pick(FLAGS_TXT, i)} ${pick(TOPICS, i)} review for ${pick(DEPTS, i)}`,
  (i) => `${pick(EMOJIS, i)} ${pick(PROJECTS, i)} ${pick(TOPICS, i)} — ${pick(QUARTERS, i)} ${pick(YEARS, i)}`,
  (i) => `RE: ${pick(PROJECTS, i)} — ${pick(TOPICS, i)} Update`,
  (i) => `FW: ${pick(SYSTEMS, i)} alert — ${pick(DEPTS, i)} team`,
  (i) => `${pick(QUARTERS, i)} ${pick(YEARS, i)} ${pick(DEPTS, i)} ${pick(TOPICS, i)} Plan`,
  (i) => `Daily Standup — ${pick(DEPTS, i)} Team — ${pick(YEARS, i)}`,
  (i) => `${pick(EMOJIS, i)} ${pick(FLAGS_TXT, i)} ${pick(SYSTEMS, i)} ${pick(TOPICS, i)}`,
  (i) => `Budget Approval: ${pick(PROJECTS, i)} ${pick(YEARS, i)}`,
  (i) => `Incident Report: ${pick(SYSTEMS, i)} — ${pick(TOPICS, i)} failure`,
  (i) => `${pick(PROJECTS, i)} go-live confirmed — ${pick(TOPICS, i)} sign-off needed`,
  (i) => `${pick(DEPTS, i)} All-Hands ${pick(QUARTERS, i)} ${pick(YEARS, i)} recap`,
  (i) => `New policy: ${pick(TOPICS, i)} for ${pick(DEPTS, i)} — effective ${pick(YEARS, i)}`,
  (i) => `${pick(EMOJIS, i)} Reminder: ${pick(TOPICS, i)} deadline — ${pick(DEPTS, i)}`,
  (i) => `Interview feedback: ${pick(DEPTS, i)} engineer candidate`,
  (i) => `OOO: ${pick(SENDERS, i).name} — ${pick(MONTHS, i)} ${pick(YEARS, i)}`,
  (i) => `Ticket #${(i * 137 + 1337) % 99999}: ${pick(SYSTEMS, i)} ${pick(TOPICS, i)} issue`,
  (i) => `Onboarding checklist — ${pick(DEPTS, i)} new hire ${pick(YEARS, i)}`,
  (i) => `${pick(FLAGS_TXT, i)}: ${pick(PROJECTS, i)} launch delayed — stakeholder update`,
  (i) => `${pick(EMOJIS, i)} ${pick(PROJECTS, i)} ${pick(QUARTERS, i)} review — highlights`,
  (i) => `Meeting notes: ${pick(DEPTS, i)} sync ${pick(YEARS, i)}`,
  (i) => `Access request: ${pick(SENDERS, i).name} → ${pick(SYSTEMS, i)}`,
  (i) => `${pick(TOPICS, i)} report — ${pick(SYSTEMS, i)} — week ${pick(WEEKS, i)}`,
  (i) => `Vendor evaluation: ${pick(PROJECTS, i)} ${pick(YEARS, i)}`,
  (i) => `${pick(EMOJIS, i)} Happy Birthday ${pick(SENDERS, i).name}! 🎂🎉`,
  (i) => `Team lunch: ${pick(DEPTS, i)} — please RSVP`,
  (i) => `${pick(PROJECTS, i)} cost analysis — ${pick(QUARTERS, i)} ${pick(YEARS, i)}`,
  (i) => `Security scan results — ${pick(SYSTEMS, i)} — ${pick(YEARS, i)}`,
  (i) => `${pick(FLAGS_TXT, i)} Performance review: ${pick(DEPTS, i)} ${pick(YEARS, i)}`,
  (i) => `Holiday schedule ${pick(YEARS, i)} — ${pick(DEPTS, i)}`,
  (i) => `New feature request: ${pick(SYSTEMS, i)} — ${pick(TOPICS, i)}`,
  (i) => `${pick(EMOJIS, i)} Sprint ${(i % 30) + 1} retrospective — ${pick(DEPTS, i)}`,
  (i) => `Expense report: ${pick(SENDERS, i).name} — ${pick(MONTHS, i)} ${pick(YEARS, i)}`,
  (i) => `${pick(PROJECTS, i)} handover document — ${pick(TOPICS, i)}`,
  (i) => `SLA breach: ${pick(SYSTEMS, i)} — ${pick(DEPTS, i)} escalation`,
  (i) => `${pick(EMOJIS, i)} Congratulations on ${pick(TOPICS, i)} completion! 🎊`,
  (i) => `Risk register update — ${pick(PROJECTS, i)} ${pick(YEARS, i)}`,
  (i) => `Cloud cost optimisation — ${pick(SYSTEMS, i)} ${pick(QUARTERS, i)}`,
  (i) => `${pick(FLAGS_TXT, i)} Legal review: ${pick(PROJECTS, i)} contract`,
  (i) => `API rate limit exceeded — ${pick(SYSTEMS, i)} ${pick(TOPICS, i)}`,
  (i) => `${pick(EMOJIS, i)} ${pick(DEPTS, i)} hackathon ${pick(YEARS, i)} — results 🏅`,
  (i) => `Data retention policy — ${pick(TOPICS, i)} for ${pick(DEPTS, i)}`,
  (i) => `Patch Tuesday: ${pick(SYSTEMS, i)} updates — ${pick(YEARS, i)}`,
  (i) => `${pick(EMOJIS, i)} ${pick(PROJECTS, i)} beta testing invite — limited seats`,
  (i) => `Invoice #${(i * 251 + 5001) % 90000}: ${pick(PROJECTS, i)} services ${pick(YEARS, i)}`,
  (i) => `Employee survey: ${pick(DEPTS, i)} engagement ${pick(QUARTERS, i)} ${pick(YEARS, i)}`,
  (i) => `${pick(FLAGS_TXT, i)} Password expiry: change required within 7 days`,
  (i) => `Monitoring alert: ${pick(SYSTEMS, i)} CPU > 90% — ${pick(DEPTS, i)}`,
  (i) => `${pick(EMOJIS, i)} Release notes: ${pick(SYSTEMS, i)} v${(i % 10) + 1}.${(i % 5) + 1}.0`,
  (i) => `Training material: ${pick(TOPICS, i)} for ${pick(DEPTS, i)} ${pick(YEARS, i)}`,
  // Unicode / multilingual
  (i) => `📢 Важное обновление: ${pick(PROJECTS, i)} — ${pick(TOPICS, i)}`,
  (i) => `紧急通知: ${pick(SYSTEMS, i)} ${pick(TOPICS, i)} — ${pick(QUARTERS, i)}`,
  (i) => `إشعار: ${pick(PROJECTS, i)} ${pick(TOPICS, i)} — ${pick(YEARS, i)}`,
  (i) => `${pick(EMOJIS, i)} Long subject line test — ${pick(PROJECTS, i)} ${pick(TOPICS, i)} for ${pick(DEPTS, i)} team in ${pick(QUARTERS, i)} ${pick(YEARS, i)} review cycle`,
  (i) => ``,  // empty subject
  (i) => `RE: RE: RE: ${pick(PROJECTS, i)} — ${pick(TOPICS, i)} chain`,
  (i) => `FW: FW: ${pick(FLAGS_TXT, i)} ${pick(SYSTEMS, i)} ${pick(TOPICS, i)}`,
];

// ─── URL / link pool ──────────────────────────────────────────────────────────
const LINK_POOL = [
  '<a href="https://learn.microsoft.com/en-us/exchange">Exchange Online Docs</a>',
  '<a href="https://www.cloudfuze.com">CloudFuze Migration Platform</a>',
  '<a href="https://admin.microsoft.com">Microsoft 365 Admin Center</a>',
  '<a href="https://portal.azure.com">Azure Portal</a>',
  '<a href="https://outlook.office.com">Outlook Web App</a>',
  '<a href="https://admin.google.com">Google Workspace Admin</a>',
  '<a href="https://learn.microsoft.com/en-us/graph/api/overview">Graph API Docs</a>',
  '<a href="https://support.microsoft.com">Microsoft Support</a>',
  '<a href="https://teams.microsoft.com">Microsoft Teams</a>',
  '<a href="https://github.com/microsoft/microsoft-graph-docs">Graph SDK GitHub</a>',
  '<a href="https://zoom.us/j/123456789">Zoom Meeting</a>',
  '<a href="https://docs.google.com/document/d/abc123">Google Doc</a>',
  '<a href="https://sharepoint.com/sites/gajhaqateam">SharePoint Site</a>',
  '<a href="https://onedrive.live.com/view?id=xyz">OneDrive File</a>',
  '<a href="https://jira.gajha.com/browse/QA-1234">JIRA Ticket QA-1234</a>',
  '<a href="https://confluence.gajha.com/wiki/spaces/QA">Confluence Wiki</a>',
  '<a href="https://app.slack.com/client/gajha">Slack Channel</a>',
  '<a href="https://calendar.google.com/r/week">Google Calendar</a>',
];
const PLAIN_URLS = [
  'https://learn.microsoft.com/en-us/exchange',
  'https://www.cloudfuze.com',
  'https://portal.azure.com',
  'https://teams.microsoft.com',
  'https://zoom.us/j/987654321',
  'https://jira.gajha.com/browse/QA-5678',
  'https://onedrive.live.com/view?id=abc',
  'https://sharepoint.com/sites/gajhaqateam',
];
function pickLinks(i, n = 2) { return Array.from({ length: n }, (_, j) => LINK_POOL[(i + j) % LINK_POOL.length]).join(' | '); }
function pickUrl(i) { return PLAIN_URLS[i % PLAIN_URLS.length]; }

// ─── Sticker / inline emoji image (data URI in HTML) ─────────────────────────
// A tiny coloured square passed as inline style background – mimics sticker visual
function stickerImg(i) {
  const colours = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', '#98D8C8', '#F7DC6F', '#BB8FCE', '#82E0AA'];
  const emojis  = ['🎉', '🚀', '🔥', '💡', '✅', '❤️', '🌟', '🎯'];
  const c = colours[i % colours.length];
  const e = emojis[i % emojis.length];
  return `<span style="display:inline-block;background:${c};border-radius:8px;padding:4px 10px;font-size:20px;line-height:1.4">${e}</span>`;
}

// ─── HTML body templates ──────────────────────────────────────────────────────
function htmlBody(i, subject) {
  const t = i % 15;
  if (t === 0) return `<html><body style="font-family:Calibri,sans-serif;font-size:14px">
    <p>Hi ${pick(ALL_USERS, i).name},</p>
    <p>Please review the details below regarding <strong>${subject}</strong>.</p>
    <ul><li>Item 1: Pre-scan complete ✅</li><li>Item 2: Migration in progress ⏳</li><li>Item 3: Validation pending 🔍</li></ul>
    <p>References: ${pickLinks(i)}</p>
    <p>— ${pick(SENDERS, i).name}</p>
  </body></html>`;
  if (t === 1) return `<html><body style="font-family:Calibri,sans-serif;font-size:14px">
    <h2 style="color:#0078D4">${subject}</h2>
    <p>Summary table:</p>
    <table style="border-collapse:collapse;font-size:13px">
      <tr style="background:#dce6f1"><th style="border:1px solid #bbb;padding:4px 10px">Metric</th><th style="border:1px solid #bbb;padding:4px 10px">Value</th><th style="border:1px solid #bbb;padding:4px 10px">Status</th></tr>
      <tr><td style="border:1px solid #bbb;padding:4px 10px">Messages</td><td style="border:1px solid #bbb;padding:4px 10px">${(i % 500) + 50}</td><td style="border:1px solid #bbb;padding:4px 10px">✅ OK</td></tr>
      <tr><td style="border:1px solid #bbb;padding:4px 10px">Folders</td><td style="border:1px solid #bbb;padding:4px 10px">${(i % 20) + 3}</td><td style="border:1px solid #bbb;padding:4px 10px">✅ OK</td></tr>
      <tr><td style="border:1px solid #bbb;padding:4px 10px">Errors</td><td style="border:1px solid #bbb;padding:4px 10px">0</td><td style="border:1px solid #bbb;padding:4px 10px">✅ OK</td></tr>
    </table>
    <p>More info: ${pickLinks(i, 3)}</p>
  </body></html>`;
  if (t === 2) return `<html><body style="font-family:Calibri,sans-serif;font-size:14px">
    <p>🚀 <strong>Update on ${subject}</strong></p>
    <blockquote style="border-left:4px solid #0078D4;padding-left:12px;color:#333">
      Previously: migration was scheduled for ${pick(MONTHS, i)} ${pick(YEARS, i)}.<br/>
      Now: ahead of schedule — completed ${(i % 30) + 1} days early! 🎉
    </blockquote>
    <p>Action items for <strong>${pick(DEPTS, i)} team</strong>:</p>
    <ol><li>Verify mailbox access</li><li>Run validation agent</li><li>Sign off in JIRA: ${pickLinks(i + 4, 1)}</li></ol>
    <p>Dashboard: ${pickLinks(i)}</p>
  </body></html>`;
  if (t === 3) return `<html><body style="font-family:Calibri,sans-serif;font-size:14px">
    <p>⚠️ <span style="color:#cc0000"><strong>Alert: ${subject}</strong></span></p>
    <p>The following issue was detected on <code style="background:#f4f4f4;padding:2px 6px">${pick(SYSTEMS, i)}</code>:</p>
    <p style="background:#fff3cd;border:1px solid #ffc107;padding:8px 12px;border-radius:4px">Error: ${pick(TOPICS, i)} process failed at step ${(i % 5) + 1}. Retry count: ${(i % 3) + 1}. Status: DEGRADED.</p>
    <p>Please investigate. Escalation contact: <a href="mailto:${pick(SENDERS, i + 1).address}">${pick(SENDERS, i + 1).name}</a></p>
    <p>Runbook: ${pickLinks(i)}</p>
  </body></html>`;
  if (t === 4) return `<html><body style="font-family:Calibri,sans-serif;font-size:14px">
    <p>Hi all 👋</p>
    <p>Here's the ${pick(QUARTERS, i)} ${pick(YEARS, i)} recap for <strong>${pick(DEPTS, i)}</strong>:</p>
    <ul>
      <li>✅ ${pick(TOPICS, i)} completed on schedule</li>
      <li>📊 ${(i % 100) + 50} items processed, ${(i % 5)} errors</li>
      <li>🏆 Top performer: <strong>${pick(SENDERS, i).name}</strong></li>
      <li>🔔 Next milestone: ${pick(TOPICS, i + 1)} by end of ${pick(MONTHS, i + 1)}</li>
    </ul>
    <p>Full report: ${pickLinks(i)}</p>
  </body></html>`;
  if (t === 5) return `<html><body style="font-family:Calibri,sans-serif;font-size:14px">
    <p>Following up on our earlier discussion about <strong>${subject}</strong>.</p>
    <p>Key decisions made:</p>
    <table style="border-collapse:collapse;font-size:13px">
      <tr style="background:#e2efda"><th style="border:1px solid #bbb;padding:4px 10px">Decision</th><th style="border:1px solid #bbb;padding:4px 10px">Owner</th><th style="border:1px solid #bbb;padding:4px 10px">Due</th></tr>
      <tr><td style="border:1px solid #bbb;padding:4px 10px">${pick(TOPICS, i)} approach</td><td style="border:1px solid #bbb;padding:4px 10px">${pick(SENDERS, i).name}</td><td style="border:1px solid #bbb;padding:4px 10px">${pick(MONTHS, i + 1)} 15</td></tr>
      <tr><td style="border:1px solid #bbb;padding:4px 10px">Vendor selection</td><td style="border:1px solid #bbb;padding:4px 10px">${pick(SENDERS, i + 1).name}</td><td style="border:1px solid #bbb;padding:4px 10px">${pick(MONTHS, i + 2)} 1</td></tr>
    </table>
    <p>More: ${pickLinks(i)}</p>
  </body></html>`;
  if (t === 6) return `<html><body style="font-family:Calibri,sans-serif;font-size:14px">
    <p>${pick(EMOJIS, i)} <strong>${subject}</strong></p>
    <p style="background:#d4edda;border:1px solid #c3e6cb;padding:8px 12px;border-radius:4px">✅ <strong>COMPLETED SUCCESSFULLY</strong> — All ${(i % 200) + 50} items processed, 0 errors.</p>
    <p>Validation results:</p>
    <ul><li>Folder count: <strong>${(i % 20) + 5}/${(i % 20) + 5}</strong> ✅</li><li>Message count: <strong>${(i % 500) + 100}/${(i % 500) + 100}</strong> ✅</li><li>Attachment integrity: <strong>PASS</strong> ✅</li><li>Thread chains: <strong>${(i % 50) + 10}</strong> verified ✅</li></ul>
    <p>Signed off by: <strong>${pick(SENDERS, i).name}</strong> | Platform: ${pickLinks(i, 1)}</p>
  </body></html>`;
  if (t === 7) return `<html><body style="font-family:Calibri,sans-serif;font-size:14px">
    <p>Dear ${pick(ALL_USERS, i).name},</p>
    <p>This is a <em>formal notification</em> regarding <strong>${subject}</strong>.</p>
    <p>Please take note of the following <span style="color:#dc3545">important</span> information:</p>
    <p style="background:#f8d7da;border:1px solid #f5c6cb;padding:8px 12px;border-radius:4px">⚠️ Action required by <strong>${pick(MONTHS, i)} ${(i % 28) + 1}, ${pick(YEARS, i)}</strong>. Non-compliance may result in access restriction.</p>
    <p>Contact <a href="mailto:${pick(SENDERS, i).address}">${pick(SENDERS, i).name}</a> for questions.</p>
    <p>Policy reference: ${pickLinks(i)}</p>
  </body></html>`;
  if (t === 8) return `<html><body style="font-family:Calibri,sans-serif;font-size:14px">
    <p>Hi team 😊 ${stickerImg(i)}</p>
    <p>Quick update on <strong>${subject}</strong> — everything is on track! 🎯</p>
    <ul>
      <li>📅 Timeline: on schedule ✅</li>
      <li>💰 Budget: within limits ✅</li>
      <li>👥 Team: ${(i % 10) + 3} members active ✅</li>
      <li>🔧 Technical: ${(i % 3) === 0 ? 'minor issue being addressed ⚠️' : 'all systems green ✅'}</li>
    </ul>
    <p>Next sync: ${pick(MONTHS, i + 1)} ${(i % 28) + 1}. Join via: ${pickLinks(i, 1)}</p>
    <p>Cheers! 🥂 ${stickerImg(i + 2)}</p>
  </body></html>`;
  if (t === 9) return `<html><body style="font-family:Calibri,sans-serif;font-size:14px">
    <p><strong>STANDUP NOTES — ${pick(DEPTS, i).toUpperCase()} TEAM</strong></p>
    <hr style="border:none;border-top:1px solid #ccc"/>
    <p><strong>${pick(SENDERS, i).name}:</strong> Completed ${pick(TOPICS, i)} review. Will start ${pick(TOPICS, i + 1)} today. No blockers.</p>
    <p><strong>${pick(SENDERS, i + 1).name}:</strong> ${pick(SYSTEMS, i)} configuration in progress. ETA: EOD. Blocker: waiting on credentials from ${pick(DEPTS, i + 1)}.</p>
    <p><strong>${pick(SENDERS, i + 2).name}:</strong> Code review done. Merging ${pick(PROJECTS, i)} changes. No blockers.</p>
    <p><strong>Action items:</strong> ${pick(SENDERS, i).name} to follow up on credentials by noon.</p>
    <p>Sprint board: ${pickLinks(i, 1)}</p>
  </body></html>`;
  if (t === 10) return `<html><body style="font-family:Calibri,sans-serif;font-size:14px">
    <p>Forwarding this for your awareness.</p>
    <p><strong>Original from:</strong> ${pick(SENDERS, i + 3).name} | <strong>Subject:</strong> ${subject}</p>
    <hr style="border:none;border-top:1px solid #ccc;margin:8px 0"/>
    <p>${pick(TOPICS, i)} results attached. Key highlight: ${(i % 5) === 0 ? 'critical issue found — see highlighted row' : 'all metrics within acceptable range'}.</p>
    <p>Please review and confirm by <strong>${pick(MONTHS, i)} ${(i % 28) + 1}</strong>.</p>
    <p>Additional context: ${pickLinks(i)}</p>
  </body></html>`;
  if (t === 11) return `<html><body style="font-family:Calibri,sans-serif;font-size:14px">
    <p>🎉 Great news about <strong>${subject}</strong>! ${stickerImg(i + 1)}</p>
    <p>The team has done an amazing job 💪 finishing this on time.</p>
    <p>Highlights: 🚀 Performance up 23% | 📉 Errors down 91% | 💰 Saved $${(i * 17 + 500) % 50000} | ⏱️ ${(i % 30) + 5}% faster</p>
    <p>Kudos to: ${pick(SENDERS, i).name} 🌟, ${pick(SENDERS, i + 1).name} 🌟, ${pick(SENDERS, i + 2).name} 🌟</p>
    <p>Next steps: 🔔 Schedule retrospective | 📋 Update runbook | 🔄 Plan next sprint</p>
    <p>Celebrate at team lunch 🍕 on ${pick(MONTHS, i)} ${(i % 28) + 1}! RSVP: ${pickLinks(i, 1)}</p>
    <p>${stickerImg(i + 3)} ${stickerImg(i + 5)}</p>
  </body></html>`;
  if (t === 12) return `<html><body style="font-family:Calibri,sans-serif;font-size:14px">
    <p>Mixed language test for <strong>${subject}</strong>:</p>
    <p>English: The migration is complete and all data has been validated.</p>
    <p>Русский: Миграция завершена успешно. Все данные проверены.</p>
    <p>中文: 迁移已完成，所有数据已验证。</p>
    <p>العربية: اكتمل الترحيل وتم التحقق من جميع البيانات.</p>
    <p>日本語: 移行が完了し、すべてのデータが検証されました。</p>
    <p>Reference: ${pickLinks(i)}</p>
  </body></html>`;
  if (t === 13) return `<html><body style="font-family:Calibri,sans-serif;font-size:14px">
    <p><strong>${subject}</strong></p>
    <p>Here are the plain URLs for reference (not hyperlinked):</p>
    <p>${pickUrl(i)}</p>
    <p>${pickUrl(i + 1)}</p>
    <p>${pickUrl(i + 2)}</p>
    <p>And formatted links: ${pickLinks(i, 3)}</p>
    <p>Meeting link: <a href="https://zoom.us/j/${(i * 13 + 10000) % 999999}">Join Zoom Call</a></p>
    <p>OneDrive: <a href="https://onedrive.live.com/view?id=gajha${i}">View shared file</a></p>
  </body></html>`;
  // t === 14: large body ~3KB with lots of text content
  return `<html><body style="font-family:Calibri,sans-serif;font-size:14px">
    <h3>${subject}</h3>
    <p>${pick(DEPTS, i)} team — full ${pick(TOPICS, i)} report for ${pick(QUARTERS, i)} ${pick(YEARS, i)}.</p>
    <p><strong>Executive Summary:</strong> The ${pick(PROJECTS, i)} initiative progressed significantly this quarter. The ${pick(TOPICS, i)} workstream delivered ${(i % 20) + 5} key milestones on schedule. Team composition included ${(i % 8) + 4} engineers, ${(i % 3) + 1} architects, and ${(i % 2) + 1} project managers.</p>
    <p><strong>Technical Details:</strong> ${pick(SYSTEMS, i)} was upgraded to support the new ${pick(TOPICS, i)} requirements. Configuration changes were applied across ${(i % 15) + 3} tenant environments. No data loss was recorded. Validation coverage reached ${(i % 15) + 85}%.</p>
    <p><strong>Risk Register:</strong></p>
    <ul><li>Risk 1: ${pick(SYSTEMS, i)} throttle — Mitigation: concurrency reduced to 4 workers</li><li>Risk 2: Attachment encoding — Mitigation: SHA-256 hash verification enabled</li><li>Risk 3: Thread chain integrity — Mitigation: internetMessageId tracking</li></ul>
    <p><strong>Next Steps:</strong> ${pick(SENDERS, i).name} to complete ${pick(TOPICS, i + 1)} sign-off by ${pick(MONTHS, i + 1)} ${(i % 28) + 1}.</p>
    <p>Resources: ${pickLinks(i, 4)}</p>
    <p>— ${pick(SENDERS, i).name} | ${pick(DEPTS, i)} | ${pick(YEARS, i)}</p>
  </body></html>`;
}

function plainBody(i, subject) {
  const t = i % 6;
  if (t === 0) return `Hi team,\n\nUpdate on: ${subject}\n\nStatus: ${['In Progress', 'Complete', 'Pending Review', 'Blocked', 'On Hold'][i % 5]}\nOwner: ${pick(SENDERS, i).name}\nDeadline: ${pick(MONTHS, i)} ${(i % 28) + 1}, ${pick(YEARS, i)}\n\nAction required: Please respond by EOD.\n\nRegards,\n${pick(SENDERS, i).name}`;
  if (t === 1) return `${subject}\n${'='.repeat(Math.min(subject.length || 20, 60))}\n\nThis email is part of QA bulk data seeding for migration testing.\n\nFolder: Inbox\nTimestamp: backdated for archive testing\nScenario: ${pick(TOPICS, i)} - ${pick(DEPTS, i)}\n\nAll content is synthetic test data. No action required.\n\n-- ${pick(SENDERS, i).name}`;
  if (t === 2) return `MEETING NOTES\n\n${subject}\n\nAttendees: ${[pick(SENDERS, i), pick(SENDERS, i + 1), pick(SENDERS, i + 2)].map((s) => s.name).join(', ')}\n\nKey decisions:\n1. ${pick(TOPICS, i)} approach approved\n2. ${pick(PROJECTS, i)} timeline confirmed\n3. Budget: within ${(i % 30) + 10}% of estimate\n\nNext steps:\n- ${pick(SENDERS, i).name}: complete ${pick(TOPICS, i + 1)} by ${pick(MONTHS, i)}\n- ${pick(SENDERS, i + 1).name}: review ${pick(SYSTEMS, i)} config\n\nNext meeting: ${pick(MONTHS, i + 1)} ${(i % 28) + 1}`;
  if (t === 3) return `ALERT: ${subject}\n\nSeverity: ${['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'][i % 4]}\nSystem: ${pick(SYSTEMS, i)}\nTime: ${pick(YEARS, i)}-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}\n\nDescription:\n${pick(TOPICS, i)} process reported anomaly.\nError code: ERR-${(i * 7 + 1001) % 9999}\nRetry attempts: ${(i % 3) + 1}\nCurrent status: ${['RESOLVED', 'INVESTIGATING', 'ESCALATED'][i % 3]}\n\nContact ${pick(SENDERS, i).name} for details.`;
  if (t === 4) return `Hi ${pick(ALL_USERS, i).name},\n\nQuick note on ${subject}.\n\nI wanted to flag that ${pick(TOPICS, i)} is progressing well. ${pick(PROJECTS, i)} is ${(i % 20) + 80}% complete as of today.\n\nCan you confirm receipt and let me know if you need anything?\n\nLinks:\n${pickUrl(i)}\n${pickUrl(i + 1)}\n\nThanks,\n${pick(SENDERS, i).name}`;
  return `${pick(EMOJIS, i)} ${subject}\n\nMultilingual test content:\nEnglish: Migration complete.\nРусский: Миграция завершена.\n中文: 迁移完成。\n日本語: 移行完了。\n\nEmoji stress: 🚀🎉💡🔥✅❌⚠️🔔📊📈💼🏆🎯🔄🛡️📋🗓️💬🌟💪\n\nURL check:\n${pickUrl(i)}\n${pickUrl(i + 2)}\n\n— ${pick(SENDERS, i).name}`;
}

// ─── Attachment selector ──────────────────────────────────────────────────────
function getAttachments(i) {
  const t = i % 22;
  if (t === 0)  return [{ name: 'report.pdf', contentType: 'application/pdf', contentBytes: BLOBS.pdf }];
  if (t === 1)  return [{ name: 'document.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', contentBytes: BLOBS.docx }];
  if (t === 2)  return [{ name: 'tracker.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', contentBytes: BLOBS.xlsx }];
  if (t === 3)  return [{ name: 'presentation.pptx', contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', contentBytes: BLOBS.pptx }];
  if (t === 4)  return [{ name: 'logs-bundle.zip', contentType: 'application/zip', contentBytes: BLOBS.zip }];
  if (t === 5)  return [{ name: 'notes.txt', contentType: 'text/plain', contentBytes: BLOBS.txt }];
  if (t === 6)  return [{ name: 'users.csv', contentType: 'text/csv', contentBytes: BLOBS.csv }];
  if (t === 7)  return [{ name: 'screenshot.png', contentType: 'image/png', contentBytes: BLOBS.png }];
  if (t === 8)  return [{ name: 'green-badge.png', contentType: 'image/png', contentBytes: BLOBS.png2 }];
  if (t === 9)  return [{ name: 'alert-icon.png', contentType: 'image/png', contentBytes: BLOBS.png3 }];
  if (t === 10) return [{ name: 'meeting-invite.ics', contentType: 'text/calendar', contentBytes: BLOBS.ics }];
  if (t === 11) return [{ name: 'report.pdf', contentType: 'application/pdf', contentBytes: BLOBS.pdf }, { name: 'tracker.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', contentBytes: BLOBS.xlsx }];
  if (t === 12) return [{ name: 'document.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', contentBytes: BLOBS.docx }, { name: 'notes.txt', contentType: 'text/plain', contentBytes: BLOBS.txt }];
  if (t === 13) return [{ name: 'presentation.pptx', contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', contentBytes: BLOBS.pptx }, { name: 'screenshot.png', contentType: 'image/png', contentBytes: BLOBS.png }];
  if (t === 14) return [{ name: 'logs-bundle.zip', contentType: 'application/zip', contentBytes: BLOBS.zip }, { name: 'users.csv', contentType: 'text/csv', contentBytes: BLOBS.csv }, { name: 'notes.txt', contentType: 'text/plain', contentBytes: BLOBS.txt }];
  if (t === 15) return [{ name: 'report.pdf', contentType: 'application/pdf', contentBytes: BLOBS.pdf }, { name: 'document.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', contentBytes: BLOBS.docx }, { name: 'screenshot.png', contentType: 'image/png', contentBytes: BLOBS.png }];
  return undefined; // t 16-21: no attachment (~27% no attachment)
}

// ─── CC / BCC / TO patterns ───────────────────────────────────────────────────
const CC_PATTERNS = [
  [],
  [ea(U.granger)],
  [ea(U.mia), ea(U.harry)],
  [ea(U.taylor), ea(U.martin)],
  [ea(U.granger), ea(U.mia), ea(U.harry)],
  [ea(U.wilson), ea(U.clark), ea(U.kim)],
  [ea(U.taylor), ea(U.granger)],
  [ea(U.mia), ea(U.taylor), ea(U.wilson), ea(U.clark)],
  [ea(U.harry), ea(U.kim)],
  [ea(U.granger), ea(U.mia), ea(U.harry), ea(U.taylor), ea(U.martin)],
  [ea(U.martin), ea(U.wilson)],
  [ea(U.clark), ea(U.kim), ea(U.granger)],
];
const BCC_PATTERNS = [
  undefined,
  [ea(U.kim)],
  undefined,
  [ea(U.wilson)],
  undefined,
  [ea(U.granger)],
  undefined,
  [ea(U.clark)],
  undefined,
  [ea(U.martin)],
  undefined,
  undefined,
];
const TO_PATTERNS = [
  [ea(U.alex)],
  [ea(U.alex), ea(U.mia)],
  [ea(U.alex), ea(U.harry)],
  [ea(U.alex), ea(U.granger), ea(U.taylor)],
  [ea(U.alex), ea(U.martin)],
  [ea(U.alex), ea(U.wilson), ea(U.clark)],
  [ea(U.alex), ea(U.mia), ea(U.harry), ea(U.taylor)],
  [ea(U.alex), ea(U.granger)],
  [ea(U.alex), ea(U.kim)],
  [ea(U.alex), ea(U.mia), ea(U.harry), ea(U.taylor), ea(U.granger), ea(U.wilson)],
  [ea(U.alex), ea(U.martin), ea(U.clark)],
  [ea(U.alex), ea(U.kim), ea(U.wilson), ea(U.clark), ea(U.martin), ea(U.granger), ea(U.mia), ea(U.harry), ea(U.taylor)],
];
const REPLY_TO_SENDERS = [U.granger, U.mia, U.harry, U.taylor, U.martin, U.wilson, U.clark, U.kim];

// ─── Message definition builder ───────────────────────────────────────────────
function buildMsgDef(globalIndex, opts = {}) {
  const i       = globalIndex;
  const subject = opts.subject !== undefined ? opts.subject : pick(SUBJECT_TEMPLATES, i)(i);
  const isHtml  = (i % 3) !== 2;
  const body    = isHtml
    ? { contentType: 'HTML', content: htmlBody(i, subject) }
    : { contentType: 'text', content: plainBody(i, subject) };

  const importance = i % 10 === 0 ? 'high' : i % 17 === 0 ? 'low' : 'normal';
  const flagStatus = i % 9 === 0 ? 'flagged' : i % 31 === 0 ? 'complete' : undefined;
  const isRead     = (i % 5) !== 0;   // 80% read
  const cats = (() => {
    if (i % 25 === 0) return ['Red Category', 'Blue Category'];
    if (i % 13 === 0) return ['Red Category'];
    if (i % 19 === 0) return ['Blue Category'];
    if (i % 23 === 0) return ['Green Category'];
    if (i % 37 === 0) return ['Purple Category'];
    if (i % 41 === 0) return ['Orange Category'];
    return undefined;
  })();

  // Reply-To differs from From on ~15% of messages
  const replyTo = (i % 7 === 0)
    ? [{ emailAddress: pick(REPLY_TO_SENDERS, i + 3) }]
    : undefined;

  const sender  = pick(SENDERS, i);
  const toList  = pick(TO_PATTERNS, i);
  const ccList  = pick(CC_PATTERNS, i);
  const bccList = pick(BCC_PATTERNS, i);
  const atts    = opts.attachments !== undefined ? opts.attachments : getAttachments(i);

  return {
    subject,
    body,
    importance,
    isRead,
    isDraft: false,
    from: { emailAddress: sender },
    toRecipients: toList,
    ccRecipients: ccList.length > 0 ? ccList : undefined,
    bccRecipients: bccList,
    replyTo,
    flag: flagStatus ? { flagStatus } : undefined,
    categories: cats,
    attachments: atts,
    internetMessageId: opts.internetMessageId,
    inReplyTo:         opts.inReplyTo,
    references:        opts.references,
  };
}

// ─── Thread chain generator (5–10 levels deep) ───────────────────────────────
const RUN_ID = Date.now().toString(36); // unique per run — prevents duplicate Message-IDs on re-runs
function generateThreadChains(chainCount, startIndex) {
  const all = [];
  let idx = startIndex;
  // Chain lengths: 5-10 levels per chain, rotating
  const chainLengths = [5, 6, 7, 8, 9, 10, 6, 7, 8, 5, 10, 9, 7, 6, 8];
  // Users who reply in threads (rotate through gajha users)
  const threadUsers = [U.granger, U.mia, U.harry, U.taylor, U.martin, U.wilson, U.clark, U.kim];

  for (let c = 0; c < chainCount; c++) {
    const len      = chainLengths[c % chainLengths.length];
    const chainId  = `${RUN_ID}-chain-gajha-${c + 1}`;
    const ids      = Array.from({ length: len }, (_, m) => `<${chainId}-m${m + 1}@gajha.com>`);
    const rootSubject = pick(SUBJECT_TEMPLATES, idx)(idx);
    // Spread chains evenly across 2019-2024
    const chainStartMs = OLD_START + (c / chainCount) * (OLD_END - OLD_START);

    for (let m = 0; m < len; m++) {
      // Each reply is 4 hours after the previous
      const received = new Date(chainStartMs + m * 4 * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      const replyUser = m === 0 ? pick(SENDERS, idx) : threadUsers[(c + m) % threadUsers.length];

      // Vary TO/CC in deeper replies to simulate real conversation dynamics
      const replyTo  = m === 0 ? pick(TO_PATTERNS, idx) : [ea(pick(threadUsers, c + m - 1))];
      const replyCc  = m > 1 ? pick(CC_PATTERNS, (idx + m) % CC_PATTERNS.length) : undefined;

      const def = buildMsgDef(idx, {
        subject: m === 0 ? rootSubject : `RE: ${rootSubject}`,
        // Attachments: on first message (c%3===0), on 3rd reply (c%2===0), on last reply
        attachments: (m === 0 && c % 3 === 0) ? getAttachments(idx)
          : (m === 2 && c % 2 === 0) ? getAttachments(idx + 1)
          : (m === len - 1 && c % 4 === 0) ? getAttachments(idx + 2)
          : undefined,
        internetMessageId: ids[m],
        inReplyTo:  m > 0 ? ids[m - 1] : undefined,
        references: m > 0 ? ids.slice(0, m).join(' ') : undefined,
      });

      // Override sender / recipients for thread replies
      def.from = { emailAddress: replyUser };
      def.toRecipients = replyTo;
      if (replyCc && replyCc.length > 0) def.ccRecipients = replyCc;
      def.receivedDateTime = received;
      def.sentDateTime     = sentFromReceived(received);
      all.push(def);
      idx++;
    }
  }
  return { messages: all, nextIndex: idx };
}

// ─── Concurrency pool ─────────────────────────────────────────────────────────
async function runPool(tasks, concurrency) {
  let i = 0, ok = 0, fail = 0;
  const total     = tasks.length;
  const startTime = Date.now();

  async function worker() {
    while (i < total) {
      const j = i++;
      try {
        await tasks[j]();
        ok++;
        if (ok % 200 === 0) {
          const elapsed = (Date.now() - startTime) / 1000;
          const rate    = ok / elapsed;
          const eta     = Math.round((total - ok) / rate);
          const pct     = Math.round(ok / total * 100);
          console.log(`  [${ok}/${total}] ${pct}% | ${rate.toFixed(1)} msg/s | ETA ~${Math.floor(eta / 60)}m ${eta % 60}s | failures: ${fail}`);
        }
      } catch (err) {
        fail++;
        if (fail <= 30) console.error(`  ✗ [${j}] ${err.message.substring(0, 100)}`);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  return { ok, fail };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const TOTAL = TOTAL_OLD + TOTAL_NEW;
  console.log(`Target: ${TARGET} | Folder: ${FOLDER}`);
  console.log(`Generating ${TOTAL} message definitions…`);

  // 1. Thread chains — avg 7.3 messages × 300 chains ≈ 2,190 messages
  const CHAIN_COUNT = 300;
  const { messages: threadMsgs, nextIndex } = generateThreadChains(CHAIN_COUNT, 0);
  console.log(`  ${threadMsgs.length} thread messages (${CHAIN_COUNT} chains, 5–10 levels deep)`);

  // 2. Old standalone messages (fills up to TOTAL_OLD)
  const oldStandaloneCount = TOTAL_OLD - threadMsgs.length;
  const oldStandalone = Array.from({ length: oldStandaloneCount }, (_, k) => {
    const idx = nextIndex + k;
    const def = buildMsgDef(idx);
    const rec = oldTs();
    def.receivedDateTime = rec;
    def.sentDateTime     = sentFromReceived(rec);
    return def;
  });
  console.log(`  ${oldStandaloneCount} standalone old messages (2019–2024)`);

  // 3. New messages (100, 2025-2026)
  const newMessages = Array.from({ length: TOTAL_NEW }, (_, k) => {
    const idx = nextIndex + oldStandaloneCount + k;
    const def = buildMsgDef(idx);
    const rec = newTs();
    def.receivedDateTime = rec;
    def.sentDateTime     = sentFromReceived(rec);
    return def;
  });
  console.log(`  ${TOTAL_NEW} new messages (2025–2026)\n`);

  const allMessages = [...threadMsgs, ...oldStandalone, ...newMessages];
  console.log(`Total: ${allMessages.length} messages | Concurrency: ${CONCURRENCY}`);
  console.log(`Estimated runtime: ~${Math.round(allMessages.length / (CONCURRENCY * 2.5))}–${Math.round(allMessages.length / (CONCURRENCY * 1.5))} seconds`);
  console.log(`Starting bulk creation…\n`);

  const tasks = allMessages.map((msg) => async () => {
    await outlookClient.createMessageInFolder(TARGET, FOLDER, msg);
  });

  const startTime = Date.now();
  const { ok, fail } = await runPool(tasks, CONCURRENCY);
  const elapsed = Math.round((Date.now() - startTime) / 1000);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Done in ${Math.floor(elapsed / 60)}m ${elapsed % 60}s`);
  console.log(`Created: ${ok}/${allMessages.length} (${fail} failed)`);
  console.log(`Old timestamps (2019–2024): ~${TOTAL_OLD}`);
  console.log(`New timestamps (2025–2026): ${TOTAL_NEW}`);
  console.log(`Thread chains: ${CHAIN_COUNT} × 5–10 levels deep`);
  console.log(`Attachments: PDF, DOCX, XLSX, PPTX, ZIP, PNG×3, TXT, CSV, ICS (multi-attach combos)`);
  console.log(`Users: ${ALL_USERS.map((u) => u.name).join(', ')}`);
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
