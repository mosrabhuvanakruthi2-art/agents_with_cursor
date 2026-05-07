/**
 * OutlookTestDataAgent
 *
 * Creates test email data in an Outlook/Microsoft 365 mailbox via Microsoft
 * Graph API — mirrors GmailTestDataAgent but targets Outlook folders.
 *
 * Test data source (priority order):
 *   1. Custom test cases from backend/data/custom-test-cases.json (Agent Repo)
 *   2. Built-in fallback messages when the file is empty or missing
 *
 * Folder mapping (tc.folder → Graph API well-known name):
 *   Inbox / INBOX          → inbox
 *   Sent / Sent Items      → sentitems
 *   Draft / Drafts         → drafts
 *   Spam / Junk Email      → junkemail
 *   Trash / Deleted Items  → deleteditems
 *   anything else          → custom folder created via Graph API
 */

const path = require('path');
const fs   = require('fs');
const { BaseAgent }    = require('../core/BaseAgent');
const outlookClient    = require('../../clients/outlookClient');
const env              = require('../../config/env');
const logger           = require('../../utils/logger');
const executionService = require('../../services/executionService');

// ── Folder mapping ────────────────────────────────────────────────────────────

const FOLDER_MAP = {
  inbox:         'inbox',
  sent:          'sentitems',
  'sent items':  'sentitems',
  draft:         'drafts',
  drafts:        'drafts',
  spam:          'junkemail',
  'junk email':  'junkemail',
  trash:         'deleteditems',
  'deleted items': 'deleteditems',
  // Gmail label IDs → Outlook well-known
  inbox_label:   'inbox',  // handled below
  sent_label:    'sentitems',
  draft_label:   'drafts',
  spam_label:    'junkemail',
  trash_label:   'deleteditems',
};

const LABEL_TO_FOLDER = {
  INBOX:  'inbox',
  SENT:   'sentitems',
  DRAFT:  'drafts',
  SPAM:   'junkemail',
  TRASH:  'deleteditems',
};

/** Resolve a test case's folder/labelIds to a Graph API folder id or well-known name. */
function resolveFolderId(tc) {
  // 1. Use tc.folder if present
  if (tc.folder) {
    const key = tc.folder.trim().toLowerCase();
    if (FOLDER_MAP[key]) return FOLDER_MAP[key];
  }
  // 2. Fall back to first labelId
  if (Array.isArray(tc.labelIds) && tc.labelIds.length > 0) {
    const label = tc.labelIds[0];
    if (LABEL_TO_FOLDER[label]) return LABEL_TO_FOLDER[label];
  }
  return 'inbox'; // default
}

// ── Test case loading ─────────────────────────────────────────────────────────

const SAMPLE_ATTACHMENT = Buffer.from('Sample QA attachment for migration testing').toString('base64');

const FALLBACK_CASES = [
  { subject: 'QA Smoke - Plain Text Email',    textBody: 'Plain text test email for migration QA.',       folder: 'Inbox', labelIds: ['INBOX'] },
  { subject: 'QA Smoke - Read State Test',     textBody: 'Read state validation test email.',             folder: 'Inbox', labelIds: ['INBOX'] },
  { subject: 'QA Smoke - Sender Visibility',   textBody: 'External sender visibility test.',              folder: 'Inbox', labelIds: ['INBOX'] },
  { subject: 'QA Smoke - Count Verification',  textBody: 'Email count verification after migration.',     folder: 'Inbox', labelIds: ['INBOX'] },
  { subject: 'QA Smoke - Unread State Test',   textBody: 'Unread state validation test email.',           folder: 'Inbox', labelIds: ['INBOX'] },
];

function loadTestCases(testType, log) {
  try {
    const filePath = path.resolve(__dirname, '../../../data/custom-test-cases.json');
    if (!fs.existsSync(filePath)) {
      log.warn('custom-test-cases.json not found — using fallback messages');
      return FALLBACK_CASES;
    }
    const data  = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const cases = data[testType.toLowerCase()] || [];
    if (cases.length > 0) {
      log.info(`Loaded ${cases.length} custom test case(s) from Agent Repo for ${testType}`);
      return cases;
    }
    log.warn(`No ${testType} test cases in Agent Repo — using fallback messages`);
    return FALLBACK_CASES;
  } catch (e) {
    log.warn(`Failed to load test cases: ${e.message} — using fallback`);
    return FALLBACK_CASES;
  }
}

// ── Message builder ───────────────────────────────────────────────────────────

/**
 * Hard-coded external addresses used only when OUTLOOK_ACCOUNTS is empty. The preferred path
 * is to rotate senders across real tenant users (env.buildOutlookInboundSenders) so inbound
 * test data survives migration as "from tenant user" — still insert-only: we POST directly
 * into the source user's Inbox via Graph; no correspondent mailbox is touched.
 */
const FALLBACK_EXTERNAL_SENDERS = [
  { name: 'Alice Johnson', address: 'alice.johnson@external.com' },
  { name: 'Bob Smith',     address: 'bob.smith@company.org' },
  { name: 'Carol White',   address: 'carol@testdomain.net' },
  { name: 'David Brown',   address: 'david.brown@example.com' },
  { name: 'Eve Martinez',  address: 'eve.m@partner.io' },
];

function toSenderObject(addressOrObj) {
  if (!addressOrObj) return null;
  if (typeof addressOrObj === 'object' && addressOrObj.address) {
    return { address: addressOrObj.address, name: addressOrObj.name || addressOrObj.address };
  }
  const address = String(addressOrObj).trim();
  if (!address || !address.includes('@')) return null;
  const localPart = address.split('@')[0].replace(/[._-]+/g, ' ').trim();
  const name = localPart
    .split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ') || address;
  return { address, name };
}

