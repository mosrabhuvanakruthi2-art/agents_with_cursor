const path = require('path');
const fs = require('fs');
const { BaseAgent } = require('../core/BaseAgent');
const gmailClient = require('../../clients/gmailClient');
const calendarClient = require('../../clients/calendarClient');
const env = require('../../config/env');
const logger = require('../../utils/logger');
const executionService = require('../../services/executionService');
const XLSX = require('xlsx');
const {
  tryLoadMailCasesFromExcel,
  tryLoadDraftCasesFromExcel,
  defaultGmailTestCasesXlsxPath,
} = require('../../utils/gmailTestCasesExcel');

/**
 * When domain users are unavailable (empty GOOGLE_ACCOUNTS, tenant3 with no Admin SDK results, etc.),
 * fall back to these external addresses so inbound/outbound mail is NOT self-addressed.
 * Inbox mail should appear to come FROM another person; Sent mail should go TO another person.
 */
const FALLBACK_EXTERNAL_CORRESPONDENTS = [
  'alice.johnson@external-qa.com',
  'bob.smith@testdomain.net',
  'carol.white@external-test.com',
  'david.lee@qamail.io',
  'eve.chen@sample-domain.org',
];

const SAMPLE_ATTACHMENT_DATA = Buffer.from('Sample attachment content for QA testing').toString('base64');
const SAMPLE_ATTACHMENT_SECOND = Buffer.from('Second file for multi-attachment E2E').toString('base64');
/** Minimal valid PDF (one empty page) for attachment-type migration checks */
const SAMPLE_MINIMAL_PDF_B64 = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/MediaBox[0 0 200 200]/Parent 2 0 R>>endobj\nxref\n0 4\ntrailer<</Root 1 0 R/Size 4>>\nstartxref\n178\n%%EOF'
).toString('base64');
/** ~1KB — small binary attachment tier */
const SAMPLE_1K_B64 = Buffer.alloc(1024, 77).toString('base64');
/** ~64KB — mid-size attachment (PDF “large” smoke) */
const SAMPLE_LARGE_B64 = Buffer.alloc(64 * 1024, 120).toString('base64');
/** ~100KB */
const SAMPLE_100K_B64 = Buffer.alloc(100 * 1024, 55).toString('base64');
/** ~512KB — large attachment stress without approaching provider limits */
const SAMPLE_512K_B64 = Buffer.alloc(512 * 1024, 99).toString('base64');
/** Minimal valid JPEG (1×1 px) — image/jpeg attachment migration */
const SAMPLE_JPEG_B64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDAREAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCwAA8A/9k=';
/** Minimal PNG (1×1 transparent) — image/png attachment migration */
const SAMPLE_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
/** Minimal STORE zip (qa-archive.txt) — application/zip attachment migration */
const SAMPLE_ZIP_B64 =
  'UEsDBBQAAAAAAIFSl1iua2JjFwAAABcAAAAOAAAAcWEtYXJjaGl2ZS50eHRtaWdyYXRpb24tcWEgemlwIHNhbXBsZVBLAQIUABQAAAAAAIFSl1iua2JjFwAAABcAAAAOAAAAAAAAAAAAAAAAAAAAAABxYS1hcmNoaXZlLnR4dFBLBQYAAAAAAQA8AAAAQwAAAAAAAAA=';
/** ~2MB — max practical tier for seeded mail (expect slower upload) */
const SAMPLE_2M_B64 = Buffer.alloc(2 * 1024 * 1024, 210).toString('base64');
/** Minimal CSV (user-mapping report style) — text/csv attachment migration */
const SAMPLE_CSV_B64 = Buffer.from(
  'Name,Email,Department\nDan,dan@cloudfuze.us,Admin\nAlice,alice@example.com,User\nBob,bob@example.com,Engineer'
).toString('base64');

function requestedTrashOrSpam(labelIds) {
  return (labelIds || []).some((id) => ['TRASH', 'SPAM'].includes(String(id).toUpperCase()));
}

/**
 * users.messages.insert often adds INBOX alongside SENT for outbound mail. Legacy seeds sometimes
 * requested INBOX explicitly (wrong for “sent” scenarios). Always remove INBOX for outbound so mail
 * stays out of Inbox; inbound keeps INBOX and drops stray SENT.
 */
async function reconcileInsertedMessageLabels(sourceEmail, emailDef, messageId, log) {
  if (!messageId) return;
  if (requestedTrashOrSpam(emailDef.labelIds)) return;

  if (emailDef.mailDirection === 'incoming') {
    try {
      await gmailClient.modifyMessageLabels(sourceEmail, 'me', messageId, [], ['SENT']);
    } catch (e) {
      log.warn(`Gmail seed: could not remove SENT from inbound message ${messageId}: ${e.message}`);
    }
    return;
  }

  try {
    await gmailClient.modifyMessageLabels(sourceEmail, 'me', messageId, [], ['INBOX']);
  } catch (e) {
    log.warn(`Gmail seed: could not remove INBOX from outbound message ${messageId}: ${e.message}`);
  }
}

/**
 * Prefix each subject with a per-run running counter so reports / Gmail show
 * "QA E2E 1 - ...", "QA E2E 2 - ...", etc. Matches any "QA <TestType> -" header (or bare
 * "QA -") and inserts the index before the separator; non-matching subjects get the
 * "[N] " prefix so numbering is still visible. Mutates + returns the same array.
 *
 * Kept intentionally separate from the insertion loop so the same function can renumber
 * mail and drafts independently (both start from 1).
 */
function applyRunningSubjectNumbering(emails) {
  if (!Array.isArray(emails)) return emails;
  let n = 0;
  const pad2 = (x) => String(x).padStart(2, '0');
  for (const def of emails) {
    if (!def || typeof def !== 'object') continue;
    n += 1;
    const original = String(def.subject || '').trim();
    if (!original) {
      def.subject = `QA [${pad2(n)}]`;
      continue;
    }
    const m = original.match(/^(QA(?:\s+[A-Za-z0-9]+)?)\s*-\s*(.*)$/i);
    if (m) {
      def.subject = `${m[1]} ${n} - ${m[2]}`.trim();
    } else {
      def.subject = `[${pad2(n)}] ${original}`;
    }
  }
  return emails;
}

/**
 * Inbound seeds: insert-only messages into the Gmail source's Inbox that LOOK like they
 * arrived from other tenant users. Nothing is actually sent — we build raw MIME and call
 * users.messages.insert against the source mailbox only; no data is written to the
 * correspondent's mailbox.
 *
 * @param {string} prefix subject prefix (e.g. "QA Smoke")
 * @param {string[] | string} sendersOrCorrespondent list of sender addresses to rotate through
 *                                                    (preferred); a single string still works.
 * @param {string} ccEmail alternate address for Cc on the "with Cc" seed (full mode).
 * @param {{ mode?: 'minimal'|'standard'|'full' }} opts
 * @returns {object[]} email definitions ready for insertion (each carries `inboundFrom`).
 */
