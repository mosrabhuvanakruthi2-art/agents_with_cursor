/**
 * quickTestTxtPdf.js
 *
 * Seeds ron@qatestagent.com Inbox with varied TXT and PDF attachment scenarios.
 * All emails backdated 2022-2023 for in-place archive testing.
 *
 * Usage:
 *   cd backend && node scripts/quickTestTxtPdf.js
 */

'use strict';

require('../src/config/env');
const outlookClient = require('../src/clients/outlookClient');

const TARGET = 'ron@qatestagent.com';
const SENDER = 'ben@qatestagent.com';
const FOLDER = 'inbox';

// ─── Raw PDF builder (no external lib — guaranteed visible text) ────────────
//
// buildRawPdf(pages) where pages = [{title, lines: string[]}]
// Each page element becomes one physical PDF page.
//
function buildRawPdf(pages) {
  const esc = (s) =>
    String(s || '')
      .replace(/\\/g, '\\\\')
      .replace(/\(/g,  '\\(')
      .replace(/\)/g,  '\\)')
      .replace(/[^\x20-\x7E]/g, ' ');   // strip non-printable (Helvetica is Latin-1)

  const N          = pages.length;
  const CATALOG    = 1;
  const PAGES_OBJ  = 2;
  const FONT_OBJ   = 2 * N + 3;
  const pageNums   = Array.from({ length: N }, (_, i) => 3 + i);
  const streamNums = Array.from({ length: N }, (_, i) => N + 3 + i);

  // Build content stream for each page
  const streams = pages.map(({ title, lines = [] }) => {
    const ops = [
      'BT',
      '/F1 16 Tf',
      '20 TL',          // line leading for title block
      '72 720 Td',      // top-left anchor (72pt from left, 720pt from bottom on A4)
      `(${esc(title)}) Tj`,
      '/F1 9 Tf',
      '16 TL',
      'T*',
      `(${'-'.repeat(72)}) Tj`,
      '/F1 11 Tf',
      '15 TL',
      'T*',
    ];
    for (const line of lines) {
      ops.push(`(${esc(line)}) Tj`, 'T*');
    }
    ops.push('ET');
    return ops.join('\n') + '\n';
  });

  // Assemble PDF objects
  const objs = new Map();
  objs.set(CATALOG,   `${CATALOG} 0 obj\n<< /Type /Catalog /Pages ${PAGES_OBJ} 0 R >>\nendobj\n`);
  objs.set(PAGES_OBJ, `${PAGES_OBJ} 0 obj\n<< /Type /Pages /Kids [${pageNums.map(n => `${n} 0 R`).join(' ')}] /Count ${N} >>\nendobj\n`);
  pageNums.forEach((n, i) => {
    objs.set(n, `${n} 0 obj\n<< /Type /Page /Parent ${PAGES_OBJ} 0 R /MediaBox [0 0 612 792]\n   /Contents ${streamNums[i]} 0 R /Resources << /Font << /F1 ${FONT_OBJ} 0 R >> >> >>\nendobj\n`);
  });
  streamNums.forEach((n, i) => {
    const s   = streams[i];
    const len = Buffer.byteLength(s, 'ascii');
    objs.set(n, `${n} 0 obj\n<< /Length ${len} >>\nstream\n${s}endstream\nendobj\n`);
  });
  objs.set(FONT_OBJ, `${FONT_OBJ} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n`);

  // Compute byte offsets for xref
  const header  = '%PDF-1.4\n';
  const allNums = Array.from({ length: FONT_OBJ }, (_, i) => i + 1);
  let offset    = Buffer.byteLength(header, 'ascii');
  const offsets = new Map();
  for (const n of allNums) {
    offsets.set(n, offset);
    offset += Buffer.byteLength(objs.get(n), 'ascii');
  }

  const pad   = (n) => String(n).padStart(10, '0');
  const xref  = ['xref', `0 ${FONT_OBJ + 1}`, '0000000000 65535 f ',
    ...allNums.map((n) => `${pad(offsets.get(n))} 00000 n `)].join('\n') + '\n';
  const trailer = `trailer\n<< /Size ${FONT_OBJ + 1} /Root ${CATALOG} 0 R >>\nstartxref\n${offset}\n%%EOF\n`;

  return Buffer.concat([
    Buffer.from(header, 'ascii'),
    ...allNums.map((n) => Buffer.from(objs.get(n), 'ascii')),
    Buffer.from(xref,    'ascii'),
    Buffer.from(trailer, 'ascii'),
  ]);
}

