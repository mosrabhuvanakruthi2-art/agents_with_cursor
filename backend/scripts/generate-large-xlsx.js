const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const TARGET_SIZES_MB = [32, 33, 34, 35];
const OUTPUT_DIR = path.join(__dirname, '../data');

const HEADERS = [
  'ID', 'Subject', 'Sender', 'Recipient', 'Date', 'Body',
  'Body2', 'Body3', 'Attachment', 'Category', 'Status', 'Notes',
];

const WORD_POOL = 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua Ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur Excepteur sint occaecat cupidatat non proident sunt in culpa qui officia deserunt mollit anim id est laborum'.split(' ');

function randomText(approxChars) {
  let s = '';
  while (s.length < approxChars) {
    s += WORD_POOL[Math.floor(Math.random() * WORD_POOL.length)] + ' ';
  }
  return s.slice(0, approxChars);
}

function buildRow(i) {
  return [
    i,
    `Email ${i}: ${randomText(60)}`,
    `sender.${i}@testdomain.com`,
    `recipient.${i}@testdomain.com`,
    new Date(Date.now() - Math.random() * 1e11).toISOString(),
    randomText(300),
    randomText(300),
    randomText(300),
    `attachment_${i}_document.pdf`,
    ['Work', 'Personal', 'Important', 'Spam', 'Newsletter'][i % 5],
    ['Migrated', 'Pending', 'Failed', 'Skipped'][i % 4],
    randomText(120),
  ];
}

function writeWorkbook(rows) {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Emails');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

async function generateFile(targetMB) {
  const targetBytes = targetMB * 1024 * 1024;

  // Calibrate: generate 500 rows and measure bytes-per-row
  const calibRows = [HEADERS];
  for (let i = 1; i <= 500; i++) calibRows.push(buildRow(i));
  const calibBuf = writeWorkbook(calibRows);
  const bytesPerRow = calibBuf.length / 500;

  let numRows = Math.ceil(targetBytes / bytesPerRow);
  let rows = [HEADERS];
  for (let i = 1; i <= numRows; i++) rows.push(buildRow(i));

  let buf = writeWorkbook(rows);

  // Binary-search adjust until within ±0.5 MB of target
  let lo = numRows;
  let hi = numRows;
  const tolerance = 0.5 * 1024 * 1024;

  // Expand hi if still under target
  while (buf.length < targetBytes - tolerance) {
    hi = Math.ceil(hi * 1.2);
    rows = [HEADERS];
    for (let i = 1; i <= hi; i++) rows.push(buildRow(i));
    buf = writeWorkbook(rows);
    lo = Math.floor(hi * 0.8);
  }

  // Shrink lo if over target
  while (buf.length > targetBytes + tolerance) {
    lo = Math.floor(lo * 0.8);
    rows = [HEADERS];
    for (let i = 1; i <= lo; i++) rows.push(buildRow(i));
    buf = writeWorkbook(rows);
    hi = Math.ceil(lo * 1.2);
  }

  // Binary search between lo and hi
  for (let iter = 0; iter < 12; iter++) {
    const mid = Math.floor((lo + hi) / 2);
    rows = [HEADERS];
    for (let i = 1; i <= mid; i++) rows.push(buildRow(i));
    buf = writeWorkbook(rows);
    if (Math.abs(buf.length - targetBytes) <= tolerance) break;
    if (buf.length < targetBytes) lo = mid;
    else hi = mid;
  }

  const outPath = path.join(OUTPUT_DIR, `sample-${targetMB}mb.xlsx`);
  fs.writeFileSync(outPath, buf);

  const actualMB = (buf.length / (1024 * 1024)).toFixed(2);
  const dataRows = rows.length - 1;
  console.log(`  -> ${outPath}  (${actualMB} MB, ${dataRows.toLocaleString()} rows)`);
}

(async () => {
  console.log('Generating sample Excel files...\n');
  for (const mb of TARGET_SIZES_MB) {
    process.stdout.write(`[${mb} MB] calibrating and building... `);
    await generateFile(mb);
  }
  console.log('\nDone.');
})();