function buildInboundInboxSeeds(prefix, sendersOrCorrespondent, ccEmail, { mode = 'standard' } = {}) {
  const sendersRaw = Array.isArray(sendersOrCorrespondent)
    ? sendersOrCorrespondent
    : [sendersOrCorrespondent];
  const senders = sendersRaw
    .map((s) => String(s || '').trim())
    .filter((s) => s.includes('@'));
  if (senders.length === 0) return [];

  // Deterministic rotation so the same run always produces the same sender per seed.
  const pickSender = (idx) => senders[idx % senders.length];

  const plain = {
    mailDirection: 'incoming',
    inboundFrom: pickSender(0),
    subject: `${prefix} - Inbound plain`,
    textBody:
      'Inbound: tenant user → migration source mailbox (expect Inbox). Used for received-mail migration QA. Insert-only — no mail left in sender mailbox.',
    labelIds: ['INBOX'],
  };
  const html = {
    mailDirection: 'incoming',
    inboundFrom: pickSender(1),
    subject: `${prefix} - Inbound HTML`,
    htmlBody:
      '<html><body><h2>Inbound HTML</h2><p>Received by source mailbox.</p><ul><li>List item</li></ul></body></html>',
    textBody: 'Inbound HTML fallback',
    labelIds: ['INBOX'],
  };
  const attach = {
    mailDirection: 'incoming',
    inboundFrom: pickSender(2),
    subject: `${prefix} - Inbound attachment`,
    textBody: 'Inbound with attachment.',
    labelIds: ['INBOX'],
    attachments: [{ filename: 'inbound-att.txt', mimeType: 'text/plain', data: SAMPLE_ATTACHMENT_DATA }],
  };

  if (mode === 'minimal') {
    return [plain];
  }

  let rows = [plain, html, attach];

  if (mode === 'standard' || mode === 'full') {
    rows.push(
      {
        mailDirection: 'incoming',
        inboundFrom: pickSender(3),
        subject: `${prefix} - Inbound text format (multiline bullets)`,
        textBody: 'Line1\nLine2\nLine3\n• bullet\n→ arrow\n€ £ ¥',
        htmlBody: '<html><body><p>Line1<br>Line2<br>Line3</p><p>• bullet</p><p>→ arrow</p><p>€ £ ¥</p></body></html>',
        labelIds: ['INBOX'],
      },
      {
        mailDirection: 'incoming',
        inboundFrom: pickSender(4),
        subject: `${prefix} - Inbound PNG image attachment`,
        textBody: 'Please find the screenshot attached.',
        labelIds: ['INBOX'],
        attachments: [{ filename: 'inbound-screenshot.png', mimeType: 'image/png', data: SAMPLE_PNG_B64 }],
      }
    );
  }

  if (mode === 'full') {
    const ccNorm = ccEmail ? String(ccEmail).trim().toLowerCase() : '';
    const ccDistinctFromSenders = ccNorm && !senders.some((s) => s.toLowerCase() === ccNorm);
    if (ccDistinctFromSenders) {
      rows.push({
        mailDirection: 'incoming',
        inboundFrom: pickSender(5),
        subject: `${prefix} - Inbound with Cc`,
        textBody: 'Inbound with Cc for mapping validation.',
        labelIds: ['INBOX'],
        cc: ccEmail,
      });
    }
    rows.push(
      {
        mailDirection: 'incoming',
        inboundFrom: pickSender(6),
        subject: `${prefix} - Inbound unread`,
        textBody: 'Inbound unread read-state check.',
        labelIds: ['INBOX', 'UNREAD'],
      },
      {
        mailDirection: 'incoming',
        inboundFrom: pickSender(7),
        subject: `${prefix} - Inbound Starred`,
        textBody: 'Inbound + Starred.',
        labelIds: ['INBOX', 'STARRED'],
      },
      {
        mailDirection: 'incoming',
        inboundFrom: pickSender(8),
        subject: `${prefix} - Inbound emoji subject 📬`,
        textBody: 'Unicode inbound subject line.',
        labelIds: ['INBOX'],
      },
      {
        mailDirection: 'incoming',
        inboundFrom: pickSender(9),
        subject: `${prefix} - Inbound rich HTML`,
        htmlBody: '<html><body><h2>Inbound Rich HTML</h2><p><strong>Bold</strong> <em>italic</em> <u>underline</u> <s>strikethrough</s></p><ul><li>Bullet one</li><li>Bullet two</li></ul><ol><li>Ordered one</li><li>Ordered two</li></ol><blockquote style="margin:0 0 0 40px;border-left:4px solid #ccc;padding-left:8px">Quoted block</blockquote><p><span style="color:#cc0000">Red text</span> <span style="background-color:#ffd600">Highlighted</span></p></body></html>',
        textBody: 'Inbound rich HTML fallback.',
        labelIds: ['INBOX'],
      },
      {
        mailDirection: 'incoming',
        inboundFrom: pickSender(10),
        subject: `${prefix} - Inbound PDF attachment`,
        textBody: 'Inbound with PDF attachment.',
        labelIds: ['INBOX'],
        attachments: [{ filename: 'inbound-document.pdf', mimeType: 'application/pdf', data: SAMPLE_MINIMAL_PDF_B64 }],
      },
      {
        mailDirection: 'incoming',
        inboundFrom: pickSender(11),
        subject: `${prefix} - Inbound two files (PNG and CSV)`,
        textBody: 'Sending 2 attachments',
        labelIds: ['INBOX'],
        attachments: [
          { filename: 'inbound-screenshot.png', mimeType: 'image/png', data: SAMPLE_PNG_B64 },
          { filename: 'inbound-report.csv', mimeType: 'text/csv', data: SAMPLE_CSV_B64 },
        ],
      },
      {
        mailDirection: 'incoming',
        inboundFrom: pickSender(12),
        subject: `${prefix} - Inbound Important`,
        textBody: 'Inbound + Important label migration check.',
        labelIds: ['INBOX', 'IMPORTANT'],
      },
      {
        mailDirection: 'incoming',
        inboundFrom: pickSender(13),
        subject: `${prefix} - Inbound long body`,
        textBody: 'This is a longer inbound email body for migration testing.\n\nParagraph two with more content to verify that multi-paragraph plain text emails are migrated correctly from Gmail to Outlook, preserving the full body without truncation.\n\nParagraph three — final section.\n\nRegards,\nQA Bot',
        labelIds: ['INBOX'],
      },
      {
        mailDirection: 'incoming',
        inboundFrom: pickSender(14),
        subject: `${prefix} - Inbound HTML with link and table`,
        htmlBody: '<html><body><p>Please review the migration report:</p><p><a href="https://example.com/report">View Report</a></p><table border="1" cellpadding="4"><tr><th>User</th><th>Status</th></tr><tr><td>alice@example.com</td><td>Migrated</td></tr><tr><td>bob@example.com</td><td>Pending</td></tr></table></body></html>',
        textBody: 'Please review the migration report. View: https://example.com/report',
        labelIds: ['INBOX'],
      }
    );
  }

  return rows;
}

/** Minimal labels for SANITY runs */
const SANITY_LABEL_NAMES = ['QA-TestLabel', 'QA-Important'];
/**
 * Full E2E: create custom Gmail labels at source, then seed mail (Sent + user labels and label-only).
 */
const E2E_LABEL_NAMES = [
  'QA-TestLabel',
  'QA-TestLabel/Nested-Child',
  'QA-Important',
  'QA-Archive',
  'QA-E2E-Staging',
  'QA-E2E-Compliance',
  /** Gmail→Outlook PDF scenarios: label→folder mapping (ProjectX, AutoLabel, nested child already above) */
  'ProjectX',
  'AutoLabel',
];

function loadCustomTestCases(testType, log) {
  try {
    const filePath = path.resolve(__dirname, '../../../data/custom-test-cases.json');
    if (!fs.existsSync(filePath)) return [];
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const cases = (data[testType.toLowerCase()] || []);
    if (cases.length > 0) log.info(`Loading ${cases.length} custom test case(s) for ${testType}`);
    return cases.map((tc) => ({
      subject: tc.subject,
      textBody: tc.textBody,
      htmlBody: tc.htmlBody,
      mailDirection: tc.mailDirection === 'incoming' ? 'incoming' : undefined,
      labelIds: tc.labelIds || (tc.mailDirection === 'incoming' ? ['INBOX'] : ['SENT']),
      attachments: tc.hasAttachment
        ? [{ filename: 'test-document.txt', mimeType: 'text/plain', data: SAMPLE_ATTACHMENT_DATA }]
        : undefined,
    }));
  } catch (e) {
    log.warn(`Failed to load custom test cases: ${e.message}`);
    return [];
  }
}
const SAMPLE_INLINE_IMAGE = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
).toString('base64');

