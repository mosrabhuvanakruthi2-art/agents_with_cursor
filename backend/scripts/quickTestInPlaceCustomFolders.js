/**
 * quickTestInPlaceCustomFolders.js
 *
 * Creates the InPlace_Archive_Test folder hierarchy in ron@qatestagent.com
 * with properly backdated non-draft emails (real old timestamps).
 *
 * Folder structure:
 *   InPlace_Archive_Test/
 *     ├── 2023_Q1          (emails from 2023-01 to 2023-03)
 *     ├── Migration_Test_1 (emails from 2020-21 — 5yr old)
 *     ├── Migration_Test_2 (emails from 2021-22 — 4yr old)
 *     ├── Migration_Test_3 (emails from 2022    — 3yr old)
 *     ├── Migration_Test_4 (emails from 2023    — 2yr old)
 *     └── Migration_Test_5 (emails from 2024    — 1yr old)
 *
 * Each subfolder gets 5 emails with varied scenarios (plain, HTML, flagged,
 * high-importance, categorized).
 *
 * The EWS inject→move path in createMessageInFolder preserves
 * receivedDateTime/sentDateTime for custom folder messages.
 *
 * Usage: cd backend && node scripts/quickTestInPlaceCustomFolders.js
 */

'use strict';

require('../src/config/env');
const outlookClient = require('../src/clients/outlookClient');

const TARGET = 'ron@qatestagent.com';

const SENDERS = [
  { address: 'Granger@qatestagent.com',  name: 'Granger QA' },
  { address: 'Alex@qatestagent.com',     name: 'Alex QA' },
  { address: 'ben@qatestagent.com',      name: 'Ben QA' },
  { address: 'dan@qatestagent.com',      name: 'Dan QA' },
  { address: 'Blueteam1@qatestagent.com',name: 'Blue Team 1' },
];

// ─── Folder definitions: [parentFolderName, subfolderName, timestamps, label] ─
const SUBFOLDERS = [
  {
    name: '2023_Q1',
    label: 'Q1 2023 archive emails',
    timestamps: [
      { received: '2023-01-09T09:15:00Z', sent: '2023-01-09T09:13:00Z' },
      { received: '2023-01-23T14:30:00Z', sent: '2023-01-23T14:28:00Z' },
      { received: '2023-02-07T10:45:00Z', sent: '2023-02-07T10:43:00Z' },
      { received: '2023-02-21T16:00:00Z', sent: '2023-02-21T15:58:00Z' },
      { received: '2023-03-15T11:30:00Z', sent: '2023-03-15T11:28:00Z' },
    ],
  },
  {
    name: 'Migration_Test_1',
    label: '5-year-old emails (2020-21)',
    timestamps: [
      { received: '2020-03-10T08:00:00Z', sent: '2020-03-10T07:58:00Z' },
      { received: '2020-07-22T13:30:00Z', sent: '2020-07-22T13:28:00Z' },
      { received: '2020-11-05T10:15:00Z', sent: '2020-11-05T10:13:00Z' },
      { received: '2021-02-18T15:45:00Z', sent: '2021-02-18T15:43:00Z' },
      { received: '2021-06-30T09:00:00Z', sent: '2021-06-30T08:58:00Z' },
    ],
  },
  {
    name: 'Migration_Test_2',
    label: '4-year-old emails (2021-22)',
    timestamps: [
      { received: '2021-08-03T09:30:00Z', sent: '2021-08-03T09:28:00Z' },
      { received: '2021-10-14T14:00:00Z', sent: '2021-10-14T13:58:00Z' },
      { received: '2022-01-19T11:15:00Z', sent: '2022-01-19T11:13:00Z' },
      { received: '2022-04-06T16:30:00Z', sent: '2022-04-06T16:28:00Z' },
      { received: '2022-07-27T08:45:00Z', sent: '2022-07-27T08:43:00Z' },
    ],
  },
  {
    name: 'Migration_Test_3',
    label: '3-year-old emails (2022)',
    timestamps: [
      { received: '2022-02-14T10:00:00Z', sent: '2022-02-14T09:58:00Z' },
      { received: '2022-05-03T13:15:00Z', sent: '2022-05-03T13:13:00Z' },
      { received: '2022-08-16T15:30:00Z', sent: '2022-08-16T15:28:00Z' },
      { received: '2022-10-25T09:45:00Z', sent: '2022-10-25T09:43:00Z' },
      { received: '2022-12-07T14:00:00Z', sent: '2022-12-07T13:58:00Z' },
    ],
  },
  {
    name: 'Migration_Test_4',
    label: '2-year-old emails (2023)',
    timestamps: [
      { received: '2023-03-20T09:00:00Z', sent: '2023-03-20T08:58:00Z' },
      { received: '2023-05-11T12:30:00Z', sent: '2023-05-11T12:28:00Z' },
      { received: '2023-07-24T15:15:00Z', sent: '2023-07-24T15:13:00Z' },
      { received: '2023-09-08T10:45:00Z', sent: '2023-09-08T10:43:00Z' },
      { received: '2023-11-29T14:00:00Z', sent: '2023-11-29T13:58:00Z' },
    ],
  },
  {
    name: 'Migration_Test_5',
    label: '1-year-old emails (2024)',
    timestamps: [
      { received: '2024-01-15T09:30:00Z', sent: '2024-01-15T09:28:00Z' },
      { received: '2024-03-28T13:00:00Z', sent: '2024-03-28T12:58:00Z' },
      { received: '2024-06-12T10:45:00Z', sent: '2024-06-12T10:43:00Z' },
      { received: '2024-09-04T14:30:00Z', sent: '2024-09-04T14:28:00Z' },
      { received: '2024-11-20T11:15:00Z', sent: '2024-11-20T11:13:00Z' },
    ],
  },
];

