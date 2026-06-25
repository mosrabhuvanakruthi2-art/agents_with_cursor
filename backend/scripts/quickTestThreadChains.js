/**
 * quickTestThreadChains.js
 *
 * Seeds 6 email thread chains (58 total messages) for ron@qatestagent.com
 * across all 5 default Outlook folders.
 *
 * Chains:
 *   1  Project Phoenix — Migration Kickoff  (10 msgs, inbox)
 *   2  Bug Report: Archive Sync Failure     (12 msgs, inbox + sentitems)
 *   3  Compliance Audit Notice              ( 7 msgs, deleteditems)
 *   4  Weekly Migration Status — 15 Weeks   (15 msgs, inbox)
 *   5  Marketing Newsletter Spam            ( 6 msgs, junkemail)
 *   6  Q4 Planning Meeting                  ( 8 msgs, inbox + drafts)
 *
 * Threading via EWS extended properties:
 *   PR_INTERNET_MESSAGE_ID (0x1035) → internetMessageId
 *   PR_IN_REPLY_TO_ID      (0x1042) → inReplyTo
 *   PR_INTERNET_REFERENCES (0x1039) → references
 *
 * Usage: cd backend && node scripts/quickTestThreadChains.js
 */

'use strict';

require('../src/config/env');
const outlookClient = require('../src/clients/outlookClient');
const XLSX          = require('xlsx');

const TARGET = 'ron@qatestagent.com';

// ─── Users ────────────────────────────────────────────────────────────────────
const U = {
  ron:     { address: 'ron@qatestagent.com',       name: 'Ron QA' },
  granger: { address: 'Granger@qatestagent.com',   name: 'Granger QA' },
  alex:    { address: 'Alex@qatestagent.com',       name: 'Alex QA' },
  ben:     { address: 'ben@qatestagent.com',        name: 'Ben QA' },
  dan:     { address: 'dan@qatestagent.com',        name: 'Dan QA' },
  bt1:     { address: 'Blueteam1@qatestagent.com',  name: 'Blue Team 1' },
  bt2:     { address: 'Blueteam2@qatestagent.com',  name: 'Blue Team 2' },
  bt3:     { address: 'Blueteam3@cloudfuze.com',    name: 'Blue Team 3 (CloudFuze)' },
};
const ea  = (u) => ({ emailAddress: u });
const eas = (...us) => us.map(ea);

function addHours(iso, h) {
  return new Date(new Date(iso).getTime() + h * 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ─── CRC-32 + ZIP ─────────────────────────────────────────────────────────────
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC32_TABLE[(c ^ buf[i]) & 0xFF];
  return (c ^ 0xFFFFFFFF) >>> 0;
}
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n >>> 0, 0); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; };
function buildZip(files) {
  const parts = [], central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nb = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const lh = Buffer.concat([Buffer.from([0x50,0x4B,0x03,0x04]),u16(20),u16(0),u16(0),u16(0),u16(0),u32(crc),u32(data.length),u32(data.length),u16(nb.length),u16(0),nb]);
    central.push(Buffer.concat([Buffer.from([0x50,0x4B,0x01,0x02]),u16(20),u16(20),u16(0),u16(0),u16(0),u16(0),u32(crc),u32(data.length),u32(data.length),u16(nb.length),u16(0),u16(0),u16(0),u16(0),u32(0),u32(offset),nb]));
    parts.push(lh, data);
    offset += lh.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.concat([Buffer.from([0x50,0x4B,0x05,0x06]),u16(0),u16(0),u16(files.length),u16(files.length),u32(cd.length),u32(offset),u16(0)]);
  return Buffer.concat([...parts, cd, eocd]);
}

