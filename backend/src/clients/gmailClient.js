const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const env = require('../config/env');
const tokenStore = require('./oauthTokenStore');
const { retryWithBackoff } = require('../utils/retry');
const logger = require('../utils/logger');

/** Return '2' or '3' if the email belongs to the second/third Google tenant, else '1'. */
function getGoogleTenant(email) {
  const domain = (email || '').split('@')[1]?.toLowerCase() || '';
  if (domain && env.GOOGLE_CLIENT_ID_3 && env.GOOGLE_TENANT_3_DOMAINS?.includes(domain)) return '3';
  if (domain && env.GOOGLE_CLIENT_ID_2 && env.GOOGLE_TENANT_2_DOMAINS?.includes(domain)) return '2';
  return '1';
}

const SERVICE_ACCOUNT_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/contacts',
  'https://www.googleapis.com/auth/directory.readonly',
  'https://www.googleapis.com/auth/admin.directory.user.readonly',
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/admin.directory.group.readonly',
];

// Superset scopes required for permanent delete (batchDelete/messages.delete).
// The DWD entry in admin.google.com must also include https://mail.google.com/
const SERVICE_ACCOUNT_SCOPES_WRITE = [
  'https://mail.google.com/',
  ...SERVICE_ACCOUNT_SCOPES,
];

/** Returns true when the tenant for this email has a service account key configured (DWD). */
function hasServiceAccount(tenant) {
  if (tenant === '3') return !!env.GOOGLE_SERVICE_ACCOUNT_KEY_3;
  if (tenant === '2') return !!env.GOOGLE_SERVICE_ACCOUNT_KEY_2;
  return false;
}

/**
 * Returns a service-account JWT auth client impersonating the given user.
 * Used for tenants with Domain-Wide Delegation configured — no per-user OAuth needed.
 */
function getServiceAccountAuth(email, write = false) {
  const tenant = getGoogleTenant(email);
  const keyPath = tenant === '2' ? env.GOOGLE_SERVICE_ACCOUNT_KEY_2 : env.GOOGLE_SERVICE_ACCOUNT_KEY_3;
  if (!keyPath) throw new Error(`GOOGLE_SERVICE_ACCOUNT_KEY_${tenant} not set in .env`);
  const key = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
  return new google.auth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: write ? SERVICE_ACCOUNT_SCOPES_WRITE : SERVICE_ACCOUNT_SCOPES,
    subject: email,
  });
}

/**
 * Get OAuth2 client for a specific refresh token.
 * Picks the correct client credentials based on the email's tenant.
 */
function getAuthForToken(refreshToken, email) {
  const tenant = getGoogleTenant(email);
  let clientId, clientSecret;
  if (tenant === '3') {
    clientId = env.GOOGLE_CLIENT_ID_3;
    clientSecret = env.GOOGLE_CLIENT_SECRET_3;
  } else if (tenant === '2') {
    clientId = env.GOOGLE_CLIENT_ID_2;
    clientSecret = env.GOOGLE_CLIENT_SECRET_2;
  } else {
    clientId = env.GOOGLE_CLIENT_ID;
    clientSecret = env.GOOGLE_CLIENT_SECRET;
  }
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  return oauth2Client;
}

/**
 * Look up the refresh token for a given email address.
 * Checks the OAuth token store (UI-connected accounts) first, then falls back
 * to the env-configured GOOGLE_ACCOUNTS map.
 */
function getRefreshTokenForEmail(email) {
  const normalizedEmail = email.toLowerCase().trim();

  // 1. Check UI-connected OAuth accounts
  const stored = tokenStore.getGoogleToken(normalizedEmail);
  if (stored?.refreshToken) return stored.refreshToken;

  // 2. Check env-configured accounts
  const envToken = env.googleAccounts.get(normalizedEmail);
  if (envToken) return envToken;

  // 3. Fallback: any OAuth-connected account
  const oauthMap = tokenStore.getGoogleAccountsMap();
  if (oauthMap.size > 0) {
    const [fallbackEmail, fallbackToken] = oauthMap.entries().next().value;
    logger.warn(`No Google token for "${email}", falling back to OAuth account ${fallbackEmail}`);
    return fallbackToken;
  }

  // 4. Fallback: first env account
  const firstEnvEntry = env.googleAccounts.entries().next().value;
  if (firstEnvEntry) {
    logger.warn(`No Google token for "${email}", falling back to env account ${firstEnvEntry[0]}`);
    return firstEnvEntry[1];
  }

  throw new Error(`No Google refresh token configured for "${email}". Connect via Settings → Connect Accounts, or add to GOOGLE_ACCOUNTS in .env`);
}

function getGmailForEmail(email) {
  if (hasServiceAccount(getGoogleTenant(email))) {
    return google.gmail({ version: 'v1', auth: getServiceAccountAuth(email, false) });
  }
  const refreshToken = getRefreshTokenForEmail(email);
  return google.gmail({ version: 'v1', auth: getAuthForToken(refreshToken, email) });
}

function getGmailForWrite(email) {
  if (hasServiceAccount(getGoogleTenant(email))) {
    return google.gmail({ version: 'v1', auth: getServiceAccountAuth(email, true) });
  }
  const refreshToken = getRefreshTokenForEmail(email);
  return google.gmail({ version: 'v1', auth: getAuthForToken(refreshToken, email) });
}

function getCalendarAuthForEmail(email) {
  if (hasServiceAccount(getGoogleTenant(email))) {
    return getServiceAccountAuth(email);
  }
  const refreshToken = getRefreshTokenForEmail(email);
  return getAuthForToken(refreshToken, email);
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
function normalizeCRLF(text) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\r\n');
}

