/**
 * quickTestAttachments.js
 *
 * Quick test: seeds ron@qatestagent.com Inbox with emails covering
 * varied attachment types (real files), HTML body links, flagged, and
 * high-importance — backdated to 2022-2023 for in-place archive testing.
 *
 * Usage:
 *   cd backend && node scripts/quickTestAttachments.js
 */

'use strict';

require('../src/config/env');
const outlookClient = require('../src/clients/outlookClient');
const XLSX          = require('xlsx');

const TARGET = 'ron@qatestagent.com';
const SENDER = 'ben@qatestagent.com';
const FOLDER = 'inbox';

// ─── CRC-32 + minimal ZIP builder (stored, no compression) ─────────────────
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
    const nb  = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const lh  = Buffer.concat([
      Buffer.from([0x50,0x4B,0x03,0x04]),
      u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length),
      u16(nb.length), u16(0), nb,
    ]);
    central.push(Buffer.concat([
      Buffer.from([0x50,0x4B,0x01,0x02]),
      u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length),
      u16(nb.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nb,
    ]));
    parts.push(lh, data);
    offset += lh.length + data.length;
  }
  const cd   = Buffer.concat(central);
  const eocd = Buffer.concat([
    Buffer.from([0x50,0x4B,0x05,0x06]),
    u16(0), u16(0), u16(files.length), u16(files.length),
    u32(cd.length), u32(offset), u16(0),
  ]);
  return Buffer.concat([...parts, cd, eocd]);
}

// ─── Real DOCX (minimal OOXML) ──────────────────────────────────────────────
function buildDocx(title, bodyText) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return buildZip([
    {
      name: '[Content_Types].xml',
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '</Types>', 'utf8'),
    },
    {
      name: '_rels/.rels',
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '</Relationships>', 'utf8'),
    },
    {
      name: 'word/_rels/document.xml.rels',
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>', 'utf8'),
    },
    {
      name: 'word/document.xml',
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        '<w:body>' +
        `<w:p><w:pPr><w:jc w:val="left"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="32"/></w:rPr><w:t>${esc(title)}</w:t></w:r></w:p>` +
        `<w:p><w:r><w:t xml:space="preserve">${esc(bodyText)}</w:t></w:r></w:p>` +
        '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>' +
        '</w:body></w:document>', 'utf8'),
    },
  ]);
}

// ─── Real PPTX (minimal OOXML — one blank slide) ────────────────────────────
function buildPptx(titleText) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const CT  =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
    '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
    '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
    '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>' +
    '</Types>';
  const rootRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>' +
    '</Relationships>';
  const presXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
    '<p:sldSz cx="9144000" cy="6858000" type="screen4x3"/>' +
    '<p:notesSz cx="6858000" cy="9144000"/>' +
    '<p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst>' +
    '</p:presentation>';
  const presRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>' +
    '</Relationships>';
  const masterXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<p:sldMaster xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
    '</p:spTree></p:cSld>' +
    '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
    '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
    '<p:txStyles><p:titleStyle><a:lstStyle/></p:titleStyle><p:bodyStyle><a:lstStyle/></p:bodyStyle><p:otherStyle><a:lstStyle/></p:otherStyle></p:txStyles>' +
    '</p:sldMaster>';
  const masterRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
    '</Relationships>';
  const layoutXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" type="blank">' +
    '<p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
    '</p:spTree></p:cSld>' +
    '<p:clrMapOvr><a:masterClr/></p:clrMapOvr>' +
    '</p:sldLayout>';
  const layoutRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>' +
    '</Relationships>';
  const slideXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>' +
    '<p:spPr><a:xfrm><a:off x="457200" y="274638"/><a:ext cx="8229600" cy="1143000"/></a:xfrm></p:spPr>' +
    `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${esc(titleText)}</a:t></a:r></a:p></p:txBody></p:sp>` +
    '</p:spTree></p:cSld>' +
    '<p:clrMapOvr><a:masterClr/></p:clrMapOvr>' +
    '</p:sld>';
  const slideRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
    '</Relationships>';

  return buildZip([
    { name: '[Content_Types].xml',                       data: Buffer.from(CT,         'utf8') },
    { name: '_rels/.rels',                               data: Buffer.from(rootRels,   'utf8') },
    { name: 'ppt/presentation.xml',                      data: Buffer.from(presXml,    'utf8') },
    { name: 'ppt/_rels/presentation.xml.rels',           data: Buffer.from(presRels,   'utf8') },
    { name: 'ppt/slideMasters/slideMaster1.xml',         data: Buffer.from(masterXml,  'utf8') },
    { name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: Buffer.from(masterRels, 'utf8') },
    { name: 'ppt/slideLayouts/slideLayout1.xml',         data: Buffer.from(layoutXml,  'utf8') },
    { name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: Buffer.from(layoutRels, 'utf8') },
    { name: 'ppt/slides/slide1.xml',                     data: Buffer.from(slideXml,   'utf8') },
    { name: 'ppt/slides/_rels/slide1.xml.rels',          data: Buffer.from(slideRels,  'utf8') },
  ]);
}