// ─── DOCX ─────────────────────────────────────────────────────────────────────
function buildDocx(title, bodyText) {
  const esc = (s) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return buildZip([
    { name: '[Content_Types].xml', data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>', 'utf8') },
    { name: '_rels/.rels', data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>', 'utf8') },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>', 'utf8') },
    { name: 'word/document.xml', data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:jc w:val="left"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="32"/></w:rPr><w:t>' + esc(title) + '</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">' + esc(bodyText) + '</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>', 'utf8') },
  ]);
}

// ─── PPTX ─────────────────────────────────────────────────────────────────────
function buildPptx(titleText) {
  const esc = (s) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const CT = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>';
  const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>';
  const presXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldSz cx="9144000" cy="6858000" type="screen4x3"/><p:notesSz cx="6858000" cy="9144000"/><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>';
  const presRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>';
  const masterXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lstStyle/></p:titleStyle><p:bodyStyle><a:lstStyle/></p:bodyStyle><p:otherStyle><a:lstStyle/></p:otherStyle></p:txStyles></p:sldMaster>';
  const masterRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>';
  const layoutXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" type="blank"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMapOvr><a:masterClr/></p:clrMapOvr></p:sldLayout>';
  const layoutRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>';
  const slideXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="274638"/><a:ext cx="8229600" cy="1143000"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>' + esc(titleText) + '</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClr/></p:clrMapOvr></p:sld>';
  const slideRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>';
  return buildZip([
    { name: '[Content_Types].xml',                           data: Buffer.from(CT,         'utf8') },
    { name: '_rels/.rels',                                   data: Buffer.from(rootRels,   'utf8') },
    { name: 'ppt/presentation.xml',                          data: Buffer.from(presXml,    'utf8') },
    { name: 'ppt/_rels/presentation.xml.rels',               data: Buffer.from(presRels,   'utf8') },
    { name: 'ppt/slideMasters/slideMaster1.xml',             data: Buffer.from(masterXml,  'utf8') },
    { name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels',  data: Buffer.from(masterRels, 'utf8') },
    { name: 'ppt/slideLayouts/slideLayout1.xml',             data: Buffer.from(layoutXml,  'utf8') },
    { name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels',  data: Buffer.from(layoutRels, 'utf8') },
    { name: 'ppt/slides/slide1.xml',                         data: Buffer.from(slideXml,   'utf8') },
    { name: 'ppt/slides/_rels/slide1.xml.rels',              data: Buffer.from(slideRels,  'utf8') },
  ]);
}

// ─── Raw PDF ──────────────────────────────────────────────────────────────────
function buildRawPdf(pages) {
  const esc = (s) => String(s||'').replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)').replace(/[^\x20-\x7E]/g,' ');
  const N=pages.length, CATALOG=1, PAGES_OBJ=2, FONT_OBJ=2*N+3;
  const pageNums=Array.from({length:N},(_,i)=>3+i);
  const streamNums=Array.from({length:N},(_,i)=>N+3+i);
  const streams=pages.map(({title,lines=[]})=>{
    const ops=['BT','/F1 16 Tf','20 TL','72 720 Td',`(${esc(title)}) Tj`,'/F1 9 Tf','16 TL','T*',`(${'-'.repeat(72)}) Tj`,'/F1 11 Tf','15 TL','T*'];
    for(const l of lines){ops.push(`(${esc(l)}) Tj`,'T*');}
    ops.push('ET');
    return ops.join('\n')+'\n';
  });
  const objs=new Map();
  objs.set(CATALOG,`${CATALOG} 0 obj\n<< /Type /Catalog /Pages ${PAGES_OBJ} 0 R >>\nendobj\n`);
  objs.set(PAGES_OBJ,`${PAGES_OBJ} 0 obj\n<< /Type /Pages /Kids [${pageNums.map(n=>`${n} 0 R`).join(' ')}] /Count ${N} >>\nendobj\n`);
  pageNums.forEach((n,i)=>objs.set(n,`${n} 0 obj\n<< /Type /Page /Parent ${PAGES_OBJ} 0 R /MediaBox [0 0 612 792]\n   /Contents ${streamNums[i]} 0 R /Resources << /Font << /F1 ${FONT_OBJ} 0 R >> >> >>\nendobj\n`));
  streamNums.forEach((n,i)=>{const s=streams[i];objs.set(n,`${n} 0 obj\n<< /Length ${Buffer.byteLength(s,'ascii')} >>\nstream\n${s}endstream\nendobj\n`);});
  objs.set(FONT_OBJ,`${FONT_OBJ} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n`);
  const header='%PDF-1.4\n';
  const allNums=Array.from({length:FONT_OBJ},(_,i)=>i+1);
  let off=Buffer.byteLength(header,'ascii');
  const offs=new Map();
  for(const n of allNums){offs.set(n,off);off+=Buffer.byteLength(objs.get(n),'ascii');}
  const pad=n=>String(n).padStart(10,'0');
  const xref=['xref',`0 ${FONT_OBJ+1}`,'0000000000 65535 f ',...allNums.map(n=>`${pad(offs.get(n))} 00000 n `)].join('\n')+'\n';
  const trailer=`trailer\n<< /Size ${FONT_OBJ+1} /Root ${CATALOG} 0 R >>\nstartxref\n${off}\n%%EOF\n`;
  return Buffer.concat([Buffer.from(header,'ascii'),...allNums.map(n=>Buffer.from(objs.get(n),'ascii')),Buffer.from(xref,'ascii'),Buffer.from(trailer,'ascii')]);
}

// ─── XLSX ─────────────────────────────────────────────────────────────────────
function buildXlsx(rows) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Migration Tracker');
  return XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
}

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAABjE+ibYAAAAASUVORK5CYII=';

// ─── Build all attachments once ───────────────────────────────────────────────
function buildAttachments() {
  const b64 = (buf) => Buffer.from(buf).toString('base64');

  const pdfPlan = buildRawPdf([{ title: 'Project Phoenix — Migration Plan v1.0', lines: [
    'Prepared by: Granger QA | CloudFuze Inc. | 2022-03-01',
    '', 'EXECUTIVE SUMMARY', '=================',
    'Full migration of ron@qatestagent.com (Exchange Online) to Gmail.',
    'Source: 187 messages, 23 folders  |  Target: ron@migrationn.com',
    '', 'MILESTONES', '==========',
    '1. Pre-scan and inventory     2022-03-01 to 2022-03-03',
    '2. Migration execution        2022-03-06 to 2022-03-10',
    '3. Post-migration validation  2022-03-11 to 2022-03-13',
    '4. Sign-off and closure       2022-03-14',
    '', 'RISKS', '=====',
    '- Large attachments (>20MB) require manual re-verification',
    '- Archive folder mapping: Outlook -> Gmail [Archive] label',
    '- Thread chain continuity across folder boundaries',
  ]}]);

  const pdfCompliance = buildRawPdf([{ title: 'Compliance Evidence Pack — Q2 2022', lines: [
    'Ref: COMP-2022-0601  |  Prepared by: Blue Team 3 (CloudFuze)',
    '', 'DATA RETENTION COMPLIANCE AUDIT',
    '================================',
    'Account: ron@qatestagent.com  |  Period: Q1-Q2 2022',
    '', 'FINDINGS', '========',
    'Item 1: Email retention policy     — COMPLIANT (7-year)',
    'Item 2: Archive configuration      — COMPLIANT',
    'Item 3: Data export capability     — COMPLIANT',
    'Item 4: Encryption at rest         — COMPLIANT',
    'Item 5: Access logging             — COMPLIANT',
    '', 'RESULT: NO ISSUES FOUND',
    '', 'Next audit scheduled: Q4 2022',
  ]}]);

  const pdfMidpoint = buildRawPdf([
    { title: 'Migration Status — Week 8 Midpoint Report', lines: [
      'Report Date: 2022-10-31  |  Author: Ben QA',
      '', 'PROGRESS SUMMARY', '================',
      'Total messages: 187  |  Migrated: 145 (77.5%)',
      'Pending: 42 (22.5%)  |  Errors: 0',
      '', 'FOLDER BREAKDOWN', '================',
      'Inbox:        47/47   (100%)   COMPLETE',
      'Sent Items:   23/23   (100%)   COMPLETE',
      'Drafts:       10/10   (100%)   COMPLETE',
      'Deleted:      12/12   (100%)   COMPLETE',
      'Junk:          8/8   (100%)   COMPLETE',
      'Custom [1-8]: 45/87   (51.7%) IN PROGRESS',
      '', 'ETA COMPLETION: Week 10 (2022-11-14)',
    ]},
    { title: 'Attachment Verification — Week 8', lines: [
      'PDF files:   23/23 verified',
      'DOCX files:  11/11 verified',
      'XLSX files:   8/8  verified',
      'PPTX files:   4/4  verified',
      'ZIP files:    3/3  verified',
      'PNG/JPG:     18/18 verified',
      'Large (>5MB): 2/4  verified — 2 PENDING re-check',
      '', 'Next: Full Tier B hash comparison on remaining 2 files',
    ]},
  ]);

  const docxAgenda = buildDocx('Q4 Planning Meeting — Agenda', [
    'Meeting: Q4 2023 Planning',
    'Date: October 15, 2023, 10:00 UTC',
    'Location: Conference Room A / Teams',
    '',
    'ATTENDEES',
    '=========',
    '- Granger QA (Chair)',
    '- Ron QA (Validation Track Lead)',
    '- Alex QA (Migration Track Lead)',
    '- Ben QA (Technical Lead)',
    '- Dan QA (Infrastructure)',
    '- Blue Team 1 and Blue Team 2',
    '- Blue Team 3 (CloudFuze, remote)',
    '',
    'AGENDA',
    '======',
    '1. Welcome and introductions               10 min',
    '2. Q3 review and lessons learned           20 min',
    '3. Q4 migration roadmap                    30 min',
    '4. Track presentations                     45 min',
    '   a. Validation track — Ron',
    '   b. Migration track — Alex',
    '   c. CloudFuze new features — Blue Team 3',
    '5. Resource allocation                     15 min',
    '6. Risk review                             10 min',
    '7. AOB and next steps                      10 min',
    '',
    'PRE-READS',
    '=========',
    '- Q3 retrospective deck (prior email)',
    '- Q4 planning deck (attached)',
    '- Risk register (SharePoint)',
  ].join('\n'));

  const docxTimeline = buildDocx('Migration Timeline — Project Phoenix', [
    'MIGRATION TIMELINE',
    '==================',
    '',
    'Phase 1: Pre-Migration (2022-02-28 to 2022-03-04)',
    '  - Source inventory and folder mapping',
    '  - EWS endpoint validation and app registration',
    '  - Pre-scan execution (187 messages discovered)',
    '',
    'Phase 2: Migration (2022-03-05 to 2022-03-10)',
    '  - Inbox migration         Day 1',
    '  - Sent Items migration    Day 1',
    '  - Drafts migration        Day 2',
    '  - Calendar migration      Day 2',
    '  - Custom folders          Days 3-5',
    '  - Attachment verification Day 5',
    '',
    'Phase 3: Post-Migration (2022-03-11 to 2022-03-14)',
    '  - Validation agent run (Tier A/B/C)',
    '  - Thread chain validation (163 conversations)',
    '  - Final sign-off',
    '',
    'RISKS',
    '=====',
    '  - Large attachments (>20 MB) need manual re-verification',
    '  - Archive folder mapping requires label check',
    '  - Conversation thread continuity across folders',
  ].join('\n'));

  const xlsxTracker = buildXlsx([
    ['#', 'Folder', 'Messages', 'Migrated', 'Pending', 'Errors', 'Status', 'Last Updated'],
    [1, 'Inbox',         47,  47,  0, 0, 'Complete',     '2022-09-19'],
    [2, 'Sent Items',    23,  23,  0, 0, 'Complete',     '2022-09-26'],
    [3, 'Drafts',        10,  10,  0, 0, 'Complete',     '2022-10-03'],
    [4, 'Deleted Items', 12,  12,  0, 0, 'Complete',     '2022-10-10'],
    [5, 'Junk Email',     8,   8,  0, 0, 'Complete',     '2022-10-10'],
    [6, 'Projects/Alpha',15,  15,  0, 0, 'Complete',     '2022-10-17'],
    [7, 'Projects/Beta', 22,  18,  4, 0, 'In Progress',  '2022-10-24'],
    [8, 'Archive/2021',  31,   0, 31, 0, 'Pending',      '-'],
    ['', 'TOTAL',       168, 133, 35, 0, '79.2% complete','2022-10-24'],
  ]);

  const pptxKickoff = buildPptx('Project Phoenix — Migration Kickoff (CloudFuze)');
  const pptxQ4      = buildPptx('Q4 2023 Planning — CloudFuze Migration Roadmap');

  const zipLogs = buildZip([
    { name: 'ews-server.log', data: Buffer.from(
      '[2022-04-13 09:00:01] INFO  EWS CreateItem inbox 3ms OK\n' +
      '[2022-04-13 09:00:05] WARN  EWS CreateItem archive 400 DistinguishedFolderNotFound\n' +
      '[2022-04-13 09:00:08] ERROR ThrottlingException user=Alex@qatestagent.com retry 1\n' +
      '[2022-04-13 09:00:11] ERROR MaxRetry reached — aborting archive sync\n', 'utf8') },
    { name: 'migration-errors.csv', data: Buffer.from(
      'Timestamp,User,Folder,Error\n' +
      '2022-04-13T09:00:05Z,Alex@qatestagent.com,archive,DistinguishedFolderNotFound\n' +
      '2022-04-13T09:00:11Z,Alex@qatestagent.com,archive,MaxRetry\n', 'utf8') },
    { name: 'event-trace.txt', data: Buffer.from(
      'TRACE 09:00:01 EWS token acquired (3600s)\n' +
      'TRACE 09:00:03 GetFolder inbox OK\n' +
      'TRACE 09:00:04 GetFolder sentitems OK\n' +
      'TRACE 09:00:05 GetFolder archive FAIL\n' +
      'TRACE 09:00:05 Fallback Graph POST /mailFolders/archive/messages\n' +
      'TRACE 09:00:07 Graph POST 400 Bad Request\n' +
      'TRACE 09:00:08 ThrottlingException — wait 2s\n', 'utf8') },
  ]);

  const txtNotes = Buffer.from([
    'Bug Investigation Notes — Archive Sync Failure',
    '================================================',
    'Reported: Granger QA  |  Investigated: Ron QA, Dan QA',
    '',
    'SYMPTOMS',
    '- Archive folder sync fails for Alex@qatestagent.com',
    '- Error: DistinguishedFolderNotFound for "archive"',
    '- Began after Exchange Online update 2022-04-08',
    '',
    'ROOT CAUSE',
    'Exchange Online renamed the In-Place Archive distinguished',
    'folder from "archive" to "recoverableitemsroot" in March 2022.',
    'EWS endpoint was still using old folder ID.',
    '',
    'FIX',
    '1. Updated EWS_FOLDER_MAP in outlookClient.js',
    '2. Added Graph fallback for archive folder lookup',
    '3. Deployed to staging 2022-04-14, verified working',
    '',
    'PREVENTION',
    '- Monitor Exchange Online change log monthly',
    '- Add automated folder mapping test to CI pipeline',
  ].join('\n'), 'utf8');

  return { b64, pdfPlan, pdfCompliance, pdfMidpoint, docxAgenda, docxTimeline,
           xlsxTracker, pptxKickoff, pptxQ4, zipLogs, txtNotes };
}

// ─── Thread builder: resolves Message-IDs and threading headers ───────────────
function buildChain(chainId, baseIso, stepHours, specs) {
  const ids = specs.map((_, i) => `<${chainId}-m${i + 1}@qatestagent.com>`);
  const rootSubject = specs[0].subject;
  return specs.map((spec, i) => {
    const receivedDt = addHours(baseIso, i * stepHours);
    const sentDt     = addHours(baseIso, i * stepHours - (2 / 60));
    return {
      folder: spec.folder,
      msg: {
        subject:          i === 0 ? rootSubject : `RE: ${rootSubject}`,
        body:             spec.body,
        from:             spec.from,
        toRecipients:     spec.to,
        ccRecipients:     spec.cc,
        bccRecipients:    spec.bcc,
        importance:       spec.importance || 'normal',
        isRead:           spec.isRead !== false,
        isDraft:          spec.isDraft || false,
        flag:             spec.flag,
        categories:       spec.categories,
        attachments:      spec.attachments,
        // Graph POST (drafts) doesn't accept these — only set for non-drafts
        internetMessageId: spec.isDraft ? undefined : ids[i],
        inReplyTo:        (!spec.isDraft && i > 0) ? ids[i - 1] : undefined,
        references:       (!spec.isDraft && i > 0) ? ids.slice(0, i).join(' ') : undefined,
        // Graph POST doesn't allow backdating drafts
        receivedDateTime: spec.isDraft ? undefined : receivedDt,
        sentDateTime:     spec.isDraft ? undefined : sentDt,
      },
    };
  });
}

// ─── HTML body helpers ────────────────────────────────────────────────────────
const html = (content) => ({ contentType: 'HTML', content: `<html><body style="font-family:Calibri,Arial,sans-serif;font-size:14px">${content}</body></html>` });
const mention = (u) => `<a href="mailto:${u.address}" style="color:#0078D4">@${u.name}</a>`;
const hr = '<hr style="border:none;border-top:1px solid #ccc;margin:12px 0"/>';
const quote = (text) => `<blockquote style="border-left:3px solid #ccc;margin:8px 0;padding-left:12px;color:#555;font-size:13px">${text}</blockquote>`;

// ─── Define all 6 chains ──────────────────────────────────────────────────────
function defineChains(A) {
  const b64 = A.b64;
  const pdf   = (buf)  => [{ name: 'migration-plan.pdf',    contentType: 'application/pdf',   contentBytes: b64(buf)    }];
  const docx  = (buf)  => [{ name: 'document.docx',         contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', contentBytes: b64(buf) }];
  const xlsx  = (s)    => [{ name: 'tracker.xlsx',          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',        contentBytes: s       }];
  const pptx  = (buf)  => [{ name: 'presentation.pptx',     contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', contentBytes: b64(buf)}];
  const zip   = (buf)  => [{ name: 'logs-bundle.zip',       contentType: 'application/zip',   contentBytes: b64(buf)    }];
  const txt   = (buf)  => [{ name: 'investigation-notes.txt',contentType: 'text/plain',        contentBytes: buf.toString('base64') }];
  const png   = ()     => [{ name: 'screenshot.png',        contentType: 'image/png',         contentBytes: PNG_B64     }];

  // ── Chain 1: Project Phoenix (10 msgs, inbox) ─────────────────────────────
  const chain1 = buildChain('phoenix', '2022-03-01T09:00:00Z', 12, [
    {
      folder: 'inbox', from: ea(U.granger), to: eas(U.ron, U.alex), cc: eas(U.ben),
      subject: 'Project Phoenix — Migration Kickoff',
      importance: 'high', flag: { flagStatus: 'flagged' }, isRead: false,
      attachments: pdf(A.pdfPlan),
      body: html(`<p>Hi team,</p><p>Kicking off <strong>Project Phoenix</strong> — full mailbox migration for <em>ron@qatestagent.com</em> to Gmail.</p>
        <p>${mention(U.ron)} — please lead the technical side. ${mention(U.alex)} — coordinate with the client on timelines.</p>
        <p>Migration plan PDF attached. Key dates:</p>
        <ul><li>Pre-scan: <strong>2022-03-01 to 2022-03-03</strong></li><li>Migration: <strong>2022-03-06 to 2022-03-10</strong></li><li>Validation &amp; sign-off: <strong>2022-03-11 to 2022-03-14</strong></li></ul>
        <p>Reference: <a href="https://learn.microsoft.com/en-us/exchange/mailbox-migration/mailbox-migration">Exchange Mailbox Migration Guide</a></p>
        <p>Regards,<br/><strong>Granger QA</strong></p>`),
    },
    {
      folder: 'inbox', from: ea(U.alex), to: eas(U.ron, U.granger), cc: eas(U.ben, U.dan),
      isRead: true,
      body: html(`<p>Thanks ${mention(U.granger)}. I've reviewed the plan — looks solid.</p>
        <p>${mention(U.ron)}, I've set up the project repo. Can you confirm T-0 for migration start?</p>
        <p>${mention(U.ben)}, ${mention(U.dan)} — please complete source inventory by EOD Wednesday.</p>
        <p>Dashboard: <a href="https://admin.microsoft.com">Microsoft 365 Admin Center</a></p>
        ${hr}${quote('Kicking off Project Phoenix — full mailbox migration...')}
        <p>— Alex</p>`),
    },
    {
      folder: 'inbox', from: ea(U.ben), to: eas(U.ron, U.granger, U.alex),
      isRead: true,
      body: html(`<p>Source inventory complete. Summary:</p>
        <ul><li>Total messages: <strong>187</strong></li><li>Default folders: <strong>6</strong></li><li>Custom folders: <strong>17</strong></li><li>Total attachments: <strong>42</strong></li><li>Mailbox size: <strong>~32 MB</strong></li></ul>
        <p>${mention(U.ron)}, EWS pre-scan is ready to run whenever you give the go-ahead.</p>
        ${hr}${quote('Can you confirm T-0 for migration start?')}
        <p>— Ben</p>`),
    },
    {
      folder: 'inbox', from: ea(U.dan), to: eas(U.ron, U.granger, U.alex), cc: eas(U.bt1),
      isRead: true, attachments: docx(A.docxTimeline),
      body: html(`<p>Hi all,</p><p>The timeline looks a bit tight. I've revised it based on our infrastructure capacity — revised schedule attached (DOCX).</p>
        <p>Main concern: custom folder migration on Days 3-5 might overrun if we hit throttling.</p>
        <p>${mention(U.bt1)}, can you check the EWS throttling policy for this tenant?</p>
        ${hr}${quote('Migration execution 2022-03-06 to 2022-03-10')}
        <p>— Dan</p>`),
    },
    {
      folder: 'inbox', from: ea(U.granger), to: eas(U.ron, U.alex, U.ben, U.dan),
      isRead: true, categories: ['Blue Category'],
      body: html(`<p>Leadership has approved the revised timeline. We're good to go.</p>
        <p>${mention(U.bt1)}, please handle the EWS configuration and app registration.</p>
        <p>${mention(U.ron)}, please run the pre-scan once ${mention(U.bt1)} confirms the endpoint is ready.</p>
        <p>${mention(U.alex)} — client confirmed they're happy with the March 6 start date.</p>
        ${hr}${quote('The timeline looks a bit tight...')}
        <p>— Granger</p>`),
    },
    {
      folder: 'inbox', from: ea(U.bt1), to: eas(U.ron, U.granger), cc: eas(U.bt2),
      isRead: true,
      body: html(`<p>${mention(U.ron)},</p>
        <p>EWS endpoint confirmed. App registration complete. Credentials added to the vault.</p>
        <ul><li>Tenant: qatestagent.com</li><li>App ID: configured</li><li>Permissions: Mail.Read, Mail.ReadWrite, Calendars.ReadWrite (Application)</li></ul>
        <p>You're clear to run the pre-scan. ${mention(U.bt2)} will monitor from our side.</p>
        <p>Docs: <a href="https://learn.microsoft.com/en-us/graph/auth/auth-concepts">Microsoft Graph App Authentication</a></p>
        ${hr}${quote('Please handle the EWS configuration and app registration')}
        <p>— Blue Team 1</p>`),
    },
    {
      folder: 'inbox', from: ea(U.alex), to: eas(U.ron, U.granger, U.bt1), cc: eas(U.bt2),
      isRead: true, attachments: xlsx(A.xlsxTracker),
      body: html(`<p>Pre-scan complete! Migration tracker XLSX attached.</p>
        <p>Highlights:</p>
        <ul><li>All 23 folders discovered and mapped ✓</li><li>187 messages enumerated ✓</li><li>42 attachments catalogued ✓</li><li>No errors in pre-scan ✓</li></ul>
        <p>${mention(U.ron)}, we're ready for the go/no-go decision.</p>
        <p>Power BI dashboard: <a href="https://app.powerbi.com">View live tracker</a></p>
        ${hr}${quote('EWS endpoint confirmed. App registration complete.')}
        <p>— Alex</p>`),
    },
    {
      folder: 'inbox', from: ea(U.bt2), to: eas(U.ron, U.alex), cc: eas(U.granger, U.dan),
      isRead: true, categories: ['Green Category'],
      body: html(`<p>All user mappings verified:</p>
        <table style="border-collapse:collapse;font-size:13px"><tr style="background:#f0f0f0"><th style="border:1px solid #ccc;padding:4px 8px">Source</th><th style="border:1px solid #ccc;padding:4px 8px">Destination</th><th style="border:1px solid #ccc;padding:4px 8px">Status</th></tr>
        <tr><td style="border:1px solid #ccc;padding:4px 8px">ron@qatestagent.com</td><td style="border:1px solid #ccc;padding:4px 8px">ron@migrationn.com</td><td style="border:1px solid #ccc;padding:4px 8px">✓ Ready</td></tr>
        <tr><td style="border:1px solid #ccc;padding:4px 8px">Alex@qatestagent.com</td><td style="border:1px solid #ccc;padding:4px 8px">alex@migrationn.com</td><td style="border:1px solid #ccc;padding:4px 8px">✓ Ready</td></tr>
        </table>
        <p>Ready for go/no-go decision, ${mention(U.granger)}.</p>
        ${hr}${quote('Pre-scan complete! 187 messages, 42 attachments...')}
        <p>— Blue Team 2</p>`),
    },
    {
      folder: 'inbox', from: ea(U.granger), to: eas(U.ron, U.alex, U.ben, U.dan, U.bt1, U.bt2),
      isRead: true, importance: 'high', flag: { flagStatus: 'flagged' }, categories: ['Red Category'],
      body: html(`<p>🟢 <strong>GO DECISION CONFIRMED</strong></p>
        <p>Migration starts <strong>2022-03-06 at 06:00 UTC</strong>.</p>
        <p>All team members: please be on standby for the first 4 hours of execution.</p>
        <p>${mention(U.ron)}, you have exec authority to pause if you see error rates above 5%.</p>
        <p>${mention(U.bt3)} (CloudFuze) has been notified and will queue the migration job.</p>
        <p>War room: <a href="https://teams.microsoft.com">Teams Channel: #project-phoenix</a></p>
        ${hr}${quote('All user mappings verified. Ready for go/no-go decision.')}
        <p>— Granger</p>`),
    },
    {
      folder: 'inbox', from: ea(U.bt3), to: eas(U.ron, U.granger), cc: eas(U.bt1, U.bt2),
      isRead: false, importance: 'high', attachments: pptx(A.pptxKickoff),
      body: html(`<p>Hi ${mention(U.ron)}, ${mention(U.granger)},</p>
        <p>CloudFuze migration job queued. Kickoff deck attached (PPTX).</p>
        <p>Job ID: <strong>CFZ-2022-0301-PHX</strong></p>
        <p>Migration URL: <a href="https://www.cloudfuze.com">CloudFuze Platform</a></p>
        <p>Estimated duration: <strong>72–96 hours</strong></p>
        <p>We'll send progress updates every 24 hours. Contact us at support@cloudfuze.com for urgent issues.</p>
        ${hr}${quote('GO decision confirmed. Migration starts 2022-03-06 at 06:00 UTC.')}
        <p>— Blue Team 3 (CloudFuze)</p>`),
    },
  ]);

  // ── Chain 2: Bug Report (12 msgs, alternating inbox/sentitems) ─────────────
  const chain2 = buildChain('bug', '2022-04-10T08:00:00Z', 6, [
    {
      folder: 'inbox', from: ea(U.granger), to: eas(U.ron),
      isRead: false, importance: 'high', flag: { flagStatus: 'flagged' },
      subject: 'Bug Report: Email Archive Sync Failure — Alex@qatestagent.com',
      body: html(`<p>${mention(U.ron)},</p>
        <p>We're seeing archive sync failures on <strong>Alex@qatestagent.com</strong>. It started after the Exchange Online update last Thursday.</p>
        <p>Error: <code style="background:#f4f4f4;padding:2px 6px">DistinguishedFolderNotFound for "archive"</code></p>
        <p>Priority: <strong>HIGH</strong> — affects 3 users. Can you investigate ASAP?</p>
        <p>Ticket: <a href="https://github.com/anthropics/claude-code/issues">Internal Issue Tracker</a></p>
        <p>— Granger</p>`),
    },
    {
      folder: 'sentitems', from: ea(U.ron), to: eas(U.granger, U.alex),
      isRead: true, attachments: png(),
      body: html(`<p>On it. I can reproduce the error. Screenshot attached.</p>
        <p>Initial observations:</p>
        <ul><li>EWS DistinguishedFolderNotFound for folder ID "archive"</li><li>Graph POST fallback also failing with 400 Bad Request</li><li>Issue is consistent — not intermittent</li></ul>
        <p>${mention(U.alex)}, can you confirm if you see the same on your end?</p>
        <p>— Ron</p>`),
    },
    {
      folder: 'inbox', from: ea(U.alex), to: eas(U.ron, U.granger),
      isRead: true,
      body: html(`<p>Confirmed — I can repro it every time.</p>
        <p>Steps to reproduce:</p>
        <ol><li>Run archive migration for Alex@qatestagent.com</li><li>EWS CreateItem fails with DistinguishedFolderNotFound</li><li>Graph fallback: POST /mailFolders/archive/messages — 400</li></ol>
        <p>${mention(U.ron)}, I think the folder name changed in the March update. Worth checking the Exchange Online release notes.</p>
        ${hr}${quote('I can reproduce the error. Screenshot attached.')}
        <p>— Alex</p>`),
    },
    {
      folder: 'sentitems', from: ea(U.ron), to: eas(U.alex, U.granger),
      isRead: true,
      body: html(`<p>Applied a temporary workaround — modified throttling policy and added a Graph filter fallback.</p>
        <p>The archive folder can now be found via: <code style="background:#f4f4f4;padding:2px 6px">GET /mailFolders?$filter=displayName eq 'Archive'</code></p>
        <p>${mention(U.alex)}, please test archive sync again. It should work now.</p>
        <p>Docs: <a href="https://learn.microsoft.com/en-us/exchange">Exchange Online documentation</a></p>
        ${hr}${quote('Steps to reproduce: EWS CreateItem fails with DistinguishedFolderNotFound')}
        <p>— Ron</p>`),
    },
    {
      folder: 'inbox', from: ea(U.granger), to: eas(U.ron, U.alex, U.ben),
      isRead: true, flag: { flagStatus: 'flagged' },
      body: html(`<p>Workaround isn't holding. ${mention(U.alex)} still reports failures on large mailboxes.</p>
        <p>${mention(U.ben)}, can you pull the EWS server logs for the last 24 hours and look for throttling or version mismatch errors?</p>
        <p>${mention(U.ron)}, should we escalate to Dan's infrastructure team?</p>
        ${hr}${quote('Applied a temporary workaround — modified throttling policy')}
        <p>— Granger</p>`),
    },
    {
      folder: 'sentitems', from: ea(U.ron), to: eas(U.granger, U.alex, U.ben, U.dan),
      isRead: true, importance: 'high', attachments: zip(A.zipLogs),
      body: html(`<p>Escalating. Full server log bundle attached (ZIP — includes ews-server.log, error CSV, event trace).</p>
        <p>${mention(U.dan)}, I need your team to look at the Exchange distinguished folder mapping.</p>
        <p>My hypothesis: Exchange Online silently renamed "archive" → "recoverableitemsroot" in the Mar 2022 update. If confirmed, we need to patch <code>EWS_FOLDER_MAP</code> in outlookClient.js.</p>
        <p>Ref: <a href="https://learn.microsoft.com/en-us/exchange/policy-and-compliance/in-place-archiving/in-place-archiving">In-Place Archiving — Microsoft Docs</a></p>
        ${hr}${quote('Workaround not holding on large mailboxes')}
        <p>— Ron</p>`),
    },
    {
      folder: 'inbox', from: ea(U.dan), to: eas(U.ron, U.granger, U.alex),
      isRead: true, categories: ['Blue Category'],
      body: html(`<p>Root cause confirmed.</p>
        <p><strong>Finding:</strong> Exchange Online Mar 2022 update changed the distinguished folder name for In-Place Archive from <code>archive</code> to <code>recoverableitemsroot</code>.</p>
        <p>Our <code>EWS_FOLDER_MAP</code> was still pointing to the old ID. The fix is straightforward:</p>
        <ol><li>Update <code>EWS_FOLDER_MAP</code> in <code>outlookClient.js</code></li><li>Add Graph fallback: <code>GET /mailFolders?$filter=displayName eq 'Archive'</code></li></ol>
        <p>${mention(U.ron)}, can you implement? I'd estimate 2 hours of work.</p>
        ${hr}${quote('Exchange distinguished folder mapping might be the issue')}
        <p>— Dan</p>`),
    },
    {
      folder: 'sentitems', from: ea(U.ron), to: eas(U.dan, U.granger, U.alex),
      isRead: true,
      body: html(`<p>Fix implemented and deployed to staging. Changes:</p>
        <ul><li>Updated <code>EWS_FOLDER_MAP['archive']</code> → uses Graph filter fallback</li><li>Added automatic retry with new folder path</li><li>Added unit test to detect future folder renames</li></ul>
        <p>Staging test: archive sync working ✓ for alex@qatestagent.com, ron@qatestagent.com</p>
        <p>${mention(U.granger)}, ${mention(U.dan)} — please verify on your end before I promote to production.</p>
        ${hr}${quote('Fix is straightforward — update EWS_FOLDER_MAP in outlookClient.js')}
        <p>— Ron</p>`),
    },
    {
      folder: 'inbox', from: ea(U.granger), to: eas(U.ron, U.dan),
      isRead: true, attachments: txt(A.txtNotes),
      body: html(`<p>Verified fix on staging. Archive sync working correctly for all affected users.</p>
        <p>Investigation notes attached (TXT) — summarizes root cause, fix, and prevention steps.</p>
        <p>${mention(U.ron)}, you're clear to promote to production. LGTM.</p>
        ${hr}${quote('Staging test: archive sync working ✓')}
        <p>— Granger</p>`),
    },
    {
      folder: 'sentitems', from: ea(U.ron), to: eas(U.granger, U.dan, U.alex),
      isRead: true, categories: ['Green Category'],
      body: html(`<p>Fix promoted to production. Monitoring for 24 hours before closing ticket.</p>
        <p>Summary of changes shipped:</p>
        <ul><li>outlookClient.js: EWS_FOLDER_MAP archive fix</li><li>outlookClient.js: Graph filter fallback for archive</li><li>Unit test: folder rename detection</li></ul>
        <p>${mention(U.bt1)}, ${mention(U.bt2)} — heads-up: archive migration is unblocked.</p>
        ${hr}${quote('Verified fix on staging. Clear to promote to production.')}
        <p>— Ron</p>`),
    },
    {
      folder: 'inbox', from: ea(U.alex), to: eas(U.ron),
      isRead: true,
      body: html(`<p>Confirmed working on my end. Archive sync is solid now — ran it on 3 mailboxes without any errors.</p>
        <p>Great debugging work ${mention(U.ron)}, ${mention(U.dan)}! 🎉</p>
        ${hr}${quote('Fix promoted to production. Archive migration unblocked.')}
        <p>— Alex</p>`),
    },
    {
      folder: 'sentitems', from: ea(U.ron), to: eas(U.alex, U.granger, U.dan, U.bt1),
      isRead: true, categories: ['Red Category'],
      body: html(`<p>Closing ticket. Post-mortem complete.</p>
        <p>Key lesson: Exchange Online can rename distinguished folders without prior notice. We should subscribe to their change management feed.</p>
        <p>Post-mortem doc will be shared at next standup. CC-ing ${mention(U.bt1)} for the QA retrospective.</p>
        <p>Ticket status: <strong>CLOSED — RESOLVED</strong></p>
        ${hr}${quote('Confirmed working on my end. Great debugging work!')}
        <p>— Ron</p>`),
    },
  ]);

  // ── Chain 3: Compliance Audit (7 msgs, deleteditems) ──────────────────────
  const chain3 = buildChain('compliance', '2022-06-01T10:00:00Z', 72, [
    {
      folder: 'deleteditems', from: ea(U.bt3), to: eas(U.ron),
      isRead: true, importance: 'high',
      subject: 'CloudFuze Compliance Audit — Action Required by 2022-06-06',
      body: html(`<p>Dear <strong>Ron QA</strong>,</p>
        <p>Your account <em>ron@qatestagent.com</em> has been selected for a routine data retention compliance audit.</p>
        <p><strong>Action required within 5 business days (by 2022-06-06).</strong></p>
        <p>Please have the following ready:</p>
        <ol><li>Email retention policy documentation</li><li>Archive configuration proof</li><li>Data export capability evidence</li></ol>
        <p>Questions? Contact <a href="mailto:Blueteam3@cloudfuze.com">Blueteam3@cloudfuze.com</a></p>
        <p>— Blue Team 3 (CloudFuze Compliance)</p>`),
    },
    {
      folder: 'deleteditems', from: ea(U.granger), to: eas(U.ron, U.bt3),
      isRead: true,
      body: html(`<p>${mention(U.ron)}, please acknowledge receipt of this compliance notice and prepare the requested evidence.</p>
        <p>I'll coordinate with legal to ensure we have everything in order. Timeline looks tight — let's aim to have evidence ready by <strong>2022-06-05</strong>.</p>
        ${hr}${quote('Routine data retention compliance audit. Action required by 2022-06-06.')}
        <p>— Granger</p>`),
    },
    {
      folder: 'deleteditems', from: ea(U.bt3), to: eas(U.ron, U.granger),
      isRead: true, attachments: [{ name: 'compliance-evidence-pack.pdf', contentType: 'application/pdf', contentBytes: b64(A.pdfCompliance) }],
      body: html(`<p>As requested, here is the compliance evidence pack (PDF attached).</p>
        <p>It covers all 5 audit items. No issues found in our initial review.</p>
        <p>Formal audit scheduled: <strong>Thursday, 2022-06-16, 14:00 UTC</strong></p>
        <p>Please confirm attendance: ${mention(U.ron)}, ${mention(U.granger)}</p>
        ${hr}${quote('Prepare the requested evidence. Timeline: 2022-06-05.')}
        <p>— Blue Team 3</p>`),
    },
    {
      folder: 'deleteditems', from: ea(U.alex), to: eas(U.ron, U.bt3, U.granger),
      isRead: true,
      body: html(`<p>Compliance checklist completed. All 5 items verified:</p>
        <ul><li>Email retention policy: ✓ 7-year retention configured</li><li>Archive: ✓ In-Place Archive enabled</li><li>Data export: ✓ eDiscovery export tested</li><li>Encryption at rest: ✓ Confirmed</li><li>Access logging: ✓ Enabled and retained 90 days</li></ul>
        <p>${mention(U.bt3)}, we're ready for the formal audit on June 16.</p>
        ${hr}${quote('Formal audit scheduled Thursday 2022-06-16 14:00 UTC')}
        <p>— Alex</p>`),
    },
    {
      folder: 'deleteditems', from: ea(U.bt3), to: eas(U.ron, U.alex, U.granger),
      isRead: true,
      body: html(`<p>Audit confirmed for <strong>2022-06-16, 14:00–16:00 UTC</strong>.</p>
        <p>Attendees required: ${mention(U.ron)}, ${mention(U.granger)}, ${mention(U.alex)}</p>
        <p>Teams meeting link: <a href="https://teams.microsoft.com">Join Teams Meeting</a></p>
        <p>Please bring: evidence pack, access logs for Q1/Q2 2022, retention policy screenshots.</p>
        ${hr}${quote('All 5 items verified. Ready for formal audit on June 16.')}
        <p>— Blue Team 3</p>`),
    },
    {
      folder: 'deleteditems', from: ea(U.granger), to: eas(U.ron, U.bt3, U.alex, U.ben),
      isRead: true,
      body: html(`<p>Audit complete — <strong>NO ISSUES FOUND</strong>. 🎉</p>
        <p>Auditors reviewed all 5 compliance items and confirmed full compliance.</p>
        <p>${mention(U.bt3)} will issue the formal closure notice within 3 business days.</p>
        <p>${mention(U.ben)}, please update the compliance register with today's audit result.</p>
        ${hr}${quote('Attendees required at 2022-06-16 audit')}
        <p>— Granger</p>`),
    },
    {
      folder: 'deleteditems', from: ea(U.bt3), to: eas(U.ron, U.granger, U.alex),
      isRead: true, categories: ['Green Category'],
      body: html(`<p>FORMAL CLOSURE NOTICE</p>
        <p>Compliance audit reference: <strong>COMP-2022-0601</strong></p>
        <p>Account: ron@qatestagent.com | Result: <strong>COMPLIANT — NO ACTION REQUIRED</strong></p>
        <p>Next scheduled audit: Q4 2022. You will be notified 2 weeks in advance.</p>
        <p>Thank you for your cooperation.</p>
        ${hr}${quote('Audit complete — no issues found')}
        <p>— Blue Team 3 (CloudFuze Compliance)</p>`),
    },
  ]);

  // ── Chain 4: Weekly Status (15 msgs, inbox) ────────────────────────────────
  const weeklySubject = 'Weekly Migration Status — Project Phoenix';
  const weeklyMsgs = Array.from({ length: 15 }, (_, w) => {
    const week = w + 1;
    const pct  = Math.round((week / 15) * 100);
    const done = Math.round(187 * week / 15);
    const atts = w === 2  ? xlsx(A.xlsxTracker)
               : w === 7  ? [{ name: `week-${week}-midpoint-report.pdf`, contentType: 'application/pdf', contentBytes: b64(A.pdfMidpoint) }]
               : w === 13 ? pptx(A.pptxQ4)
               : undefined;
    const ccList = week <= 5 ? eas(U.granger, U.alex) :
                   week <= 10 ? eas(U.granger, U.alex, U.dan, U.bt1) :
                   eas(U.granger, U.alex, U.dan, U.bt1, U.bt2, U.bt3);
    return {
      folder: 'inbox',
      from: ea(U.ben),
      to: week === 15 ? eas(U.ron, U.granger, U.alex, U.dan, U.bt1, U.bt2, U.bt3) : eas(U.ron),
      cc: ccList,
      isRead: week < 15,
      importance: week === 15 ? 'high' : 'normal',
      flag: week === 15 ? { flagStatus: 'flagged' } : undefined,
      categories: week === 15 ? ['Green Category'] : undefined,
      attachments: atts,
      subject: weeklySubject,
      body: html(week < 15
        ? `<p>Week ${week} Status Update — ${pct}% complete (${done}/187 messages migrated)</p>
           ${w === 0 ? '<p>Pre-scan initiated. Source inventory: 187 messages, 23 folders, ~32 MB.</p>' : ''}
           ${w === 1 ? '<p>Source inventory complete. Folder mapping done. Ready for migration start.</p>' : ''}
           ${w === 2 ? '<p>Migration started. Inbox: in progress. Migration tracker XLSX attached.</p>' : ''}
           ${w === 3 ? `<p>Inbox migrated (47/47 ✓). Sent Items in progress.</p>` : ''}
           ${w === 4 ? '<p>Sent Items (23/23 ✓). Drafts (10/10 ✓). Custom folders starting.</p>' : ''}
           ${w === 5 ? `<p>${mention(U.bt1)}: please verify EWS token refresh is working — we saw a 401 on retry 2.</p>` : ''}
           ${w === 6 ? '<p>15/23 custom folders complete. On track for Week 9 completion.</p>' : ''}
           ${w === 7 ? '<p>Midpoint report attached. 78% complete. No errors. Large attachments pending re-check.</p>' : ''}
           ${w === 8 ? '<p>All custom folders done. Calendars (42 events) and contacts next.</p>' : ''}
           ${w === 9 ? '<p>Calendars migrated (42/42 ✓). Contacts starting.</p>' : ''}
           ${w === 10 ? '<p>Contacts migrated (34/34 ✓). Attachment hash validation in progress.</p>' : ''}
           ${w === 11 ? `<p>Attachment check: 40/42 verified ✓. 2 large files (>20 MB) pending ${mention(U.dan)} manual re-check.</p>` : ''}
           ${w === 12 ? '<p>Post-migration validation agent running. Tier A/B/C checks in progress.</p>' : ''}
           ${w === 13 ? '<p>Validation complete. Final deck attached. Awaiting sign-off.</p>' : ''}
           <p>Next update: Week ${week + 1}. Questions? Reply to this thread.</p>
           <p>— Ben QA</p>`
        : `<p>🎉 <strong>PROJECT PHOENIX — MIGRATION COMPLETE</strong> 🎉</p>
           <p>All 187 messages migrated successfully across 23 folders. Zero errors.</p>
           <table style="border-collapse:collapse;font-size:13px"><tr style="background:#d4edda"><th style="border:1px solid #ccc;padding:4px 12px">Check</th><th style="border:1px solid #ccc;padding:4px 12px">Result</th></tr>
           <tr><td style="border:1px solid #ccc;padding:4px 12px">Folders</td><td style="border:1px solid #ccc;padding:4px 12px">23/23 ✓</td></tr>
           <tr><td style="border:1px solid #ccc;padding:4px 12px">Messages</td><td style="border:1px solid #ccc;padding:4px 12px">187/187 ✓</td></tr>
           <tr><td style="border:1px solid #ccc;padding:4px 12px">Drafts</td><td style="border:1px solid #ccc;padding:4px 12px">10/10 ✓</td></tr>
           <tr><td style="border:1px solid #ccc;padding:4px 12px">Attachments</td><td style="border:1px solid #ccc;padding:4px 12px">42/42 ✓</td></tr>
           <tr><td style="border:1px solid #ccc;padding:4px 12px">Thread chains</td><td style="border:1px solid #ccc;padding:4px 12px">163 conversations ✓</td></tr>
           </table>
           <p>Huge thanks to the entire team: ${mention(U.ron)}, ${mention(U.alex)}, ${mention(U.dan)}, ${mention(U.bt1)}, ${mention(U.bt2)}, ${mention(U.bt3)}</p>
           <p><a href="https://www.cloudfuze.com">CloudFuze Migration Platform</a></p>
           <p>— Ben QA</p>`),
    };
  });
  const chain4 = buildChain('weekly', '2022-09-05T10:00:00Z', 168, weeklyMsgs);

  // ── Chain 5: Marketing Spam (6 msgs, junkemail) ────────────────────────────
  const chain5 = buildChain('spam', '2023-01-10T08:00:00Z', 96, [
    {
      folder: 'junkemail', from: ea(U.bt3), to: eas(U.ron),
      isRead: false,
      subject: 'Special Offer: CloudFuze Premium Migration — 50% Off This Week Only!',
      body: html(`<p style="color:#cc0000"><strong>🔥 LIMITED TIME OFFER 🔥</strong></p>
        <p>Upgrade to <strong>CloudFuze Premium</strong> and get <strong>50% off</strong> your next mailbox migration!</p>
        <ul><li>Unlimited mailbox size</li><li>Priority EWS processing</li><li>24/7 dedicated support</li><li>Advanced thread chain preservation</li></ul>
        <p><a href="https://www.cloudfuze.com" style="background:#0078D4;color:white;padding:8px 16px;text-decoration:none">CLAIM YOUR DISCOUNT</a></p>
        <p style="font-size:11px;color:#888">To unsubscribe, reply with "UNSUBSCRIBE". CloudFuze Inc., 100 Migration Ave, Cloud City, CC 00001</p>`),
    },
    {
      folder: 'junkemail', from: ea(U.bt3), to: eas(U.ron),
      isRead: false,
      body: html(`<p>⏰ <strong>Reminder: Your exclusive deal expires in 48 hours!</strong></p>
        <p>Don't miss the 50% discount on CloudFuze Premium migration.</p>
        <p><a href="https://www.cloudfuze.com">Click here to redeem before it expires</a></p>
        <p style="font-size:11px;color:#888">You're receiving this because you signed up at cloudfuze.com</p>`),
    },
    {
      folder: 'junkemail', from: ea(U.bt3), to: eas(U.ron),
      isRead: false, importance: 'high',
      body: html(`<p><strong>LAST CHANCE:</strong> Migration bundle deal ending TODAY at midnight!</p>
        <p>Everything in the offer: <a href="https://www.cloudfuze.com">CloudFuze Offer Page</a></p>
        <p>Use code: <strong>PHOENIX50</strong></p>`),
    },
    {
      folder: 'junkemail', from: ea(U.bt3), to: eas(U.ron),
      isRead: false,
      body: html(`<p>You missed the sale... but don't worry! We have a <strong>NEW exclusive offer</strong> just for you.</p>
        <p>60% off CloudFuze Enterprise — includes Outlook-to-Gmail, Gmail-to-Outlook, and more!</p>
        <p><a href="https://www.cloudfuze.com">See new offer</a></p>`),
    },
    {
      folder: 'junkemail', from: ea(U.bt3), to: eas(U.ron),
      isRead: false,
      body: html(`<p>We noticed you clicked "Unsubscribe" — but we want to make sure that's what you intended.</p>
        <p>To confirm: <a href="https://www.cloudfuze.com">Yes, unsubscribe me</a> | <a href="https://www.cloudfuze.com">No, keep me subscribed</a></p>
        <p style="font-size:11px;color:#888">If you don't confirm within 24 hours, you will remain subscribed.</p>`),
    },
    {
      folder: 'junkemail', from: ea(U.bt3), to: eas(U.ron),
      isRead: false,
      body: html(`<p>We're sad to see you go, ${mention(U.ron)}.</p>
        <p>As a farewell gift: <strong>75% off</strong> — our highest discount ever. One-time offer.</p>
        <p>Use code: <strong>GOODBYE75</strong> at checkout: <a href="https://www.cloudfuze.com">CloudFuze Checkout</a></p>
        <p style="font-size:11px;color:#888">You have been unsubscribed from marketing emails.</p>`),
    },
  ]);

  // ── Chain 6: Q4 Planning (8 msgs, inbox + drafts) ─────────────────────────
  const chain6 = buildChain('q4plan', '2023-09-01T09:00:00Z', 48, [
    {
      folder: 'inbox', from: ea(U.granger), to: eas(U.ron, U.alex, U.ben, U.dan, U.bt1, U.bt2),
      isRead: true, importance: 'high', flag: { flagStatus: 'flagged' },
      subject: 'Q4 2023 Planning Meeting — Agenda and Track Assignments',
      attachments: docx(A.docxAgenda),
      body: html(`<p>Team,</p>
        <p>Q4 planning meeting is confirmed for <strong>October 15, 2023, 10:00 UTC</strong>. Full agenda attached (DOCX).</p>
        <p>Track assignments:</p>
        <ul><li>Validation track: <strong>${mention(U.ron)}</strong></li><li>Migration track: <strong>${mention(U.alex)}</strong></li><li>Infrastructure: <strong>${mention(U.dan)}</strong></li><li>CloudFuze features: <strong>${mention(U.bt3)}</strong> (remote)</li></ul>
        <p>Please review the agenda and confirm attendance by <strong>September 10</strong>.</p>
        <p>— Granger</p>`),
    },
    {
      folder: 'inbox', from: ea(U.alex), to: eas(U.ron, U.granger, U.ben, U.dan),
      isRead: true,
      body: html(`<p>Attendance confirmed. I'll take the migration track.</p>
        <p>${mention(U.ron)}, can you confirm you're owning the validation track? I'd like to align our slide decks.</p>
        <p>Suggested split: Migration track covers data movement; Validation track covers accuracy + thread chain checks.</p>
        ${hr}${quote('Validation track: Ron QA | Migration track: Alex QA')}
        <p>— Alex</p>`),
    },
    {
      folder: 'inbox', from: ea(U.ben), to: eas(U.ron, U.granger, U.alex, U.dan),
      isRead: true,
      body: html(`<p>Confirmed for infrastructure support. A few questions for the agenda:</p>
        <ol><li>Are we including the Archive migration improvements in Q4 scope?</li><li>Should we cover the EWS-to-Graph API migration plan?</li><li>${mention(U.ron)}'s validation results from last quarter — can those be the baseline for Q4 targets?</li></ol>
        ${hr}${quote('Suggested split: Migration track + Validation track')}
        <p>— Ben</p>`),
    },
    {
      folder: 'inbox', from: ea(U.dan), to: eas(U.ron, U.alex, U.granger, U.bt1), cc: eas(U.bt2),
      isRead: true,
      body: html(`<p>CloudFuze team (${mention(U.bt3)}) confirmed joining remotely. They'll present the new Graph API migration features.</p>
        <p>${mention(U.bt1)}, ${mention(U.bt2)} — please make sure the Teams room is set up for remote participants 15 min before the meeting.</p>
        <p>${mention(U.ron)}, I've booked Conference Room A (10 seats). Let me know if you need more capacity.</p>
        ${hr}${quote('Ben: Are we including Archive migration improvements in Q4 scope?')}
        <p>— Dan</p>`),
    },
    {
      folder: 'inbox', from: ea(U.granger), to: eas(U.ron, U.alex, U.ben, U.dan, U.bt1, U.bt2),
      isRead: true, attachments: pptx(A.pptxQ4),
      body: html(`<p>All tracks confirmed. Q4 planning deck attached (PPTX) — please review before the meeting.</p>
        <p>To answer Ben's questions:</p>
        <ol><li>Yes — Archive migration is in Q4 scope (high priority)</li><li>EWS-to-Graph migration: stretch goal for Q4</li><li>Ron's Q3 validation baseline: yes, use those numbers</li></ol>
        <p>${mention(U.ron)}, please prep 10-minute slot on validation metrics + Q4 targets.</p>
        ${hr}${quote('Questions for the agenda: Archive migration in Q4 scope?')}
        <p>— Granger</p>`),
    },
    {
      folder: 'inbox', from: ea(U.alex), to: eas(U.ron, U.granger, U.ben), cc: eas(U.bt1, U.bt2, U.bt3),
      isRead: false, importance: 'high',
      body: html(`<p>Room booked and confirmed:</p>
        <ul><li>Location: <strong>Conference Room A</strong> (on-site)</li><li>Teams: <a href="https://teams.microsoft.com">Teams meeting link</a> (for remote)</li><li>Date: <strong>October 15, 2023, 10:00–13:00 UTC</strong></li></ul>
        <p>Catering for 8 people confirmed.</p>
        <p>${mention(U.ron)}, please send your validation track slides to the group by <strong>October 13</strong>.</p>
        ${hr}${quote('Q4 planning deck attached. Ron: prep 10-minute validation slot.')}
        <p>— Alex</p>`),
    },
    {
      folder: 'drafts', from: ea(U.ron), to: eas(U.granger, U.alex, U.ben, U.dan),
      isRead: true, isDraft: true,
      body: html(`<p>[DRAFT — not sent]</p>
        <p>Attendance confirmed. Validation track prep underway.</p>
        <p>My plan for the 10-minute slot:</p>
        <ol><li>Q3 validation baseline: 186/187 messages, 0 failed thread chains</li><li>Key improvement: Tier B attachment hash comparison now covers files up to 10 MB</li><li>Q4 target: raise limit to 25 MB, add PPTX deep validation</li><li>Open question: should we add cross-folder thread chain validation?</li></ol>
        <p>Draft slides being prepared — will share by October 13 as requested by ${mention(U.alex)}.</p>
        <p>— Ron (draft)</p>`),
    },
    {
      folder: 'drafts', from: ea(U.ron), to: eas(U.alex, U.granger),
      isRead: true, isDraft: true,
      body: html(`<p>[DRAFT — not sent]</p>
        <p>${mention(U.alex)}, a few questions about the Q4 planning deck before the meeting:</p>
        <ol><li>Slide 8 mentions "EWS deprecation timeline" — do we have a confirmed date from Microsoft?</li><li>The migration throughput numbers on slide 12 seem low — are those worst-case or average?</li><li>Should we include the Gmail-to-Outlook flow in Q4 scope, or keep it as Q1 2024?</li></ol>
        <p>Will finalize my validation slides once I hear back. Targeting Oct 13 for share.</p>
        <p>— Ron (draft)</p>`),
    },
  ]);

  return [
    { label: 'Chain 1: Project Phoenix (10 msgs, inbox)',          items: chain1 },
    { label: 'Chain 2: Bug Report: Archive Sync (12 msgs, mixed)', items: chain2 },
    { label: 'Chain 3: Compliance Audit (7 msgs, deleteditems)',   items: chain3 },
    { label: 'Chain 4: Weekly Status 15-week (15 msgs, inbox)',    items: chain4 },
    { label: 'Chain 5: Marketing Spam (6 msgs, junkemail)',        items: chain5 },
    { label: 'Chain 6: Q4 Planning (8 msgs, inbox+drafts)',        items: chain6 },
  ];
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('Building attachments…');
  const A      = buildAttachments();
  const chains = defineChains(A);

  const total = chains.reduce((s, c) => s + c.items.length, 0);
  console.log(`\nSeeding ${chains.length} chains (${total} total messages) into ${TARGET}\n`);

  let grandOk = 0, grandFail = 0;

  for (const chain of chains) {
    console.log(`\n── ${chain.label} ──`);
    let chainOk = 0;
    for (let i = 0; i < chain.items.length; i++) {
      const { folder, msg } = chain.items[i];
      try {
        await outlookClient.createMessageInFolder(TARGET, folder, msg);
        const attList = (msg.attachments || []).map((a) => a.name).join(', ') || 'none';
        const depth   = i + 1;
        console.log(`  [${depth}/${chain.items.length}] ✓ [${folder}] ${msg.subject}`);
        if (attList !== 'none') console.log(`        attachments: ${attList}`);
        chainOk++;
        grandOk++;
      } catch (err) {
        console.error(`  [${i + 1}/${chain.items.length}] ✗ [${folder}] ${msg.subject} — ${err.message}`);
        grandFail++;
      }
    }
    console.log(`  → ${chainOk}/${chain.items.length} created`);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Done — ${grandOk}/${total} messages created  (${grandFail} failed)`);
  console.log(`Folders seeded: inbox, sentitems, drafts, deleteditems, junkemail`);
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