/** RFC 2045 §6.8 — base64 lines must not exceed 76 characters. */
function wrapBase64(data) {
  return String(data || '').replace(/(.{1,76})/g, '$1\r\n').trimEnd();
}

/** RFC 2822 date string, e.g. "Fri, 25 Apr 2026 10:30:00 +0000" */
function rfc2822Date(date = new Date()) {
  return date.toUTCString().replace('GMT', '+0000');
}

/** Convert plain text to minimal HTML, preserving line breaks. */
function textToSimpleHtml(text) {
  const escaped = String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r\n/g, '<br>\r\n')
    .replace(/\n/g, '<br>\r\n');
  return `<html><body><p>${escaped}</p></body></html>`;
}

/**
 * Builds a RFC 2822 compliant raw email message.
 *
 * MIME structure mirrors what email clients (Gmail UI, Outlook) produce so that
 * migration tools reliably find the body:
 *
 *   text only               → text/plain
 *   html only               → multipart/alternative (text/plain + text/html)
 *   text + attach           → multipart/mixed > multipart/alternative (text/plain + auto-html)
 *   html + attach           → multipart/mixed > multipart/alternative (text/plain + text/html)
 *   html + inline imgs      → multipart/alternative (text/plain + multipart/related(html + images))
 *   html + inline + attach  → multipart/mixed > multipart/alternative (text/plain + multipart/related)
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
  const ts = Date.now();
  const altBoundary = `alt_${ts}`;
  const mixedBoundary = `mixed_${ts}`;
  const relBoundary = `related_${ts}`;
  const hasRegularAttachments = attachments.length > 0;
  const hasInlineImages = inlineImages.length > 0;
  const hasHtml = !!htmlBody;

  // Normalize line endings to RFC 2822 CRLF so MIME parsers (including Outlook's
  // migration importer) don't collapse bare \n into spaces.
  const plainBody = normalizeCRLF(textBody);

  let message = '';
  message += `From: ${from}\r\n`;
  message += `To: ${to}\r\n`;
  const ccLine = formatAddressList(cc);
  if (ccLine) message += `Cc: ${ccLine}\r\n`;
  const bccLine = formatAddressList(bcc);
  if (bccLine) message += `Bcc: ${bccLine}\r\n`;
  message += `Subject: ${encodeSubject(subject)}\r\n`;
  message += `Date: ${rfc2822Date()}\r\n`;
  message += `Message-ID: <${ts}-${Math.random().toString(36).slice(2)}@cloudfuze.qa>\r\n`;
  message += `MIME-Version: 1.0\r\n`;

  // Helper: emit the multipart/related block (html + inline images)
  const emitRelated = () => {
    message += `Content-Type: multipart/related; boundary="${relBoundary}"\r\n\r\n`;
    message += `--${relBoundary}\r\n`;
    message += `Content-Type: text/html; charset="UTF-8"\r\nContent-Transfer-Encoding: 8bit\r\n\r\n`;
    message += `${htmlBody}\r\n`;
    for (const img of inlineImages) {
      message += `--${relBoundary}\r\n`;
      message += `Content-Type: ${img.mimeType}\r\n`;
      message += `Content-Transfer-Encoding: base64\r\n`;
      message += `Content-ID: <${img.contentId}>\r\n`;
      message += `Content-Disposition: inline; filename="${img.contentId}"\r\n\r\n`;
      message += `${wrapBase64(img.data)}\r\n`;
    }
    message += `--${relBoundary}--\r\n`;
  };

  if (hasRegularAttachments) {
    // multipart/mixed wraps the body + file attachments
    message += `Content-Type: multipart/mixed; boundary="${mixedBoundary}"\r\n\r\n`;
    message += `--${mixedBoundary}\r\n`;

    if (hasHtml && hasInlineImages) {
      message += `Content-Type: multipart/alternative; boundary="${altBoundary}"\r\n\r\n`;
      message += `--${altBoundary}\r\n`;
      message += `Content-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: 8bit\r\n\r\n`;
      message += `${plainBody}\r\n`;
      message += `--${altBoundary}\r\n`;
      emitRelated();
      message += `--${altBoundary}--\r\n\r\n`;
    } else if (hasHtml) {
      message += `Content-Type: multipart/alternative; boundary="${altBoundary}"\r\n\r\n`;
      message += `--${altBoundary}\r\n`;
      message += `Content-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: 8bit\r\n\r\n`;
      message += `${plainBody}\r\n`;
      message += `--${altBoundary}\r\n`;
      message += `Content-Type: text/html; charset="UTF-8"\r\nContent-Transfer-Encoding: 8bit\r\n\r\n`;
      message += `${htmlBody}\r\n`;
      message += `--${altBoundary}--\r\n\r\n`;
    } else {
      // text only + attachments: auto-generate HTML so migration tools find the body
      const autoHtml = textToSimpleHtml(plainBody);
      message += `Content-Type: multipart/alternative; boundary="${altBoundary}"\r\n\r\n`;
      message += `--${altBoundary}\r\n`;
      message += `Content-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: 8bit\r\n\r\n`;
      message += `${plainBody}\r\n`;
      message += `--${altBoundary}\r\n`;
      message += `Content-Type: text/html; charset="UTF-8"\r\nContent-Transfer-Encoding: 8bit\r\n\r\n`;
      message += `${autoHtml}\r\n`;
      message += `--${altBoundary}--\r\n\r\n`;
    }

    for (const att of attachments) {
      message += `--${mixedBoundary}\r\n`;
      message += `Content-Type: ${att.mimeType}; name="${att.filename}"\r\n`;
      message += `Content-Disposition: attachment; filename="${att.filename}"\r\n`;
      message += `Content-Transfer-Encoding: base64\r\n\r\n`;
      message += `${wrapBase64(att.data)}\r\n`;
    }
    message += `--${mixedBoundary}--\r\n`;

  } else if (hasHtml && hasInlineImages) {
    // Inline images only (no file attachments): multipart/alternative → multipart/related
    // Do NOT wrap in multipart/mixed — that signals file attachments and breaks inline rendering
    message += `Content-Type: multipart/alternative; boundary="${altBoundary}"\r\n\r\n`;
    message += `--${altBoundary}\r\n`;
    message += `Content-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: 8bit\r\n\r\n`;
    message += `${plainBody}\r\n`;
    message += `--${altBoundary}\r\n`;
    emitRelated();
    message += `--${altBoundary}--\r\n`;

  } else if (hasHtml) {
    message += `Content-Type: multipart/alternative; boundary="${altBoundary}"\r\n\r\n`;
    message += `--${altBoundary}\r\n`;
    message += `Content-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: 8bit\r\n\r\n`;
    message += `${plainBody}\r\n`;
    message += `--${altBoundary}\r\n`;
    message += `Content-Type: text/html; charset="UTF-8"\r\nContent-Transfer-Encoding: 8bit\r\n\r\n`;
    message += `${htmlBody}\r\n`;
    message += `--${altBoundary}--\r\n`;
  } else {
    message += `Content-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: 8bit\r\n\r\n`;
    message += `${plainBody}\r\n`;
  }

  return Buffer.from(message).toString('base64url');
}

/**
 * @param {string[]} labelIds
 * @param {{ threadId?: string }} [opts] - pass threadId to append to an existing Gmail thread (conversation)
 */
