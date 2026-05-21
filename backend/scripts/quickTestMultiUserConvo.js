/**
 * quickTestMultiUserConvo.js
 *
 * Seeds a single 10-message back-and-forth conversation thread in
 * ron@qatestagent.com Inbox where every reply is from a DIFFERENT user.
 *
 * Thread: "Migration Approach Decision — EWS vs Graph API"
 * Participants: Granger, Ron, Alex, Ben, Dan, BT1, BT2, BT3
 *
 * Usage: cd backend && node scripts/quickTestMultiUserConvo.js
 */

'use strict';

require('../src/config/env');
const outlookClient = require('../src/clients/outlookClient');
const XLSX          = require('xlsx');

const TARGET = 'ron@qatestagent.com';

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
const ea = (u) => ({ emailAddress: u });

function addMinutes(iso, m) {
  return new Date(new Date(iso).getTime() + m * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ─── Simple attachment builders ───────────────────────────────────────────────
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
  const parts = [], central = []; let offset = 0;
  for (const { name, data } of files) {
    const nb = Buffer.from(name, 'utf8'), crc = crc32(data);
    const lh = Buffer.concat([Buffer.from([0x50,0x4B,0x03,0x04]),u16(20),u16(0),u16(0),u16(0),u16(0),u32(crc),u32(data.length),u32(data.length),u16(nb.length),u16(0),nb]);
    central.push(Buffer.concat([Buffer.from([0x50,0x4B,0x01,0x02]),u16(20),u16(20),u16(0),u16(0),u16(0),u16(0),u32(crc),u32(data.length),u32(data.length),u16(nb.length),u16(0),u16(0),u16(0),u16(0),u32(0),u32(offset),nb]));
    parts.push(lh, data); offset += lh.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.concat([Buffer.from([0x50,0x4B,0x05,0x06]),u16(0),u16(0),u16(files.length),u16(files.length),u32(cd.length),u32(offset),u16(0)]);
  return Buffer.concat([...parts, cd, eocd]);
}
function buildDocx(title, bodyText) {
  const esc = (s) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return buildZip([
    { name:'[Content_Types].xml', data:Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>','utf8')},
    { name:'_rels/.rels', data:Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>','utf8')},
    { name:'word/_rels/document.xml.rels', data:Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>','utf8')},
    { name:'word/document.xml', data:Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:b/><w:sz w:val="32"/></w:rPr><w:t>'+esc(title)+'</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">'+esc(bodyText)+'</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>','utf8')},
  ]);
}
function buildRawPdf(title, lines) {
  const esc = (s) => String(s||'').replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)').replace(/[^\x20-\x7E]/g,' ');
  const CATALOG=1,PAGES_OBJ=2,PAGE_OBJ=3,STREAM_OBJ=4,FONT_OBJ=5;
  const ops=['BT','/F1 14 Tf','18 TL','72 720 Td',`(${esc(title)}) Tj`,'/F1 9 Tf','14 TL','T*',`(${'-'.repeat(72)}) Tj`,'/F1 11 Tf','14 TL','T*'];
  for(const l of lines) ops.push(`(${esc(l)}) Tj`,'T*');
  ops.push('ET');
  const s = ops.join('\n')+'\n';
  const objs = new Map([
    [CATALOG, `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`],
    [PAGES_OBJ, `2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n`],
    [PAGE_OBJ, `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n`],
    [STREAM_OBJ, `4 0 obj\n<< /Length ${Buffer.byteLength(s,'ascii')} >>\nstream\n${s}endstream\nendobj\n`],
    [FONT_OBJ, `5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n`],
  ]);
  const header='%PDF-1.4\n';
  let off=Buffer.byteLength(header,'ascii');
  const offs=new Map();
  for(const n of [1,2,3,4,5]){offs.set(n,off);off+=Buffer.byteLength(objs.get(n),'ascii');}
  const pad=n=>String(n).padStart(10,'0');
  const xref=['xref','0 6','0000000000 65535 f ',...[1,2,3,4,5].map(n=>`${pad(offs.get(n))} 00000 n `)].join('\n')+'\n';
  const trailer=`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${off}\n%%EOF\n`;
  return Buffer.concat([Buffer.from(header,'ascii'),...[1,2,3,4,5].map(n=>Buffer.from(objs.get(n),'ascii')),Buffer.from(xref,'ascii'),Buffer.from(trailer,'ascii')]);
}
function buildXlsx(rows) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Comparison');
  return XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
}

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAABjE+ibYAAAAASUVORK5CYII=';
const b64 = (buf) => Buffer.from(buf).toString('base64');

// ─── Build attachments ────────────────────────────────────────────────────────
const pdfProposal = buildRawPdf('Migration Approach Comparison', [
  'Prepared by: Ron QA  |  2023-02-10',
  '',
  'OPTION A: EWS (Exchange Web Services)',
  '=====================================',
  'Pros:',
  '  - Supports backdated receivedDateTime / sentDateTime',
  '  - Direct MAPI property access (PR_* extended properties)',
  '  - Reliable for large mailbox migrations (>50k messages)',
  'Cons:',
  '  - Being deprecated by Microsoft (EWS retirement TBD)',
  '  - Complex SOAP XML — harder to maintain',
  '  - No support for modern Graph-only features',
  '',
  'OPTION B: Microsoft Graph API',
  '=============================',
  'Pros:',
  '  - Modern REST API — actively developed by Microsoft',
  '  - Full OAuth 2.0 support, easy token management',
  '  - Native support for Outlook features (categories, flags)',
  'Cons:',
  '  - Cannot set receivedDateTime on non-draft messages',
  '  - No direct extended property support for thread index',
  '  - Throttling limits lower than EWS in some scenarios',
  '',
  'RECOMMENDATION: Hybrid approach (EWS for injection + Graph for reads)',
]);

const xlsxComparison = buildXlsx([
  ['Feature', 'EWS', 'Graph API', 'Hybrid (Recommended)'],
  ['Backdate receivedDateTime',  '✓ Yes',    '✗ No',     '✓ Via EWS'],
  ['Thread chain linking',       '✓ Yes',    'Partial',  '✓ Via EWS headers'],
  ['Large attachments (>25MB)',  '✓ Yes',    'Chunked',  '✓ EWS handles directly'],
  ['Modern OAuth 2.0',           'Partial',  '✓ Yes',    '✓ Both'],
  ['Microsoft retirement risk',  'High',     'None',     'Low'],
  ['Category/flag support',      '✓ Yes',    '✓ Yes',    '✓ Yes'],
  ['API complexity',             'High',     'Low',      'Medium'],
  ['Throughput (msgs/min)',       '~300',     '~120',     '~300'],
  ['CloudFuze recommendation',   '—',        '—',        '✓ USE THIS'],
]);

const docxDecision = buildDocx('Migration Decision Record — EWS vs Graph API', [
  'Date: 2023-02-17',
  'Decision owner: Granger QA',
  'Participants: Ron, Alex, Ben, Dan, Blue Team 1, 2, 3',
  '',
  'DECISION',
  '========',
  'Adopt Hybrid approach: EWS for message injection (full metadata',
  'control) + Microsoft Graph for reads, folder management, and',
  'modern features like categories, mentions, and calendar.',
  '',
  'RATIONALE',
  '=========',
  '1. EWS enables backdating (critical for In-Place Archive testing)',
  '2. Graph API is the future — use for all read-only operations',
  '3. Hybrid gives us best of both until EWS retirement is confirmed',
  '4. Blue Team 3 (CloudFuze) confirmed the platform supports hybrid',
  '',
  'ACTION ITEMS',
  '============',
  '- Ron: Implement hybrid outlookClient.js wrapper     by 2023-03-01',
  '- Alex: Update migration scripts to use new client   by 2023-03-01',
  '- Ben: Write integration tests for both API paths    by 2023-03-08',
  '- Dan: Provision EWS + Graph credentials in vault    by 2023-02-24',
].join('\n'));

// ─── Thread definition ────────────────────────────────────────────────────────
const ROOT_SUBJECT = 'Migration Approach Decision — EWS vs Graph API';
const CHAIN_ID     = 'multiuser-convo';

// Base: 2023-02-10 09:00 UTC, replies every 25 minutes
const BASE = '2023-02-10T09:00:00Z';
const STEP = 25; // minutes between replies

const MESSAGES = [
  // ── msg 0 ── Granger kicks off the discussion
  {
    from: ea(U.granger),
    to:   [ea(U.ron), ea(U.alex), ea(U.ben)],
    cc:   [ea(U.dan), ea(U.bt1), ea(U.bt2), ea(U.bt3)],
    importance: 'high',
    flag: { flagStatus: 'flagged' },
    isRead: false,
    attachments: [{ name: 'approach-comparison.pdf', contentType: 'application/pdf', contentBytes: b64(pdfProposal) }],
    body: {
      contentType: 'HTML',
      content: `<html><body style="font-family:Calibri,Arial,sans-serif;font-size:14px">
        <p>Team,</p>
        <p>We need to make a final decision on our migration API approach before Q2 planning. I've attached a comparison PDF.</p>
        <p><strong>Question:</strong> Should we standardise on <strong>EWS</strong>, <strong>Microsoft Graph</strong>, or a <strong>hybrid</strong> approach?</p>
        <p>Please share your perspective by EOD — this affects the entire Q2 roadmap.</p>
        <p>Tagging: <a href="mailto:ron@qatestagent.com" style="color:#0078D4">@Ron</a> (validation lead),
           <a href="mailto:Alex@qatestagent.com" style="color:#0078D4">@Alex</a> (migration lead),
           <a href="mailto:ben@qatestagent.com" style="color:#0078D4">@Ben</a> (tech lead),
           <a href="mailto:dan@qatestagent.com" style="color:#0078D4">@Dan</a> (infra),
           <a href="mailto:Blueteam3@cloudfuze.com" style="color:#0078D4">@Blue Team 3</a> (CloudFuze platform).</p>
        <p>— Granger</p>
      </body></html>`,
    },
  },

  // ── msg 1 ── Ron replies with EWS recommendation
  {
    from: ea(U.ron),
    to:   [ea(U.granger), ea(U.alex), ea(U.ben)],
    cc:   [ea(U.dan)],
    isRead: true,
    categories: ['Blue Category'],
    body: {
      contentType: 'HTML',
      content: `<html><body style="font-family:Calibri,Arial,sans-serif;font-size:14px">
        <p><a href="mailto:Granger@qatestagent.com" style="color:#0078D4">@Granger</a>,</p>
        <p>My recommendation: <strong>EWS first, Graph later</strong>.</p>
        <p>Key reasons from a <em>validation</em> perspective:</p>
        <ol>
          <li>EWS lets us set <code>receivedDateTime</code> and <code>sentDateTime</code> — critical for In-Place Archive testing</li>
          <li>Thread chain linking (<code>PR_IN_REPLY_TO</code>, <code>PR_INTERNET_REFERENCES</code>) only works reliably via EWS</li>
          <li>Extended properties for importance, flags, categories are more granular via EWS MAPI properties</li>
        </ol>
        <p>That said, EWS retirement risk is real. I'd suggest a hybrid wrapper that uses EWS for <em>injection</em> and Graph for <em>reads</em>.</p>
        <p><a href="mailto:Alex@qatestagent.com" style="color:#0078D4">@Alex</a> — what does the migration engine currently use?</p>
        <p>— Ron</p>
        <hr style="border:none;border-top:1px solid #eee"/>
        <blockquote style="border-left:3px solid #ccc;padding-left:12px;color:#555;font-size:12px">From: Granger QA — Should we standardise on EWS, Graph, or hybrid?</blockquote>
      </body></html>`,
    },
  },

  // ── msg 2 ── Alex with a different take (prefers Graph)
  {
    from: ea(U.alex),
    to:   [ea(U.ron), ea(U.granger), ea(U.ben)],
    cc:   [ea(U.bt3)],
    isRead: true,
    body: {
      contentType: 'HTML',
      content: `<html><body style="font-family:Calibri,Arial,sans-serif;font-size:14px">
        <p><a href="mailto:ron@qatestagent.com" style="color:#0078D4">@Ron</a>, <a href="mailto:Granger@qatestagent.com" style="color:#0078D4">@Granger</a>,</p>
        <p>I'm going to push back a little — the migration engine already uses Graph for 70% of operations and it's been solid.</p>
        <p>My concern with doubling down on EWS:</p>
        <ul>
          <li>Microsoft EWS deprecation is listed on their roadmap (no firm date but it's coming)</li>
          <li>Onboarding new engineers is harder with SOAP/EWS vs REST/Graph</li>
          <li>Graph's <code>/sendMail</code> and <code>/messages</code> endpoints handle 99% of our use cases</li>
        </ul>
        <p>I can accept a hybrid for the archive edge cases, but I don't want to build <em>new</em> features on EWS.</p>
        <p><a href="mailto:Blueteam3@cloudfuze.com" style="color:#0078D4">@Blue Team 3</a> — what does CloudFuze platform use internally? That should inform our decision.</p>
        <p>— Alex</p>
        <hr style="border:none;border-top:1px solid #eee"/>
        <blockquote style="border-left:3px solid #ccc;padding-left:12px;color:#555;font-size:12px">Ron: EWS lets us set receivedDateTime — critical for archive testing</blockquote>
      </body></html>`,
    },
  },

  // ── msg 3 ── Ben brings benchmark data + XLSX
  {
    from: ea(U.ben),
    to:   [ea(U.ron), ea(U.alex), ea(U.granger)],
    cc:   [ea(U.dan), ea(U.bt1)],
    isRead: true,
    attachments: [{ name: 'api-benchmark-comparison.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', contentBytes: xlsxComparison }],
    body: {
      contentType: 'HTML',
      content: `<html><body style="font-family:Calibri,Arial,sans-serif;font-size:14px">
        <p>Let me bring some data to this discussion. Benchmark XLSX attached.</p>
        <p>Key findings from our 30-day production run:</p>
        <table style="border-collapse:collapse;font-size:13px;margin:8px 0">
          <tr style="background:#dce6f1"><th style="border:1px solid #bbb;padding:4px 12px">Metric</th><th style="border:1px solid #bbb;padding:4px 12px">EWS</th><th style="border:1px solid #bbb;padding:4px 12px">Graph</th></tr>
          <tr><td style="border:1px solid #bbb;padding:4px 12px">Throughput (msgs/min)</td><td style="border:1px solid #bbb;padding:4px 12px"><strong>~300</strong></td><td style="border:1px solid #bbb;padding:4px 12px">~120</td></tr>
          <tr><td style="border:1px solid #bbb;padding:4px 12px">Error rate</td><td style="border:1px solid #bbb;padding:4px 12px">0.3%</td><td style="border:1px solid #bbb;padding:4px 12px">0.8%</td></tr>
          <tr><td style="border:1px solid #bbb;padding:4px 12px">Backdate support</td><td style="border:1px solid #bbb;padding:4px 12px">✓</td><td style="border:1px solid #bbb;padding:4px 12px">✗</td></tr>
          <tr><td style="border:1px solid #bbb;padding:4px 12px">Thread linking</td><td style="border:1px solid #bbb;padding:4px 12px">✓</td><td style="border:1px solid #bbb;padding:4px 12px">Partial</td></tr>
        </table>
        <p>EWS wins on throughput and completeness. But <a href="mailto:Alex@qatestagent.com" style="color:#0078D4">@Alex</a>'s point about retirement risk is valid.</p>
        <p><a href="mailto:dan@qatestagent.com" style="color:#0078D4">@Dan</a> — can infra support both API credentials long-term?</p>
        <p>— Ben</p>
        <hr style="border:none;border-top:1px solid #eee"/>
        <blockquote style="border-left:3px solid #ccc;padding-left:12px;color:#555;font-size:12px">Alex: I can accept hybrid for archive edge cases</blockquote>
      </body></html>`,
    },
  },

  // ── msg 4 ── Dan from infrastructure angle
  {
    from: ea(U.dan),
    to:   [ea(U.ron), ea(U.granger), ea(U.alex), ea(U.ben)],
    cc:   [ea(U.bt1), ea(U.bt2)],
    isRead: true,
    importance: 'normal',
    body: {
      contentType: 'HTML',
      content: `<html><body style="font-family:Calibri,Arial,sans-serif;font-size:14px">
        <p><a href="mailto:ben@qatestagent.com" style="color:#0078D4">@Ben</a> — yes, infra can absolutely support both credential sets in the vault. We already have separate app registrations for EWS and Graph.</p>
        <p>From infrastructure perspective:</p>
        <ul>
          <li>Both APIs share the same Azure AD tenant — single credential rotation cycle</li>
          <li>EWS token TTL is 60 min; Graph is 60 min too — no operational difference</li>
          <li>Monitoring: we have alerting on both endpoints already</li>
          <li>Disaster recovery: Graph has better SLA documentation from Microsoft</li>
        </ul>
        <p><strong>My vote: hybrid.</strong> No infra objection. Provision both, use EWS where Graph can't do it.</p>
        <p><a href="mailto:Blueteam1@qatestagent.com" style="color:#0078D4">@Blue Team 1</a> — anything from the EWS config side we should flag?</p>
        <p>— Dan</p>
        <hr style="border:none;border-top:1px solid #eee"/>
        <blockquote style="border-left:3px solid #ccc;padding-left:12px;color:#555;font-size:12px">Ben: EWS wins on throughput 300 vs 120 msgs/min</blockquote>
      </body></html>`,
    },
  },

  // ── msg 5 ── Blue Team 1 adds EWS config notes
  {
    from: ea(U.bt1),
    to:   [ea(U.ron), ea(U.granger), ea(U.dan)],
    cc:   [ea(U.bt2), ea(U.alex)],
    isRead: true,
    body: {
      contentType: 'HTML',
      content: `<html><body style="font-family:Calibri,Arial,sans-serif;font-size:14px">
        <p><a href="mailto:dan@qatestagent.com" style="color:#0078D4">@Dan</a>,</p>
        <p>From EWS configuration standpoint — a couple of things to flag:</p>
        <ol>
          <li><strong>EWS throttling policy</strong>: default allows 300 concurrent connections. We hit this limit for mailboxes with >5k messages. Recommend requesting a throttling policy increase from Microsoft.</li>
          <li><strong>EWS impersonation scope</strong>: app needs <code>full_access_as_app</code> permission at tenant level — this is broader than Graph's scoped permissions.</li>
          <li><strong>Distinguished folder changes</strong>: Exchange Online has changed folder IDs twice in 2022 (the "archive" rename we debugged last month). Build in a fallback detection.</li>
        </ol>
        <p>All manageable. Hybrid approach is our recommendation too. <a href="mailto:Blueteam3@cloudfuze.com" style="color:#0078D4">@Blue Team 3</a> has the most experience here.</p>
        <p>— Blue Team 1</p>
        <hr style="border:none;border-top:1px solid #eee"/>
        <blockquote style="border-left:3px solid #ccc;padding-left:12px;color:#555;font-size:12px">Dan: Infra can support both. My vote: hybrid.</blockquote>
      </body></html>`,
    },
  },

  // ── msg 6 ── Blue Team 2 adds scale testing data + screenshot
  {
    from: ea(U.bt2),
    to:   [ea(U.ron), ea(U.bt1), ea(U.granger)],
    cc:   [ea(U.alex), ea(U.ben)],
    isRead: true,
    attachments: [{ name: 'scale-test-screenshot.png', contentType: 'image/png', contentBytes: PNG_B64 }],
    body: {
      contentType: 'HTML',
      content: `<html><body style="font-family:Calibri,Arial,sans-serif;font-size:14px">
        <p>Adding scale test results (screenshot attached).</p>
        <p>We tested both APIs at 50k message mailboxes:</p>
        <ul>
          <li>EWS: completed in <strong>2.8 hours</strong>, 0 errors, full metadata preserved</li>
          <li>Graph: completed in <strong>7.1 hours</strong>, 4 errors (attachment chunking edge case), metadata partial</li>
          <li>Hybrid (EWS inject + Graph reads): <strong>2.9 hours</strong>, 0 errors, full metadata preserved</li>
        </ul>
        <p>Hybrid adds &lt;5% overhead but gives us the Graph fallback path for future-proofing.</p>
        <p><strong>Hybrid is the clear winner at scale.</strong></p>
        <p><a href="mailto:ron@qatestagent.com" style="color:#0078D4">@Ron</a> — the thread linking works end-to-end in our hybrid test. <code>PR_IN_REPLY_TO</code> preserved correctly.</p>
        <p>— Blue Team 2</p>
        <hr style="border:none;border-top:1px solid #eee"/>
        <blockquote style="border-left:3px solid #ccc;padding-left:12px;color:#555;font-size:12px">BT1: EWS throttling + distinguished folder changes — manageable</blockquote>
      </body></html>`,
    },
  },

  // ── msg 7 ── Blue Team 3 (CloudFuze) platform perspective
  {
    from: ea(U.bt3),
    to:   [ea(U.ron), ea(U.granger), ea(U.alex)],
    cc:   [ea(U.ben), ea(U.dan), ea(U.bt1), ea(U.bt2)],
    isRead: true,
    importance: 'high',
    categories: ['Blue Category'],
    body: {
      contentType: 'HTML',
      content: `<html><body style="font-family:Calibri,Arial,sans-serif;font-size:14px">
        <p>CloudFuze platform perspective:</p>
        <p>We process <strong>2M+ mailbox migrations per year</strong> — here's what we've learned:</p>
        <ol>
          <li><strong>Hybrid is what we use in production.</strong> EWS for injection, Graph for everything else.</li>
          <li>Microsoft has NOT announced EWS retirement. The "deprecation" warnings are for on-premises Exchange, not Exchange Online. EWS Online is stable for at least 3-5 years.</li>
          <li>New Graph API migration endpoints (<code>/migrateExternalEmails</code>) are still in beta — not production-ready for our use case.</li>
          <li>The CloudFuze platform can support your hybrid implementation. We'll provide the EWS token management library.</li>
        </ol>
        <p>References:</p>
        <ul>
          <li><a href="https://learn.microsoft.com/en-us/exchange/client-developer/exchange-web-services/ews-applications-and-the-exchange-architecture">EWS Architecture — Microsoft Docs</a></li>
          <li><a href="https://learn.microsoft.com/en-us/graph/api/resources/mail-api-overview">Graph Mail API Overview</a></li>
          <li><a href="https://www.cloudfuze.com">CloudFuze Platform</a></li>
        </ul>
        <p>— Blue Team 3 (CloudFuze)</p>
        <hr style="border:none;border-top:1px solid #eee"/>
        <blockquote style="border-left:3px solid #ccc;padding-left:12px;color:#555;font-size:12px">BT2: Hybrid completed 50k mailbox in 2.9 hours, 0 errors</blockquote>
      </body></html>`,
    },
  },

  // ── msg 8 ── Ron summarises and proposes decision
  {
    from: ea(U.ron),
    to:   [ea(U.granger), ea(U.alex), ea(U.ben), ea(U.dan), ea(U.bt1), ea(U.bt2), ea(U.bt3)],
    isRead: true,
    flag: { flagStatus: 'flagged' },
    categories: ['Red Category'],
    body: {
      contentType: 'HTML',
      content: `<html><body style="font-family:Calibri,Arial,sans-serif;font-size:14px">
        <p>Team — based on all the input, here's my recommendation to <a href="mailto:Granger@qatestagent.com" style="color:#0078D4">@Granger</a>:</p>
        <p><strong>Decision: Hybrid approach (EWS injection + Graph reads)</strong></p>
        <p>Summary of votes:</p>
        <table style="border-collapse:collapse;font-size:13px;margin:8px 0">
          <tr style="background:#dce6f1"><th style="border:1px solid #bbb;padding:4px 12px">Person</th><th style="border:1px solid #bbb;padding:4px 12px">Vote</th><th style="border:1px solid #bbb;padding:4px 12px">Rationale</th></tr>
          <tr><td style="border:1px solid #bbb;padding:4px 12px">Ron</td><td style="border:1px solid #bbb;padding:4px 12px">Hybrid</td><td style="border:1px solid #bbb;padding:4px 12px">Backdate + thread linking</td></tr>
          <tr><td style="border:1px solid #bbb;padding:4px 12px">Alex</td><td style="border:1px solid #bbb;padding:4px 12px">Hybrid</td><td style="border:1px solid #bbb;padding:4px 12px">Graph for new features</td></tr>
          <tr><td style="border:1px solid #bbb;padding:4px 12px">Ben</td><td style="border:1px solid #bbb;padding:4px 12px">Hybrid</td><td style="border:1px solid #bbb;padding:4px 12px">EWS 2.5x throughput</td></tr>
          <tr><td style="border:1px solid #bbb;padding:4px 12px">Dan</td><td style="border:1px solid #bbb;padding:4px 12px">Hybrid</td><td style="border:1px solid #bbb;padding:4px 12px">No infra objection</td></tr>
          <tr><td style="border:1px solid #bbb;padding:4px 12px">Blue Team 1/2</td><td style="border:1px solid #bbb;padding:4px 12px">Hybrid</td><td style="border:1px solid #bbb;padding:4px 12px">Scale test confirms</td></tr>
          <tr><td style="border:1px solid #bbb;padding:4px 12px">Blue Team 3</td><td style="border:1px solid #bbb;padding:4px 12px">Hybrid</td><td style="border:1px solid #bbb;padding:4px 12px">Production-proven approach</td></tr>
        </table>
        <p><strong>Unanimous: Hybrid</strong> ✅</p>
        <p>Waiting for <a href="mailto:Granger@qatestagent.com" style="color:#0078D4">@Granger</a>'s final sign-off to make this official.</p>
        <p>— Ron</p>
        <hr style="border:none;border-top:1px solid #eee"/>
        <blockquote style="border-left:3px solid #ccc;padding-left:12px;color:#555;font-size:12px">BT3: Hybrid is what CloudFuze uses in production</blockquote>
      </body></html>`,
    },
  },

  // ── msg 9 ── Granger gives final decision + decision record DOCX
  {
    from: ea(U.granger),
    to:   [ea(U.ron), ea(U.alex), ea(U.ben), ea(U.dan), ea(U.bt1), ea(U.bt2), ea(U.bt3)],
    isRead: false,
    importance: 'high',
    flag: { flagStatus: 'flagged' },
    categories: ['Green Category'],
    attachments: [{ name: 'migration-decision-record.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', contentBytes: b64(docxDecision) }],
    body: {
      contentType: 'HTML',
      content: `<html><body style="font-family:Calibri,Arial,sans-serif;font-size:14px">
        <p>✅ <strong>DECISION CONFIRMED: Hybrid approach (EWS + Graph)</strong></p>
        <p>Formal decision record attached (DOCX). This is the architectural baseline for Q2 2023.</p>
        <p><strong>Action items:</strong></p>
        <ul>
          <li><a href="mailto:ron@qatestagent.com" style="color:#0078D4">@Ron</a> — Implement hybrid <code>outlookClient.js</code> wrapper by <strong>2023-03-01</strong></li>
          <li><a href="mailto:Alex@qatestagent.com" style="color:#0078D4">@Alex</a> — Update migration scripts by <strong>2023-03-01</strong></li>
          <li><a href="mailto:ben@qatestagent.com" style="color:#0078D4">@Ben</a> — Write integration tests for both API paths by <strong>2023-03-08</strong></li>
          <li><a href="mailto:dan@qatestagent.com" style="color:#0078D4">@Dan</a> — Provision credentials in vault by <strong>2023-02-24</strong></li>
          <li><a href="mailto:Blueteam3@cloudfuze.com" style="color:#0078D4">@Blue Team 3</a> — Share EWS token management library by <strong>2023-02-20</strong></li>
        </ul>
        <p>Well done everyone — this was a great technical discussion. 👏</p>
        <p>Reference: <a href="https://learn.microsoft.com/en-us/exchange/client-developer/exchange-web-services/ews-applications-and-the-exchange-architecture">EWS Architecture (Microsoft Docs)</a></p>
        <p>— Granger</p>
        <hr style="border:none;border-top:1px solid #eee"/>
        <blockquote style="border-left:3px solid #ccc;padding-left:12px;color:#555;font-size:12px">Ron: Unanimous vote — Hybrid ✅ Awaiting your sign-off.</blockquote>
      </body></html>`,
    },
  },
];

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const total = MESSAGES.length;
  const msgIds = MESSAGES.map((_, i) => `<${CHAIN_ID}-m${i + 1}@qatestagent.com>`);

  console.log(`Seeding ${total}-message multi-user conversation into ${TARGET}/inbox\n`);
  console.log(`Subject: "${ROOT_SUBJECT}"`);
  console.log(`Participants: Granger, Ron, Alex, Ben, Dan, BT1, BT2, BT3\n`);

  let ok = 0;
  for (let i = 0; i < MESSAGES.length; i++) {
    const spec = MESSAGES[i];
    const receivedDt = addMinutes(BASE, i * STEP);
    const sentDt     = addMinutes(BASE, i * STEP - 2);

    const msg = {
      ...spec,
      subject:          i === 0 ? ROOT_SUBJECT : `RE: ${ROOT_SUBJECT}`,
      receivedDateTime: receivedDt,
      sentDateTime:     sentDt,
      internetMessageId: msgIds[i],
      inReplyTo:        i > 0 ? msgIds[i - 1] : undefined,
      references:       i > 0 ? msgIds.slice(0, i).join(' ') : undefined,
    };

    try {
      await outlookClient.createMessageInFolder(TARGET, 'inbox', msg);
      const sender  = spec.from.emailAddress.name;
      const attList = (spec.attachments || []).map((a) => a.name).join(', ') || 'none';
      console.log(`  [${i + 1}/${total}] ✓  FROM: ${sender.padEnd(22)} | ${msg.subject}`);
      if (attList !== 'none') console.log(`         attachments: ${attList}`);
      ok++;
    } catch (err) {
      console.error(`  [${i + 1}/${total}] ✗  ${err.message}`);
    }
  }

  console.log(`\nDone — ${ok}/${total} messages created.`);
  console.log(`\nSenders in order:`);
  MESSAGES.forEach((m, i) => {
    console.log(`  ${String(i + 1).padStart(2)}. ${m.from.emailAddress.name}`);
  });
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
