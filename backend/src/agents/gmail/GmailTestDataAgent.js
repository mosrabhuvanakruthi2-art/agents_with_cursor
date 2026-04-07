const { BaseAgent } = require('../core/BaseAgent');
const gmailClient = require('../../clients/gmailClient');
const calendarClient = require('../../clients/calendarClient');
const env = require('../../config/env');
const logger = require('../../utils/logger');
const {
  tryLoadMailCasesFromExcel,
  tryLoadDraftCasesFromExcel,
  defaultGmailTestCasesXlsxPath,
} = require('../../utils/gmailTestCasesExcel');

const SAMPLE_ATTACHMENT_DATA = Buffer.from('Sample attachment content for QA testing').toString('base64');
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

    const correspondentEmail = env.pickCorrespondentEmail(sourceEmail);
    const ccEmail = env.pickCcEmail(sourceEmail, correspondentEmail);
    summary.correspondentEmail = correspondentEmail;
    summary.ccEmail = ccEmail;
    log.info(
      `Creating test data in Gmail for: ${sourceEmail} [${testType}] — To: ${correspondentEmail}, Cc: ${ccEmail} (GOOGLE_ACCOUNTS)`
    );

    if (context.includeMail) {
      if (testType !== 'SMOKE') {
        await this._createLabels(sourceEmail, testType, summary, log);
      }
      await this._createEmails(sourceEmail, correspondentEmail, ccEmail, testType, summary, log);
      if (testType !== 'SMOKE') {
        await this._createDrafts(sourceEmail, correspondentEmail, ccEmail, testType, summary, log);
      }
    }

    if (context.includeCalendar && testType === 'E2E') {
      await this._createCalendarEvents(sourceEmail, correspondentEmail, summary, log);
    }

    log.info(`Test data generation complete [${testType}]: ${JSON.stringify(summary)}`);
    return summary;
  }

  async _createLabels(sourceEmail, testType, summary, log) {
    const labels = testType === 'SANITY'
      ? ['QA-TestLabel', 'QA-Important']
      : ['QA-TestLabel', 'QA-TestLabel/Nested-Child', 'QA-Important', 'QA-Archive'];

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
    const names = ['QA-TestLabel', 'QA-TestLabel/Nested-Child', 'QA-Important', 'QA-Archive'];
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

  _e2eEmailDefinitions(qaIds, snoozeId, ccEmail) {
    const reactionNote =
      '<p style="color:#666"><i>Gmail UI reactions are not set via API; emoji exercises Unicode in migration.</i></p>';
    const base = [
      {
        subject: 'QA E2E - Plain Text Email',
        textBody: 'E2E test: plain text email for full migration testing.',
        labelIds: ['INBOX'],
      },
      {
        subject: 'QA E2E - HTML Email',
        htmlBody: `<html><body>
          <h1>HTML Test Email</h1>
          <p>This is an <strong>HTML email</strong> generated by the QA agent.</p>
          <ul><li>Item 1</li><li>Item 2</li><li>Item 3</li></ul>
        </body></html>`,
        textBody: 'HTML Test Email - fallback plain text',
        labelIds: ['INBOX'],
      },
      {
        subject: 'QA E2E - Email with Attachment',
        textBody: 'E2E test: email with attachment.',
        attachments: [{ filename: 'test-document.txt', mimeType: 'text/plain', data: SAMPLE_ATTACHMENT_DATA }],
        labelIds: ['INBOX'],
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
        labelIds: ['INBOX'],
        cc: ccEmail,
      },
      {
        subject: 'QA E2E - Cc from GOOGLE_ACCOUNTS',
        textBody: 'E2E: Cc line uses a distinct address from GOOGLE_ACCOUNTS (see env picker).',
        labelIds: ['INBOX'],
        cc: ccEmail,
      },
      {
        subject: 'QA E2E - Emoji subject 📧✅',
        textBody: 'Plain body emoji: 👍 ❤️ 😀 🎉 📎',
        htmlBody: `<html><body>${reactionNote}<h2>Unicode 🚀</h2><p>✅ ❌ ⭐ 📧</p></body></html>`,
        labelIds: ['INBOX'],
        cc: ccEmail,
      },
      { subject: 'QA E2E - Starred', textBody: 'E2E: Inbox + Starred.', labelIds: ['INBOX', 'STARRED'] },
      { subject: 'QA E2E - Important', textBody: 'E2E: Inbox + Important.', labelIds: ['INBOX', 'IMPORTANT'] },
      {
        subject: 'QA E2E - Category Social',
        textBody: 'E2E: Primary + Social category.',
        labelIds: ['INBOX', 'CATEGORY_SOCIAL'],
      },
      {
        subject: 'QA E2E - Category Forums',
        textBody: 'E2E: Primary + Forums category.',
        labelIds: ['INBOX', 'CATEGORY_FORUMS'],
      },
      {
        subject: 'QA E2E - Category Promotions',
        textBody: 'E2E: Primary + Promotions category.',
        labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'],
      },
      {
        subject: 'QA E2E - Category Updates',
        textBody: 'E2E: Primary + Updates category.',
        labelIds: ['INBOX', 'CATEGORY_UPDATES'],
      },
      { subject: 'QA E2E - Spam folder', textBody: 'E2E: message in Spam.', labelIds: ['SPAM'] },
      { subject: 'QA E2E - Trash folder', textBody: 'E2E: message in Trash.', labelIds: ['TRASH'] },
      {
        subject: 'QA E2E - Sent Email',
        textBody: 'E2E test: sent email for migration testing.',
        labelIds: ['SENT'],
      },
    ];

    const custom = [];
    const addIf = (name, subject, body) => {
      const id = qaIds[name];
      if (id) custom.push({ subject, textBody: body, labelIds: ['INBOX', id] });
    };
    addIf('QA-TestLabel', 'QA E2E - In QA-TestLabel', 'E2E: user label QA-TestLabel.');
    addIf('QA-Important', 'QA E2E - In QA-Important', 'E2E: user label QA-Important.');
    addIf('QA-Archive', 'QA E2E - In QA-Archive', 'E2E: user label QA-Archive.');
    addIf(
      'QA-TestLabel/Nested-Child',
      'QA E2E - In QA-TestLabel/Nested-Child',
      'E2E: nested user label.'
    );

    const snooze = [];
    if (snoozeId) {
      snooze.push({
        subject: 'QA E2E - Snoozed label',
        textBody: 'E2E: INBOX + Snoozed label applied via API (snooze time not set).',
        labelIds: ['INBOX'],
        postInsert: async (src, msgId, lg) => {
          await gmailClient.modifyMessageLabels(src, 'me', msgId, [snoozeId], []);
          lg.info(`Applied Snoozed label to message ${msgId}`);
        },
      });
    }

    return [...base, ...custom, ...snooze];
  }

  async _createEmails(sourceEmail, toEmail, ccEmail, testType, summary, log) {
    const smokeEmails = [
      {
        subject: 'QA Smoke - Plain Text Email',
        textBody: 'Smoke test: plain text email for migration connectivity check.',
        labelIds: ['INBOX'],
      },
    ];

    const sanityEmails = [
      {
        subject: 'QA Sanity - Plain Text Email',
        textBody: 'Sanity test: plain text email for migration testing.',
        labelIds: ['INBOX'],
      },
      {
        subject: 'QA Sanity - HTML Email',
        htmlBody: `<html><body><h1>HTML Test</h1><p>This is an <strong>HTML email</strong> for sanity testing.</p></body></html>`,
        textBody: 'HTML Test Email - fallback',
        labelIds: ['INBOX'],
      },
      {
        subject: 'QA Sanity - Email with Attachment',
        textBody: 'Sanity test: email with attachment.',
        attachments: [{ filename: 'test-document.txt', mimeType: 'text/plain', data: SAMPLE_ATTACHMENT_DATA }],
        labelIds: ['INBOX'],
      },
    ];

    const xlsxPath = env.GMAIL_TEST_CASES_XLSX || defaultGmailTestCasesXlsxPath();
    const excelSamples = { attachmentData: SAMPLE_ATTACHMENT_DATA, inlineImageData: SAMPLE_INLINE_IMAGE };

    let emails;
    if (testType === 'E2E') {
      const { qaIds, snoozeId } = await this._loadE2ELabelContext(sourceEmail, log);
      emails =
        tryLoadMailCasesFromExcel(xlsxPath, 'E2E', {
          qaIds,
          snoozeId,
          ccEmail,
          samples: excelSamples,
          log,
        }) ?? this._e2eEmailDefinitions(qaIds, snoozeId, ccEmail);
    } else {
      emails =
        tryLoadMailCasesFromExcel(xlsxPath, testType, {
          qaIds: {},
          snoozeId: null,
          ccEmail,
          samples: excelSamples,
          log,
        }) ?? (testType === 'SMOKE' ? smokeEmails : sanityEmails);
    }

    for (const emailDef of emails) {
      try {
        const raw = gmailClient.buildRawMessage({
          to: toEmail,
          from: sourceEmail,
          cc: emailDef.cc,
          bcc: emailDef.bcc,
          subject: emailDef.subject,
          textBody: emailDef.textBody,
          htmlBody: emailDef.htmlBody,
          attachments: emailDef.attachments || [],
          inlineImages: emailDef.inlineImages || [],
        });

        const data = await gmailClient.insertEmail(sourceEmail, 'me', raw, emailDef.labelIds || ['INBOX']);
        summary.emailsCreated++;
        log.info(`Inserted email: ${emailDef.subject}`);
        if (typeof emailDef.postInsert === 'function' && data?.id) {
          await emailDef.postInsert(sourceEmail, data.id, log);
        }
      } catch (err) {
        log.error(`Failed to insert email "${emailDef.subject}": ${err.message}`);
      }
    }
  }

  async _createDrafts(sourceEmail, toEmail, ccEmail, testType, summary, log) {
    const xlsxPath = env.GMAIL_TEST_CASES_XLSX || defaultGmailTestCasesXlsxPath();
    const fallbackDrafts = testType === 'SANITY'
      ? [{ subject: 'QA Sanity - Draft Email', textBody: 'Sanity test: draft for migration.' }]
      : [
          {
            subject: 'QA E2E - Draft Email 1',
            textBody: 'E2E test: draft with Cc from GOOGLE_ACCOUNTS.',
            cc: ccEmail,
          },
          {
            subject: 'QA E2E - Draft Email 2 📝',
            htmlBody: '<html><body><p>E2E draft with emoji in body: ✅ 🎉</p></body></html>',
            textBody: 'E2E test: another draft for QA validation.',
          },
        ];
    const drafts = tryLoadDraftCasesFromExcel(xlsxPath, testType, ccEmail, log) ?? fallbackDrafts;

    for (const draft of drafts) {
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
