/**
 * Creates "Large Data Size" folder in Agent My Drive and uploads 10 files
 * of increasing size (100 MB → 10 GB) using streaming (no disk usage).
 * Run: node scripts/create-large-files.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { google }   = require('googleapis');
const { Readable } = require('stream');
const driveClient  = require('../src/clients/driveClient');

const EMAIL     = 'zara@storefuze.com';
const ROOT      = '1js5PWQKmjpRWwDG1CUYNeac4pE_RSFqO';
const MB        = 1024 * 1024;
const GB        = 1024 * MB;

// ── 10 files with increasing sizes ───────────────────────────────────────────
const FILES = [
  { name: 'large_file_100mb.bin',   size:  100 * MB,  label:  '100 MB'  },
  { name: 'large_file_250mb.bin',   size:  250 * MB,  label:  '250 MB'  },
  { name: 'large_file_500mb.bin',   size:  500 * MB,  label:  '500 MB'  },
  { name: 'large_file_750mb.bin',   size:  750 * MB,  label:  '750 MB'  },
  { name: 'large_file_1gb.bin',     size:    1 * GB,  label:    '1 GB'  },
  { name: 'large_file_2gb.bin',     size:    2 * GB,  label:    '2 GB'  },
  { name: 'large_file_3gb.bin',     size:    3 * GB,  label:    '3 GB'  },
  { name: 'large_file_5gb.bin',     size:    5 * GB,  label:    '5 GB'  },
  { name: 'large_file_7gb.bin',     size:    7 * GB,  label:    '7 GB'  },
  { name: 'large_file_10gb.bin',    size:   10 * GB,  label:   '10 GB'  },
];

// ── Streaming large file generator (no in-memory buffer) ─────────────────────
function makeStream(totalBytes) {
  const CHUNK_SIZE = 512 * 1024; // 512 KB chunks
  // Use a repeating pattern so the file has realistic non-zero content
  const pattern = Buffer.from(
    'CloudFuze Drive Migration QA Large File Test Data — ' +
    'This content is used to simulate large binary files for testing.\n'
  );
  const chunk = Buffer.alloc(CHUNK_SIZE);
  for (let i = 0; i < CHUNK_SIZE; i++) chunk[i] = pattern[i % pattern.length];

  let remaining = totalBytes;
  return new Readable({
    read() {
      if (remaining <= 0) return this.push(null);
      const n = Math.min(CHUNK_SIZE, remaining);
      remaining -= n;
      this.push(n === CHUNK_SIZE ? chunk : chunk.slice(0, n));
    },
  });
}

// ── Upload one file with progress logging ────────────────────────────────────
async function uploadLargeFile(drive, name, sizeBytes, label, parentId) {
  const start = Date.now();
  console.log(`\n  ► ${name}  (${label})`);
  console.log(`    Started  : ${new Date().toISOString()}`);

  const res = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/octet-stream',
      parents: [parentId],
    },
    media: {
      mimeType: 'application/octet-stream',
      body: makeStream(sizeBytes),
    },
    fields: 'id, name',
  });

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const mbps    = (sizeBytes / MB / elapsed).toFixed(2);
  console.log(`    Done     : ${new Date().toISOString()}`);
  console.log(`    Duration : ${elapsed}s  (${mbps} MB/s)`);
  console.log(`    File ID  : ${res.data.id}`);
  return res.data;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  const totalGB = FILES.reduce((s, f) => s + f.size, 0) / GB;
  console.log('\n=== Large Data Size Upload ===');
  console.log(`Files : ${FILES.length}`);
  console.log(`Total : ~${totalGB.toFixed(1)} GB`);
  console.log(`Speed : ~3.3 MB/s (measured)\n`);

  // Auth + Drive client
  const auth  = await driveClient.getAuth(EMAIL);
  const drive = google.drive({ version: 'v3', auth });

  // Find or create "Large Data Size" folder
  let parent = await driveClient.findByName('Large Data Size', ROOT, EMAIL);
  if (parent) {
    console.log(`Using existing folder: ${parent.id}`);
  } else {
    parent = await driveClient.createFolder('Large Data Size', ROOT, EMAIL);
    console.log(`Created folder "Large Data Size": ${parent.id}`);
  }

  const results = [];
  for (const f of FILES) {
    try {
      const result = await uploadLargeFile(drive, f.name, f.size, f.label, parent.id);
      results.push({ ...f, id: result.id, status: 'ok' });
    } catch (err) {
      console.error(`  ✗ ${f.name}: ${err.message}`);
      results.push({ ...f, status: 'failed', error: err.message });
    }
  }

  console.log('\n' + '═'.repeat(60));
  console.log('SUMMARY');
  console.log('═'.repeat(60));
  results.forEach(r => {
    const icon = r.status === 'ok' ? '✓' : '✗';
    console.log(`  ${icon}  ${r.label.padEnd(8)}  ${r.name}`);
  });
  console.log('═'.repeat(60));
  console.log('All uploads complete.');
}

run().catch(console.error);