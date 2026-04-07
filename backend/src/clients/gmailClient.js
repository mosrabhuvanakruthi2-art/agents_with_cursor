const { google } = require('googleapis');
const env = require('../config/env');
const { retryWithBackoff } = require('../utils/retry');
const logger = require('../utils/logger');

/**
 * Get OAuth2 client for a specific refresh token.
 */
function getAuthForToken(refreshToken) {
  const oauth2Client = new google.auth.OAuth2(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET
  );
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  return oauth2Client;
}

/**
 * Look up the refresh token for a given email address.
 * Falls back to the first available account if no match found.
 */
function getRefreshTokenForEmail(email) {
  const normalizedEmail = email.toLowerCase().trim();
  const token = env.googleAccounts.get(normalizedEmail);
  if (token) return token;

  // Fallback: use the first account
  const firstEntry = env.googleAccounts.entries().next().value;
  if (firstEntry) {
    logger.warn(`No Google token for "${email}", falling back to ${firstEntry[0]}`);
    return firstEntry[1];
  }

  throw new Error(`No Google refresh token configured for "${email}". Add it to GOOGLE_ACCOUNTS in .env`);
}

function getGmailForEmail(email) {
  const refreshToken = getRefreshTokenForEmail(email);
  return google.gmail({ version: 'v1', auth: getAuthForToken(refreshToken) });
}

function getCalendarAuthForEmail(email) {
  const refreshToken = getRefreshTokenForEmail(email);
  return getAuthForToken(refreshToken);
}

