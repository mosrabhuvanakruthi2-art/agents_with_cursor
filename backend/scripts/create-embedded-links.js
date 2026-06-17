/**
 * Creates "Embedded Links" folder in Agent My Drive, then uploads:
 *   - embedded_link.docx  — Word doc with clickable hyperlink in body text
 *   - embedded_link.xlsx  — Excel workbook with clickable hyperlink in a cell
 * Run: node scripts/create-embedded-links.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const path        = require('path');
const os          = require('os');
const fs          = require('fs');
const driveClient = require('../src/clients/driveClient');

const {
  Document, Paragraph, TextRun, ExternalHyperlink, HeadingLevel,
  AlignmentType, Packer, BorderStyle, TableRow, TableCell, Table, WidthType,
} = require('docx');

const ExcelJS = require('exceljs');

const EMAIL    = 'zara@storefuze.com';
const ROOT     = '1js5PWQKmjpRWwDG1CUYNeac4pE_RSFqO';

// The hyperlink we'll embed — webViewLink of root_document.pdf
const EMBED_URL   = 'https://drive.google.com/file/d/1ZyJGYb4Lpf9DEInPST-t7kcqI8Rk4wXi/view?usp=drivesdk';
const EMBED_LABEL = 'root_document.pdf (Google Drive)';

// ── Build DOCX ────────────────────────────────────────────────────────────────
async function buildDocx() {
  const doc = new Document({
    sections: [{
      children: [
        // Title
        new Paragraph({
          text: 'CloudFuze — Embedded Hyperlink Test Document',
          heading: HeadingLevel.HEADING_1,
        }),

        // Intro paragraph
        new Paragraph({
          children: [
            new TextRun({
              text: 'This document was created by the DriveTestDataAgent for Google My Drive → OneDrive migration QA. ',
            }),
            new TextRun({
              text: 'It contains an embedded hyperlink to verify that hyperlinks inside Word documents are preserved after migration.',
            }),
          ],
          spacing: { after: 200 },
        }),

        // Section heading
        new Paragraph({
          text: 'Embedded Link Section',
          heading: HeadingLevel.HEADING_2,
        }),

        // Paragraph with the embedded hyperlink
        new Paragraph({
          children: [
            new TextRun('Click the link below to open the source file on Google Drive: '),
            new ExternalHyperlink({
              link: EMBED_URL,
              children: [
                new TextRun({
                  text: EMBED_LABEL,
                  style: 'Hyperlink',
                }),
              ],
            }),
            new TextRun('. This link should remain clickable after migration to OneDrive.'),
          ],
          spacing: { after: 200 },
        }),

        // Additional context paragraph
        new Paragraph({
          children: [
            new TextRun({
              text: 'Migration scope: ',
              bold: true,
            }),
            new TextRun('One-time migration and delta migration. The hyperlink URL, display text, and formatting should all be intact in the migrated Word document on OneDrive.'),
          ],
          spacing: { after: 200 },
        }),

        // Second hyperlink paragraph (same link, different anchor text)
        new Paragraph({
          children: [
            new TextRun('Direct URL reference: '),
            new ExternalHyperlink({
              link: EMBED_URL,
              children: [
                new TextRun({
                  text: EMBED_URL,
                  style: 'Hyperlink',
                }),
              ],
            }),
          ],
        }),
      ],
    }],
  });

  return Packer.toBuffer(doc);
}

// ── Build XLSX ────────────────────────────────────────────────────────────────
async function buildXlsx(tmpPath) {
  const wb = new ExcelJS.Workbook();
  wb.creator  = 'DriveTestDataAgent';
  wb.created  = new Date();
  wb.modified = new Date();

  const ws = wb.addWorksheet('Embedded Links');

  // Column widths
  ws.getColumn('A').width = 30;
  ws.getColumn('B').width = 70;

  // Header row
  const header = ws.getRow(1);
  header.getCell('A').value = 'Field';
  header.getCell('B').value = 'Value';
  header.font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4285F4' } };
  header.height = 22;

  // Data rows
  const rows = [
    ['Document Title',   'CloudFuze Embedded Hyperlink Test Spreadsheet'],
    ['Source System',    'Google My Drive (zara@storefuze.com)'],
    ['Destination',      'OneDrive (via CloudFuze migration)'],
    ['Migration Type',   'One-Time + Delta'],
    ['Test Purpose',     'Verify embedded hyperlinks survive migration'],
    ['File Description', 'root_document.pdf stored in Agent My Drive root'],
    ['Embedded Link',    { text: EMBED_LABEL, hyperlink: EMBED_URL }],
    ['Raw URL',          { text: EMBED_URL,   hyperlink: EMBED_URL }],
    ['QA Status',        'READY FOR MIGRATION'],
  ];

  rows.forEach((row, i) => {
    const r = ws.getRow(i + 2);
    r.getCell('A').value = row[0];
    r.getCell('B').value = row[1];
    r.getCell('A').font  = { bold: true };

    // Style hyperlink cells
    if (typeof row[1] === 'object' && row[1].hyperlink) {
      r.getCell('B').font = { color: { argb: 'FF1155CC' }, underline: true };
    }

    // Alternate row fill
    if ((i + 2) % 2 === 0) {
      r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F8FF' } };
    }
  });

  // Add a second sheet demonstrating multiple embedded links
  const ws2 = wb.addWorksheet('Link Gallery');
  ws2.getColumn('A').width = 40;
  ws2.getColumn('B').width = 50;
  ws2.getColumn('C').width = 20;

  const h2 = ws2.getRow(1);
  h2.getCell('A').value = 'Description';
  h2.getCell('B').value = 'Hyperlink';
  h2.getCell('C').value = 'Type';
  h2.font  = { bold: true, color: { argb: 'FFFFFFFF' } };
  h2.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF34A853' } };
  h2.height = 22;

  const galleryRows = [
    ['PDF document in Agent My Drive root', { text: 'Open root_document.pdf', hyperlink: EMBED_URL }, 'Google Drive'],
    ['CloudFuze Migration Platform',        { text: 'cloudfuze.com',           hyperlink: 'https://cloudfuze.com' }, 'External'],
    ['Google Drive Help',                   { text: 'Drive Help Center',        hyperlink: 'https://support.google.com/drive' }, 'External'],
    ['Microsoft OneDrive',                  { text: 'OneDrive for Business',    hyperlink: 'https://onedrive.live.com' }, 'External'],
  ];

  galleryRows.forEach((row, i) => {
    const r = ws2.getRow(i + 2);
    r.getCell('A').value = row[0];
    r.getCell('B').value = row[1];
    r.getCell('C').value = row[2];
    r.getCell('B').font  = { color: { argb: 'FF1155CC' }, underline: true };
  });

  await wb.xlsx.writeFile(tmpPath);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  console.log('\nCreating Embedded Links folder and files...\n');

  // 1. Find or create the folder
  let folder = await driveClient.findByName('Embedded Links', ROOT, EMAIL);
  if (folder) {
    console.log(`Found existing "Embedded Links" folder: ${folder.id}`);
  } else {
    folder = await driveClient.createFolder('Embedded Links', ROOT, EMAIL);
    console.log(`Created "Embedded Links" folder: ${folder.id}`);
  }

  // 2. Build and upload DOCX
  console.log('\n  Building embedded_link.docx...');
  const docxBuffer = await buildDocx();
  const docxResult = await driveClient.uploadFile(
    'embedded_link.docx',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    docxBuffer,
    folder.id,
    EMAIL
  );
  console.log(`  ✓ embedded_link.docx uploaded  → ${docxResult.id}`);

  // 3. Build and upload XLSX
  console.log('\n  Building embedded_link.xlsx...');
  const tmpXlsx = path.join(os.tmpdir(), 'embedded_link_qa.xlsx');
  await buildXlsx(tmpXlsx);
  const xlsxBuffer = fs.readFileSync(tmpXlsx);
  fs.unlinkSync(tmpXlsx);

  const xlsxResult = await driveClient.uploadFile(
    'embedded_link.xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    xlsxBuffer,
    folder.id,
    EMAIL
  );
  console.log(`  ✓ embedded_link.xlsx uploaded  → ${xlsxResult.id}`);

  console.log('\n' + '─'.repeat(60));
  console.log('  Folder   : Embedded Links');
  console.log(`  Folder ID: ${folder.id}`);
  console.log(`  DOCX ID  : ${docxResult.id}`);
  console.log(`  XLSX ID  : ${xlsxResult.id}`);
  console.log(`  Link URL : ${EMBED_URL}`);
  console.log('  Done.');
}

run().catch(console.error);