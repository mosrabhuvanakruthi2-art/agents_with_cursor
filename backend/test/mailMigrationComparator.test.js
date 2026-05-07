/**
 * Run: node test/mailMigrationComparator.test.js (from backend/)
 */
const assert = require('assert');
const {
  normalizeSubject,
  parseRecipientEmails,
  graphRecipientsToEmails,
  compareTierA,
  compareTierBHashes,
  compareTierC,
  normalizeAttachmentListForCompare,
  buildRecipientEmailMapping,
  expectedDestRecipientsFromSource,
  compareFolderPlacement,
  expectedOutlookFolderForGmailLabels,
  validateGmailToOutlookPlacement,
} = require('../src/utils/mailMigrationComparator');
const { internetMessageIdsEqual, stripAngleBrackets } = require('../src/clients/outlookClient');

function run() {
  assert.strictEqual(normalizeSubject('  hello   world  '), 'hello world');
  assert.strictEqual(
    parseRecipientEmails('Foo <a@b.com>, c@d.com').join(','),
    'a@b.com,c@d.com'
  );
  const g = [
    { emailAddress: { address: 'A@B.com' } },
    { emailAddress: { address: 'c@d.com' } },
  ];
  assert.deepStrictEqual(graphRecipientsToEmails(g), ['a@b.com', 'c@d.com']);

  const diffs = compareTierA(
    {
      subject: 'Test',
      to: 'a@x.com',
      attachments: [{ filename: 'f.txt', size: 10 }],
    },
    {
      subject: 'Test',
      toRecipients: [{ emailAddress: { address: 'a@x.com' } }],
      attachments: [{ filename: 'f.txt', size: 10 }],
    }
  );
  assert.strictEqual(diffs.length, 0);

  const diff2 = compareTierA(
    { subject: 'A', to: 'a@x.com', attachments: [] },
    { subject: 'B', toRecipients: [{ emailAddress: { address: 'a@x.com' } }], attachments: [] }
  );
  assert.ok(diff2.some((d) => d.field === 'subject'));

  const hashDiffs = compareTierBHashes(
    [{ name: 'a.txt', sha256: 'aa' }],
    [{ name: 'a.txt', sha256: 'bb' }]
  );
  assert.strictEqual(hashDiffs.length, 1);

  const norm = normalizeAttachmentListForCompare([
    { filename: 'z', size: 1 },
    { filename: 'a', size: 2 },
  ]);
  assert.strictEqual(norm[0].name, 'a');

  assert.ok(internetMessageIdsEqual('<CA+abc@mail.gmail.com>', 'ca+abc@mail.gmail.com'));
  assert.ok(!internetMessageIdsEqual('<a@b>', '<c@d>'));
  assert.strictEqual(stripAngleBrackets('<<x@y>>'), 'x@y');

  const map = buildRecipientEmailMapping(
    [
      { sourceEmail: 'alice@src.test', destinationEmail: 'alice@dst.test' },
      { sourceEmail: 'bob@src.test', destinationEmail: 'bob@dst.test' },
    ],
    { sourceEmail: 'owner@src.test', destinationEmail: 'owner@dst.test' }
  );
  assert.strictEqual(map.get('alice@src.test'), 'alice@dst.test');
  assert.strictEqual(map.get('owner@src.test'), 'owner@dst.test');
  const exp = expectedDestRecipientsFromSource(
    ['alice@src.test', 'noreply@external.com'].sort(),
    map
  );
  assert.deepStrictEqual(exp, ['alice@dst.test', 'noreply@external.com']);

  const tierDiffs = compareTierA(
    { subject: 'Hi', to: 'alice@src.test', attachments: [] },
    {
      subject: 'Hi',
      toRecipients: [{ emailAddress: { address: 'alice@dst.test' } }],
      attachments: [],
    },
    { recipientMapping: map }
  );
  assert.strictEqual(tierDiffs.filter((d) => d.field === 'to').length, 0);

  // Migration preserves the original sender address — From compares raw regardless of user-mapping.
  const fromPreservedOk = compareTierA(
    {
      subject: 'Hi',
      from: 'Peter <peter@src.test>',
      to: 'bob@src.test',
      attachments: [],
    },
    {
      subject: 'Hi',
      from: { emailAddress: { address: 'peter@src.test', name: 'Peter' } },
      toRecipients: [{ emailAddress: { address: 'bob@dst.test' } }],
      attachments: [],
    },
    {
      recipientMapping: buildRecipientEmailMapping(
        [
          { sourceEmail: 'peter@src.test', destinationEmail: 'peter@dst.test' },
          { sourceEmail: 'bob@src.test', destinationEmail: 'bob@dst.test' },
        ],
        null
      ),
    }
  );
  assert.strictEqual(
    fromPreservedOk.filter((d) => d.field === 'from').length,
    0,
    'From preserved (peter) should not diff even with user-mapping'
  );

  const fromChangedBad = compareTierA(
    {
      subject: 'Hi',
      from: 'Peter <peter@src.test>',
      attachments: [],
    },
    {
      subject: 'Hi',
      from: { emailAddress: { address: 'someoneelse@dst.test' } },
      attachments: [],
    },
    { recipientMapping: null }
  );
  assert.ok(
    fromChangedBad.some((d) => d.field === 'from'),
    'From rewritten at destination should be flagged'
  );

  // Permission mapping: source To granger@source → expect granger@dest in destination Tier A compare
  const grangerMap = buildRecipientEmailMapping(
    [
      { sourceEmail: 'granger@cloudfuze.us', destinationEmail: 'granger@gajha.com' },
      { sourceEmail: 'peter@cloudfuze.us', destinationEmail: 'santosh@gajha.com' },
    ],
    null
  );
  const grangerTier = compareTierA(
    {
      subject: 'QA thread',
      from: 'Peter <peter@cloudfuze.us>',
      to: 'Granger Test <granger@cloudfuze.us>',
      attachments: [],
    },
    {
      subject: 'QA thread',
      from: { emailAddress: { address: 'santosh@gajha.com' } },
      toRecipients: [{ emailAddress: { address: 'granger@gajha.com', name: 'Granger G' } }],
      attachments: [],
    },
    { recipientMapping: grangerMap }
  );
  assert.strictEqual(
    grangerTier.filter((d) => d.field === 'to').length,
    0,
    'destination To should match mapped granger@gajha.com'
  );

  // Attachment size divergence (Gmail decoded bytes vs Graph MIME-ish bytes) is not a mismatch:
  // names match ⇒ no Tier-A attachments diff.
  const attachSizeTier = compareTierA(
    {
      subject: 'QA E2E - Two attachments',
      from: 'peter@src.test',
      to: 'dan@src.test',
      attachments: [
        { filename: 'qa-first.txt', size: 40 },
        { filename: 'qa-second.txt', size: 36 },
      ],
    },
    {
      subject: 'QA E2E - Two attachments',
      from: { emailAddress: { address: 'peter@src.test' } },
      toRecipients: [{ emailAddress: { address: 'dan@src.test' } }],
      attachments: [
        { filename: 'qa-first.txt', size: 222 },
        { filename: 'qa-second.txt', size: 218 },
      ],
    }
  );
  assert.strictEqual(
    attachSizeTier.filter((d) => d.field === 'attachments').length,
    0,
    'attachment size divergence alone should not be flagged as a Tier-A mismatch'
  );

  // Tier C: source has text + attachments, destination body empty, source has attachments →
  // should note that re-migration is needed; wording stays short.
  const tierCEmptyDest = compareTierC(
    'E2E: multiple file attachments for name/size validation.',
    { content: '<html><body></body></html>', contentType: 'html' },
    { bodyMismatchSeverity: 'error', hasAttachments: true }
  );
  assert.strictEqual(tierCEmptyDest.length, 1);
  assert.ok(/re-migrate|support/i.test(tierCEmptyDest[0].displayDestination));

  // Tier C: source has text + attachments, destination body empty but attachments present →
  // report should say only the text body is missing, NOT that the whole body is empty.
  const tierCTextOnlyMissing = compareTierC(
    'Three file types in one message.',
    { content: '<html><body></body></html>', contentType: 'html' },
    { bodyMismatchSeverity: 'error', hasAttachments: true, destHasAttachments: true }
  );
  assert.strictEqual(tierCTextOnlyMissing.length, 1);
  assert.ok(
    /text body missing \(attachments migrated/i.test(tierCTextOnlyMissing[0].displayDestination),
    'should call out that only the text body is missing and attachments migrated'
  );
  assert.ok(
    /re-migrate|support ticket/i.test(tierCTextOnlyMissing[0].displayDestination),
    'should include an actionable step'
  );
  assert.ok(
    !/Destination body is empty/i.test(tierCTextOnlyMissing[0].displayDestination),
    'should NOT claim the whole destination body is empty when attachments are present'
  );

  // Tier C: source has text + attachments, destination has neither.
  const tierCWholeMissing = compareTierC(
    'Three file types in one message.',
    { content: '<html><body></body></html>', contentType: 'html' },
    { bodyMismatchSeverity: 'error', hasAttachments: true, destHasAttachments: false }
  );
  assert.strictEqual(tierCWholeMissing.length, 1);
  assert.ok(/body and attachments missing/i.test(tierCWholeMissing[0].displayDestination));

  // Gmail system labels ↔ Outlook system folders
  assert.strictEqual(
    compareFolderPlacement('SENT', 'Sent Items').length,
    0,
    'Gmail SENT ≡ Outlook "Sent Items" — no folder diff'
  );
  assert.strictEqual(compareFolderPlacement('INBOX', 'Inbox').length, 0);
  assert.strictEqual(compareFolderPlacement('TRASH', 'Deleted Items').length, 0);
  assert.strictEqual(compareFolderPlacement('SPAM', 'Junk Email').length, 0);
  assert.strictEqual(compareFolderPlacement('DRAFT', 'Drafts').length, 0);

  // ── Gmail → Outlook mapping rules ─────────────────────────────────────────
  {
    // System-label rule table
    const tbl = [
      [['INBOX'], 'Inbox'],
      [['SENT'], 'Sent Items'],
      [['DRAFT'], 'Drafts'],
      [['TRASH'], 'Deleted Items'],
      [['SPAM'], 'Junk Email'],
      [['CATEGORY_FORUMS'], 'CATEGORY_FORUMS'],
      [['CATEGORY_PROMOTIONS'], 'CATEGORY_PROMOTIONS'],
      [['CATEGORY_SOCIAL'], 'CATEGORY_SOCIAL'],
      [['CATEGORY_UPDATES'], 'CATEGORY_UPDATES'],
    ];
    for (const [labels, expected] of tbl) {
      const r = expectedOutlookFolderForGmailLabels(labels);
      assert.strictEqual(r.expectedFolder, expected, `Gmail ${labels.join('+')} → ${expected}`);
    }
  }

  // INBOX + SENT → INBOX wins (priority).
  assert.strictEqual(
    expectedOutlookFolderForGmailLabels(['INBOX', 'SENT']).expectedFolder,
    'Inbox'
  );

  // Custom label "ProjectX" → same-name Outlook folder.
  assert.strictEqual(
    expectedOutlookFolderForGmailLabels(['ProjectX']).expectedFolder,
    'ProjectX'
  );

  // STARRED-only → YELLOW_STAR
  assert.strictEqual(
    expectedOutlookFolderForGmailLabels(['STARRED']).expectedFolder,
    'YELLOW_STAR'
  );

  // STARRED + INBOX → Inbox (red flag stays in original folder)
  assert.strictEqual(
    expectedOutlookFolderForGmailLabels(['STARRED', 'INBOX']).expectedFolder,
    'Inbox'
  );

  // STARRED + custom label → custom label folder
  assert.strictEqual(
    expectedOutlookFolderForGmailLabels(['STARRED', 'ProjectX']).expectedFolder,
    'ProjectX'
  );

  // SNOOZED only → never migrated
  {
    const r = expectedOutlookFolderForGmailLabels(['SNOOZED']);
    assert.strictEqual(r.expectedFolder, null);
    assert.strictEqual(r.source, 'never-migrated');
  }

  // No labels + migrateOrphaned=false → orphan, no expected folder
  {
    const r = expectedOutlookFolderForGmailLabels([]);
    assert.strictEqual(r.expectedFolder, null);
    assert.strictEqual(r.source, 'orphan');
  }
  {
    const r = expectedOutlookFolderForGmailLabels([], { migrateOrphaned: true });
    assert.strictEqual(r.expectedFolder, 'Archive');
  }

  // ── validateGmailToOutlookPlacement — full scenarios ──────────────────────

  // Happy path: INBOX mail correctly in Outlook Inbox, no flags needed.
  assert.strictEqual(
    validateGmailToOutlookPlacement({
      gmailLabels: ['INBOX'],
      destFolderPath: 'Inbox',
      destFlag: null,
      destImportance: 'normal',
    }).length,
    0,
    'INBOX → Inbox with no markers: pass'
  );

  // STARRED + INBOX: expected Inbox + red flag; destination in Inbox but NOT flagged → flag error.
  {
    const d = validateGmailToOutlookPlacement({
      gmailLabels: ['INBOX', 'STARRED'],
      destFolderPath: 'Inbox',
      destFlag: { flagStatus: 'notFlagged' },
      destImportance: 'normal',
    });
    assert.strictEqual(d.length, 1);
    assert.strictEqual(d[0].field, 'starred');
    assert.ok(/flagged/i.test(d[0].expected));
  }

  // STARRED + INBOX + correctly flagged → pass.
  assert.strictEqual(
    validateGmailToOutlookPlacement({
      gmailLabels: ['INBOX', 'STARRED'],
      destFolderPath: 'Inbox',
      destFlag: { flagStatus: 'flagged' },
    }).length,
    0
  );

  // STARRED only → YELLOW_STAR folder required; destination in Inbox → folder error.
  {
    const d = validateGmailToOutlookPlacement({
      gmailLabels: ['STARRED'],
      destFolderPath: 'Inbox',
      destFlag: { flagStatus: 'flagged' },
    });
    assert.ok(d.some((x) => x.field === 'folder' && x.expected === 'YELLOW_STAR'));
  }

  // IMPORTANT → Outlook importance must be high.
  {
    const d = validateGmailToOutlookPlacement({
      gmailLabels: ['INBOX', 'IMPORTANT'],
      destFolderPath: 'Inbox',
      destImportance: 'normal',
    });
    assert.ok(d.some((x) => x.field === 'important'));
  }
  assert.strictEqual(
    validateGmailToOutlookPlacement({
      gmailLabels: ['INBOX', 'IMPORTANT'],
      destFolderPath: 'Inbox',
      destImportance: 'high',
    }).length,
    0
  );

  // Custom Gmail label preserved as same-name Outlook folder.
  assert.strictEqual(
    validateGmailToOutlookPlacement({
      gmailLabels: ['ProjectX'],
      destFolderPath: 'Inbox/ProjectX',
    }).length,
    0,
    'ProjectX (Gmail) ≡ ProjectX (Outlook folder) — pass, leaf-name compare'
  );

  // CATEGORY_FORUMS
  assert.strictEqual(
    validateGmailToOutlookPlacement({
      gmailLabels: ['CATEGORY_FORUMS'],
      destFolderPath: 'Inbox/CATEGORY_FORUMS',
    }).length,
    0
  );

  // TRASH → Deleted Items
  assert.strictEqual(
    validateGmailToOutlookPlacement({
      gmailLabels: ['TRASH'],
      destFolderPath: 'Deleted Items',
    }).length,
    0
  );

  // SPAM → Junk Email
  assert.strictEqual(
    validateGmailToOutlookPlacement({
      gmailLabels: ['SPAM'],
      destFolderPath: 'Junk Email',
    }).length,
    0
  );

  // SNOOZED but something appeared in Outlook → error (never-migrated rule breached).
  {
    const d = validateGmailToOutlookPlacement({
      gmailLabels: ['SNOOZED'],
      destFolderPath: 'Inbox',
    });
    assert.ok(d.some((x) => x.field === 'folder' && /not migrated/i.test(x.expected)));
  }

  console.log('mailMigrationComparator.test.js: ok');
}

run();