// ─── TXT file builders ──────────────────────────────────────────────────────
const txt = (content) => Buffer.from(content, 'utf8');

const LOREM = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. ';

// ─── Build all file buffers ─────────────────────────────────────────────────
function buildFiles() {
  // ── TXT variants ─────────────────────────────────────────────────────────

  // 1. Simple plain text
  const txtSimple = txt(
    'Migration Notes\n===============\nDate: 2022-05-10\nAuthor: Ben QA\n\nThis is a simple plain-text file attached to a migration test email.\nVerifies that TXT attachments survive with correct encoding.\n'
  );

  // 2. Large text file (~30 KB)
  const txtLarge = txt(
    'QA Large Text File\n==================\n\n' +
    Array.from({ length: 300 }, (_, i) =>
      `Line ${String(i + 1).padStart(4, '0')}: ${LOREM.slice(0, 80)}`
    ).join('\n') + '\n'
  );

  // 3. Log file (.log extension)
  const txtLog = txt(
    '[2022-07-01 08:00:01] INFO  Migration started for ron@qatestagent.com\n' +
    '[2022-07-01 08:00:05] INFO  Pre-scan: 187 messages, 23 folders\n' +
    '[2022-07-01 08:02:10] INFO  Batch 1/10 complete — 20 messages\n' +
    '[2022-07-01 08:04:22] INFO  Batch 2/10 complete — 20 messages\n' +
    '[2022-07-01 08:06:45] WARN  Attachment >10 MB skipped: qa-large-file.pptx\n' +
    '[2022-07-01 08:09:10] INFO  Batch 3/10 complete — 20 messages\n' +
    '[2022-07-01 08:11:30] INFO  Batch 4/10 complete — 19 messages\n' +
    '[2022-07-01 08:15:00] INFO  Migration complete: 159/160 messages migrated\n' +
    '[2022-07-01 08:15:01] INFO  Validation started\n' +
    '[2022-07-01 08:20:45] INFO  Validation result: PASS (0 mismatches)\n'
  );

  // 4. Config / INI file (.conf extension)
  const txtConf = txt(
    '[migration]\n' +
    'source_provider=OUTLOOK\n' +
    'dest_provider=GMAIL\n' +
    'source_email=ron@qatestagent.com\n' +
    'dest_email=ron@migrationn.com\n' +
    'delta_migration=false\n' +
    'max_retries=3\n' +
    'timeout_seconds=300\n\n' +
    '[validation]\n' +
    'deep_check=true\n' +
    'attachment_hash=true\n' +
    'subject_time_fallback=true\n' +
    'time_window_minutes=120\n\n' +
    '[logging]\n' +
    'level=info\n' +
    'output=migration.log\n'
  );

  // 5. Tab-separated values (.tsv)
  const txtTsv = txt(
    'User\tSource\tDestination\tFolders\tMessages\tStatus\n' +
    'Ron\tron@qatestagent.com\tron@migrationn.com\t12\t187\tComplete\n' +
    'Ben\tben@qatestagent.com\tben@migrationn.com\t10\t142\tComplete\n' +
    'Dan\tdan@qatestagent.com\tdan@migrationn.com\t8\t98\tIn Progress\n' +
    'Alex\talex@qatestagent.com\talex@migrationn.com\t9\t115\tPending\n'
  );

  // 6. Script / code snippet (.py extension, text content)
  const txtScript = txt(
    '#!/usr/bin/env python3\n' +
    '"""QA migration validation helper script."""\n\n' +
    'import json, sys\n\n' +
    'def load_report(path):\n' +
    '    with open(path) as f:\n' +
    '        return json.load(f)\n\n' +
    'def check_mismatches(report):\n' +
    '    issues = report.get("mismatches", [])\n' +
    '    if not issues:\n' +
    '        print("PASS — no mismatches")\n' +
    '    else:\n' +
    '        print(f"FAIL — {len(issues)} mismatch(es)")\n' +
    '        for i in issues:\n' +
    '            print(f"  - {i}")\n\n' +
    'if __name__ == "__main__":\n' +
    '    report = load_report(sys.argv[1])\n' +
    '    check_mismatches(report)\n'
  );

  // ── PDF variants (raw PDF builder — no pdfkit, guaranteed visible text) ──

  // 7. Simple single-page PDF
  const pdfSimple = buildRawPdf([{
    title: 'QA Migration Summary',
    lines: [
      'Date: 2022-09-15   |   Prepared by: Ben QA',
      '',
      'This is a simple one-page PDF attachment for migration QA testing.',
      'Verifies that PDF files are transported with correct content and file name.',
      '',
      'Source:  ron@qatestagent.com  (Outlook)',
      'Dest:    ron@migrationn.com   (Gmail)',
      'Status:  PASS',
    ],
  }]);

  // 8. Multi-page PDF (3 pages)
  const pdfMultiPage = buildRawPdf([
    {
      title: 'Page 1 - Executive Summary',
      lines: [
        'Migration completed: ron@qatestagent.com to ron@migrationn.com',
        '',
        'Total messages : 187   Migrated: 186   Failed: 1 (oversized)',
        'Total folders  : 23    Migrated: 23',
        'Duration       : 18 minutes',
        'Result         : PASS (with 1 warning)',
      ],
    },
    {
      title: 'Page 2 - Folder Breakdown',
      lines: [
        'Folder            Source  Dest  Status',
        '---------------------------------------------',
        'Inbox             72      72    Pass',
        'Sent Items        45      45    Pass',
        'Drafts            10      10    Pass',
        'Deleted Items     18      18    Pass',
        'Junk Email         5       5    Pass',
        'Archive            7       7    Pass',
        'Custom (x17)      30      29    Warn - 1 oversized',
      ],
    },
    {
      title: 'Page 3 - Recommendations',
      lines: [
        '1. Re-attempt migration for the 1 oversized attachment (>25 MB).',
        '2. Enable delta migration to capture emails received during the run.',
        '3. Ask users to verify sent items and drafts in the destination.',
        '4. Archive the migration log for compliance records.',
      ],
    },
  ]);

  // 9. Large PDF (8 pages)
  const pdfLarge = buildRawPdf(
    Array.from({ length: 8 }, (_, p) => ({
      title: `Section ${p + 1} - Migration Detail Block`,
      lines: [
        `This is page ${p + 1} of 8 in the large PDF stress test.`,
        '',
        LOREM.slice(0, 72),
        LOREM.slice(72, 144),
        LOREM.slice(144, 216),
        LOREM.slice(0, 72),
        LOREM.slice(72, 144),
        '',
        `Section ${p + 1} notes:`,
        '  - Check attachment hash after migration',
        '  - Verify file size matches source',
        '  - Confirm MIME type preserved',
      ],
    }))
  );

  // 10. Structured PDF (sections)
  const pdfStructured = buildRawPdf([{
    title: 'Migration Validation Report',
    lines: [
      'Generated: 2023-04-20   Run ID: QA-E2E-2023-04',
      '',
      '1. Tier A - Folder Count Comparison',
      '   Default folders : PASS (6/6 match)',
      '   Custom folders  : PASS (17/17 match)',
      '   Total messages  : WARN (187 src vs 186 dst)',
      '',
      '2. Tier A - Draft Comparison',
      '   Drafts: PASS (10/10 match)',
      '   Subjects, recipients, bodies all verified.',
      '',
      '3. Tier B - Deep Mail Validation',
      '   Sampled: 50   Passed: 48   Failed: 2',
      '   - Message-ID mismatch on 1 Archive folder message',
      '   - Subject truncation on 1 long-subject message',
      '',
      '4. Tier B - Attachment Hash',
      '   Checked: 34   Match: 32/34   Skipped (>10 MB): 2',
      '',
      '5. Recommendations',
      '   - Raise attachment hash limit from 10 MB to 30 MB',
      '   - Investigate Archive folder Message-ID preservation',
      '   - Re-run delta migration to capture missed message',
    ],
  }]);

  // 11. Two TXT files in one email (README + CHANGELOG)
  const txtReadme = txt(
    '# QA Migration Test Suite\n\n' +
    '## Overview\nThis repository contains QA test data for CloudFuze email migration.\n\n' +
    '## Folder Structure\n' +
    '  scripts/     — seed and test scripts\n' +
    '  data/        — test case definitions\n' +
    '  reports/     — validation output\n\n' +
    '## Usage\n' +
    '  node scripts/seedArchiveData.js\n' +
    '  node scripts/quickTestAttachments.js\n\n' +
    '## Contact\n' +
    '  qa@cloudfuze.com\n'
  );
  const txtChangelog = txt(
    'CHANGELOG\n=========\n\n' +
    'v1.3.0 (2023-05-01)\n' +
    '  - Added in-place archive test data seeder\n' +
    '  - Added real DOCX/PPTX/XLSX generation\n' +
    '  - Fixed attachment CRC32 ZIP builder\n\n' +
    'v1.2.0 (2023-01-15)\n' +
    '  - Added Tier B attachment hash validation\n' +
    '  - Added deep mail validator thread chain check\n\n' +
    'v1.1.0 (2022-08-01)\n' +
    '  - Initial Gmail→Outlook and Outlook→Gmail support\n' +
    '  - Added custom folder migration\n'
  );

  // 12. PDF + TXT combo (both in one email)
  const pdfCombo = buildRawPdf([{
    title: 'Compliance Archive Notice',
    lines: [
      'To:   ron@qatestagent.com',
      'From: Compliance Team',
      'Date: 2023-08-30',
      '',
      'Per company policy, all emails older than 12 months have been moved',
      'to the In-Place Archive. Do not delete archived emails without prior',
      'approval from the compliance team.',
      '',
      'To access an archived email, open Outlook and navigate to your',
      'Online Archive mailbox, or contact: helpdesk@qatestagent.com',
      '',
      'This is an automated compliance notice. No reply is required.',
    ],
  }]);
  const txtComboNotes = txt(
    'Archive Policy Reference\n========================\nPolicy ID: COMP-2023-07\nEffective: 2023-07-01\n\n' +
    'Items archived after: 365 days from received date\nTarget mailbox: Online Archive (Exchange In-Place Archive)\nRetention period: 7 years\n\n' +
    'Affected folders:\n  - Inbox\n  - Sent Items\n  - Deleted Items\n  - Junk Email\n  - All custom folders\n\n' +
    'Excluded folders:\n  - Drafts (not archived)\n  - Calendars (separate policy)\n  - Contacts (separate policy)\n'
  );

  return {
    txtSimple, txtLarge, txtLog, txtConf, txtTsv, txtScript,
    pdfSimple, pdfMultiPage, pdfLarge, pdfStructured,
    txtReadme, txtChangelog,
    pdfCombo, txtComboNotes,
  };
}