// ─── Raw PDF builder (guaranteed visible text — no pdfkit) ─────────────────
function buildRawPdf(pages) {
  const esc = (s) =>
    String(s || '').replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)').replace(/[^\x20-\x7E]/g,' ');
  const N = pages.length, CATALOG = 1, PAGES_OBJ = 2, FONT_OBJ = 2*N+3;
  const pageNums   = Array.from({length:N},(_,i)=>3+i);
  const streamNums = Array.from({length:N},(_,i)=>N+3+i);
  const streams = pages.map(({title,lines=[]})=>{
    const ops=['BT','/F1 16 Tf','20 TL','72 720 Td',`(${esc(title)}) Tj`,'/F1 9 Tf','16 TL','T*',`(${'-'.repeat(72)}) Tj`,'/F1 11 Tf','15 TL','T*'];
    for(const l of lines){ops.push(`(${esc(l)}) Tj`,'T*');}
    ops.push('ET');
    return ops.join('\n')+'\n';
  });
  const objs=new Map();
  objs.set(CATALOG,  `${CATALOG} 0 obj\n<< /Type /Catalog /Pages ${PAGES_OBJ} 0 R >>\nendobj\n`);
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

// ─── XLSX via xlsx library (type:'base64' avoids Uint8Array→base64 bug) ────
function buildXlsx(rows) {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, 'Migration Tracker');
  // type:'base64' returns a string directly — avoids SheetJS Uint8Array issue
  return XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
}

// ─── Real ZIP containing two text files ────────────────────────────────────
function buildZipBundle() {
  return buildZip([
    { name: 'qa-migration-log.txt',   data: Buffer.from('Migration log\n=============\nStep 1: Pre-scan complete\nStep 2: Migration initiated\nStep 3: Validation in progress\n', 'utf8') },
    { name: 'qa-user-mapping.csv',    data: Buffer.from('Source,Destination\nron@qatestagent.com,ron@migrationn.com\nben@qatestagent.com,ben@migrationn.com\n', 'utf8') },
  ]);
}

// ─── Static: valid 1×1 transparent PNG ─────────────────────────────────────
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAABjE+ibYAAAAASUVORK5CYII=';

// ─── Build all attachments (synchronous) ────────────────────────────────────
function buildAttachments() {
  const pdfBuf  = buildRawPdf([{ title: 'QA Migration Report', lines: ['Generated for in-place archive QA testing.','','Verifies PDF attachments survive migration with correct content.','Source: ron@qatestagent.com (Outlook)','Dest:   ron@migrationn.com   (Gmail)','Status: PASS'] }]);
  const pdfBuf2 = buildRawPdf([{ title: 'QA Final Report', lines: ['Final migration validation report.','','All checks complete. See attachment summary for details.','Folders: 23/23  Messages: 186/187  Drafts: 10/10','Result: PASS'] }]);
  const docxBuf = buildDocx('QA Migration Plan', 'This Word document was created for in-place archive QA testing.\n\nSection 1: Pre-migration checklist\nSection 2: Migration steps\nSection 3: Post-migration validation');
  // buildXlsx returns base64 string directly (avoids SheetJS Uint8Array issue)
  const xlsxB64 = buildXlsx([
    ['User', 'Source Email', 'Destination Email', 'Folder Count', 'Message Count', 'Status'],
    ['Ron',  'ron@qatestagent.com',  'ron@migrationn.com',  '12', '187', 'Complete'],
    ['Ben',  'ben@qatestagent.com',  'ben@migrationn.com',  '10', '142', 'Complete'],
    ['Dan',  'dan@qatestagent.com',  'dan@migrationn.com',   '8',  '98', 'In Progress'],
    ['Alex', 'alex@qatestagent.com', 'alex@migrationn.com',  '9', '115', 'Pending'],
  ]);
  const pptxBuf = buildPptx('QA Migration Kickoff — Attachment Test');
  const zipBuf  = buildZipBundle();
  const csvBuf  = Buffer.from('Name,Email,Department,Role\nAlice,alice@qatestagent.com,Engineering,Lead\nBob,bob@qatestagent.com,Marketing,Manager\nCarol,carol@qatestagent.com,Sales,Executive\n');
  const txtBuf  = Buffer.from('QA Archive Test Notes\n======================\nLine 1: Validate attachment migration fidelity\nLine 2: Check file name preservation\nLine 3: Verify MIME type after migration\nLine 4: Confirm flag and importance carry over\n');

  return { pdfBuf, pdfBuf2, docxBuf, xlsxB64, pptxBuf, zipBuf, csvBuf, txtBuf };
}