/*
 * Test type determines how much test data gets created:
 *
 * SMOKE  — 1 plain text email only (quick connectivity check)
 * SANITY — plain text + HTML + attachment + labels + drafts (core features)
 * E2E    — full coverage: default + category + custom labels, Cc from GOOGLE_ACCOUNTS, emoji/Unicode,
 *          optional Snoozed label if present (Gmail API cannot set snooze time). Gmail UI “reactions”
 *          are not exposed for creation via public Gmail API — emoji-rich bodies cover Unicode instead.
 *          E2E adds: Bcc-only / Cc+Bcc / multi-attachment, HTML links+tables, unread bit, Personal category.
 *          E2E creates user labels (QA-E2E-*, ProjectX, AutoLabel, etc.) and seeds mail per label,
 *          including label-only. Outgoing: SENT + reconcile; inbound: INBOX (correspondent → source) so
 *          the source user receives mail. Additional seeds align with Gmail→Outlook PDF smoke/migration
 *          docs: compose To/Cc/Bcc + formatting + signature block, unicode, PDF + large binary attachments,
 *          multi-label on one message, conversation thread (In-Reply chain).
 *
 * Mail To: / calendar attendees: pickCorrespondentEmail() — another address from GOOGLE_ACCOUNTS
 * when available (else source). Messages are still inserted into the migration source mailbox.
 *
 * Calendar (E2E + Include Calendar): data is always created in the *source* user's Google account
 * (OAuth via GOOGLE_ACCOUNTS token for that user, with gmailClient fallback). One *secondary*
 * calendar "QA Secondary Calendar" is created; three events go on *primary*, one on that secondary.
 * FULL vs DELTA does not change this seeding — CloudFuze delta still migrates new/changed items.
 *
 * Mail + draft scenarios: primary source is backend/data/gmail-test-cases.xlsx (sheets Mail, Drafts).
 * Override path with GMAIL_TEST_CASES_XLSX. If the file or matching rows are missing, built-in
 * definitions in this module are used. Regenerate defaults: npm run generate-gmail-test-xlsx
 */

class GmailTestDataAgent extends BaseAgent {
  constructor() {
    super('GmailTestDataAgent');
  }

  async execute(context) {
    const log = logger.child({ agent: this.name, executionId: context.executionId });
    const sourceEmail = context.sourceEmail;
    const testType = context.testType || 'E2E';
    const summary = {
      testType,
      emailsCreated: 0,
      labelsCreated: 0,
      draftsCreated: 0,
      eventsCreated: 0,
      correspondentEmail: null,
    };

    // For tenant 3 (migrationn.com DWD), fetch domain users via Admin SDK
    // and use them as correspondent/cc/bcc/inbound senders instead of GOOGLE_ACCOUNTS.
    const sourceDomain = (sourceEmail || '').split('@')[1]?.toLowerCase() || '';
    const isTenant2 = Array.isArray(env.GOOGLE_TENANT_2_DOMAINS) && env.GOOGLE_TENANT_2_DOMAINS.includes(sourceDomain);
    const isTenant3 = Array.isArray(env.GOOGLE_TENANT_3_DOMAINS) && env.GOOGLE_TENANT_3_DOMAINS.includes(sourceDomain);
    const isDWDTenant = (isTenant2 && gmailClient.hasServiceAccount('2')) || isTenant3;

    let correspondentEmail, ccEmail, bccEmail, effectiveInboundSenders;

    if (isDWDTenant) {
      const tenantLabel = isTenant2 ? 'Tenant 2' : 'Tenant 3';
      const knownUsersEnvKey = isTenant2 ? 'GOOGLE_TENANT_2_KNOWN_USERS' : 'GOOGLE_TENANT_3_KNOWN_USERS';
      let domainUserEmails = [];

      // Prefer explicitly configured known users over Admin SDK.
      const knownUsers = (env[knownUsersEnvKey] || [])
        .filter((e) => e.toLowerCase() !== sourceEmail.toLowerCase());

      if (knownUsers.length > 0) {
        domainUserEmails = knownUsers;
        log.info(`${tenantLabel}: using ${domainUserEmails.length} configured known user(s): [${domainUserEmails.join(', ')}]`);
      } else {
        try {
          const domainUsers = await gmailClient.listDomainUsers(sourceEmail);
          domainUserEmails = domainUsers
            .map((u) => u.email)
            .filter((e) => e.toLowerCase() !== sourceEmail.toLowerCase());
          log.info(`${tenantLabel}: fetched ${domainUserEmails.length} domain user(s) via Admin SDK: [${domainUserEmails.join(', ')}]`);
        } catch (e) {
          log.warn(`${tenantLabel}: failed to fetch domain users via Admin SDK: ${e.message}`);
        }
      }

      if (domainUserEmails.length === 0) {
        log.warn(`${tenantLabel}: no domain users found — using external fallback correspondents so mail is not self-addressed`);
        correspondentEmail      = FALLBACK_EXTERNAL_CORRESPONDENTS[0];
        ccEmail                 = FALLBACK_EXTERNAL_CORRESPONDENTS[1];
        bccEmail                = FALLBACK_EXTERNAL_CORRESPONDENTS[2];
        effectiveInboundSenders = FALLBACK_EXTERNAL_CORRESPONDENTS;
      } else {
        correspondentEmail      = domainUserEmails[0];
        ccEmail                 = domainUserEmails[1] || FALLBACK_EXTERNAL_CORRESPONDENTS[1];
        bccEmail                = domainUserEmails[2] || FALLBACK_EXTERNAL_CORRESPONDENTS[2];
        effectiveInboundSenders = domainUserEmails;
      }
    } else {
      correspondentEmail = env.pickCorrespondentEmail(sourceEmail);
      ccEmail = env.pickCcEmail(sourceEmail, correspondentEmail);
      bccEmail = env.pickBccEmail(sourceEmail, correspondentEmail, ccEmail);
      const inboundSenders = env.buildGoogleInboundSenders(sourceEmail);
      effectiveInboundSenders = inboundSenders.length > 0 ? inboundSenders : [correspondentEmail];

      // If GOOGLE_ACCOUNTS has only one entry the pickers fall back to sourceEmail.
      // Replace with external fallback addresses so mail is never self-addressed.
      if (correspondentEmail.toLowerCase() === sourceEmail.toLowerCase()) {
        log.warn('No distinct correspondent in GOOGLE_ACCOUNTS — using external fallback addresses so mail is not self-addressed');
        correspondentEmail      = FALLBACK_EXTERNAL_CORRESPONDENTS[0];
        ccEmail                 = FALLBACK_EXTERNAL_CORRESPONDENTS[1];
        bccEmail                = FALLBACK_EXTERNAL_CORRESPONDENTS[2];
        effectiveInboundSenders = FALLBACK_EXTERNAL_CORRESPONDENTS;
      }
    }

    summary.correspondentEmail = correspondentEmail;
    summary.ccEmail = ccEmail;
    summary.bccEmail = bccEmail;
    summary.inboundSenders = effectiveInboundSenders;
    log.info(
      `Creating test data in Gmail for: ${sourceEmail} [${testType}] — To: ${correspondentEmail}, Cc: ${ccEmail}, Bcc: ${bccEmail}, Inbound senders: [${effectiveInboundSenders.join(', ')}] (${isDWDTenant ? 'Admin SDK DWD' : 'GOOGLE_ACCOUNTS'})`
    );

    if (context.includeMail) {
      if (testType !== 'SMOKE') {
        await this._createLabels(sourceEmail, testType, summary, log);
      }
      if (!executionService.isCancelled(context.executionId)) {
        await this._createEmails(sourceEmail, correspondentEmail, ccEmail, bccEmail, effectiveInboundSenders, testType, summary, log, context.executionId);
      }
      if (!executionService.isCancelled(context.executionId) && testType !== 'SMOKE') {
        await this._createDrafts(sourceEmail, correspondentEmail, ccEmail, testType, summary, log, context.executionId);
      }
    }

    if (!executionService.isCancelled(context.executionId) && context.includeCalendar && testType === 'E2E') {
      await this._createCalendarEvents(sourceEmail, correspondentEmail, summary, log);
    }

    log.info(`Test data generation complete [${testType}]: ${JSON.stringify(summary)}`);
    return summary;
  }

  async _createLabels(sourceEmail, testType, summary, log) {
    const labels = testType === 'SANITY' ? SANITY_LABEL_NAMES : E2E_LABEL_NAMES;

    for (const labelName of labels) {
      try {
        await gmailClient.createLabel(sourceEmail, 'me', labelName);
        summary.labelsCreated++;
        log.info(`Created label: ${labelName}`);
      } catch (err) {
        if (err.message?.includes('already exists') || err.message?.includes('conflicts')) {
          log.info(`Label already exists: ${labelName}`);
        } else {
          log.error(`Failed to create label ${labelName}: ${err.message}`);
        }
      }
    }
  }

