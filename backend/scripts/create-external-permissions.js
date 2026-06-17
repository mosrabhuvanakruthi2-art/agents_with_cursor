/**
 * Creates files in Agent Permissions folder and shares them with external users
 * (domains other than storefuze.com).
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { google }  = require('googleapis');
const driveClient = require('../src/clients/driveClient');

const EMAIL  = 'zara@storefuze.com';
const FOLDER = '1ndGN7XB71AYzLznZX9jbGID8BJLtn8mi'; // Agent Permissions

// External users — confirmed Google Workspace accounts (cloudfuze.us) + filefuze.co
const FILES = [
  {
    name: 'ext_perm_cloudfuze_us_viewer.txt',
    content: 'Shared with granger@cloudfuze.us as Viewer (external domain: cloudfuze.us).\nDrive to OneDrive migration QA — external permission test.',
    shares: [{ email: 'granger@cloudfuze.us', role: 'reader' }],
  },
  {
    name: 'ext_perm_cloudfuze_us_editor.txt',
    content: 'Shared with alex@cloudfuze.us as Editor (external domain: cloudfuze.us).\nDrive to OneDrive migration QA — external permission test.',
    shares: [{ email: 'alex@cloudfuze.us', role: 'writer' }],
  },
  {
    name: 'ext_perm_cloudfuze_us_commenter.txt',
    content: 'Shared with dan@cloudfuze.us as Commenter (external domain: cloudfuze.us).\nDrive to OneDrive migration QA — external permission test.',
    shares: [{ email: 'dan@cloudfuze.us', role: 'commenter' }],
  },
  {
    name: 'ext_perm_filefuze_viewer.txt',
    content: 'Shared with erik@filefuze.co as Viewer (external domain: filefuze.co).\nDrive to OneDrive migration QA — external permission test.',
    shares: [{ email: 'erik@filefuze.co', role: 'reader', notify: true }],
  },
  {
    name: 'ext_perm_multi_domain.txt',
    content: 'Shared with multiple external domain users:\n- granger@cloudfuze.us (viewer)\n- harry@cloudfuze.us (editor)\n- peter@cloudfuze.us (commenter)\nMulti-domain external permission test.',
    shares: [
      { email: 'granger@cloudfuze.us', role: 'reader' },
      { email: 'harry@cloudfuze.us',   role: 'writer' },
      { email: 'peter@cloudfuze.us',   role: 'commenter' },
    ],
  },
];

async function shareExternal(drive, fileId, email, role, notify = false) {
  const res = await drive.permissions.create({
    fileId,
    requestBody: { type: 'user', role, emailAddress: email },
    fields: 'id, role',
    sendNotificationEmail: notify,
  });
  return res.data;
}

async function run() {
  const auth  = await driveClient.getAuth(EMAIL);
  const drive = google.drive({ version: 'v3', auth });

  console.log('\nCreating 5 files with external permissions in Agent Permissions folder...\n');

  for (const f of FILES) {
    const uploaded = await driveClient.uploadFile(
      f.name, 'text/plain', Buffer.from(f.content), FOLDER, EMAIL
    );
    console.log(`  ✓ Created : ${f.name}`);
    console.log(`    File ID : ${uploaded.id}`);

    for (const s of f.shares) {
      try {
        await shareExternal(drive, uploaded.id, s.email, s.role, s.notify || false);
        console.log(`    → ${s.role.padEnd(10)} ${s.email}`);
      } catch (err) {
        console.error(`    ✗ Failed  ${s.email}: ${err.message}`);
      }
    }
    console.log();
  }

  console.log('─'.repeat(60));
  console.log('Done — 5 files created with external permissions.');
}

run().catch(console.error);