async function insertEmail(sourceEmail, userId, rawMessage, labelIds = ['INBOX'], opts = {}) {
  const gmail = getGmailForEmail(sourceEmail);
  const requestBody = { raw: rawMessage, labelIds };
  if (opts.threadId) {
    requestBody.threadId = opts.threadId;
  }
  const res = await retryWithBackoff(
    () =>
      gmail.users.messages.insert({
        userId,
        requestBody,
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
 * Paginated message id list for a label (e.g. INBOX).
 */
async function listMessageIdsForLabel(sourceEmail, labelId, options = {}) {
  const maxResults = Math.min(Math.max(options.maxResults || 100, 1), 500);
  const pageToken = options.pageToken || undefined;
  const gmail = getGmailForEmail(sourceEmail);
  const res = await retryWithBackoff(
    () =>
      gmail.users.messages.list({
        userId: 'me',
        labelIds: labelId ? [labelId] : undefined,
        maxResults,
        pageToken,
      }),
    { label: `Gmail messages.list (${sourceEmail})` }
  );
  return {
    messages: res.data.messages || [],
    nextPageToken: res.data.nextPageToken || null,
    resultSizeEstimate: res.data.resultSizeEstimate,
  };
}

function headersArrayToMap(headers) {
  const map = {};
  if (!headers || !Array.isArray(headers)) return map;
  for (const h of headers) {
    const name = String(h.name || '').toLowerCase();
    map[name] = h.value || '';
  }
  return map;
}

function normalizeInternetMessageId(raw) {
  const inner = String(raw || '')
    .trim()
    .replace(/^<+/, '')
    .replace(/>+$/, '')
    .trim();
  if (!inner) return '';
  return `<${inner}>`;
}

async function getMessageMetadata(sourceEmail, messageId, format = 'metadata') {
  const gmail = getGmailForEmail(sourceEmail);
  const res = await retryWithBackoff(
    () =>
      gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format,
      }),
    { label: `Gmail messages.get (${sourceEmail})` }
  );
  const data = res.data;
  const headerMap = headersArrayToMap(data.payload?.headers);
  const midHeader = headerMap['message-id'] || '';
  const internalMs =
    data.internalDate != null && String(data.internalDate).length > 0 ? Number(data.internalDate) : null;
  return {
    id: data.id,
    threadId: data.threadId,
    labelIds: data.labelIds || [],
    snippet: data.snippet || '',
    sizeEstimate: data.sizeEstimate,
    payload: data.payload,
    headers: headerMap,
    internetMessageId: normalizeInternetMessageId(midHeader),
    /** Epoch ms when Gmail stored the message (preferred for pairing with Graph receivedDateTime). */
    internalDateMs: Number.isFinite(internalMs) ? internalMs : null,
    subject: headerMap.subject || '',
    from: headerMap.from || '',
    to: headerMap.to || '',
    cc: headerMap.cc || '',
    bcc: headerMap.bcc || '',
    date: headerMap.date || '',
    raw: data,
  };
}

function collectGmailAttachmentParts(payload, out = []) {
  if (!payload) return out;
  const filename = payload.filename;
  const body = payload.body || {};
  if (filename && body.attachmentId) {
    out.push({
      filename,
      size: Number(body.size) || 0,
      attachmentId: body.attachmentId,
      mimeType: payload.mimeType || '',
    });
  }
  const parts = payload.parts;
  if (parts && Array.isArray(parts)) {
    for (const p of parts) collectGmailAttachmentParts(p, out);
  }
  return out;
}

function decodeMimePartBody(data) {
  if (!data || typeof data !== 'string') return '';
  const b64 = data.replace(/-/g, '+').replace(/_/g, '/');
  try {
    return Buffer.from(b64, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function stripHtmlMinimal(html) {
  return String(html || '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Best-effort plain text from Gmail MIME payload (prefers text/plain, else text/html stripped).
 */
function extractPlainBodyFromPayload(payload, depth = 0) {
  if (!payload || depth > 24) return '';
  const mime = String(payload.mimeType || '').toLowerCase();
  const body = payload.body || {};

  if (mime.includes('multipart')) {
    for (const p of payload.parts || []) {
      const got = extractPlainBodyFromPayload(p, depth + 1);
      if (got) return got;
    }
    return '';
  }
  if (mime.includes('text/plain') && body.data) {
    return decodeMimePartBody(body.data).trim();
  }
  if (mime.includes('text/html') && body.data) {
    return stripHtmlMinimal(decodeMimePartBody(body.data));
  }
  if (body.data && mime.includes('text')) {
    return decodeMimePartBody(body.data).trim();
  }
  return '';
}

/**
 * Extract raw text/html part (first occurrence) from Gmail MIME payload. Returns '' if none.
 * Used by deep mail validation so the HTML part on Gmail compares against Outlook's HTML body,
 * avoiding a false-positive when the text/plain alternative differs from the HTML content.
 */
function extractHtmlBodyFromPayload(payload, depth = 0) {
  if (!payload || depth > 24) return '';
  const mime = String(payload.mimeType || '').toLowerCase();
  const body = payload.body || {};
  if (mime.includes('multipart')) {
    for (const p of payload.parts || []) {
      const got = extractHtmlBodyFromPayload(p, depth + 1);
      if (got) return got;
    }
    return '';
  }
  if (mime.includes('text/html') && body.data) {
    return decodeMimePartBody(body.data);
  }
  return '';
}

/**
 * Human-readable Gmail label list for a message (sorted, joined).
 * @param {string[]} labelIds
 * @param {Map<string,string>} labelIdToName
 */
function formatGmailLabelsForCompare(labelIds, labelIdToName) {
  const names = (labelIds || [])
    .map((id) => labelIdToName?.get?.(id) || id)
    .filter(Boolean);
  return [...new Set(names)].sort((a, b) => String(a).localeCompare(String(b))).join(' | ');
}

async function getMessageFullForValidation(sourceEmail, messageId) {
  const meta = await getMessageMetadata(sourceEmail, messageId, 'full');
  const attachments = collectGmailAttachmentParts(meta.payload);
  return { ...meta, attachments };
}

async function getAttachmentData(sourceEmail, messageId, attachmentId) {
  const gmail = getGmailForEmail(sourceEmail);
  const res = await retryWithBackoff(
    () =>
      gmail.users.messages.attachments.get({
        userId: 'me',
        messageId,
        id: attachmentId,
      }),
    { label: `Gmail attachments.get (${sourceEmail})` }
  );
  const data = res.data?.data;
  if (!data) return Buffer.alloc(0);
  const b64 = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b64, 'base64');
}

/**
 * Find Gmail messages matching an RFC 2822 Message-ID header (internetMessageId).
 * Returns [{id, threadId}] or [] when nothing found.
 */
async function findMessagesByInternetMessageId(email, internetMessageId) {
  const rawId = String(internetMessageId || '').replace(/^<+|>+$/g, '').trim();
  if (!rawId) return [];
  const gmail = getGmailForEmail(email);
  const res = await retryWithBackoff(
    () => gmail.users.messages.list({ userId: 'me', q: `rfc822msgid:${rawId}`, maxResults: 5 }),
    { label: `Gmail findByMID (${email})` }
  );
  return res.data.messages || [];
}

/**
 * Find Gmail messages by subject within a time window around anchorMs.
 * Returns [{id, threadId}] or [].
 */
async function findMessagesBySubjectAndTime(email, subject, anchorMs, windowMinutes = 120) {
  const gmail = getGmailForEmail(email);
  const windowSec = windowMinutes * 60;
  const afterSec = Math.floor(anchorMs / 1000) - windowSec;
  const beforeSec = Math.floor(anchorMs / 1000) + windowSec;
  const safeSubject = String(subject || '').replace(/"/g, '').slice(0, 100);
  const q = `subject:"${safeSubject}" after:${afterSec} before:${beforeSec}`;
  const res = await retryWithBackoff(
    () => gmail.users.messages.list({ userId: 'me', q, maxResults: 10 }),
    { label: `Gmail findBySubjectTime (${email})` }
  );
  return res.data.messages || [];
}

async function listMessageIdsForLabelUpTo(sourceEmail, labelId, maxIds, options = {}) {
  const cap = Math.min(Math.max(maxIds || 500, 1), 5000);
  const collected = [];
  let pageToken = undefined;
  const pageSize = Math.min(100, cap);
  while (collected.length < cap) {
    const page = await listMessageIdsForLabel(sourceEmail, labelId, {
      maxResults: Math.min(pageSize, cap - collected.length),
      pageToken,
    });
    for (const m of page.messages || []) {
      collected.push(m.id);
      if (collected.length >= cap) break;
    }
    if (!page.nextPageToken || collected.length >= cap) break;
    pageToken = page.nextPageToken;
  }
  return collected;
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
  const tenant = getGoogleTenant(adminEmail);
  const domain = adminEmail.split('@')[1];

  // Tenants with DWD service account: use Admin SDK Directory API
  if (hasServiceAccount(tenant)) {
    try {
      const auth = getServiceAccountAuth(adminEmail);
      const adminSdk = google.admin({ version: 'directory_v1', auth });
      const users = [];
      let pageToken = undefined;
      do {
        const res = await adminSdk.users.list({
          domain,
          maxResults: 500,
          orderBy: 'email',
          pageToken,
        });
        for (const u of res.data.users || []) {
          const email = (u.primaryEmail || '').toLowerCase();
          if (!email) continue;
          const name = u.name || {};
          users.push({
            id: u.id || email,
            email,
            displayName: name.fullName || email.split('@')[0],
            firstName: name.givenName || email.split('@')[0],
            lastName: name.familyName || '',
          });
        }
        pageToken = res.data.nextPageToken;
      } while (pageToken);
      logger.info(`Admin SDK listed ${users.length} users for ${domain}`);
      return users;
    } catch (err) {
      logger.warn(`Admin SDK user listing failed for ${adminEmail}: ${err.message}`);
      return [];
    }
  }

  const auth = getAuthForToken(getRefreshTokenForEmail(adminEmail), adminEmail);

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

  // Accurate total using getProfile (includes Inbox, Sent, Spam, Trash — everything).
  // resultSizeEstimate from messages.list is a rough hint, not a real count.
  let totalMessages = 0;
  try {
    const profile = await gmail.users.getProfile({ userId: 'me' });
    totalMessages = profile.data.messagesTotal || 0;
  } catch (profileErr) {
    // Re-throw auth errors (DWD not configured, token invalid) so the controller surfaces them.
    const msg = String(profileErr?.message || '');
    if (/unauthorized|forbidden|invalid_grant|access_denied|insufficientPermissions|403|401/i.test(msg)) {
      throw profileErr;
    }
    // Fallback for scope-only issues
    try {
      const msgList = await gmail.users.messages.list({ userId: 'me', maxResults: 1, includeSpamTrash: true });
      totalMessages = msgList.data.resultSizeEstimate || 0;
    } catch (listErr) {
      const lmsg = String(listErr?.message || '');
      if (/unauthorized|forbidden|invalid_grant|access_denied|insufficientPermissions|403|401/i.test(lmsg)) {
        throw listErr;
      }
    }
  }

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
  // Hard 12-second timeout for all calendar stats — prevents hanging on slow/large calendars
  const calResult = await Promise.race([
    (async () => {
      try {
        const calAuth = getCalendarAuthForEmail(sourceEmail);
        const calApi = google.calendar({ version: 'v3', auth: calAuth });
        const calList = await calApi.calendarList.list({ maxResults: 250 });
        const calendars = calList.data.items || [];

        // Only count calendars the user can actually clean:
        //   - owner/writer: can delete or unsubscribe
        //   - reader (holidays, contact birthdays): events can't be deleted, skip
        const ownedCals = calendars.filter((c) => !c.primary && c.accessRole !== 'reader');
        let evtCount = 0;
        for (const item of calendars) {
          if (item.accessRole === 'reader') continue;
          try {
            // First page only (no pagination) — fast approximate count for stats display
            const ev = await calApi.events.list({
              calendarId: item.id,
              maxResults: 250,
              singleEvents: false,
            });
            evtCount += (ev.data.items || []).length;
          } catch { /* skip this calendar */ }
        }
        return { calendarCount: ownedCals.length, eventCount: evtCount };
      } catch { return null; }
    })(),
    new Promise((resolve) => setTimeout(() => resolve(null), 12000)),
  ]);
  if (calResult) {
    calendarCount = calResult.calendarCount;
    eventCount = calResult.eventCount;
  }

  return { mailCount: totalMessages, folderCount: customLabelCount, calendarCount, eventCount };
}

/**
 * Best-effort Google Contacts count for the source mailbox user.
 *
 * Uses People API `people.connections.list` against `people/me` paginated at 1000/page.
 * Returns 0 with `available:false` when the user's OAuth refresh token lacks the
 * https://www.googleapis.com/auth/contacts.readonly scope — caller renders the validation
 * report row with that 0 and a note so the 4-metric Mail/Folders/Calendars/Contacts layout
 * stays consistent across executions.
 *
 * @param {string} sourceEmail
 * @returns {Promise<{ count: number, available: boolean, note?: string }>}
 */
async function getGmailContactsCount(sourceEmail) {
  try {
    const auth = hasServiceAccount(getGoogleTenant(sourceEmail))
      ? getServiceAccountAuth(sourceEmail)
      : getAuthForToken(getRefreshTokenForEmail(sourceEmail), sourceEmail);
    const people = google.people({ version: 'v1', auth });
    let count = 0;
    let pageToken = undefined;
    // Cap at 10k for safety (large tenants can time out); good enough for reporting tile.
    for (let i = 0; i < 20; i++) {
      const res = await people.people.connections.list({
        resourceName: 'people/me',
        personFields: 'metadata',
        pageSize: 1000,
        pageToken,
      });
      const items = res.data.connections || [];
      count += items.length;
      pageToken = res.data.nextPageToken;
      if (!pageToken) break;
    }
    return { count, available: true };
  } catch (e) {
    const msg = String(e?.message || e);
    // "ACCESS_TOKEN_SCOPE_INSUFFICIENT" or 403/401 → scope/permissions
    const scope = /scope|permission|invalid_grant|403|401/i.test(msg);
    return {
      count: 0,
      available: false,
      note: scope
        ? 'Contacts scope not granted to the refresh token — enable contacts.readonly to include this count.'
        : `Contacts fetch failed: ${msg.substring(0, 160)}`,
    };
  }
}

async function getGmailContactsWithDetails(sourceEmail) {
  try {
    const auth = hasServiceAccount(getGoogleTenant(sourceEmail))
      ? getServiceAccountAuth(sourceEmail)
      : getAuthForToken(getRefreshTokenForEmail(sourceEmail), sourceEmail);
    const people = google.people({ version: 'v1', auth });
    const personFields = 'names,emailAddresses,phoneNumbers,organizations,photos';
    const contacts = [];
    let pageToken;
    for (let i = 0; i < 10; i++) {
      const res = await people.people.connections.list({
        resourceName: 'people/me',
        personFields,
        pageSize: 200,
        pageToken,
      });
      for (const p of res.data.connections || []) {
        contacts.push({
          resourceName: p.resourceName,
          displayName: (p.names?.[0]?.displayName) || '',
          givenName:   (p.names?.[0]?.givenName)   || '',
          familyName:  (p.names?.[0]?.familyName)  || '',
          emailAddresses: (p.emailAddresses || []).map(e => e.value).filter(Boolean),
          phoneNumbers:   (p.phoneNumbers  || []).map(p => p.value).filter(Boolean),
          organization:   (p.organizations?.[0]?.name) || '',
          jobTitle:       (p.organizations?.[0]?.title) || '',
          photoUrl:       (p.photos?.[0]?.url) || null,
          hasPhoto:       (p.photos || []).some(ph => !ph.default),
        });
      }
      pageToken = res.data.nextPageToken;
      if (!pageToken) break;
    }
    return { contacts, available: true };
  } catch (e) {
    const msg = String(e?.message || e);
    return { contacts: [], available: false, note: `getGmailContactsWithDetails failed: ${msg.substring(0, 160)}` };
  }
}

/**
 * Count Google Workspace groups in a domain using the Admin SDK.
 * Requires admin.directory.group.readonly DWD scope.
 * @param {string} adminEmail — a domain admin to impersonate (for DWD)
 * @returns {Promise<{ count: number, available: boolean, note?: string }>}
 */
async function getGoogleGroupsCount(adminEmail) {
  try {
    const auth = hasServiceAccount(getGoogleTenant(adminEmail))
      ? getServiceAccountAuth(adminEmail)
      : getAuthForToken(getRefreshTokenForEmail(adminEmail), adminEmail);
    const admin = google.admin({ version: 'directory_v1', auth });
    const domain = (adminEmail || '').split('@')[1] || '';
    let count = 0;
    let pageToken = undefined;
    for (let i = 0; i < 20; i++) {
      const res = await admin.groups.list({ domain, maxResults: 200, pageToken });
      count += (res.data.groups || []).length;
      pageToken = res.data.nextPageToken;
      if (!pageToken) break;
    }
    return { count, available: true };
  } catch (e) {
    const msg = String(e?.message || e);
    const scope = /scope|permission|invalid_grant|403|401/i.test(msg);
    return {
      count: 0,
      available: false,
      note: scope
        ? 'admin.directory.group.readonly scope not granted — enable in DWD to include group count.'
        : `Groups fetch failed: ${msg.substring(0, 160)}`,
    };
  }
}

async function cleanGmailMailbox(sourceEmail) {
  const log = require('../utils/logger');
  const gmail = getGmailForWrite(sourceEmail);
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

  log.info('[clean-gmail ' + sourceEmail + '] Step 2: Deleting all emails (including Spam & Trash)...');
  try {
    let hasMore = true;
    while (hasMore) {
      // includeSpamTrash: true ensures Spam and Trash messages are also deleted
      const res = await gmail.users.messages.list({ userId: 'me', maxResults: 100, includeSpamTrash: true });
      const messages = res.data.messages || [];
      if (messages.length === 0) { hasMore = false; break; }
      const ids = messages.map(function(m) { return m.id; });
      await gmail.users.messages.batchDelete({ userId: 'me', requestBody: { ids: ids } }).catch(function(e) {
        const hint = /insufficient.*scope|scope.*insufficient|403/i.test(e.message) ? ' — reconnect the account to grant https://mail.google.com/ scope' : '';
        log.error('[clean-gmail ' + sourceEmail + ']   batchDelete failed: ' + e.message + hint);
        throw e;
      });
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
        // Primary calendar cannot be deleted — clear all its events
        log.info('[clean-gmail ' + sourceEmail + ']   Cleaning primary calendar events...');
        let pt = undefined, del = 0;
        do {
          const ev = await cal.events.list({ calendarId: c.id, maxResults: 250, pageToken: pt, singleEvents: false });
          for (const e of ev.data.items || []) {
            try { await cal.events.delete({ calendarId: c.id, eventId: e.id }); del++; } catch {}
          }
          pt = ev.data.nextPageToken;
        } while (pt);
        summary.eventsDeleted += del;
        log.info('[clean-gmail ' + sourceEmail + ']   Deleted ' + del + ' events from primary calendar');
      } else if (c.accessRole === 'owner') {
        // Non-primary owned calendars: delete entirely (events go with it)
        try {
          await cal.calendars.delete({ calendarId: c.id });
          summary.calendarsDeleted++;
          log.info('[clean-gmail ' + sourceEmail + ']   Deleted owned calendar "' + c.summary + '"');
        } catch (err) {
          summary.errors.push('Calendar "' + c.summary + '": ' + err.message);
        }
      } else {
        // Non-primary shared/non-owned calendars: clear events then remove from list
        log.info('[clean-gmail ' + sourceEmail + ']   Removing shared calendar "' + c.summary + '" from list...');
        let pt = undefined, del = 0;
        try {
          do {
            const ev = await cal.events.list({ calendarId: c.id, maxResults: 250, pageToken: pt, singleEvents: false });
            for (const e of ev.data.items || []) {
              // Only delete events we created/own
              try { await cal.events.delete({ calendarId: c.id, eventId: e.id }); del++; } catch {}
            }
            pt = ev.data.nextPageToken;
          } while (pt);
        } catch {}
        summary.eventsDeleted += del;
        // Remove the shared calendar from the user's calendar list
        try {
          await cal.calendarList.delete({ calendarId: c.id });
          summary.calendarsDeleted++;
          log.info('[clean-gmail ' + sourceEmail + ']   Removed shared calendar "' + c.summary + '" from list');
        } catch (err) {
          summary.errors.push('Remove shared calendar "' + c.summary + '": ' + err.message);
        }
      }
    }
  } catch (err) { summary.errors.push('Calendars: ' + err.message); }

  log.info('[clean-gmail ' + sourceEmail + '] DONE: ' + summary.messagesDeleted + ' msgs, ' + summary.foldersDeleted + ' labels, ' + summary.eventsDeleted + ' events, ' + summary.calendarsDeleted + ' calendars');
  return summary;
}

/**
 * Delete only QA-tagged messages (subject contains "QA") and QA custom labels.
 * Pass { emptyTrash: true } to also purge every message in the Trash folder
 * (used for destination mailbox cleanup — safe before a fresh migration run).
 */
async function deleteGmailQaMessages(email, { emptyTrash = false } = {}) {
  const log = require('../utils/logger');
  const gmail = getGmailForWrite(email);
  let messagesDeleted = 0;
  let labelsDeleted = 0;
  let trashDeleted = 0;
  const errors = [];

  // 1. Delete messages with "QA" in subject (all folders including spam/trash)
  try {
    let pageToken;
    do {
      const res = await gmail.users.messages.list({
        userId: 'me', q: 'subject:QA', maxResults: 100, includeSpamTrash: true, pageToken,
      });
      const messages = res.data.messages || [];
      if (messages.length === 0) break;
      const ids = messages.map((m) => m.id);
      await gmail.users.messages.batchDelete({ userId: 'me', requestBody: { ids } });
      messagesDeleted += ids.length;
      log.info(`[deleteGmailQaMessages ${email}] Deleted ${ids.length} QA messages (total: ${messagesDeleted})`);
      pageToken = res.data.nextPageToken;
    } while (pageToken);
  } catch (err) {
    errors.push(`messages: ${err.message}`);
    log.warn(`[deleteGmailQaMessages ${email}] Message delete error: ${err.message}`);
  }

  // 2. Delete custom labels starting with "QA" (or "/QA" for nested path prefixes)
  //    and the Archive[Gmail] label created by Outlook→Gmail migration.
  try {
    const labelsRes = await gmail.users.labels.list({ userId: 'me' });
    const qaLabels = (labelsRes.data.labels || []).filter((l) => {
      if (l.type !== 'user') return false;
      const n = l.name;
      return n.startsWith('QA') || n.startsWith('/QA') || /^archive\[gmail\]$/i.test(n);
    });
    for (const label of qaLabels) {
      try {
        await gmail.users.labels.delete({ userId: 'me', id: label.id });
        labelsDeleted++;
        log.info(`[deleteGmailQaMessages ${email}] Deleted label "${label.name}"`);
      } catch (err) {
        errors.push(`label "${label.name}": ${err.message}`);
      }
    }
  } catch (err) {
    errors.push(`labels: ${err.message}`);
    log.warn(`[deleteGmailQaMessages ${email}] Label delete error: ${err.message}`);
  }

  // 3. Empty entire Trash (destination-only cleanup — removes accumulated migration leftovers)
  if (emptyTrash) {
    try {
      let pageToken;
      do {
        const res = await gmail.users.messages.list({
          userId: 'me', q: 'in:trash', maxResults: 100, includeSpamTrash: true, pageToken,
        });
        const messages = res.data.messages || [];
        if (messages.length === 0) break;
        const ids = messages.map((m) => m.id);
        await gmail.users.messages.batchDelete({ userId: 'me', requestBody: { ids } });
        trashDeleted += ids.length;
        log.info(`[deleteGmailQaMessages ${email}] Emptied ${ids.length} trash messages (total: ${trashDeleted})`);
        pageToken = res.data.nextPageToken;
      } while (pageToken);
    } catch (err) {
      errors.push(`trash: ${err.message}`);
      log.warn(`[deleteGmailQaMessages ${email}] Trash empty error: ${err.message}`);
    }
  }

  log.info(`[deleteGmailQaMessages ${email}] Done: ${messagesDeleted} QA msgs, ${labelsDeleted} labels, ${trashDeleted} trash msgs deleted`);
  return { messagesDeleted, labelsDeleted, trashDeleted, errors };
}

async function cleanGmailEmailsOnly(sourceEmail) {
  const log = require('../utils/logger');
  const gmail = getGmailForWrite(sourceEmail);
  const summary = { messagesDeleted: 0, errors: [] };
  log.info('[clean-gmail-emails ' + sourceEmail + '] Deleting all messages...');
  try {
    let hasMore = true;
    while (hasMore) {
      const res = await gmail.users.messages.list({ userId: 'me', maxResults: 100, includeSpamTrash: true });
      const messages = res.data.messages || [];
      if (messages.length === 0) { hasMore = false; break; }
      const ids = messages.map((m) => m.id);
      await gmail.users.messages.batchDelete({ userId: 'me', requestBody: { ids } });
      summary.messagesDeleted += ids.length;
    }
  } catch (err) { summary.errors.push('Messages: ' + err.message); }
  try {
    let hasMore = true;
    while (hasMore) {
      const res = await gmail.users.drafts.list({ userId: 'me', maxResults: 100 });
      const drafts = res.data.drafts || [];
      if (drafts.length === 0) { hasMore = false; break; }
      for (const d of drafts) { try { await gmail.users.drafts.delete({ userId: 'me', id: d.id }); summary.messagesDeleted++; } catch {} }
    }
  } catch (err) { summary.errors.push('Drafts: ' + err.message); }
  log.info('[clean-gmail-emails ' + sourceEmail + '] DONE: ' + summary.messagesDeleted + ' msgs/drafts');
  return summary;
}

async function cleanGmailFoldersOnly(sourceEmail) {
  const log = require('../utils/logger');
  const gmail = getGmailForWrite(sourceEmail);
  const summary = { foldersDeleted: 0, errors: [] };
  log.info('[clean-gmail-folders ' + sourceEmail + '] Deleting custom labels...');
  try {
    const labelsRes = await gmail.users.labels.list({ userId: 'me' });
    for (const label of labelsRes.data.labels || []) {
      if (!GMAIL_SYSTEM_LABEL_IDS.has(label.id) && label.type === 'user') {
        try { await gmail.users.labels.delete({ userId: 'me', id: label.id }); summary.foldersDeleted++; }
        catch (err) { summary.errors.push('Label "' + label.name + '": ' + err.message); }
      }
    }
  } catch (err) { summary.errors.push('Labels: ' + err.message); }
  log.info('[clean-gmail-folders ' + sourceEmail + '] DONE: ' + summary.foldersDeleted + ' labels');
  return summary;
}

async function cleanGmailCalendarsOnly(sourceEmail) {
  const log = require('../utils/logger');
  const summary = { eventsDeleted: 0, calendarsDeleted: 0, errors: [] };
  log.info('[clean-gmail-cals ' + sourceEmail + '] Cleaning calendars...');
  try {
    const calAuth = getCalendarAuthForEmail(sourceEmail);
    const cal = google.calendar({ version: 'v3', auth: calAuth });
    const calList = await cal.calendarList.list();
    for (const c of calList.data.items || []) {
      if (c.primary) {
        let pt, del = 0;
        do {
          const ev = await cal.events.list({ calendarId: c.id, maxResults: 250, pageToken: pt, singleEvents: false });
          for (const e of ev.data.items || []) { try { await cal.events.delete({ calendarId: c.id, eventId: e.id }); del++; } catch {} }
          pt = ev.data.nextPageToken;
        } while (pt);
        summary.eventsDeleted += del;
      } else if (c.accessRole === 'owner') {
        try { await cal.calendars.delete({ calendarId: c.id }); summary.calendarsDeleted++; }
        catch (err) { summary.errors.push('Calendar "' + c.summary + '": ' + err.message); }
      } else {
        let pt, del = 0;
        try {
          do {
            const ev = await cal.events.list({ calendarId: c.id, maxResults: 250, pageToken: pt, singleEvents: false });
            for (const e of ev.data.items || []) { try { await cal.events.delete({ calendarId: c.id, eventId: e.id }); del++; } catch {} }
            pt = ev.data.nextPageToken;
          } while (pt);
        } catch {}
        summary.eventsDeleted += del;
        try { await cal.calendarList.delete({ calendarId: c.id }); summary.calendarsDeleted++; } catch {}
      }
    }
  } catch (err) { summary.errors.push('Calendars: ' + err.message); }
  log.info('[clean-gmail-cals ' + sourceEmail + '] DONE: ' + summary.eventsDeleted + ' events, ' + summary.calendarsDeleted + ' cals');
  return summary;
}

/**
 * Sum sizeEstimate for every message in the mailbox.
 * Paginates messages.list to collect all IDs, then fetches sizeEstimate in parallel chunks.
 * Caps at 5000 messages (sets partial:true beyond that).
 * Returns { sizeBytes, messageCount, partial, method }.
 */
async function getGmailMailboxSizeBytes(userEmail) {
  const gmail = getGmailForEmail(userEmail);
  const MAX_MESSAGES = 5000;
  const allIds = [];
  let pageToken;
  while (allIds.length < MAX_MESSAGES) {
    const res = await gmail.users.messages.list({
      userId: 'me',
      maxResults: 500,
      includeSpamTrash: true,
      pageToken,
      fields: 'messages/id,nextPageToken',
    });
    for (const m of (res.data.messages || [])) allIds.push(m.id);
    pageToken = res.data.nextPageToken;
    if (!pageToken) break;
  }
  const partial = allIds.length >= MAX_MESSAGES;
  let totalBytes = 0;
  const CHUNK = 50;
  for (let i = 0; i < allIds.length; i += CHUNK) {
    const results = await Promise.allSettled(
      allIds.slice(i, i + CHUNK).map((id) =>
        gmail.users.messages.get({ userId: 'me', id, format: 'minimal', fields: 'sizeEstimate' })
      )
    );
    for (const r of results) {
      if (r.status === 'fulfilled') totalBytes += Number(r.value.data.sizeEstimate) || 0;
    }
  }
  return { sizeBytes: totalBytes, messageCount: allIds.length, partial, method: 'gmail_size_estimate' };
}

module.exports = {
  hasServiceAccount,
  buildRawMessage,
  insertEmail,
  modifyMessageLabels,
  createLabel,
  createDraft,
  listLabels,
  getMessageCount,
  listMessageIdsForLabel,
  listMessageIdsForLabelUpTo,
  findMessagesByInternetMessageId,
  findMessagesBySubjectAndTime,
  getMessageMetadata,
  getMessageFullForValidation,
  getAttachmentData,
  collectGmailAttachmentParts,
  extractPlainBodyFromPayload,
  extractHtmlBodyFromPayload,
  formatGmailLabelsForCompare,
  normalizeInternetMessageId,
  getCalendarAuthForEmail,
  getRefreshTokenForEmail,
  getConfiguredAccounts,
  listDomainUsers,
  getGmailMailboxStats,
  getGmailMailboxSizeBytes,
  getGmailContactsCount,
  getGmailContactsWithDetails,
  getGoogleGroupsCount,
  cleanGmailMailbox,
  cleanGmailEmailsOnly,
  cleanGmailFoldersOnly,
  cleanGmailCalendarsOnly,
  deleteGmailQaMessages,
  GMAIL_SYSTEM_LABEL_IDS,
};