  async _loadE2ELabelContext(sourceEmail, log) {
    let labels = [];
    try {
      labels = await gmailClient.listLabels(sourceEmail, 'me');
    } catch (e) {
      log.error(`E2E: listLabels failed: ${e.message}`);
    }
    const names = [...E2E_LABEL_NAMES];
    const qaIds = {};
    for (const n of names) {
      const hit = labels.find((l) => l.name === n);
      if (hit) qaIds[n] = hit.id;
      else log.warn(`E2E: label "${n}" not found — run label creation or check name`);
    }
    const snoozeHit = labels.find((l) => /snooz/i.test(l.name || ''));
    if (snoozeHit) log.info(`E2E: Snooze label "${snoozeHit.name}" (${snoozeHit.id})`);
    const snoozeId = snoozeHit?.id || null;
    if (!snoozeId) log.warn('E2E: No "Snoozed" label in mailbox — skipping snooze sample');
    return { qaIds, snoozeId };
  }

  _e2eEmailDefinitions(qaIds, snoozeId, ccEmail, bccEmail, sourceEmail, correspondentEmail) {
    const reactionNote =
      '<p style="color:#666"><i>Gmail UI reactions are not set via API; emoji exercises Unicode in migration.</i></p>';
    const base = [
      {
        subject: 'QA E2E - Plain Text Email',
        textBody: 'E2E test: plain text email for full migration testing.',
        labelIds: ['SENT'],
      },
      {
        subject: 'QA E2E - HTML Email',
        htmlBody: `<html><body>
          <h1>HTML Test Email</h1>
          <p>This is an <strong>HTML email</strong> generated by the QA agent.</p>
          <ul><li>Item 1</li><li>Item 2</li><li>Item 3</li></ul>
        </body></html>`,
        textBody: 'HTML Test Email - fallback plain text',
        labelIds: ['SENT'],
      },
      {
        subject: 'QA E2E - Email with Attachment',
        textBody: 'E2E test: email with attachment.',
        attachments: [{ filename: 'test-document.txt', mimeType: 'text/plain', data: SAMPLE_ATTACHMENT_DATA }],
        labelIds: ['SENT'],
      },
      {
        subject: 'QA E2E - Email with Inline Image',
        htmlBody: `<html><body>
          <h1>Inline Image Test 👍</h1>
          ${reactionNote}
          <p>Emoji in body: ❤️ 😀 🎉</p>
          <p>Below is an inline image:</p>
          <img src="cid:inline-image-001" alt="test image" />
        </body></html>`,
        textBody: 'Inline + emoji fallback',
        inlineImages: [{ contentId: 'inline-image-001', mimeType: 'image/gif', data: SAMPLE_INLINE_IMAGE }],
        labelIds: ['SENT'],
        cc: ccEmail,
      },
      {
        subject: 'QA E2E - Cc from GOOGLE_ACCOUNTS',
        textBody: 'E2E: Cc line uses a distinct address from GOOGLE_ACCOUNTS (see env picker).',
        labelIds: ['SENT'],
        cc: ccEmail,
      },
      {
        subject: 'QA E2E - Emoji subject 📧✅',
        textBody: 'Plain body emoji: 👍 ❤️ 😀 🎉 📎',
        htmlBody: `<html><body>${reactionNote}<h2>Unicode 🚀</h2><p>✅ ❌ ⭐ 📧</p></body></html>`,
        labelIds: ['SENT'],
        cc: ccEmail,
      },
      { subject: 'QA E2E - Starred', textBody: 'E2E: Sent + Starred.', labelIds: ['SENT', 'STARRED'] },
      { subject: 'QA E2E - Important', textBody: 'E2E: Sent + Important.', labelIds: ['SENT', 'IMPORTANT'] },
      {
        subject: 'QA E2E - Category Social',
        textBody: 'E2E: Primary + Social category.',
        labelIds: ['SENT', 'CATEGORY_SOCIAL'],
      },
      {
        subject: 'QA E2E - Category Forums',
        textBody: 'E2E: Primary + Forums category.',
        labelIds: ['SENT', 'CATEGORY_FORUMS'],
      },
      {
        subject: 'QA E2E - Category Promotions',
        textBody: 'E2E: Primary + Promotions category.',
        labelIds: ['SENT', 'CATEGORY_PROMOTIONS'],
      },
      {
        subject: 'QA E2E - Category Updates',
        textBody: 'E2E: Primary + Updates category.',
        labelIds: ['SENT', 'CATEGORY_UPDATES'],
      },
      { subject: 'QA E2E - Spam folder', textBody: 'E2E: message in Spam.', labelIds: ['SPAM'] },
      { subject: 'QA E2E - Trash folder', textBody: 'E2E: message in Trash.', labelIds: ['TRASH'] },
      {
        subject: 'QA E2E - Sent Email',
        textBody: 'E2E test: sent email for migration testing.',
        labelIds: ['SENT'],
      },
      {
        subject: 'QA E2E - Bcc from GOOGLE_ACCOUNTS',
        textBody: 'E2E: Bcc line only (distinct GOOGLE_ACCOUNTS user, not sender); validates Bcc migration + mapping.',
        labelIds: ['SENT'],
        bcc: bccEmail,
      },
      {
        subject: 'QA E2E - Cc and Bcc combined',
        textBody: 'E2E: From/To/Cc/Bcc all distinct GOOGLE_ACCOUNTS users (no self-Bcc).',
        labelIds: ['SENT'],
        cc: ccEmail,
        bcc: bccEmail,
      },
      {
        subject: 'QA E2E - Two attachments',
        textBody: 'E2E: multiple file attachments for name/size validation.',
        labelIds: ['SENT'],
        attachments: [
          { filename: 'qa-first.txt', mimeType: 'text/plain', data: SAMPLE_ATTACHMENT_DATA },
          { filename: 'qa-second.txt', mimeType: 'text/plain', data: SAMPLE_ATTACHMENT_SECOND },
        ],
      },
      {
        subject: 'QA E2E - Text with single file (PNG image)',
        textBody: 'Please find the screenshot attached.',
        labelIds: ['SENT'],
        attachments: [{ filename: 'qa-screenshot.png', mimeType: 'image/png', data: SAMPLE_PNG_B64 }],
      },
      {
        subject: 'QA E2E - Text with two files (PNG and CSV)',
        textBody: 'Sending 2 attachments',
        labelIds: ['SENT'],
        attachments: [
          { filename: 'qa-screenshot.png', mimeType: 'image/png', data: SAMPLE_PNG_B64 },
          { filename: 'qa-report.csv', mimeType: 'text/csv', data: SAMPLE_CSV_B64 },
        ],
      },
      {
        subject: 'QA E2E - Text with file (JPEG and PDF)',
        textBody: 'Please review the attached image and PDF document.',
        labelIds: ['SENT'],
        attachments: [
          { filename: 'qa-sample.jpg', mimeType: 'image/jpeg', data: SAMPLE_JPEG_B64 },
          { filename: 'qa-onepage.pdf', mimeType: 'application/pdf', data: SAMPLE_MINIMAL_PDF_B64 },
        ],
      },
      {
        subject: 'QA E2E - Text with CSV attachment',
        textBody: 'Please find the user mapping report attached.',
        labelIds: ['SENT'],
        attachments: [{ filename: 'qa-report.csv', mimeType: 'text/csv', data: SAMPLE_CSV_B64 }],
      },
      {
        subject: 'QA E2E - HTML links and table',
        textBody: 'Plain fallback for HTML with links.',
        htmlBody: `<html><body>
          <p><a href="https://example.com/migration-qa">Example link</a> and <a href="mailto:test@example.com">mailto</a></p>
          <table border="1" cellpadding="4"><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>
        </body></html>`,
        labelIds: ['SENT'],
      },
      {
        subject: 'QA E2E - Subject "Re:" special chars <tag> | pipe',
        textBody: 'E2E: subject line encoding and punctuation survive migration.',
        labelIds: ['SENT'],
      },
      {
        subject: 'QA E2E - Unread',
        textBody: 'E2E: Sent + UNREAD for read-state migration checks.',
        labelIds: ['SENT', 'UNREAD'],
      },
      {
        subject: 'QA E2E - Category Personal',
        textBody: 'E2E: Primary + Personal category.',
        labelIds: ['SENT', 'CATEGORY_PERSONAL'],
      },
      {
        subject: 'QA E2E - PDF Smoke 3.2 Compose To Cc Bcc format signature',
        htmlBody: `<html><body>
          <p><strong>Bold</strong>, <em>italic</em>, <u>underline</u></p>
          <ul><li>Bullet one</li><li>Bullet two</li></ul>
          <p style="color:#234">Formatted body (Smoke PDF 3.2).</p>
          <hr/>
          <p>—<br/>Migration QA Bot<br/>Signature block</p>
        </body></html>`,
        textBody: 'Compose PDF scenario: formatting + signature plain fallback.',
        labelIds: ['SENT'],
        cc: ccEmail,
        bcc: bccEmail,
      },
      {
        subject: 'QA E2E - PDF 3.14 Email formatting',
        htmlBody:
          '<html><body><p><b>Bold</b> <i>Italic</i> <u>Underline</u></p><ol><li>Ordered</li><li>List</li></ol></body></html>',
        textBody: 'Formatting fallback',
        labelIds: ['SENT'],
      },
      {
        subject: 'QA E2E - PDF 3.30 Unicode multilingual مرحبا 中文 한글 🌍',
        textBody: 'rus: привет • téxt',
        htmlBody: '<html><body><p>العربية • 日本語 • 🎉</p></body></html>',
        labelIds: ['SENT'],
      },
      {
        subject: 'QA E2E - PDF 3.4 Attachments txt and pdf',
        textBody: 'GMAIL TO OUTLOOK PDF: multiple attachment types.',
        labelIds: ['SENT'],
        attachments: [
          { filename: 'qa-notes.txt', mimeType: 'text/plain', data: SAMPLE_ATTACHMENT_DATA },
          { filename: 'qa-onepage.pdf', mimeType: 'application/pdf', data: SAMPLE_MINIMAL_PDF_B64 },
        ],
      },
      {
        subject: 'QA E2E - PDF 3.4 Large attachment 64KB',
        textBody: 'Large blob for size/integrity checks.',
        labelIds: ['SENT'],
        attachments: [{ filename: 'qa-large.bin', mimeType: 'application/octet-stream', data: SAMPLE_LARGE_B64 }],
      },
      {
        subject: 'QA E2E - Attachment ~1KB binary',
        textBody: 'Single ~1KB attachment (small tier).',
        labelIds: ['SENT'],
        attachments: [{ filename: 'qa-1k.bin', mimeType: 'application/octet-stream', data: SAMPLE_1K_B64 }],
      },
      {
        subject: 'QA E2E - Attachment ~100KB binary',
        textBody: 'Single ~100KB attachment (medium-large tier).',
        labelIds: ['SENT'],
        attachments: [{ filename: 'qa-100k.bin', mimeType: 'application/octet-stream', data: SAMPLE_100K_B64 }],
      },
      {
        subject: 'QA E2E - Attachment ~512KB binary',
        textBody: 'Single ~512KB attachment (large tier for Gmail→Outlook).',
        labelIds: ['SENT'],
        attachments: [{ filename: 'qa-512k.bin', mimeType: 'application/octet-stream', data: SAMPLE_512K_B64 }],
      },
      {
        subject: 'QA E2E - Attachment JPEG image',
        textBody: 'Minimal JPEG file as normal attachment (not inline).',
        labelIds: ['SENT'],
        attachments: [{ filename: 'qa-sample.jpg', mimeType: 'image/jpeg', data: SAMPLE_JPEG_B64 }],
      },
      {
        subject: 'QA E2E - Attachment PNG image',
        textBody: 'Minimal PNG file as normal attachment.',
        labelIds: ['SENT'],
        attachments: [{ filename: 'qa-sample.png', mimeType: 'image/png', data: SAMPLE_PNG_B64 }],
      },
      {
        subject: 'QA E2E - Attachment ZIP archive',
        textBody: 'Minimal ZIP with one text entry.',
        labelIds: ['SENT'],
        attachments: [{ filename: 'qa-sample.zip', mimeType: 'application/zip', data: SAMPLE_ZIP_B64 }],
      },
      {
        subject: 'QA E2E - Attachment ~2MB binary',
        textBody: 'Large ~2MB blob for attachment size ceiling checks.',
        labelIds: ['SENT'],
        attachments: [{ filename: 'qa-2mb.bin', mimeType: 'application/octet-stream', data: SAMPLE_2M_B64 }],
      },
      {
        subject: 'QA E2E - Attachments JPEG PNG ZIP together',
        textBody: 'Three common file types in one message.',
        labelIds: ['SENT'],
        attachments: [
          { filename: 'qa-sample.jpg', mimeType: 'image/jpeg', data: SAMPLE_JPEG_B64 },
          { filename: 'qa-sample.png', mimeType: 'image/png', data: SAMPLE_PNG_B64 },
          { filename: 'qa-sample.zip', mimeType: 'application/zip', data: SAMPLE_ZIP_B64 },
        ],
      },
      {
        subject: 'QA E2E - Rich HTML strike blockquote pre code color font',
        textBody: 'Fallback: strike, quote, code.',
        htmlBody: `<html><body>
          <p><s>Strikethrough</s> <sub>sub</sub> <sup>sup</sup></p>
          <blockquote cite="https://example.com">Quoted migration block.</blockquote>
          <pre>line1\nline2\t<code>inline code</code></pre>
          <p><span style="color:#b35900;font-size:16px">Colored span</span>
          <span style="background:#eee;padding:2px">Highlighted</span></p>
          <p><font face="Georgia,serif">Georgia body text</font></p>
        </body></html>`,
        labelIds: ['SENT'],
      },
      {
        subject: 'QA E2E - Many hyperlinks http https mailto query',
        textBody: 'Plain fallback for link-heavy HTML.',
        htmlBody: `<html><body>
          <p><a href="https://example.com/migration-qa/path">HTTPS path</a></p>
          <p><a href="http://example.org/http-only">HTTP only</a></p>
          <p><a href="mailto:migration-qa@example.com?subject=Hello">mailto with subject</a></p>
          <p><a href="https://example.com/search?q=gmail+outlook&amp;utf8=✓">Query + unicode</a></p>
          <p><a href="https://learn.microsoft.com/graph/">Microsoft Graph docs</a></p>
        </body></html>`,
        labelIds: ['SENT'],
      },
      {
        subject: 'QA E2E - Emoji density 🎯📎✨ mixed scripts',
        textBody: '🎉'.repeat(12) + ' plain • tab\there • newline\nnext line',
        htmlBody: `<html><body><p>${'🙂❤️📧'.repeat(8)}</p>
          <p>αβγ Δ Ε • 中文 • العربية • 한글</p>
          <p>${reactionNote}</p></body></html>`,
        labelIds: ['SENT'],
      },
      {
        subject: 'QA E2E - Text format plain (multiline bullets arrows currency)',
        textBody: 'Line1\nLine2\nLine3\n• bullet\n→ arrow\n€ £ ¥',
        htmlBody: '<html><body><p>Line1<br>Line2<br>Line3</p><p>• bullet</p><p>→ arrow</p><p>€ £ ¥</p></body></html>',
        labelIds: ['SENT'],
      },
      {
        subject: 'QA E2E - All text formats comprehensive',
        textBody: 'All Gmail compose toolbar formats: bold, italic, underline, strikethrough, font size/family, colors, alignment, lists, blockquote, indent, unicode.',
        htmlBody: `<html><body>
<p><strong>Bold text</strong></p>
<p><em>Italic text</em></p>
<p><u>Underlined text</u></p>
<p><s>Strikethrough text</s></p>
<p><strong><em>Bold and Italic combined</em></strong></p>
<p><strong><em><u>Bold Italic Underline all three</u></em></strong></p>
<p><strong><s>Bold Strikethrough</s></strong></p>
<p><span style="font-size:10px">Small font (10px)</span></p>
<p><span style="font-size:14px">Normal font (14px)</span></p>
<p><span style="font-size:18px">Large font (18px)</span></p>
<p><span style="font-size:24px">Extra large font (24px)</span></p>
<p><span style="font-family:Georgia,serif">Georgia serif font</span></p>
<p><span style="font-family:'Courier New',monospace">Courier monospace font</span></p>
<p><span style="font-family:Arial,sans-serif">Arial sans-serif font</span></p>
<p><span style="color:#cc0000">Red colored text</span></p>
<p><span style="color:#1a73e8">Blue colored text</span></p>
<p><span style="color:#188038">Green colored text</span></p>
<p><span style="background-color:#ffd600">Yellow highlighted text</span></p>
<p><span style="color:#cc0000;background-color:#ffd600"><strong>Bold red on yellow highlight</strong></span></p>
<p style="text-align:left">Left aligned paragraph</p>
<p style="text-align:center">Center aligned paragraph</p>
<p style="text-align:right">Right aligned paragraph</p>
<p style="text-align:justify">Justified paragraph — longer text to demonstrate full-width justification across the line in migration.</p>
<ol><li>Ordered item one</li><li>Ordered item two</li><li>Ordered item three</li></ol>
<ul><li>Bullet item one</li><li>Bullet item two</li><li>Bullet item three</li></ul>
<ul><li>Parent bullet<ul><li>Nested child bullet one</li><li>Nested child bullet two</li></ul></li></ul>
<blockquote style="margin:0 0 0 40px;border-left:4px solid #ccc;padding-left:8px">Blockquote — indented quoted block for migration testing.</blockquote>
<p style="padding-left:40px">Single indent paragraph</p>
<p style="padding-left:80px">Double indent paragraph</p>
<p>Line1<br>Line2<br>Line3<br>• bullet &nbsp; → arrow &nbsp; € £ ¥ § ™ © ®</p>
</body></html>`,
        labelIds: ['SENT'],
      },
      {
        subject: 'QA E2E - Text format bold italic underline strikethrough',
        textBody: 'Bold / italic / underline / strikethrough format test.',
        htmlBody: '<html><body><p><strong>Bold</strong> — <em>Italic</em> — <u>Underline</u> — <s>Strikethrough</s></p><p><strong><em><u><s>All four combined</s></u></em></strong></p></body></html>',
        labelIds: ['SENT'],
      },
      {
        subject: 'QA E2E - Text format font sizes',
        textBody: 'Font size format test: small normal large extra-large.',
        htmlBody: '<html><body><p><span style="font-size:10px">Small (10px)</span></p><p><span style="font-size:14px">Normal (14px)</span></p><p><span style="font-size:18px">Large (18px)</span></p><p><span style="font-size:24px">Extra Large (24px)</span></p><p><span style="font-size:36px">Huge (36px)</span></p></body></html>',
        labelIds: ['SENT'],
      },
      {
        subject: 'QA E2E - Text format font families',
        textBody: 'Font family format test: sans-serif, serif, monospace.',
        htmlBody: '<html><body><p><span style="font-family:Arial,sans-serif">Arial sans-serif</span></p><p><span style="font-family:Georgia,serif">Georgia serif</span></p><p><span style="font-family:\'Courier New\',monospace">Courier New monospace</span></p><p><span style="font-family:Tahoma,sans-serif">Tahoma</span></p><p><span style="font-family:Verdana,sans-serif">Verdana</span></p></body></html>',
        labelIds: ['SENT'],
      },
      {
        subject: 'QA E2E - Text format text colors and highlights',
        textBody: 'Text color and highlight format test.',
        htmlBody: '<html><body><p><span style="color:#cc0000">Red text</span></p><p><span style="color:#1a73e8">Blue text</span></p><p><span style="color:#188038">Green text</span></p><p><span style="color:#e37400">Orange text</span></p><p><span style="color:#9c27b0">Purple text</span></p><p><span style="background-color:#ffd600">Yellow highlight</span></p><p><span style="background-color:#b2dfdb">Teal highlight</span></p><p><span style="color:#cc0000;background-color:#ffd600">Red text yellow background</span></p></body></html>',
        labelIds: ['SENT'],
      },
      {
        subject: 'QA E2E - Text format alignment (left center right justify)',
        textBody: 'Text alignment format test.',
        htmlBody: '<html><body><p style="text-align:left">Left aligned text</p><p style="text-align:center">Center aligned text</p><p style="text-align:right">Right aligned text</p><p style="text-align:justify">Justified text — this paragraph has enough words to stretch across the full width and demonstrate text justification in migration from Gmail to Outlook.</p></body></html>',
        labelIds: ['SENT'],
      },
      {
        subject: 'QA E2E - Text format ordered and unordered lists',
        textBody: 'Ordered and unordered list format test.',
        htmlBody: '<html><body><ol><li>First ordered item</li><li>Second ordered item</li><li>Third ordered item</li></ol><ul><li>First bullet item</li><li>Second bullet item</li><li>Third bullet item</li></ul><ul><li>Parent item<ul><li>Nested child one</li><li>Nested child two<ul><li>Deep nested level</li></ul></li></ul></li></ul><ol><li>Ordered parent<ol><li>Ordered sub-item</li><li>Another sub-item</li></ol></li></ol></body></html>',
        labelIds: ['SENT'],
      },
      {
        subject: 'QA E2E - Text format blockquote and indent',
        textBody: 'Blockquote and indent format test.',
        htmlBody: '<html><body><p>Normal paragraph before blockquote.</p><blockquote style="margin:0 0 0 40px;border-left:4px solid #ccc;padding-left:8px">Single level blockquote text.</blockquote><blockquote style="margin:0 0 0 40px;border-left:4px solid #ccc;padding-left:8px"><blockquote style="margin:0 0 0 40px;border-left:4px solid #ccc;padding-left:8px">Double nested blockquote.</blockquote></blockquote><p style="padding-left:40px">Single indent paragraph.</p><p style="padding-left:80px">Double indent paragraph.</p><p style="padding-left:120px">Triple indent paragraph.</p><p>Normal paragraph after.</p></body></html>',
        labelIds: ['SENT'],
      },
      {
        subject: 'QA E2E - Cc Bcc txt attachment + HTML link',
        textBody: 'Combo: Cc + Bcc + attachment + formatted link body.',
        htmlBody:
          '<html><body><p><a href="https://example.com/migration">Migration link</a></p><p><strong>Bold</strong> <em>italic</em></p></body></html>',
        labelIds: ['SENT'],
        cc: ccEmail,
        bcc: ccEmail,
        attachments: [{ filename: 'test-document.txt', mimeType: 'text/plain', data: SAMPLE_ATTACHMENT_DATA }],
      },
    ];

    const custom = [];
    const addIf = (name, subject, body) => {
      const id = qaIds[name];
      if (id) custom.push({ subject, textBody: body, labelIds: ['SENT', id] });
    };
    addIf('QA-TestLabel', 'QA E2E - In QA-TestLabel', 'E2E: user label QA-TestLabel.');
    addIf('QA-TestLabel', 'QA E2E - Second mail in QA-TestLabel', 'E2E: second message under QA-TestLabel.');
    addIf('QA-Important', 'QA E2E - In QA-Important', 'E2E: user label QA-Important.');
    addIf('QA-Important', 'QA E2E - Second mail in QA-Important', 'E2E: second message under QA-Important.');
    addIf('QA-Archive', 'QA E2E - In QA-Archive', 'E2E: user label QA-Archive.');
    addIf(
      'QA-TestLabel/Nested-Child',
      'QA E2E - In QA-TestLabel/Nested-Child',
      'E2E: nested user label.'
    );
    addIf('QA-E2E-Staging', 'QA E2E - In QA-E2E-Staging', 'E2E: staging label + Sent.');
    addIf('QA-E2E-Staging', 'QA E2E - Staging follow-up', 'E2E: second mail in QA-E2E-Staging.');
    addIf('QA-E2E-Compliance', 'QA E2E - In QA-E2E-Compliance', 'E2E: compliance label + Sent.');
    addIf('QA-E2E-Compliance', 'QA E2E - Compliance attachment note', 'E2E: second mail in QA-E2E-Compliance.');
    addIf('ProjectX', 'QA E2E - PDF 3.5 ProjectX (A)', 'GMAIL TO OUTLOOK PDF: label ProjectX → Outlook folder.');
    addIf('ProjectX', 'QA E2E - PDF 3.5 ProjectX (B)', 'Second mail under ProjectX.');
    addIf('AutoLabel', 'QA E2E - PDF AutoLabel', 'Smoke PDF 3.18 / PDF 3.16: filter/rule label target.');

    /** PDF 3.6 — multiple user labels on one message */
    const multiLabelOne = [];
    const idMultA = qaIds['QA-TestLabel'];
    const idMultB = qaIds['QA-E2E-Staging'];
    if (idMultA && idMultB) {
      multiLabelOne.push({
        subject: 'QA E2E - PDF 3.6 Multiple labels one message',
        textBody: 'GMAIL TO OUTLOOK PDF 3.6: one message with two user labels.',
        labelIds: ['SENT', idMultA, idMultB],
      });
    }

    /** Messages that exist only under a custom label (not in Sent/Inbox) — folder migration coverage */
    const labelOnly = [];
    for (const name of ['QA-Archive', 'QA-E2E-Compliance', 'QA-E2E-Staging']) {
      const id = qaIds[name];
      if (id) {
        labelOnly.push({
          subject: `QA E2E - Label-only · ${name}`,
          textBody: `E2E: message appears only under user label "${name}" (not in Sent/Inbox).`,
          labelIds: [id],
        });
      }
    }

    const snooze = [];
    if (snoozeId) {
      snooze.push({
        subject: 'QA E2E - Snoozed label',
        textBody: 'E2E: Sent + Snoozed label applied via API (snooze time not set).',
        labelIds: ['SENT'],
        postInsert: async (src, msgId, lg) => {
          await gmailClient.modifyMessageLabels(src, 'me', msgId, [snoozeId], []);
          lg.info(`Applied Snoozed label to message ${msgId}`);
        },
      });
    }

    const inbound = buildInboundInboxSeeds('QA E2E', correspondentEmail, ccEmail, { mode: 'full' });

    return [...base, ...custom, ...multiLabelOne, ...labelOnly, ...snooze, ...inbound];
  }

