/**
 * seedArchiveData.js
 *
 * Creates 10 backdated emails (2022-2023 timestamps) in each default Outlook
 * folder for ron@qatestagent.com to test In-Place Archive functionality.
 *
 * Usage:
 *   cd backend
 *   node scripts/seedArchiveData.js
 *
 * Requires .env with GRAPH_CLIENT_ID_2, GRAPH_CLIENT_SECRET_2, GRAPH_TENANT_ID_2,
 * and GRAPH_TENANT_2_DOMAINS=...,qatestagent.com
 */

'use strict';

require('../src/config/env'); // loads .env
const outlookClient = require('../src/clients/outlookClient');

const TARGET_USER = 'ron@qatestagent.com';

// Default folders — EWS well-known names (drafts uses Graph POST path)
const FOLDERS = ['inbox', 'sentitems', 'drafts', 'deleteditems', 'junkemail'];

// 10 backdated timestamps spread across 2022-2023 (oldest first)
const TIMESTAMPS = [
  { received: '2022-03-14T08:12:00Z', sent: '2022-03-14T08:10:00Z' },
  { received: '2022-05-22T14:33:00Z', sent: '2022-05-22T14:31:00Z' },
  { received: '2022-07-04T09:07:00Z', sent: '2022-07-04T09:05:00Z' },
  { received: '2022-09-19T16:45:00Z', sent: '2022-09-19T16:43:00Z' },
  { received: '2022-11-30T11:20:00Z', sent: '2022-11-30T11:18:00Z' },
  { received: '2023-01-10T07:55:00Z', sent: '2023-01-10T07:53:00Z' },
  { received: '2023-03-28T13:15:00Z', sent: '2023-03-28T13:13:00Z' },
  { received: '2023-06-06T10:42:00Z', sent: '2023-06-06T10:40:00Z' },
  { received: '2023-08-17T15:30:00Z', sent: '2023-08-17T15:28:00Z' },
  { received: '2023-10-25T12:00:00Z', sent: '2023-10-25T11:58:00Z' },
];

// 10 varied message scenarios (same list used for all folders, folder prefix added to subject)
const SCENARIOS = [
  {
    label: 'plain text',
    body: { contentType: 'text', content: 'This is a plain-text email created for In-Place Archive testing.' },
    importance: 'normal',
    isRead: true,
  },
  {
    label: 'HTML rich content',
    body: {
      contentType: 'HTML',
      content: '<html><body><h2>Archive Test</h2><p>This email has <b>bold</b> and <i>italic</i> content.</p></body></html>',
    },
    importance: 'normal',
    isRead: true,
  },
  {
    label: 'high importance',
    body: { contentType: 'text', content: 'High importance archive test email.' },
    importance: 'high',
    isRead: false,
  },
  {
    label: 'low importance',
    body: { contentType: 'text', content: 'Low importance archive test email.' },
    importance: 'low',
    isRead: true,
  },
  {
    label: 'with CC',
    body: { contentType: 'text', content: 'Archive test email with CC recipients.' },
    importance: 'normal',
    isRead: true,
    cc: [{ emailAddress: { address: 'Alex@qatestagent.com', name: 'Alex QA' } }],
  },
  {
    label: 'flagged for follow-up',
    body: { contentType: 'text', content: 'This email is flagged for follow-up — archive test.' },
    importance: 'normal',
    isRead: false,
    flag: { flagStatus: 'flagged' },
  },
  {
    label: 'with category',
    body: { contentType: 'text', content: 'Categorized email for archive testing.' },
    importance: 'normal',
    isRead: true,
    categories: ['Red Category'],
  },
  {
    label: 'large body',
    body: {
      contentType: 'text',
      content: 'Archive test — large body.\n\n' + 'Lorem ipsum dolor sit amet. '.repeat(600),
    },
    importance: 'normal',
    isRead: true,
  },
  {
    label: 'multiple categories',
    body: { contentType: 'text', content: 'Multi-category archive test email.' },
    importance: 'normal',
    isRead: false,
    categories: ['Red Category', 'Blue Category'],
  },
  {
    label: 'unicode subject',
    subjectSuffix: ' — こんにちは αβγ',
    body: { contentType: 'text', content: 'Unicode subject archive test.' },
    importance: 'normal',
    isRead: true,
  },
];

function buildMessage(folder, scenarioIndex, ts, scenario) {
  const folderLabel = folder.charAt(0).toUpperCase() + folder.slice(1);
  const subject = `[Archive-${folderLabel}] ${scenarioIndex + 1} - ${scenario.label}${scenario.subjectSuffix || ''}`;

  const msg = {
    subject,
    body: scenario.body,
    from: { emailAddress: { address: 'ben@qatestagent.com', name: 'Ben QA' } },
    toRecipients: [{ emailAddress: { address: TARGET_USER, name: 'Ron QA' } }],
    importance: scenario.importance || 'normal',
    isRead: scenario.isRead !== false,
    isDraft: folder === 'drafts',
    receivedDateTime: ts.received,
    sentDateTime: ts.sent,
  };

  if (scenario.cc)         msg.ccRecipients = scenario.cc;
  if (scenario.flag)       msg.flag = scenario.flag;
  if (scenario.categories) msg.categories = scenario.categories;

  // Drafts: swap from/to so it looks like an outgoing draft from ron
  if (folder === 'drafts') {
    msg.from         = { emailAddress: { address: TARGET_USER, name: 'Ron QA' } };
    msg.toRecipients = [{ emailAddress: { address: 'ben@qatestagent.com', name: 'Ben QA' } }];
  }

  // Sent Items: from ron, to ben
  if (folder === 'sentitems') {
    msg.from         = { emailAddress: { address: TARGET_USER, name: 'Ron QA' } };
    msg.toRecipients = [{ emailAddress: { address: 'ben@qatestagent.com', name: 'Ben QA' } }];
  }

  return msg;
}

async function seedFolder(folder) {
  console.log(`\n── ${folder.toUpperCase()} ──`);
  let created = 0;
  for (let i = 0; i < SCENARIOS.length; i++) {
    const ts  = TIMESTAMPS[i];
    const msg = buildMessage(folder, i, ts, SCENARIOS[i]);
    try {
      await outlookClient.createMessageInFolder(TARGET_USER, folder, msg);
      console.log(`  [${i + 1}/10] ✓ ${msg.subject}`);
      created++;
    } catch (err) {
      console.error(`  [${i + 1}/10] ✗ ${msg.subject} — ${err.message}`);
    }
  }
  console.log(`  → ${created}/10 created`);
  return created;
}

async function main() {
  console.log(`Seeding ${FOLDERS.length} folders × 10 messages for ${TARGET_USER}`);
  console.log('Timestamps range: 2022-03 → 2023-10 (for In-Place Archive testing)\n');

  let total = 0;
  for (const folder of FOLDERS) {
    total += await seedFolder(folder);
  }

  console.log(`\nDone — ${total}/${FOLDERS.length * 10} messages created across all folders.`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
