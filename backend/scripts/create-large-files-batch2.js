/**
 * Batch 2 — adds 5 more large files to "Large Data Size" folder (total → 15 files)
 * Run: node scripts/create-large-files-batch2.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { google }   = require('googleapis');
const { Readable } = require('stream');
const driveClient  = require('../src/clients/driveClient');

const EMAIL    = 'zara@storefuze.com';
const FOLDER   = '1r1hcOd3zxDr87tGkZF3WfFJSVowHWgxx';  // Large Data Size
const MB       = 1024 * 1024;
const GB       = 1024 * MB;

const FILES = [
  { name: 'large_file_150mb.bin',  size:  150 * MB, label:  '150 MB' },
  { name: 'large_file_400mb.bin',  size:  400 * MB, label:  '400 MB' },
  { name: 'large_file_1_5gb.bin',  size:  1.5 * GB, label:  '1.5 GB' },
  { name: 'large_file_4gb.bin',    size:    4 * GB, label:    '4 GB' },
  { name: 'large_file_8gb.bin',    size:    8 * GB, label:    '8 GB' },
];

function makeStream(totalBytes) {
  const CHUNK = 512 * 1024;
  const pattern = Buffer.from(
    'CloudFuze Drive Migration QA Large File Test Data — ' +
    'This content is used to simulate large binary files for testing.\n'
  );
  const chunk = Buffer.alloc(CHUNK);
  for (let i = 0; i < CHUNK; i++) chunk[i] = pattern[i % pattern.length];
  let rem = totalBytes;
  return new Readable({ read() {
    if (rem <= 0) return this.push(null);
    const n = Math.min(CHUNK, rem); rem -= n;
    this.push(n === CHUNK ? chunk : chunk.slice(0, n));
  }});
}

async function run() {
  const totalGB = FILES.reduce((s, f) => s + f.size, 0) / GB;
  console.log('\n=== Large Data Size — Batch 2 (5 more files) ===');
  console.log(`Total : ~${totalGB.toFixed(1)} GB\n`);

  const auth  = await driveClient.getAuth(EMAIL);
  const drive = google.drive({ version: 'v3', auth });

  for (const f of FILES) {
    const start = Date.now();
    console.log(`  ► ${f.name}  (${f.label})`);
    console.log(`    Started  : ${new Date().toISOString()}`);
    try {
      const res = await drive.files.create({
        requestBody: { name: f.name, mimeType: 'application/octet-stream', parents: [FOLDER] },
        media:       { mimeType: 'application/octet-stream', body: makeStream(f.size) },
        fields:      'id, name',
      });
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      const mbps    = (f.size / MB / elapsed).toFixed(2);
      console.log(`    Done     : ${new Date().toISOString()}`);
      console.log(`    Duration : ${elapsed}s  (${mbps} MB/s)`);
      console.log(`    File ID  : ${res.data.id}\n`);
    } catch (err) {
      console.error(`    ✗ Error  : ${err.message}\n`);
    }
  }

  console.log('═'.repeat(50));
  console.log('Batch 2 complete. Total files in folder: 15');
}

run().catch(console.error);