  /**
   * Smoke PDF 3.15 / GMAIL PDF 3.12 — two messages in one Gmail thread for Outlook conversation view.
   */
  async _seedPdfConversationThread(sourceEmail, toEmail, summary, log, executionId) {
    if (executionId && executionService.isCancelled(executionId)) return;
    try {
      const rawRoot = gmailClient.buildRawMessage({
        to: toEmail,
        from: sourceEmail,
        subject: 'QA E2E - PDF Thread root (conversation)',
        textBody: 'Root message for conversation / thread migration (PDF scenarios).',
      });
      const root = await gmailClient.insertEmail(sourceEmail, 'me', rawRoot, ['SENT']);
      await reconcileInsertedMessageLabels(
        sourceEmail,
        { labelIds: ['SENT'] },
        root?.id,
        log
      );
      const tid = root.threadId;
      if (!tid) {
        log.warn('E2E conversation seed: no threadId from Gmail');
        return;
      }
      const rawReply = gmailClient.buildRawMessage({
        to: toEmail,
        from: sourceEmail,
        subject: 'Re: QA E2E - PDF Thread root (conversation)',
        textBody: 'Reply in the same Gmail thread for Outlook conversation grouping.',
      });
      const reply = await gmailClient.insertEmail(sourceEmail, 'me', rawReply, ['SENT'], { threadId: tid });
      await reconcileInsertedMessageLabels(sourceEmail, { labelIds: ['SENT'] }, reply?.id, log);
      summary.emailsCreated += 2;
      log.info('E2E: seeded PDF conversation thread (2 messages)');
    } catch (err) {
      log.warn(`E2E conversation thread seed failed: ${err.message}`);
    }
  }