// ─── Email definitions (built after attachments are ready) ──────────────────
function buildMessages(atts) {
  // Buffer.from() handles both Buffer and Uint8Array safely
  const b64 = (buf) => Buffer.from(buf).toString('base64');

  return [
    {
      subject: '[QA-Attach] 1 - PDF + Flagged + High Importance',
      body: {
        contentType: 'HTML',
        content: `<html><body>
          <p>This email has a <b>real PDF attachment</b>, is flagged and marked high importance.</p>
          <ul>
            <li><a href="https://www.cloudfuze.com">CloudFuze Migration Platform</a></li>
            <li><a href="https://learn.microsoft.com/en-us/exchange/policy-and-compliance/in-place-archiving/in-place-archiving">In-Place Archive Docs (Microsoft)</a></li>
          </ul>
        </body></html>`,
      },
      importance: 'high',
      flag: { flagStatus: 'flagged' },
      isRead: false,
      receivedDateTime: '2022-04-15T09:00:00Z',
      sentDateTime:     '2022-04-15T08:58:00Z',
      attachments: [{ name: 'qa-report.pdf', contentType: 'application/pdf', contentBytes: b64(atts.pdfBuf) }],
    },
    {
      subject: '[QA-Attach] 2 - DOCX + body links',
      body: {
        contentType: 'HTML',
        content: `<html><body>
          <p>Real Word document attached — verifies DOCX structure survives migration.</p>
          <p>Reference: <a href="https://docs.microsoft.com/en-us/graph/overview">Microsoft Graph API Overview</a></p>
          <p>Dashboard: <a href="https://portal.azure.com">Azure Portal</a></p>
        </body></html>`,
      },
      importance: 'normal',
      isRead: true,
      receivedDateTime: '2022-06-20T11:30:00Z',
      sentDateTime:     '2022-06-20T11:28:00Z',
      attachments: [{ name: 'qa-migration-plan.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', contentBytes: b64(atts.docxBuf) }],
    },
    {
      subject: '[QA-Attach] 3 - XLSX spreadsheet + High Importance',
      body: {
        contentType: 'HTML',
        content: `<html><body>
          <p>Migration tracking spreadsheet attached — <strong>Action Required</strong>.</p>
          <p>View live dashboard: <a href="https://app.powerbi.com">Power BI</a></p>
          <p>Admin center: <a href="https://admin.microsoft.com">Microsoft 365 Admin</a></p>
        </body></html>`,
      },
      importance: 'high',
      isRead: false,
      receivedDateTime: '2022-08-10T14:00:00Z',
      sentDateTime:     '2022-08-10T13:58:00Z',
      attachments: [{ name: 'qa-migration-tracker.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', contentBytes: atts.xlsxB64 }],
    },
    {
      subject: '[QA-Attach] 4 - PNG image + Flagged',
      body: {
        contentType: 'HTML',
        content: `<html><body>
          <p>Screenshot attached for your review.</p>
          <p>Ticket: <a href="https://jira.example.com/browse/QA-101">QA-101 — Archive Migration</a></p>
          <p>Slack: <a href="https://slack.com">View thread in Slack</a></p>
        </body></html>`,
      },
      importance: 'normal',
      flag: { flagStatus: 'flagged' },
      isRead: false,
      receivedDateTime: '2022-10-05T08:45:00Z',
      sentDateTime:     '2022-10-05T08:43:00Z',
      attachments: [{ name: 'qa-screenshot.png', contentType: 'image/png', contentBytes: PNG_B64 }],
    },
    {
      subject: '[QA-Attach] 5 - CSV + TXT (multiple attachments)',
      body: {
        contentType: 'HTML',
        content: `<html><body>
          <p>Two attachments: CSV user list + plain-text notes file.</p>
          <p>See also: <a href="https://admin.microsoft.com">Microsoft 365 Admin Center</a></p>
          <p>Migration docs: <a href="https://learn.microsoft.com/en-us/exchange/mailbox-migration/mailbox-migration">Exchange Migration Guide</a></p>
        </body></html>`,
      },
      importance: 'normal',
      isRead: true,
      receivedDateTime: '2022-12-12T16:20:00Z',
      sentDateTime:     '2022-12-12T16:18:00Z',
      attachments: [
        { name: 'qa-users.csv',  contentType: 'text/csv',   contentBytes: atts.csvBuf.toString('base64') },
        { name: 'qa-notes.txt',  contentType: 'text/plain', contentBytes: atts.txtBuf.toString('base64') },
      ],
    },
    {
      subject: '[QA-Attach] 6 - ZIP bundle + Flagged + High Importance',
      body: {
        contentType: 'HTML',
        content: `<html><body>
          <h3>Quarterly Archive Package</h3>
          <p>ZIP contains migration log + user mapping CSV.</p>
          <ul>
            <li><a href="https://www.cloudfuze.com/support">CloudFuze Support</a></li>
            <li><a href="https://learn.microsoft.com/en-us/exchange">Exchange Online Docs</a></li>
            <li><a href="https://outlook.office.com">Outlook Web App</a></li>
          </ul>
          <p><strong>Review and confirm by end of week.</strong></p>
        </body></html>`,
      },
      importance: 'high',
      flag: { flagStatus: 'flagged' },
      isRead: false,
      categories: ['Red Category'],
      receivedDateTime: '2023-01-25T10:00:00Z',
      sentDateTime:     '2023-01-25T09:58:00Z',
      attachments: [{ name: 'qa-artifacts-q4-2022.zip', contentType: 'application/zip', contentBytes: b64(atts.zipBuf) }],
    },
    {
      subject: '[QA-Attach] 7 - PPTX presentation + body links',
      body: {
        contentType: 'HTML',
        content: `<html><body>
          <p>Migration kickoff presentation attached — real PPTX with one slide.</p>
          <ul>
            <li><a href="https://learn.microsoft.com/en-us/microsoft-365/enterprise/plan-for-directory-synchronization">Directory Sync Guide</a></li>
            <li><a href="https://learn.microsoft.com/en-us/exchange/mailbox-migration/mailbox-migration">Mailbox Migration Guide</a></li>
            <li><a href="https://admin.google.com">Google Workspace Admin</a></li>
          </ul>
        </body></html>`,
      },
      importance: 'normal',
      isRead: true,
      categories: ['Blue Category'],
      receivedDateTime: '2023-03-08T13:30:00Z',
      sentDateTime:     '2023-03-08T13:28:00Z',
      attachments: [{ name: 'qa-migration-kickoff.pptx', contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', contentBytes: b64(atts.pptxBuf) }],
    },
    {
      subject: '[QA-Attach] 8 - PDF + PNG (2 attachments) + Flagged + High Importance',
      body: {
        contentType: 'HTML',
        content: `<html><body>
          <h3>Final Migration Report</h3>
          <p>Two attachments: full PDF report + summary PNG chart.</p>
          <ul>
            <li><a href="https://www.cloudfuze.com">CloudFuze Home</a></li>
            <li><a href="https://admin.google.com">Google Admin Console</a></li>
            <li><a href="https://outlook.office.com">Outlook Web App</a></li>
            <li><a href="https://gmail.com">Gmail</a></li>
          </ul>
          <p><em>Action required by 2023-06-01.</em></p>
        </body></html>`,
      },
      importance: 'high',
      flag: { flagStatus: 'flagged' },
      isRead: false,
      categories: ['Red Category', 'Blue Category'],
      receivedDateTime: '2023-05-14T09:15:00Z',
      sentDateTime:     '2023-05-14T09:13:00Z',
      attachments: [
        { name: 'qa-final-report.pdf',  contentType: 'application/pdf', contentBytes: b64(atts.pdfBuf2) },
        { name: 'qa-summary-chart.png', contentType: 'image/png',       contentBytes: PNG_B64 },
      ],
    },
  ];
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('Building real file attachments…');
  const atts     = buildAttachments();
  const messages = buildMessages(atts);
  console.log(`Seeding ${messages.length} emails into ${TARGET} / ${FOLDER}\n`);

  let ok = 0;
  for (let i = 0; i < messages.length; i++) {
    const msg = {
      ...messages[i],
      from:         { emailAddress: { address: SENDER, name: 'Ben QA' } },
      toRecipients: [{ emailAddress: { address: TARGET,  name: 'Ron QA' } }],
    };
    try {
      await outlookClient.createMessageInFolder(TARGET, FOLDER, msg);
      const attList = (msg.attachments || []).map((a) => a.name).join(', ') || 'none';
      console.log(`  [${i + 1}/${messages.length}] ✓  ${msg.subject}`);
      console.log(`        attachments: ${attList}`);
      console.log(`        importance: ${msg.importance}  |  flag: ${msg.flag?.flagStatus || 'none'}`);
      ok++;
    } catch (err) {
      console.error(`  [${i + 1}/${messages.length}] ✗  ${msg.subject} — ${err.message}`);
    }
  }

  console.log(`\nDone — ${ok}/${messages.length} emails created in ${TARGET} / ${FOLDER}`);
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