/** RFC 2047 encode subject when it contains non-ASCII (emoji, etc.). */
function encodeSubject(subject) {
  const s = String(subject ?? '');
  if (!/[^\u0000-\u007f]/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

function formatAddressList(cc) {
  if (!cc) return '';
  if (Array.isArray(cc)) return cc.filter(Boolean).join(', ');
  return String(cc);
}

/**
 * Builds a RFC 2822 compliant raw email message.
 * Supports plain text, HTML, attachments, inline images, Cc, Bcc.
 */
function buildRawMessage({
  to,
  from,
  subject,
  cc,
  bcc,
  textBody,
  htmlBody,
  attachments = [],
  inlineImages = [],
}) {
  const boundary = `boundary_${Date.now()}`;
  const mixedBoundary = `mixed_${Date.now()}`;
  const hasAttachments = attachments.length > 0 || inlineImages.length > 0;
  const hasHtml = !!htmlBody;

  let message = '';
  message += `From: ${from}\r\n`;
  message += `To: ${to}\r\n`;
  const ccLine = formatAddressList(cc);
  if (ccLine) message += `Cc: ${ccLine}\r\n`;
  const bccLine = formatAddressList(bcc);
  if (bccLine) message += `Bcc: ${bccLine}\r\n`;
  message += `Subject: ${encodeSubject(subject)}\r\n`;
  message += `MIME-Version: 1.0\r\n`;

  if (hasAttachments) {
    message += `Content-Type: multipart/mixed; boundary="${mixedBoundary}"\r\n\r\n`;
    message += `--${mixedBoundary}\r\n`;

    if (hasHtml && inlineImages.length > 0) {
      message += `Content-Type: multipart/related; boundary="${boundary}"\r\n\r\n`;
      message += `--${boundary}\r\n`;
      message += `Content-Type: text/html; charset="UTF-8"\r\n\r\n`;
      message += `${htmlBody}\r\n`;

      for (const img of inlineImages) {
        message += `--${boundary}\r\n`;
        message += `Content-Type: ${img.mimeType}\r\n`;
        message += `Content-Transfer-Encoding: base64\r\n`;
        message += `Content-ID: <${img.contentId}>\r\n\r\n`;
        message += `${img.data}\r\n`;
      }
      message += `--${boundary}--\r\n`;
    } else if (hasHtml) {
      message += `Content-Type: text/html; charset="UTF-8"\r\n\r\n`;
      message += `${htmlBody}\r\n`;
    } else {
      message += `Content-Type: text/plain; charset="UTF-8"\r\n\r\n`;
      message += `${textBody}\r\n`;
    }

    for (const att of attachments) {
      message += `--${mixedBoundary}\r\n`;
      message += `Content-Type: ${att.mimeType}; name="${att.filename}"\r\n`;
      message += `Content-Disposition: attachment; filename="${att.filename}"\r\n`;
      message += `Content-Transfer-Encoding: base64\r\n\r\n`;
      message += `${att.data}\r\n`;
    }
    message += `--${mixedBoundary}--\r\n`;
  } else if (hasHtml) {
    message += `Content-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n`;
    message += `--${boundary}\r\n`;
    message += `Content-Type: text/plain; charset="UTF-8"\r\n\r\n`;
    message += `${textBody || ''}\r\n`;
    message += `--${boundary}\r\n`;
    message += `Content-Type: text/html; charset="UTF-8"\r\n\r\n`;
    message += `${htmlBody}\r\n`;
    message += `--${boundary}--\r\n`;
  } else {
    message += `Content-Type: text/plain; charset="UTF-8"\r\n\r\n`;
    message += `${textBody}\r\n`;
  }

  return Buffer.from(message).toString('base64url');
}

async function insertEmail(sourceEmail, userId, rawMessage, labelIds = ['INBOX']) {
  const gmail = getGmailForEmail(sourceEmail);
  const res = await retryWithBackoff(
    () =>
      gmail.users.messages.insert({
        userId,
        requestBody: { raw: rawMessage, labelIds },
      }),
    { label: `Gmail insertEmail (${sourceEmail})` }
  );
  return res.data;
}

async function modifyMessageLabels(sourceEmail, userId, messageId, addLabelIds = [], removeLabelIds = []) {
  if (!messageId || (!addLabelIds.length && !removeLabelIds.length)) return null;
  const gmail = getGmailForEmail(sourceEmail);
  const res = await retryWithBackoff(
    () =>
      gmail.users.messages.modify({
        userId,
        id: messageId,
        requestBody: { addLabelIds, removeLabelIds },
      }),
    { label: `Gmail modifyMessageLabels (${sourceEmail})` }
  );
  return res.data;
}

async function createLabel(sourceEmail, userId, labelName) {
  const gmail = getGmailForEmail(sourceEmail);
  return retryWithBackoff(
    () =>
      gmail.users.labels.create({
        userId,
        requestBody: {
          name: labelName,
          labelListVisibility: 'labelShow',
          messageListVisibility: 'show',
        },
      }),
    { label: `Gmail createLabel(${labelName}) for ${sourceEmail}` }
  );
}

async function createDraft(sourceEmail, userId, rawMessage) {
  const gmail = getGmailForEmail(sourceEmail);
  return retryWithBackoff(
    () =>
      gmail.users.drafts.create({
        userId,
        requestBody: { message: { raw: rawMessage } },
      }),
    { label: `Gmail createDraft (${sourceEmail})` }
  );
}

async function listLabels(sourceEmail, userId) {
  const gmail = getGmailForEmail(sourceEmail);
  const res = await retryWithBackoff(
    () => gmail.users.labels.list({ userId }),
    { label: `Gmail listLabels (${sourceEmail})` }
  );
  return res.data.labels || [];
}

async function getMessageCount(sourceEmail, userId, labelId = 'INBOX') {
  const gmail = getGmailForEmail(sourceEmail);
  const res = await retryWithBackoff(
    () => gmail.users.labels.get({ userId, id: labelId }),
    { label: `Gmail getMessageCount (${sourceEmail})` }
  );
  return res.data.messagesTotal || 0;
}

/**
 * Returns all configured Google account emails.
 */
function getConfiguredAccounts() {
  return Array.from(env.googleAccounts.keys());
}

/**
 * List all users in the same Google Workspace domain using the People API Directory.
 * Falls back to returning configured accounts if the directory API is not available.
 */
async function listDomainUsers(adminEmail) {
  const refreshToken = getRefreshTokenForEmail(adminEmail);
  const auth = getAuthForToken(refreshToken);
  const domain = adminEmail.split('@')[1];

  // Try People API directory listing first
  try {
    const people = google.people({ version: 'v1', auth });
    const users = [];
    let pageToken = undefined;

    do {
      const res = await people.people.listDirectoryPeople({
        readMask: 'names,emailAddresses',
        sources: ['DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE'],
        pageSize: 1000,
        pageToken,
      });

      const items = res.data.people || [];
      for (const p of items) {
        const email = p.emailAddresses?.find((e) => e.value?.endsWith(`@${domain}`))?.value;
        const name = p.names?.[0];
        if (email) {
          users.push({
            id: p.resourceName,
            email,
            displayName: name?.displayName || email.split('@')[0],
            firstName: name?.givenName || email.split('@')[0],
            lastName: name?.familyName || '',
          });
        }
      }

      pageToken = res.data.nextPageToken;
    } while (pageToken);

    if (users.length > 0) return users;
  } catch (err) {
    logger.warn(`People API directory listing failed for ${adminEmail}: ${err.message}`);
  }

  // Fallback: return all configured accounts for this domain
  const users = [];
  for (const [email] of env.googleAccounts) {
    if (email.endsWith(`@${domain}`)) {
      const localPart = email.split('@')[0];
      users.push({
        id: email,
        email,
        displayName: localPart.charAt(0).toUpperCase() + localPart.slice(1),
        firstName: localPart.charAt(0).toUpperCase() + localPart.slice(1),
        lastName: '',
      });
    }
  }

  return users;
}

const GMAIL_SYSTEM_LABEL_IDS = new Set([
  'INBOX', 'SENT', 'DRAFT', 'TRASH', 'SPAM', 'STARRED', 'IMPORTANT',
  'UNREAD', 'CHAT', 'CATEGORY_PERSONAL', 'CATEGORY_SOCIAL',
  'CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS',
]);

async function getGmailMailboxStats(sourceEmail) {
  const gmail = getGmailForEmail(sourceEmail);
  // Use profile for fast total count
  let totalMessages = 0;
  try {
    const msgList = await gmail.users.messages.list({ userId: 'me', maxResults: 1 });
    totalMessages = msgList.data.resultSizeEstimate || 0;
  } catch {}
  // Count custom labels only (no per-label message count to avoid slowness)
  let customLabelCount = 0;
  try {
    const labelsRes = await gmail.users.labels.list({ userId: 'me' });
    const labels = labelsRes.data.labels || [];
    for (const label of labels) {
      if (!GMAIL_SYSTEM_LABEL_IDS.has(label.id) && label.type === 'user') customLabelCount++;
    }
  } catch { /* token may lack labels scope */ }
  let calendarCount = 0, eventCount = 0;
  try {
    const calAuth = getCalendarAuthForEmail(sourceEmail);
    const calApi = google.calendar({ version: 'v3', auth: calAuth });
    const calList = await calApi.calendarList.list();
    calendarCount = (calList.data.items || []).length;
    for (const item of calList.data.items || []) {
      try {
        let pageToken = undefined;
        do {
          const ev = await calApi.events.list({ calendarId: item.id, maxResults: 2500, singleEvents: false, pageToken });
          eventCount += (ev.data.items || []).length;
          pageToken = ev.data.nextPageToken;
        } while (pageToken);
      } catch {}
    }
  } catch {}
  return { mailCount: totalMessages, folderCount: customLabelCount, calendarCount, eventCount };
}

async function cleanGmailMailbox(sourceEmail) {
  const log = require('../utils/logger');
  const gmail = getGmailForEmail(sourceEmail);
  const summary = { messagesDeleted: 0, foldersDeleted: 0, eventsDeleted: 0, calendarsDeleted: 0, errors: [] };

  log.info('[clean-gmail ' + sourceEmail + '] Step 1: Deleting custom labels...');
  try {
    const labelsRes = await gmail.users.labels.list({ userId: 'me' });
    for (const label of labelsRes.data.labels || []) {
      if (!GMAIL_SYSTEM_LABEL_IDS.has(label.id) && label.type === 'user') {
        try {
          await gmail.users.labels.delete({ userId: 'me', id: label.id });
          summary.foldersDeleted++;
          log.info('[clean-gmail ' + sourceEmail + ']   Deleted label "' + label.name + '"');
        } catch (err) { summary.errors.push('Label "' + label.name + '": ' + err.message); }
      }
    }
  } catch (err) { summary.errors.push('Labels: ' + err.message); }

  log.info('[clean-gmail ' + sourceEmail + '] Step 2: Deleting all emails...');
  try {
    let hasMore = true;
    while (hasMore) {
      const res = await gmail.users.messages.list({ userId: 'me', maxResults: 100 });
      const messages = res.data.messages || [];
      if (messages.length === 0) { hasMore = false; break; }
      const ids = messages.map(function(m) { return m.id; });
      await gmail.users.messages.batchDelete({ userId: 'me', requestBody: { ids: ids } }).catch(function(e) { log.error('[clean-gmail ' + sourceEmail + ']   batchDelete failed: ' + e.message); throw e; });
      summary.messagesDeleted += ids.length;
      log.info('[clean-gmail ' + sourceEmail + ']   Deleted ' + ids.length + ' emails (total: ' + summary.messagesDeleted + ')');
    }
  } catch (err) { summary.errors.push('Messages: ' + err.message); }

  log.info('[clean-gmail ' + sourceEmail + '] Step 3: Deleting drafts...');
  try {
    let hasMore = true;
    while (hasMore) {
      const res = await gmail.users.drafts.list({ userId: 'me', maxResults: 100 });
      const drafts = res.data.drafts || [];
      if (drafts.length === 0) { hasMore = false; break; }
      for (const d of drafts) { try { await gmail.users.drafts.delete({ userId: 'me', id: d.id }); summary.messagesDeleted++; } catch {} }
      log.info('[clean-gmail ' + sourceEmail + ']   Deleted ' + drafts.length + ' drafts');
    }
  } catch (err) { summary.errors.push('Drafts: ' + err.message); }

  log.info('[clean-gmail ' + sourceEmail + '] Step 4: Cleaning calendars...');
  try {
    const calAuth = getCalendarAuthForEmail(sourceEmail);
    const cal = google.calendar({ version: 'v3', auth: calAuth });
    const calList = await cal.calendarList.list();
    for (const c of calList.data.items || []) {
      if (c.primary) {
        log.info('[clean-gmail ' + sourceEmail + ']   Cleaning primary calendar...');
        let pt = undefined, del = 0;
        do {
          const ev = await cal.events.list({ calendarId: c.id, maxResults: 250, pageToken: pt, singleEvents: false });
          for (const e of ev.data.items || []) { try { await cal.events.delete({ calendarId: c.id, eventId: e.id }); del++; } catch {} }
          pt = ev.data.nextPageToken;
        } while (pt);
        summary.eventsDeleted += del;
        log.info('[clean-gmail ' + sourceEmail + ']   Deleted ' + del + ' events from primary calendar');
      } else if (c.accessRole === 'owner') {
        try {
          await cal.calendars.delete({ calendarId: c.id });
          summary.calendarsDeleted++;
          log.info('[clean-gmail ' + sourceEmail + ']   Deleted calendar "' + c.summary + '"');
        } catch (err) { summary.errors.push('Calendar "' + c.summary + '": ' + err.message); }
      }
    }
  } catch (err) { summary.errors.push('Calendars: ' + err.message); }

  log.info('[clean-gmail ' + sourceEmail + '] DONE: ' + summary.messagesDeleted + ' msgs, ' + summary.foldersDeleted + ' labels, ' + summary.eventsDeleted + ' events, ' + summary.calendarsDeleted + ' calendars');
  return summary;
}

module.exports = {
  buildRawMessage,
  insertEmail,
  modifyMessageLabels,
  createLabel,
  createDraft,
  listLabels,
  getMessageCount,
  getCalendarAuthForEmail,
  getRefreshTokenForEmail,
  getConfiguredAccounts,
  listDomainUsers,
  getGmailMailboxStats,
  cleanGmailMailbox,
  GMAIL_SYSTEM_LABEL_IDS,
};