  async _createEmails(sourceEmail, toEmail, ccEmail, bccEmail, inboundSenders, testType, summary, log, executionId) {
    const smokeOutbound = [
      {
        subject: 'QA Smoke - Plain Text Email',
        textBody: 'Smoke test: plain text email for migration connectivity check.',
        labelIds: ['SENT'],
      },
    ];
    const smokeEmails = [
      ...smokeOutbound,
      ...buildInboundInboxSeeds('QA Smoke', inboundSenders, ccEmail, { mode: 'minimal' }),
    ];

    const sanityOutbound = [
      {
        subject: 'QA Sanity - Plain Text Email',
        textBody: 'Sanity test: plain text email for migration testing.',
        labelIds: ['SENT'],
      },
      {
        subject: 'QA Sanity - HTML Email',
        htmlBody: `<html><body><h1>HTML Test</h1><p>This is an <strong>HTML email</strong> for sanity testing.</p></body></html>`,
        textBody: 'HTML Test Email - fallback',
        labelIds: ['SENT'],
      },
      {
        subject: 'QA Sanity - Email with Attachment',
        textBody: 'Sanity test: email with attachment.',
        attachments: [{ filename: 'test-document.txt', mimeType: 'text/plain', data: SAMPLE_ATTACHMENT_DATA }],
        labelIds: ['SENT'],
      },
      {
        subject: 'QA Sanity - Text format plain (multiline bullets arrows currency)',
        textBody: 'Line1\nLine2\nLine3\n• bullet\n→ arrow\n€ £ ¥',
        htmlBody: '<html><body><p>Line1<br>Line2<br>Line3</p><p>• bullet</p><p>→ arrow</p><p>€ £ ¥</p></body></html>',
        labelIds: ['SENT'],
      },
      {
        subject: 'QA Sanity - Text format bold italic underline strikethrough',
        textBody: 'Bold italic underline strikethrough format test.',
        htmlBody: '<html><body><p><strong>Bold</strong> — <em>Italic</em> — <u>Underline</u> — <s>Strikethrough</s></p><p><strong><em><u>Bold Italic Underline combined</u></em></strong></p></body></html>',
        labelIds: ['SENT'],
      },
      {
        subject: 'QA Sanity - Text format lists and alignment',
        textBody: 'Lists and alignment format test.',
        htmlBody: '<html><body><ol><li>Ordered one</li><li>Ordered two</li></ol><ul><li>Bullet one</li><li>Bullet two</li></ul><p style="text-align:center">Center aligned</p><p style="text-align:right">Right aligned</p><blockquote style="margin:0 0 0 40px;border-left:4px solid #ccc;padding-left:8px">Blockquote text</blockquote></body></html>',
        labelIds: ['SENT'],
      },
      {
        subject: 'QA Sanity - Text with file (PNG image)',
        textBody: 'Please find the screenshot attached.',
        attachments: [{ filename: 'qa-screenshot.png', mimeType: 'image/png', data: SAMPLE_PNG_B64 }],
        labelIds: ['SENT'],
      },
      {
        subject: 'QA Sanity - Text with two files (PNG and CSV)',
        textBody: 'Sending 2 attachments',
        attachments: [
          { filename: 'qa-screenshot.png', mimeType: 'image/png', data: SAMPLE_PNG_B64 },
          { filename: 'qa-report.csv', mimeType: 'text/csv', data: SAMPLE_CSV_B64 },
        ],
        labelIds: ['SENT'],
      },
    ];
    const sanityEmails = [
      ...sanityOutbound,
      ...buildInboundInboxSeeds('QA Sanity', inboundSenders, ccEmail, { mode: 'standard' }),
    ];

    const xlsxPath = env.GMAIL_TEST_CASES_XLSX || defaultGmailTestCasesXlsxPath();
    const excelSamples = {
      attachmentData: SAMPLE_ATTACHMENT_DATA,
      inlineImageData: SAMPLE_INLINE_IMAGE,
      secondAttachmentData: SAMPLE_ATTACHMENT_SECOND,
      minimalPdfData: SAMPLE_MINIMAL_PDF_B64,
      largeAttachmentData: SAMPLE_LARGE_B64,
      small1kData: SAMPLE_1K_B64,
      medium100kData: SAMPLE_100K_B64,
      xlarge512kData: SAMPLE_512K_B64,
      jpegAttachmentData: SAMPLE_JPEG_B64,
      pngAttachmentData: SAMPLE_PNG_B64,
      zipAttachmentData: SAMPLE_ZIP_B64,
      huge2mData: SAMPLE_2M_B64,
      csvAttachmentData: SAMPLE_CSV_B64,
    };

    let emails;
    if (testType === 'E2E') {
      const { qaIds, snoozeId } = await this._loadE2ELabelContext(sourceEmail, log);
      const xlsxEmails = tryLoadMailCasesFromExcel(xlsxPath, 'E2E', {
        qaIds,
        snoozeId,
        ccEmail,
        bccEmail,
        sourceEmail,
        samples: excelSamples,
        log,
      });
      if (xlsxEmails) {
        // Always append inbound seeds so Inbox is populated even when xlsx is used
        const inbound = buildInboundInboxSeeds('QA E2E', inboundSenders, ccEmail, { mode: 'full' });
        emails = [...xlsxEmails, ...inbound];
      } else {
        emails = this._e2eEmailDefinitions(qaIds, snoozeId, ccEmail, bccEmail, sourceEmail, toEmail);
      }
    } else {
      const xlsxEmails = tryLoadMailCasesFromExcel(xlsxPath, testType, {
        qaIds: {},
        snoozeId: null,
        ccEmail,
        bccEmail,
        sourceEmail,
        samples: excelSamples,
        log,
      });
      if (xlsxEmails) {
        const mode = testType === 'SMOKE' ? 'minimal' : 'standard';
        const prefix = testType === 'SMOKE' ? 'QA Smoke' : 'QA Sanity';
        const inbound = buildInboundInboxSeeds(prefix, inboundSenders, ccEmail, { mode });
        emails = [...xlsxEmails, ...inbound];
      } else {
        emails = testType === 'SMOKE' ? smokeEmails : sanityEmails;
      }
    }

    // Append custom test cases saved via the Test Case Generator (smoke/sanity only)
    if (testType !== 'E2E') {
      emails = [...emails, ...loadCustomTestCases(testType, log)];
    }

    /**
     * Insert a running counter into every subject so operators can reference each
     * seeded message by number in the validation PDF and the Gmail UI.
     *   "QA E2E - Plain Text Email"      →  "QA E2E 1 - Plain Text Email"
     *   "QA Sanity - Inbound plain"      →  "QA Sanity 2 - Inbound plain"
     * Applied here so Excel rows, JS fallbacks, and custom cases are all numbered.
     */
    applyRunningSubjectNumbering(emails);

    for (const emailDef of emails) {
      if (executionId && executionService.isCancelled(executionId)) {
        log.info('Email insertion cancelled by user');
        break;
      }
      try {
        const incoming = emailDef.mailDirection === 'incoming';
        // Rotated inbound sender (insert-only — no mail ever leaves this process; we only
        // call users.messages.insert on the source mailbox, no correspondent mailbox is touched).
        const inboundFrom = incoming
          ? String(emailDef.inboundFrom || toEmail || '').trim() || toEmail
          : null;
        const raw = gmailClient.buildRawMessage(
          incoming
            ? {
                to: sourceEmail,
                from: inboundFrom,
                cc: emailDef.cc,
                bcc: emailDef.bcc,
                subject: emailDef.subject,
                textBody: emailDef.textBody,
                htmlBody: emailDef.htmlBody,
                attachments: emailDef.attachments || [],
                inlineImages: emailDef.inlineImages || [],
              }
            : {
                to: toEmail,
                from: sourceEmail,
                cc: emailDef.cc,
                bcc: emailDef.bcc,
                subject: emailDef.subject,
                textBody: emailDef.textBody,
                htmlBody: emailDef.htmlBody,
                attachments: emailDef.attachments || [],
                inlineImages: emailDef.inlineImages || [],
              }
        );

        const data = await gmailClient.insertEmail(
          sourceEmail,
          'me',
          raw,
          emailDef.labelIds || (incoming ? ['INBOX'] : ['SENT']),
          emailDef.insertOpts || {}
        );
        summary.emailsCreated++;
        log.info(`Inserted email: ${emailDef.subject}`);
        if (data?.id) {
          await reconcileInsertedMessageLabels(sourceEmail, emailDef, data.id, log);
        }
        if (typeof emailDef.postInsert === 'function' && data?.id) {
          await emailDef.postInsert(sourceEmail, data.id, log);
        }
      } catch (err) {
        log.error(`Failed to insert email "${emailDef.subject}": ${err.message}`);
      }
    }

    if (testType === 'E2E' && (!executionId || !executionService.isCancelled(executionId))) {
      await this._seedPdfConversationThread(sourceEmail, toEmail, summary, log, executionId);
    }
  }