/**
 * Builds the Graph message payload for a single test case.
 * - Inbox/custom: from = external sender → to = userEmail  (received mail)
 * - Sent Items:   from = userEmail       → to = external   (sent mail)
 * - Drafts:       isDraft = true (default Graph behaviour)
 * All non-draft folders get isDraft: false so messages appear as real mail.
 */
function buildGraphMessage(tc, index, userEmail, senderRotation) {
  const rotation = Array.isArray(senderRotation) && senderRotation.length > 0
    ? senderRotation
    : FALLBACK_EXTERNAL_SENDERS;
  const externalContact = toSenderObject(rotation[index % rotation.length]);
  const body   = tc.textBody || tc.htmlBody || 'QA migration test message.';

  const folder = (tc.folder || '').trim().toLowerCase();
  const isSent  = folder === 'sent' || folder === 'sent items' || folder === 'sentitems';
  const isDraft = folder === 'draft' || folder === 'drafts';

  const msg = {
    subject:      tc.subject || `QA Test Message #${index + 1}`,
    body:         { contentType: 'text', content: body },
    isRead:       index % 2 === 0,
    isDraft:      isDraft,
  };

  if (isSent) {
    // Sent Items: user sent this mail to the external contact
    msg.from         = { emailAddress: { address: userEmail, name: userEmail.split('@')[0] } };
    msg.toRecipients = [{ emailAddress: externalContact }];
  } else {
    // Inbox / custom / Drafts: external contact sent this to the user
    msg.from         = { emailAddress: externalContact };
    msg.toRecipients = [{ emailAddress: { address: userEmail, name: userEmail.split('@')[0] } }];
  }

  return msg;
}

// ── Agent ─────────────────────────────────────────────────────────────────────

class OutlookTestDataAgent extends BaseAgent {
  constructor() {
    super('OutlookTestDataAgent');
  }

  async execute(context) {
    const log       = logger.child({ agent: this.name, executionId: context.executionId });
    const userEmail = context.sourceEmail;
    const testType  = (context.testType || 'SMOKE').toUpperCase();

    log.info(`Starting — testType=${testType}  user=${userEmail}`);

    /**
     * Rotation of inbound senders read from OUTLOOK_ACCOUNTS (excluding the source user).
     * Graph stores `from` verbatim on messages created via POST /mailFolders/{id}/messages,
     * so inserted mail in the source Inbox shows the tenant user as the sender. Nothing is
     * actually sent — we never touch the correspondent's mailbox.
     */
    const senderRotation = typeof env.buildOutlookInboundSenders === 'function'
      ? env.buildOutlookInboundSenders(userEmail)
      : [];
    if (senderRotation.length > 0) {
      log.info(`Inbound senders (OUTLOOK_ACCOUNTS, insert-only): ${senderRotation.join(', ')}`);
    } else {
      log.warn(
        'OUTLOOK_ACCOUNTS is empty or contains only the source user — falling back to fake external senders'
      );
    }

    const summary = {
      testType,
      userEmail,
      messagesCreated: 0,
      foldersPopulated: [],
      inboundSenders: senderRotation,
      errors: [],
    };

    // Load test cases from Agent Repo
    const testCases = loadTestCases(testType, log);
    log.info(`Creating ${testCases.length} message(s) in Outlook…`);

    // Track which custom folders we've already created (name → id)
    const customFolderCache = {};

    for (let i = 0; i < testCases.length; i++) {
      if (context.executionId && executionService.isCancelled(context.executionId)) {
        log.info('Data creation cancelled by user');
        break;
      }

      const tc = testCases[i];

      // Resolve folder
      let folderId = resolveFolderId(tc);
      const folderDisplay = tc.folder || folderId;

      // If it's not a well-known folder, create/cache it
      if (!Object.values(FOLDER_MAP).includes(folderId)) {
        if (!customFolderCache[folderId]) {
          try {
            customFolderCache[folderId] = await outlookClient.getOrCreateMailFolder(userEmail, folderId);
          } catch (err) {
            log.warn(`Could not create custom folder "${folderId}": ${err.message} — placing in Inbox`);
            customFolderCache[folderId] = 'inbox';
          }
        }
        folderId = customFolderCache[folderId];
      }

      try {
        const msgBody = buildGraphMessage(tc, i, userEmail, senderRotation);
        await outlookClient.createMessageInFolder(userEmail, folderId, msgBody);
        summary.messagesCreated++;
        if (!summary.foldersPopulated.includes(folderDisplay)) {
          summary.foldersPopulated.push(folderDisplay);
        }
        log.info(`✓ [${i + 1}/${testCases.length}] "${tc.subject}" → ${folderDisplay}`);
      } catch (err) {
        log.error(`✗ [${i + 1}] "${tc.subject}": ${err.message}`);
        summary.errors.push(`${tc.subject}: ${err.message}`);
      }

      // Update progress every 10 messages
      if (context.executionId && i % 10 === 9) {
        executionService.update(context.executionId, {
          progress: `OutlookTestDataAgent: ${summary.messagesCreated}/${testCases.length} messages created…`,
        });
      }
    }

    const ok = summary.errors.length === 0;
    log.info(
      `Done — ${summary.messagesCreated}/${testCases.length} messages created` +
      `, folders: [${summary.foldersPopulated.join(', ')}]` +
      (ok ? '' : `, ${summary.errors.length} error(s)`)
    );

    return summary;
  }
}

module.exports = OutlookTestDataAgent;
