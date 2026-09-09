/**
 * Builds/repairs the "Long Folder Path" structure:
 *   - Renames every folder to a 200-300 character name
 *   - Creates 25 levels of nested folders, each with a long name
 * Run: node scripts/build-long-folder-path.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { google } = require('googleapis');
const driveClient = require('../src/clients/driveClient');

const EMAIL           = 'zara@storefuze.com';
const LONG_PATH_ID    = '1WwyYhPiNhcnfpDliZMaoPhjGV8YxUQGJ'; // "Long Folder Path"
const TARGET_LEVELS   = 25;

// ── 25 unique, descriptive 200-300 char folder names ─────────────────────────
// Format: "[Level NN] [Topic] — [Detail] — [extra padding to hit 200-300 chars]"
const LEVEL_NAMES = [
  'Level 01 — Documents and Text Files — Google My Drive to OneDrive Migration QA Testing — CloudFuze Deep Nesting Validation — Verifying that all document formats are correctly transferred across levels',
  'Level 02 — Spreadsheets and Tabular Data — Google My Drive to OneDrive Migration QA — CloudFuze Folder Depth Test — Ensuring xlsx csv and xls files migrate accurately through deeply nested directory structures',
  'Level 03 — Presentations and Slide Decks — Google My Drive to OneDrive Migration QA — CloudFuze Path Length Test — Verifying pptx ppt and Google Slides convert and land correctly at target destination',
  'Level 04 — Images and Photographs — Google My Drive to OneDrive Migration QA Testing — CloudFuze Deep Path Validation — Checking jpg png gif bmp svg tiff webp formats survive deep folder nesting intact',
  'Level 05 — Audio and Music Files — Google My Drive to OneDrive Migration QA Testing — CloudFuze Nesting Depth Verification — Confirming mp3 wav aac flac ogg audio files are migrated without corruption',
  'Level 06 — Video and Multimedia Content — Google My Drive to OneDrive Migration QA — CloudFuze Long Path Test — Validating that mp4 avi mov mkv wmv video files migrate correctly through nested folders',
  'Level 07 — Archive and Compressed Files — Google My Drive to OneDrive Migration QA — CloudFuze Folder Depth Test — Ensuring zip tar gz rar 7z archives are all handled properly at all deep nesting levels',
  'Level 08 — Source Code and Developer Files — Google My Drive to OneDrive Migration QA — CloudFuze Path Depth Check — Verifying js ts py java cpp sql sh code files migrate correctly at depth level eight',
  'Level 09 — Configuration and Settings Files — Google My Drive to OneDrive Migration QA — CloudFuze Deep Path Test — Confirming json yaml yml ini xml config files are preserved through deep folder hierarchies',
  'Level 10 — Database and Data Export Files — Google My Drive to OneDrive Migration QA — CloudFuze Path Validation — Checking csv tsv sql and structured data files reach the destination intact at level ten',
  'Level 11 — Native Google Workspace Files — Google My Drive to OneDrive Migration QA — CloudFuze Conversion Test — Validating Google Docs Sheets and Slides are converted to OOXML formats at depth level eleven',
  'Level 12 — Permissions and Shared Content — Google My Drive to OneDrive Migration QA — CloudFuze Permission Mapping — Verifying owner editor viewer permission assignments survive deep nesting at level twelve',
  'Level 13 — Version History and Revisions — Google My Drive to OneDrive Migration QA — CloudFuze Delta Migration Test — Checking that file version history and incremental changes are tracked at level thirteen',
  'Level 14 — Special Characters in File Names — Google My Drive to OneDrive Migration QA — CloudFuze Name Encoding Test — Validating files with special chars brackets and symbols migrate correctly at level fourteen',
  'Level 15 — Large Files and Binary Content — Google My Drive to OneDrive Migration QA — CloudFuze Size Limit Test — Confirming oversized binary files and large attachments are transferred intact at level fifteen',
  'Level 16 — Timestamps and Metadata Preservation — Google My Drive to OneDrive Migration QA — CloudFuze Metadata Test — Ensuring created modified and accessed timestamps are preserved through deep folder levels sixteen',
  'Level 17 — Shared Drive and Team Content — Google My Drive to OneDrive Migration QA — CloudFuze Shared Drive Test — Validating that shared drive content and team folder structures migrate correctly at level seventeen',
  'Level 18 — Root Level and Standalone Files — Google My Drive to OneDrive Migration QA — CloudFuze Structure Test — Checking files placed directly in root folders without subfolders migrate correctly at level eighteen',
  'Level 19 — Delta and Incremental Migration — Google My Drive to OneDrive Migration QA — CloudFuze Delta Test — Verifying that incremental changes detected after one-time migration are synced correctly at level nineteen',
  'Level 20 — One-Time Full Migration Validation — Google My Drive to OneDrive Migration QA — CloudFuze Full Sync Test — Confirming complete one-time migration captures all files and folders at nesting level twenty',
  'Level 21 — Cross-Platform Compatibility Check — Google My Drive to OneDrive Migration QA — CloudFuze Compatibility Test — Validating file formats open and function correctly on OneDrive after migration at level twenty-one',
  'Level 22 — Error Handling and Retry Scenarios — Google My Drive to OneDrive Migration QA — CloudFuze Resilience Test — Checking that failed or interrupted migrations are retried and completed at nesting depth twenty-two',
  'Level 23 — Folder Structure and Hierarchy Test — Google My Drive to OneDrive Migration QA — CloudFuze Structure Validation — Verifying parent-child folder relationships are preserved end to end at depth level twenty-three',
  'Level 24 — End-to-End Migration Pipeline Test — Google My Drive to OneDrive Migration QA — CloudFuze Pipeline Validation — Confirming entire source-to-destination pipeline handles content at nesting depth twenty-four',
  'Level 25 — Final Depth Validation and QA Sign-Off — Google My Drive to OneDrive Migration QA — CloudFuze Deep Nesting Limit Test — This is the deepest folder level created for maximum path length migration validation',
];

// Verify all names are 200-300 chars
LEVEL_NAMES.forEach((n, i) => {
  if (n.length < 200 || n.length > 300) {
    console.warn(`⚠  Level ${i + 1} name length = ${n.length} (expected 200-300)`);
  }
});

// ── Drive rename helper (not in driveClient.js) ───────────────────────────────
async function renameFolder(fileId, newName, email) {
  const auth  = await driveClient.getAuth(email);
  const drive = google.drive({ version: 'v3', auth });
  const res   = await drive.files.update({ fileId, requestBody: { name: newName }, fields: 'id, name' });
  return res.data;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  console.log(`\nBuilding 25-level deep folder path inside "Long Folder Path"...\n`);

  // Step 1: find or rename Level 1 (already exists: id 1ncszcVIE1SvwtCTBpfzl7u9vV_ExDZFD)
  let existingLevel1 = await driveClient.findByName('Level 1', LONG_PATH_ID, EMAIL);
  // Also check for any already-renamed level-1 folder
  if (!existingLevel1) {
    const children = await driveClient.listChildren(LONG_PATH_ID, EMAIL);
    existingLevel1 = children.find(c => c.mimeType === 'application/vnd.google-apps.folder') || null;
  }

  let currentParentId = LONG_PATH_ID;
  let previousFolderId = null;

  for (let level = 1; level <= TARGET_LEVELS; level++) {
    const desiredName = LEVEL_NAMES[level - 1];
    console.log(`  Processing Level ${String(level).padStart(2, '0')} (${desiredName.length} chars)...`);

    if (level === 1 && existingLevel1) {
      // Rename the existing Level 1 folder
      await renameFolder(existingLevel1.id, desiredName, EMAIL);
      console.log(`    ✓ Renamed existing folder → ${existingLevel1.id}`);
      previousFolderId = existingLevel1.id;
      currentParentId  = existingLevel1.id;
    } else {
      // Check if a folder with this level's prefix already exists under the parent
      const children = await driveClient.listChildren(currentParentId, EMAIL);
      const existing = children.find(c =>
        c.mimeType === 'application/vnd.google-apps.folder' &&
        c.name.startsWith(`Level ${String(level).padStart(2, '0')}`)
      );

      if (existing) {
        await renameFolder(existing.id, desiredName, EMAIL);
        console.log(`    ✓ Renamed existing folder → ${existing.id}`);
        previousFolderId = existing.id;
        currentParentId  = existing.id;
      } else {
        const created = await driveClient.createFolder(desiredName, currentParentId, EMAIL);
        console.log(`    ✓ Created new folder      → ${created.id}`);
        previousFolderId = created.id;
        currentParentId  = created.id;
      }
    }
  }

  console.log(`\n${'─'.repeat(70)}`);
  console.log(`  Done — 25 nested folders with 200-300 char names created/updated.`);
  console.log(`  Deepest folder ID: ${previousFolderId}`);
}

run().catch(console.error);