  async _createDrafts(sourceEmail, toEmail, ccEmail, testType, summary, log, executionId) {
    const xlsxPath = env.GMAIL_TEST_CASES_XLSX || defaultGmailTestCasesXlsxPath();
    const fallbackDrafts = testType === 'SANITY'
      ? [{ subject: 'QA Sanity - Draft', textBody: 'Sanity test: draft for migration.' }]
      : [
          {
            subject: 'QA E2E - Plain draft',
            textBody: 'E2E test: draft with Cc from GOOGLE_ACCOUNTS.',
            cc: ccEmail,
          },
          {
            subject: 'QA E2E - Emoji HTML draft 📝',
            htmlBody: '<html><body><p>E2E draft with emoji in body: ✅ 🎉</p></body></html>',
            textBody: 'E2E test: another draft for QA validation.',
          },
        ];
    const drafts = tryLoadDraftCasesFromExcel(xlsxPath, testType, ccEmail, log) ?? fallbackDrafts;

    // Drafts use their own 1..N numbering (independent of the mail counter).
    applyRunningSubjectNumbering(drafts);

    for (const draft of drafts) {
      if (executionId && executionService.isCancelled(executionId)) {
        log.info('Draft creation cancelled by user');
        break;
      }
      try {
        const raw = gmailClient.buildRawMessage({
          to: toEmail,
          from: sourceEmail,
          cc: draft.cc,
          subject: draft.subject,
          textBody: draft.textBody,
          htmlBody: draft.htmlBody,
        });
        await gmailClient.createDraft(sourceEmail, 'me', raw);
        summary.draftsCreated++;
        log.info(`Created draft: ${draft.subject}`);
      } catch (err) {
        log.error(`Failed to create draft "${draft.subject}": ${err.message}`);
      }
    }
  }