// 5 varied scenarios — same list applied to every subfolder
function buildScenarios(folderName, label) {
  const age = label.match(/(\d+)-?year/) ? label.match(/(\d+)-?year/)[1] + 'yr' : 'archive';
  return [
    {
      subject: `[CUSTOM] ${folderName} — Plain text email (${age} old)`,
      body: {
        contentType: 'text',
        content: [
          'In-Place Archive Test Email',
          '',
          `Scenario: Plain text — ${folderName}`,
          `Folder: InPlace_Archive_Test/${folderName}`,
          `Simulated Age: ${age}`,
          '',
          'This message was generated to test Exchange Online in-place archive',
          'functionality. It validates that plain-text emails in custom nested',
          'folders are correctly archived and retrievable after migration.',
          '',
          'Content for migration/archive QA validation.',
        ].join('\n'),
      },
      importance: 'normal',
      isRead: true,
      isDraft: false,
    },
    {
      subject: `[CUSTOM] ${folderName} — HTML email with links (${age} old)`,
      body: {
        contentType: 'HTML',
        content: `<html><body style="font-family:Calibri,Arial,sans-serif;font-size:14px">
          <h2>In-Place Archive Test Email</h2>
          <p>This message was generated to test Exchange Online in-place archive functionality.</p>
          <table style="border-collapse:collapse;font-size:13px;margin:8px 0">
            <tr style="background:#dce6f1"><th style="border:1px solid #bbb;padding:4px 12px">Field</th><th style="border:1px solid #bbb;padding:4px 12px">Value</th></tr>
            <tr><td style="border:1px solid #bbb;padding:4px 12px">Scenario</td><td style="border:1px solid #bbb;padding:4px 12px">HTML email — archive custom folder test</td></tr>
            <tr><td style="border:1px solid #bbb;padding:4px 12px">Folder</td><td style="border:1px solid #bbb;padding:4px 12px">InPlace_Archive_Test/${folderName}</td></tr>
            <tr><td style="border:1px solid #bbb;padding:4px 12px">Simulated Age</td><td style="border:1px solid #bbb;padding:4px 12px"><strong>${age}</strong></td></tr>
          </table>
          <p>References:</p>
          <ul>
            <li><a href="https://learn.microsoft.com/en-us/exchange/policy-and-compliance/in-place-archiving/in-place-archiving">In-Place Archive — Microsoft Docs</a></li>
            <li><a href="https://www.cloudfuze.com">CloudFuze Migration Platform</a></li>
          </ul>
          <p>Content for migration/archive QA validation.</p>
        </body></html>`,
      },
      importance: 'normal',
      isRead: true,
      isDraft: false,
    },
    {
      subject: `[CUSTOM] ${folderName} — Flagged + High Importance (${age} old)`,
      body: {
        contentType: 'HTML',
        content: `<html><body style="font-family:Calibri,Arial,sans-serif;font-size:14px">
          <p><strong>⚑ Flagged for follow-up | High Importance</strong></p>
          <h3>In-Place Archive Test Email</h3>
          <p>Scenario: <em>Flagged + high importance</em> — archive custom folder test</p>
          <p>Folder: <code>InPlace_Archive_Test/${folderName}</code> | Simulated Age: <strong>${age}</strong></p>
          <p>This email tests that the flagged state and high-importance marker are both preserved during in-place archive migration.</p>
          <p>Action required: Verify this email appears as flagged and important after migration.</p>
          <p>Content for migration/archive QA validation.</p>
        </body></html>`,
      },
      importance: 'high',
      flag: { flagStatus: 'flagged' },
      isRead: false,
      isDraft: false,
    },
    {
      subject: `[CUSTOM] ${folderName} — Categorized email (${age} old)`,
      body: {
        contentType: 'text',
        content: [
          'In-Place Archive Test Email',
          '',
          `Scenario: Categorized (Red Category) — ${folderName}`,
          `Folder: InPlace_Archive_Test/${folderName}`,
          `Simulated Age: ${age}`,
          '',
          'This email has a Red Category assigned. Migration QA should',
          'verify the category is preserved after in-place archive migration.',
          '',
          'Content for migration/archive QA validation.',
        ].join('\n'),
      },
      importance: 'normal',
      categories: ['Red Category'],
      isRead: true,
      isDraft: false,
    },
    {
      subject: `[CUSTOM] ${folderName} — Unread + CC recipients (${age} old)`,
      body: {
        contentType: 'HTML',
        content: `<html><body style="font-family:Calibri,Arial,sans-serif;font-size:14px">
          <p>Hi Team,</p>
          <h3>In-Place Archive Test Email</h3>
          <p>Scenario: <em>Unread with CC recipients</em> — ${folderName}</p>
          <p>Folder: <code>InPlace_Archive_Test/${folderName}</code> | Simulated Age: <strong>${age}</strong></p>
          <p>This email tests that the unread state and CC recipients are preserved during in-place archive migration.</p>
          <p>CC: Granger QA, Alex QA (see recipients)</p>
          <p>Content for migration/archive QA validation.</p>
        </body></html>`,
      },
      importance: 'normal',
      isRead: false,
      isDraft: false,
      ccRecipients: [
        { emailAddress: { address: 'Granger@qatestagent.com', name: 'Granger QA' } },
        { emailAddress: { address: 'Alex@qatestagent.com',    name: 'Alex QA' } },
      ],
    },
  ];
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const PARENT_FOLDER = 'InPlace_Archive_Test';

  console.log(`Creating folder hierarchy under "${PARENT_FOLDER}" in ${TARGET}\n`);

  // 1. Create or get the parent folder
  let parentId;
  try {
    parentId = await outlookClient.getOrCreateMailFolder(TARGET, PARENT_FOLDER);
    console.log(`✓ Parent folder "${PARENT_FOLDER}" ready (ID: ${parentId.substring(0, 20)}...)\n`);
  } catch (err) {
    console.error(`✗ Failed to create parent folder: ${err.message}`);
    process.exit(1);
  }

  let grandTotal = 0, grandOk = 0;

  for (const sf of SUBFOLDERS) {
    console.log(`── ${sf.name}  (${sf.label}) ──`);

    // 2. Create subfolder under parent
    let subFolderId;
    try {
      subFolderId = await outlookClient.createChildFolder(TARGET, parentId, sf.name);
      console.log(`  ✓ Subfolder "${sf.name}" created`);
    } catch (err) {
      // Already exists — try to find it
      try {
        const folders = await outlookClient.getMailFolders(TARGET);
        const found = folders.find((f) => f.displayName === sf.name);
        if (found) {
          subFolderId = found.id;
          console.log(`  ℹ  Subfolder "${sf.name}" already exists — reusing`);
        } else {
          console.error(`  ✗ Cannot get/create subfolder "${sf.name}": ${err.message}`);
          continue;
        }
      } catch (e2) {
        console.error(`  ✗ Subfolder lookup failed: ${e2.message}`);
        continue;
      }
    }

    // 3. Seed 5 emails per subfolder
    const scenarios = buildScenarios(sf.name, sf.label);
    for (let i = 0; i < scenarios.length; i++) {
      const scenario = scenarios[i];
      const ts       = sf.timestamps[i];
      const sender   = SENDERS[i % SENDERS.length];
      grandTotal++;

      const msg = {
        subject:          scenario.subject,
        body:             scenario.body,
        from:             { emailAddress: sender },
        toRecipients:     [{ emailAddress: { address: TARGET, name: 'Ron QA' } }],
        ccRecipients:     scenario.ccRecipients,
        importance:       scenario.importance || 'normal',
        isRead:           scenario.isRead !== false,
        isDraft:          false,
        flag:             scenario.flag,
        categories:       scenario.categories,
        receivedDateTime: ts.received,
        sentDateTime:     ts.sent,
      };

      try {
        await outlookClient.createMessageInFolder(TARGET, subFolderId, msg);
        const flags = [
          scenario.flag?.flagStatus === 'flagged' ? '⚑ flagged' : '',
          scenario.importance === 'high' ? '★ high' : '',
          scenario.isRead === false ? '● unread' : '',
          (scenario.categories || []).join(', '),
        ].filter(Boolean).join(' | ');
        console.log(`    [${i + 1}/5] ✓  ${ts.received.slice(0, 10)} — ${msg.subject.substring(0, 55)}`);
        if (flags) console.log(`           ${flags}`);
        grandOk++;
      } catch (err) {
        console.error(`    [${i + 1}/5] ✗  ${msg.subject} — ${err.message}`);
      }
    }
    console.log(`  → ${scenarios.length} emails seeded into ${sf.name}\n`);
  }

  console.log('='.repeat(60));
  console.log(`Done — ${grandOk}/${grandTotal} emails created`);
  console.log(`Folder: ${PARENT_FOLDER}/`);
  SUBFOLDERS.forEach((sf) => console.log(`  ├── ${sf.name}  (${sf.timestamps[0].received.slice(0,7)} to ${sf.timestamps[4].received.slice(0,7)})`));
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