// ─── Email definitions ──────────────────────────────────────────────────────
function buildMessages(f) {
  // Handles both Buffer and Uint8Array (xlsx lib returns Uint8Array in SheetJS 0.18)
  const b64 = (buf) => Buffer.from(buf).toString('base64');
  const at  = (name, ct, buf) => ({ name, contentType: ct, contentBytes: b64(buf) });
  const PDF  = 'application/pdf';
  const TXT  = 'text/plain';

  return [
    // ── TXT scenarios ─────────────────────────────────────────────────────
    {
      subject: '[QA-TxtPdf] 1 - Simple TXT + Flagged',
      body: { contentType: 'HTML', content: '<html><body><p>Simple plain-text file attached for migration QA.</p><p>Ref: <a href="https://www.cloudfuze.com">CloudFuze Platform</a></p></body></html>' },
      importance: 'normal', flag: { flagStatus: 'flagged' }, isRead: false,
      receivedDateTime: '2022-03-10T09:00:00Z', sentDateTime: '2022-03-10T08:58:00Z',
      attachments: [at('qa-notes.txt', TXT, f.txtSimple)],
    },
    {
      subject: '[QA-TxtPdf] 2 - Large TXT (~30 KB) + High Importance',
      body: { contentType: 'HTML', content: '<html><body><p>Large text file (300 lines, ~30 KB) — tests migration of bigger TXT attachments.</p><p>Admin: <a href="https://admin.microsoft.com">Microsoft 365 Admin Center</a></p></body></html>' },
      importance: 'high', isRead: false,
      receivedDateTime: '2022-05-18T11:00:00Z', sentDateTime: '2022-05-18T10:58:00Z',
      attachments: [at('qa-large-text.txt', TXT, f.txtLarge)],
    },
    {
      subject: '[QA-TxtPdf] 3 - Log file (.log) attachment',
      body: { contentType: 'HTML', content: '<html><body><p>Migration log file attached — verifies <code>.log</code> extension files migrate correctly.</p><p>See: <a href="https://learn.microsoft.com/en-us/exchange/mailbox-migration/mailbox-migration">Exchange Migration Guide</a></p></body></html>' },
      importance: 'normal', isRead: true,
      receivedDateTime: '2022-07-01T15:30:00Z', sentDateTime: '2022-07-01T15:28:00Z',
      attachments: [at('qa-migration-2022-07-01.log', TXT, f.txtLog)],
    },
    {
      subject: '[QA-TxtPdf] 4 - Config file (.conf) + Flagged',
      body: { contentType: 'HTML', content: '<html><body><p>Migration config file attached (.conf extension).</p><p>Portal: <a href="https://portal.azure.com">Azure Portal</a></p></body></html>' },
      importance: 'normal', flag: { flagStatus: 'flagged' }, isRead: false,
      receivedDateTime: '2022-09-05T08:20:00Z', sentDateTime: '2022-09-05T08:18:00Z',
      attachments: [at('qa-migration.conf', TXT, f.txtConf)],
    },
    {
      subject: '[QA-TxtPdf] 5 - TSV data file + High Importance',
      body: { contentType: 'HTML', content: '<html><body><p>Tab-separated user migration data (.tsv) attached.</p><p>Dashboard: <a href="https://app.powerbi.com">Power BI</a> | <a href="https://admin.google.com">Google Admin</a></p></body></html>' },
      importance: 'high', isRead: false,
      receivedDateTime: '2022-11-12T13:00:00Z', sentDateTime: '2022-11-12T12:58:00Z',
      attachments: [at('qa-migration-data.tsv', TXT, f.txtTsv)],
    },
    {
      subject: '[QA-TxtPdf] 6 - Python script (.py) as text attachment',
      body: { contentType: 'HTML', content: '<html><body><p>Code snippet (.py extension, text content) attached — tests file extension variety.</p><p>Docs: <a href="https://docs.microsoft.com/en-us/graph/overview">Microsoft Graph API</a></p></body></html>' },
      importance: 'normal', isRead: true, categories: ['Blue Category'],
      receivedDateTime: '2023-01-20T10:15:00Z', sentDateTime: '2023-01-20T10:13:00Z',
      attachments: [at('qa-validate-script.py.txt', TXT, f.txtScript)],
    },
    {
      subject: '[QA-TxtPdf] 7 - README + CHANGELOG (two TXT files) + Flagged + High Importance',
      body: { contentType: 'HTML', content: '<html><body><h3>Two text files attached</h3><p>README.md and CHANGELOG.txt — verifies multiple TXT attachments in one email.</p><p>Repo: <a href="https://github.com/cloudfuze">CloudFuze GitHub</a> | Support: <a href="https://www.cloudfuze.com/support">CloudFuze Support</a></p></body></html>' },
      importance: 'high', flag: { flagStatus: 'flagged' }, isRead: false, categories: ['Red Category'],
      receivedDateTime: '2023-03-15T09:30:00Z', sentDateTime: '2023-03-15T09:28:00Z',
      attachments: [
        at('README.md',       TXT, f.txtReadme),
        at('CHANGELOG.txt',   TXT, f.txtChangelog),
      ],
    },

    // ── PDF scenarios ─────────────────────────────────────────────────────
    {
      subject: '[QA-TxtPdf] 8 - Simple PDF + Flagged',
      body: { contentType: 'HTML', content: '<html><body><p>Simple single-page PDF summary attached.</p><p>Platform: <a href="https://www.cloudfuze.com">CloudFuze Migration</a></p></body></html>' },
      importance: 'normal', flag: { flagStatus: 'flagged' }, isRead: false,
      receivedDateTime: '2022-04-20T14:00:00Z', sentDateTime: '2022-04-20T13:58:00Z',
      attachments: [at('qa-summary.pdf', PDF, f.pdfSimple)],
    },
    {
      subject: '[QA-TxtPdf] 9 - Multi-page PDF (3 pages) + High Importance',
      body: { contentType: 'HTML', content: '<html><body><p>Full 3-page migration report PDF — tests multi-page document migration.</p><p>Compliance: <a href="https://learn.microsoft.com/en-us/exchange/policy-and-compliance/in-place-archiving/in-place-archiving">In-Place Archive Policy</a> | <a href="https://outlook.office.com">Outlook Web</a></p></body></html>' },
      importance: 'high', isRead: false,
      receivedDateTime: '2022-06-30T10:00:00Z', sentDateTime: '2022-06-30T09:58:00Z',
      attachments: [at('qa-migration-report-full.pdf', PDF, f.pdfMultiPage)],
    },
    {
      subject: '[QA-TxtPdf] 10 - Large PDF (~50 KB, 8 pages) + Flagged + High Importance',
      body: { contentType: 'HTML', content: '<html><body><p>Large 8-page PDF stress test — verifies migration of heavier PDF files.</p><p>Resources: <a href="https://admin.microsoft.com">M365 Admin</a> | <a href="https://portal.azure.com">Azure Portal</a> | <a href="https://admin.google.com">Google Admin</a></p></body></html>' },
      importance: 'high', flag: { flagStatus: 'flagged' }, isRead: false, categories: ['Red Category'],
      receivedDateTime: '2022-09-14T08:00:00Z', sentDateTime: '2022-09-14T07:58:00Z',
      attachments: [at('qa-stress-test-large.pdf', PDF, f.pdfLarge)],
    },
    {
      subject: '[QA-TxtPdf] 11 - Structured PDF (tables + sections) + High Importance',
      body: { contentType: 'HTML', content: '<html><body><p>Structured PDF with tables and multiple sections — tests complex PDF layout migration.</p><p>Validation guide: <a href="https://learn.microsoft.com/en-us/exchange/mailbox-migration/mailbox-migration">Microsoft Migration Docs</a></p></body></html>' },
      importance: 'high', isRead: false, categories: ['Blue Category'],
      receivedDateTime: '2023-02-10T11:30:00Z', sentDateTime: '2023-02-10T11:28:00Z',
      attachments: [at('qa-validation-report.pdf', PDF, f.pdfStructured)],
    },

    // ── PDF + TXT combo ───────────────────────────────────────────────────
    {
      subject: '[QA-TxtPdf] 12 - PDF + TXT combo + Flagged + High Importance',
      body: { contentType: 'HTML', content: '<html><body><h3>Compliance Archive Notice</h3><p>Two attachments: PDF notice + TXT policy reference document.</p><ul><li><a href="https://www.cloudfuze.com/support">CloudFuze Support</a></li><li><a href="https://outlook.office.com">Outlook Web App</a></li><li><a href="https://gmail.com">Gmail</a></li></ul><p><strong>Flagged for compliance review.</strong></p></body></html>' },
      importance: 'high', flag: { flagStatus: 'flagged' }, isRead: false, categories: ['Red Category', 'Blue Category'],
      receivedDateTime: '2023-08-30T09:00:00Z', sentDateTime: '2023-08-30T08:58:00Z',
      attachments: [
        at('qa-compliance-notice.pdf',  PDF, f.pdfCombo),
        at('qa-archive-policy.txt',     TXT, f.txtComboNotes),
      ],
    },
  ];
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('Building TXT and PDF file content…');
  const files    = buildFiles();
  const messages = buildMessages(files);
  console.log(`Seeding ${messages.length} emails into ${TARGET} / ${FOLDER}\n`);
  console.log('Coverage:');
  console.log('  TXT: plain, large (~30 KB), .log, .conf, .tsv, .py script, README+CHANGELOG (2 files)');
  console.log('  PDF: simple (1-page), multi-page (3-page), large (~50 KB, 8-page), structured (tables+sections), PDF+TXT combo\n');

  let ok = 0;
  for (let i = 0; i < messages.length; i++) {
    const msg = {
      ...messages[i],
      from:         { emailAddress: { address: SENDER, name: 'Ben QA' } },
      toRecipients: [{ emailAddress: { address: TARGET, name: 'Ron QA' } }],
    };
    try {
      await outlookClient.createMessageInFolder(TARGET, FOLDER, msg);
      const atts = (msg.attachments || []).map((a) => `${a.name} (${(a.contentBytes.length * 3 / 4 / 1024).toFixed(1)} KB)`).join(', ');
      console.log(`  [${String(i + 1).padStart(2)}/${messages.length}] ✓  ${msg.subject}`);
      console.log(`         ${atts}`);
      console.log(`         importance: ${msg.importance}  |  flag: ${msg.flag?.flagStatus || 'none'}  |  categories: ${(msg.categories || []).join(', ') || 'none'}`);
      ok++;
    } catch (err) {
      console.error(`  [${String(i + 1).padStart(2)}/${messages.length}] ✗  ${msg.subject} — ${err.message}`);
    }
  }

  console.log(`\nDone — ${ok}/${messages.length} emails created in ${TARGET} / ${FOLDER}`);
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