  _withOptionalAttendee(eventBase, attendeeEmail, sourceEmail) {
    if (!attendeeEmail || attendeeEmail.toLowerCase() === String(sourceEmail).toLowerCase()) {
      return eventBase;
    }
    return {
      ...eventBase,
      attendees: [{ email: attendeeEmail }],
    };
  }

  async _createCalendarEvents(sourceEmail, attendeeEmail, summary, log) {
    try {
      const calRes = await calendarClient.createCalendar(sourceEmail, 'QA Secondary Calendar');
      const secondaryCalId = calRes.data.id;
      log.info(`Created secondary calendar: ${secondaryCalId} (mailbox: ${sourceEmail})`);

      const events = [
        {
          calendarId: 'primary',
          event: this._withOptionalAttendee(
            {
              summary: 'QA E2E - Single Event',
              description: 'E2E test: single event for migration QA',
              start: { dateTime: new Date(Date.now() + 86400000).toISOString(), timeZone: 'UTC' },
              end: { dateTime: new Date(Date.now() + 90000000).toISOString(), timeZone: 'UTC' },
            },
            attendeeEmail,
            sourceEmail
          ),
        },
        {
          calendarId: 'primary',
          event: this._withOptionalAttendee(
            {
              summary: 'QA E2E - Recurring Weekly Event',
              description: 'E2E test: recurring event',
              start: { dateTime: new Date(Date.now() + 172800000).toISOString(), timeZone: 'UTC' },
              end: { dateTime: new Date(Date.now() + 176400000).toISOString(), timeZone: 'UTC' },
              recurrence: ['RRULE:FREQ=WEEKLY;COUNT=4'],
            },
            attendeeEmail,
            sourceEmail
          ),
        },
        {
          calendarId: 'primary',
          event: this._withOptionalAttendee(
            {
              summary: 'QA E2E - All Day Event',
              description: 'E2E test: all-day event',
              start: { date: new Date(Date.now() + 259200000).toISOString().split('T')[0] },
              end: { date: new Date(Date.now() + 345600000).toISOString().split('T')[0] },
            },
            attendeeEmail,
            sourceEmail
          ),
        },
        {
          calendarId: secondaryCalId,
          event: this._withOptionalAttendee(
            {
              summary: 'QA E2E - Secondary Calendar Event',
              description: 'E2E test: event on secondary calendar',
              start: { dateTime: new Date(Date.now() + 432000000).toISOString(), timeZone: 'UTC' },
              end: { dateTime: new Date(Date.now() + 435600000).toISOString(), timeZone: 'UTC' },
            },
            attendeeEmail,
            sourceEmail
          ),
        },
      ];

      for (const { calendarId, event } of events) {
        try {
          await calendarClient.createEvent(sourceEmail, calendarId, event, { sendUpdates: 'none' });
          summary.eventsCreated++;
          log.info(`Created event: ${event.summary} on ${calendarId}`);
        } catch (err) {
          log.error(`Failed to create event "${event.summary}": ${err.message}`);
        }
      }
    } catch (err) {
      log.error(`Failed to create calendar events: ${err.message}`);
    }
  }
}

module.exports = GmailTestDataAgent;
