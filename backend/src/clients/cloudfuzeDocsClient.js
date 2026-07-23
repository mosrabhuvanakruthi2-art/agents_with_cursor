/**
 * CloudFuze Documentation API client.
 *
 * Uses the live API at https://doc.cftools.live/api/features to classify
 * each mismatch as:
 *   'bug'              — inscope feature failing → real migration bug
 *   'known_limitation' — outscope feature → documented platform limitation
 *   'unknown'          — not in docs → treated as bug
 *
 * Fallback priority (most → least preferred):
 *   1. Live API  — doc.cftools.live (fresh, authoritative)
 *   2. Persisted last-known file  — backend/data/docs-features-last-known.json
 *      (written after every successful API call; survives doc tool crashes)
 *   3. Hardcoded FEATURES array   — always available, updated manually
 *
 * API:
 *   GET /api/features?productType=Mail&combination=<combo>&scope=outscope
 *   GET /api/features?productType=Mail&combination=<combo>&scope=inscope
 */

const axios  = require('axios');
const fs     = require('fs');
const path   = require('path');
const logger = require('../utils/logger');

const DOCS_BASE        = 'https://doc.cftools.live';
const LAST_KNOWN_FILE  = path.resolve(__dirname, '../../data/docs-features-last-known.json');

// ── Persist helpers ───────────────────────────────────────────────────────────

/**
 * Load the last-known features map from disk.
 * Returns { syncedAt, features: { key → [] } } or null.
 */
function loadLastKnown() {
  try {
    if (fs.existsSync(LAST_KNOWN_FILE)) {
      return JSON.parse(fs.readFileSync(LAST_KNOWN_FILE, 'utf-8'));
    }
  } catch (e) {
    logger.warn(`[cloudfuzeDocsClient] Could not read last-known file: ${e.message}`);
  }
  return null;
}

/**
 * Overwrite the entire last-known file with fresh data from a full sync.
 * Called by docsSyncService after all combinations are fetched — replaces
 * everything so only the most recent sync is stored, no old data retained.
 *
 * @param {Record<string, Array>} featuresMap  key → features array
 */
function saveLastKnown(featuresMap) {
  try {
    const payload = { syncedAt: new Date().toISOString(), features: featuresMap };
    const dir = path.dirname(LAST_KNOWN_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(LAST_KNOWN_FILE, JSON.stringify(payload, null, 2), 'utf-8');
    logger.info(`[cloudfuzeDocsClient] Saved last-known features to disk (${Object.keys(featuresMap).length} keys)`);
  } catch (e) {
    logger.warn(`[cloudfuzeDocsClient] Could not write last-known file: ${e.message}`);
  }
}

// In-memory cache per combination+scope — avoids repeated disk reads within a run
const _cache = {};

async function fetchFeatures(combination, scope) {
  const key = `${combination}::${scope}`;
  if (_cache[key]) return _cache[key];

  // Tier 3 baseline — hardcoded local entries always available
  const localFeatures = getLocalFeatures(combination, scope);

  try {
    // Tier 1 — try the live documentation API
    const res = await axios.get(`${DOCS_BASE}/api/features`, {
      params: { productType: 'Mail', combination, scope },
      timeout: 10000,
    });
    const liveFeatures = res.data?.features || [];

    // Merge: live API wins on name collision; local entries fill any gaps
    const liveNames = new Set(liveFeatures.map((f) => String(f.name || '').toLowerCase()));
    const merged = [
      ...liveFeatures,
      ...localFeatures.filter((f) => !liveNames.has(String(f.name || '').toLowerCase())),
    ];

    _cache[key] = merged;
    logger.info(`[cloudfuzeDocsClient] Loaded ${liveFeatures.length} live + ${merged.length - liveFeatures.length} local ${scope} features for "${combination}"`);
    return merged;
  } catch (err) {
    logger.warn(`[cloudfuzeDocsClient] Live API unavailable for "${combination}" ${scope}: ${err.message}`);

    // Tier 2 — fall back to last-known file written by the most recent Sync
    const lastKnown = loadLastKnown();
    const persisted  = lastKnown?.features?.[key];
    if (persisted && persisted.length > 0) {
      const syncedAt = lastKnown?.syncedAt || 'unknown';
      logger.info(`[cloudfuzeDocsClient] Using last-known data for "${combination}" ${scope} (${persisted.length} features, synced ${syncedAt})`);
      _cache[key] = persisted;
      return persisted;
    }

    // Tier 3 — fall back to hardcoded FEATURES array
    logger.warn(`[cloudfuzeDocsClient] No last-known data found — using ${localFeatures.length} hardcoded features for "${combination}" ${scope}`);
    _cache[key] = localFeatures;
    return localFeatures;
  }
}

// ── Static local FEATURES registry ───────────────────────────────────────────
// Mirrors what the live API returns but is available offline and as a fallback.
//
// Each entry shape:
//   combination   — exact combination string matching getCombination() output
//   scope         — 'outscope' | 'inscope'
//   name          — short display name shown in reports
//   description   — human-readable explanation shown in reports
//   matchFields   — structuredDiff fieldKey values that signal this limitation
//   matchKinds    — mismatch.kind values that signal this limitation
//   matchKeywords — additional lowercase terms matched against the mismatch blob
//
// fetchFeatures() merges the live API response with these entries (live wins on
// name collision) so the classifier always has complete coverage.
const FEATURES = [

  // ═══════════════════════════════════════════════════════════════════════════
  // OUTLOOK TO GMAIL — OUTSCOPE (25 features)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    combination: 'Outlook to Gmail',
    scope: 'outscope',
    name: 'Categories not Preserved',
    description: 'Outlook category information is lost during migration — Gmail has no equivalent category tagging system.',
    matchFields: ['categories', 'category'],
    matchKinds: ['other'],
    matchKeywords: ['categories', 'category', 'color category'],
  },
  {
    combination: 'Outlook to Gmail',
    scope: 'outscope',
    name: 'Sensitivity Labels / Information Protection Labels',
    description: 'Microsoft sensitivity labels and Information Protection Labels (ILP) are not supported in Gmail and cannot be transferred.',
    matchFields: ['sensitivity', 'sensitivityLabel', 'informationProtection'],
    matchKinds: ['other'],
    matchKeywords: ['sensitivity', 'sensitivity label', 'information protection', 'ilp', 'confidential label', 'dlp label'],
  },
  {
    combination: 'Outlook to Gmail',
    scope: 'outscope',
    name: 'Emoji Folder Name not Preserved',
    description: 'Gmail enforces a 225-character label limit; folder names containing emoji characters may be truncated or altered.',
    matchFields: ['folder', 'folderName', 'label'],
    matchKinds: ['folder', 'other'],
    matchKeywords: ['emoji', 'folder name', 'label name', 'truncated', '225 character'],
  },
  {
    combination: 'Outlook to Gmail',
    scope: 'outscope',
    name: 'Conversation History Folder not Preserved',
    description: 'The Conversation History folder (Skype/Teams/Lync chat history) is excluded from mail migration as it is not standard email content.',
    matchFields: ['folder'],
    matchKinds: ['folder', 'other'],
    matchKeywords: ['conversation history', 'skype', 'teams chat', 'lync', 'chat history'],
  },
  {
    combination: 'Outlook to Gmail',
    scope: 'outscope',
    name: 'Notes Migration not Preserved',
    description: 'Outlook Notes are not email content and are excluded from mail migration scope.',
    matchFields: ['folder', 'notFoundReason'],
    matchKinds: ['other'],
    matchKeywords: ['notes', 'notes folder', 'sticky note', 'outlook note'],
  },
  {
    combination: 'Outlook to Gmail',
    scope: 'outscope',
    name: 'Contact Categories',
    description: 'Contact category information is not retrievable via the Microsoft API and therefore cannot be migrated.',
    matchFields: ['contactCategory', 'category'],
    matchKinds: ['other'],
    matchKeywords: ['contact categor', 'contact group category'],
  },
  {
    combination: 'Outlook to Gmail',
    scope: 'outscope',
    name: 'Contact Lists / Groups',
    description: 'Google Contacts lacks group structure support; Outlook contact lists/groups cannot be recreated at the destination.',
    matchFields: ['contactGroup', 'contactList'],
    matchKinds: ['other'],
    matchKeywords: ['contact list', 'contact group', 'distribution list', 'contact folder group'],
  },
  {
    combination: 'Outlook to Gmail',
    scope: 'outscope',
    name: 'Pinned Mails',
    description: 'Emails are migrated but the pin status is not preserved — Gmail has no pinning equivalent.',
    matchFields: ['pinned', 'flag', 'followUp'],
    matchKinds: ['other'],
    matchKeywords: ['pinned', 'pin status', 'pinned mail', 'pin flag'],
  },
  {
    combination: 'Outlook to Gmail',
    scope: 'outscope',
    name: 'Notes',
    description: 'Notes content is not standard email and is excluded from migration scope.',
    matchFields: ['notes', 'folder'],
    matchKinds: ['other'],
    matchKeywords: ['notes', 'note content', 'mapi note'],
  },
  {
    combination: 'Outlook to Gmail',
    scope: 'outscope',
    name: 'Encrypted and Non-Encrypted',
    description: 'Platform-specific encryption tags (S/MIME, IRM, Confidential Mode) have no Gmail equivalent and cannot be transferred.',
    matchFields: ['encryption', 'irm', 'smime', 'sensitivity'],
    matchKinds: ['other'],
    matchKeywords: ['encrypt', 'encrypted', 's/mime', 'irm', 'rights managed', 'information rights', 'non-encrypted'],
  },
  {
    combination: 'Outlook to Gmail',
    scope: 'outscope',
    name: 'To Do List',
    description: 'Outlook Tasks/To-Do list structure is not supported by Gmail and is excluded from migration.',
    matchFields: ['task', 'todo', 'taskFolder'],
    matchKinds: ['other'],
    matchKeywords: ['to do', 'todo', 'task list', 'outlook task', 'microsoft to do'],
  },
  {
    combination: 'Outlook to Gmail',
    scope: 'outscope',
    name: 'Any Invites Created by External Users',
    description: 'Calendar invites from external users will trigger notifications by design when migrated — this is expected behaviour.',
    matchFields: ['calendarInvite', 'organizer', 'attendees'],
    matchKinds: ['other'],
    matchKeywords: ['external invite', 'external organizer', 'external user invite', 'invite notification'],
  },
  {
    combination: 'Outlook to Gmail',
    scope: 'outscope',
    name: 'Attendees Will Not Receive Calendar Events for Past Events',
    description: 'Attendee notifications are intentionally not sent for past calendar events after migration.',
    matchFields: ['calendarEvent', 'attendees', 'pastEvent'],
    matchKinds: ['other'],
    matchKeywords: ['past event', 'past calendar', 'attendee notification', 'no notification past'],
  },
  {
    combination: 'Outlook to Gmail',
    scope: 'outscope',
    name: 'Legal Hold Data',
    description: 'The Microsoft API blocks metadata retrieval for mailboxes under legal preservation — Legal Hold data cannot be migrated.',
    matchFields: ['folder', 'notFoundReason'],
    matchKinds: ['other', 'infrastructure'],
    matchKeywords: ['legal hold', 'litigation hold', 'preservation hold', 'compliance hold'],
  },
  {
    combination: 'Outlook to Gmail',
    scope: 'outscope',
    name: 'Admin or User Settings',
    description: 'Admin-level and user-level settings are not exposed via the Microsoft API and are not migrated.',
    matchFields: ['settings', 'adminSettings', 'userSettings'],
    matchKinds: ['other'],
    matchKeywords: ['admin setting', 'user setting', 'mailbox setting', 'account setting'],
  },
  {
    combination: 'Outlook to Gmail',
    scope: 'outscope',
    name: 'Calendar Owner Scope',
    description: 'Users outside the migration scope are excluded from calendar event ownership transfer.',
    matchFields: ['calendarOwner', 'organizer'],
    matchKinds: ['other'],
    matchKeywords: ['calendar owner', 'out of scope', 'owner scope', 'calendar scope'],
  },
  {
    combination: 'Outlook to Gmail',
    scope: 'outscope',
    name: 'Calendar Attachment Size Varies',
    description: 'Variation in calendar attachment size between source and destination is expected behaviour.',
    matchFields: ['calendarAttachment', 'attachmentSize'],
    matchKinds: ['attachment', 'other'],
    matchKeywords: ['calendar attachment', 'ical attachment', 'attachment size varies', 'calendar attach'],
  },
  {
    combination: 'Outlook to Gmail',
    scope: 'outscope',
    name: 'Mailbox Policy',
    description: 'An applied mailbox policy can prevent migration — the mailbox must be policy-free for migration to proceed.',
    matchFields: ['mailboxPolicy', 'policy'],
    matchKinds: ['infrastructure', 'other'],
    matchKeywords: ['mailbox policy', 'retention policy', 'compliance policy', 'policy applied', 'policy blocked'],
  },
  {
    combination: 'Outlook to Gmail',
    scope: 'outscope',
    name: 'Group Members',
    description: 'Groups are migrated but group membership is not transferred to the destination.',
    matchFields: ['groupMembers', 'members'],
    matchKinds: ['other'],
    matchKeywords: ['group member', 'group membership', 'distribution group member'],
  },
  {
    combination: 'Outlook to Gmail',
    scope: 'outscope',
    name: 'In-Place Archive',
    description: 'In-Place Archive is a separate mailbox and requires a separate migration scope — it is excluded from standard mail migration.',
    matchFields: ['folder', 'archive'],
    matchKinds: ['other'],
    matchKeywords: ['in place archive', 'in-place archive', 'archive mailbox', 'online archive'],
  },
  {
    combination: 'Outlook to Gmail',
    scope: 'outscope',
    name: 'Rooms / Resources',
    description: 'Resource mailbox types (Rooms, Equipment) are excluded from user mail migration scope.',
    matchFields: ['folder', 'resourceType', 'mailboxType'],
    matchKinds: ['other'],
    matchKeywords: ['room', 'resource', 'equipment mailbox', 'resource mailbox', 'conference room'],
  },
  {
    combination: 'Outlook to Gmail',
    scope: 'outscope',
    name: 'Calendar — Recurring Series',
    description: 'Google Calendar does not support exception mapping for recurring series — recurring event exceptions may not be preserved.',
    matchFields: ['recurrence', 'recurringEvent', 'seriesException'],
    matchKinds: ['other'],
    matchKeywords: ['recurring series', 'recurrence exception', 'series exception', 'recurring event exception'],
  },
  {
    combination: 'Outlook to Gmail',
    scope: 'outscope',
    name: 'Email Rules and Forwarding Rules',
    description: 'Outlook and Gmail use different rule engines; the Microsoft API does not expose rule definitions for migration.',
    matchFields: ['rules', 'forwardingRules', 'inboxRules'],
    matchKinds: ['other'],
    matchKeywords: ['email rule', 'forwarding rule', 'inbox rule', 'mail rule', 'filter rule'],
  },
  {
    combination: 'Outlook to Gmail',
    scope: 'outscope',
    name: 'Contact Pictures',
    description: 'Contact profile pictures are not supported for migration between Outlook and Gmail.',
    matchFields: ['contactPhoto', 'photo', 'picture'],
    matchKinds: ['other'],
    matchKeywords: ['contact picture', 'contact photo', 'profile picture', 'contact image'],
  },
  {
    combination: 'Outlook to Gmail',
    scope: 'outscope',
    name: 'Attachment with Link is Migrated as Source Link',
    description: 'Attachments stored as links (OneDrive/SharePoint) are copied as source links and will not open in Gmail.',
    matchFields: ['attachmentLink', 'attachmentUrl', 'oneDriveLink', 'sharePointLink'],
    matchKinds: ['attachment', 'other'],
    matchKeywords: ['attachment link', 'source link', 'onedrive link', 'sharepoint link', 'cloud attachment', 'link attachment'],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // GMAIL TO OUTLOOK — OUTSCOPE (11 features)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    combination: 'Gmail to Outlook',
    scope: 'outscope',
    name: 'Scheduled',
    description: 'Gmail scheduled emails are system-managed and not migrated until they are actually sent.',
    matchFields: ['folder', 'label', 'scheduledSend'],
    matchKinds: ['folder', 'other'],
    matchKeywords: ['scheduled', 'scheduled email', 'scheduled send', 'scheduled mail'],
  },
  {
    combination: 'Gmail to Outlook',
    scope: 'outscope',
    name: 'Snoozed',
    description: 'Gmail snoozed emails have no Outlook equivalent and are not migrated.',
    matchFields: ['folder', 'label', 'snoozed'],
    matchKinds: ['folder', 'other'],
    matchKeywords: ['snoozed', 'snoozed email', 'snooze label', 'snoozed mail'],
  },
  {
    combination: 'Gmail to Outlook',
    scope: 'outscope',
    name: 'Purchase',
    description: 'The Gmail "Purchase/Transactions" label is not created at the destination; emails are migrated without the label.',
    matchFields: ['folder', 'label', 'category'],
    matchKinds: ['folder', 'other'],
    matchKeywords: ['purchase', 'transaction', 'purchase label', 'transaction label', 'promotions', 'social'],
  },
  {
    combination: 'Gmail to Outlook',
    scope: 'outscope',
    name: 'Multiple Delta',
    description: 'Only a single incremental mail delta is supported; multiple sequential deltas are not handled.',
    matchFields: ['delta', 'incremental'],
    matchKinds: ['other'],
    matchKeywords: ['multiple delta', 'incremental delta', 'multi delta', 'delta migration'],
  },
  {
    combination: 'Gmail to Outlook',
    scope: 'outscope',
    name: 'External User in Groups',
    description: 'External users cannot be added to same-organisation groups at the destination.',
    matchFields: ['groupMembers', 'externalUser'],
    matchKinds: ['other'],
    matchKeywords: ['external user', 'external group', 'external member', 'guest user group'],
  },
  {
    combination: 'Gmail to Outlook',
    scope: 'outscope',
    name: 'Group Members',
    description: 'Group members are not added at the destination during migration.',
    matchFields: ['groupMembers', 'members'],
    matchKinds: ['other'],
    matchKeywords: ['group member', 'group membership', 'group members not added'],
  },
  {
    combination: 'Gmail to Outlook',
    scope: 'outscope',
    name: 'Contact Photos',
    description: 'Contact profile photos are profile-based or externally linked and are not standard fields that can be migrated.',
    matchFields: ['contactPhoto', 'photo'],
    matchKinds: ['other'],
    matchKeywords: ['contact photo', 'contact picture', 'profile photo', 'contact image'],
  },
  {
    combination: 'Gmail to Outlook',
    scope: 'outscope',
    name: 'All Mail',
    description: '"All Mail" is not a real folder in Gmail — it is a collection view of all messages in their actual labels. It is not migrated as a folder.',
    matchFields: ['folder', 'label'],
    matchKinds: ['folder', 'other'],
    matchKeywords: ['all mail', 'allmail', 'all mail folder', 'all mail label'],
  },
  {
    combination: 'Gmail to Outlook',
    scope: 'outscope',
    name: 'Past Calendar Events',
    description: 'Past calendar events are intentionally excluded from migration.',
    matchFields: ['calendarEvent', 'pastEvent', 'startDateTime'],
    matchKinds: ['other'],
    matchKeywords: ['past calendar', 'past event', 'historical event', 'past calendar event'],
  },
  {
    combination: 'Gmail to Outlook',
    scope: 'outscope',
    name: 'Encrypted Mails',
    description: 'Gmail Confidential Mode encryption is not preserved during migration to Outlook.',
    matchFields: ['encryption', 'sensitivity', 'confidential'],
    matchKinds: ['other'],
    matchKeywords: ['encrypted', 'confidential mode', 'gmail confidential', 'encrypted mail'],
  },
  {
    combination: 'Gmail to Outlook',
    scope: 'outscope',
    name: 'Contact Directory',
    description: 'The contact directory is an organisation-level feature and is not migrated.',
    matchFields: ['contactDirectory', 'directory'],
    matchKinds: ['other'],
    matchKeywords: ['contact directory', 'global address list', 'org directory', 'organisation directory'],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // OUTLOOK TO OUTLOOK — OUTSCOPE (11 features)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    combination: 'Outlook to Outlook',
    scope: 'outscope',
    name: 'Pinned Mails',
    description: 'Pin status is not preserved in the destination Outlook mailbox.',
    matchFields: ['pinned', 'flag', 'followUp'],
    matchKinds: ['other'],
    matchKeywords: ['pinned', 'pin status', 'pinned mail', 'pin flag'],
  },
  {
    combination: 'Outlook to Outlook',
    scope: 'outscope',
    name: 'Group Members',
    description: 'Group members are not migrated in Outlook-to-Outlook migration.',
    matchFields: ['groupMembers', 'members'],
    matchKinds: ['other'],
    matchKeywords: ['group member', 'group membership', 'distribution group member'],
  },
  {
    combination: 'Outlook to Outlook',
    scope: 'outscope',
    name: 'Categories in Mails',
    description: 'Outlook categories are not preserved in Outlook-to-Outlook migration.',
    matchFields: ['categories', 'category'],
    matchKinds: ['other'],
    matchKeywords: ['categories', 'category', 'color category', 'mail category'],
  },
  {
    combination: 'Outlook to Outlook',
    scope: 'outscope',
    name: 'Contact Photos',
    description: 'Contact photos are not migrated in Outlook-to-Outlook migration.',
    matchFields: ['contactPhoto', 'photo'],
    matchKinds: ['other'],
    matchKeywords: ['contact photo', 'contact picture', 'profile photo', 'contact image'],
  },
  {
    combination: 'Outlook to Outlook',
    scope: 'outscope',
    name: 'Contact Categories',
    description: 'Contact category data is not transferred during Outlook-to-Outlook migration.',
    matchFields: ['contactCategory', 'category'],
    matchKinds: ['other'],
    matchKeywords: ['contact categor', 'contact category'],
  },
  {
    combination: 'Outlook to Outlook',
    scope: 'outscope',
    name: 'Contact Directories',
    description: 'Organisation-level contact directories are not migrated in Outlook-to-Outlook migration.',
    matchFields: ['contactDirectory', 'directory'],
    matchKinds: ['other'],
    matchKeywords: ['contact director', 'contact directory', 'global address', 'org contact directory'],
  },
  {
    combination: 'Outlook to Outlook',
    scope: 'outscope',
    name: 'Group Mails',
    description: 'Group mail content is not migrated in Outlook-to-Outlook migration.',
    matchFields: ['groupMail', 'groupEmail'],
    matchKinds: ['other'],
    matchKeywords: ['group mail', 'group email', 'group mailbox content'],
  },
  {
    combination: 'Outlook to Outlook',
    scope: 'outscope',
    name: 'Multiple Delta',
    description: 'Only a single incremental delta is supported; multiple sequential deltas are not handled.',
    matchFields: ['delta', 'incremental'],
    matchKinds: ['other'],
    matchKeywords: ['multiple delta', 'incremental delta', 'multi delta'],
  },
  {
    combination: 'Outlook to Outlook',
    scope: 'outscope',
    name: 'Past Calendar Events',
    description: 'Past calendar events are intentionally excluded from Outlook-to-Outlook migration.',
    matchFields: ['calendarEvent', 'pastEvent'],
    matchKinds: ['other'],
    matchKeywords: ['past calendar', 'past event', 'historical event', 'past calendar event'],
  },
  {
    combination: 'Outlook to Outlook',
    scope: 'outscope',
    name: 'Notes Folder',
    description: 'Notes folder content is excluded from Outlook-to-Outlook migration scope.',
    matchFields: ['folder', 'notes'],
    matchKinds: ['other'],
    matchKeywords: ['notes folder', 'notes', 'outlook notes', 'mapi notes'],
  },
  {
    combination: 'Outlook to Outlook',
    scope: 'outscope',
    name: 'Copy Attachment',
    description: 'Attachments exceeding 36MB are not supported from Outlook as source in O→O migration. Attachment copy behaviour may vary between source and destination.',
    matchFields: ['attachmentCopy', 'attachments'],
    matchKinds: ['attachment', 'other'],
    matchKeywords: ['copy attachment', 'attachment copy', 'attachment behaviour', 'attachment behavior', '36mb', 'attachment size', 'attachment exceeds'],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // GMAIL TO GMAIL — OUTSCOPE (none documented)
  // ═══════════════════════════════════════════════════════════════════════════
  // No outscope features documented for this combination.
];

/**
 * Return the subset of local FEATURES entries matching combination + scope,
 * shaped as the same plain objects the live API returns:
 *   { name, description, matchFields, matchKinds, matchKeywords }
 */
function getLocalFeatures(combination, scope) {
  return FEATURES.filter((f) => f.combination === combination && f.scope === scope);
}

// ── Folder/message-type patterns that are documented as NOT migrated ─────────
// Used to decide if a "not found" message is a known limitation rather than a bug.
// Matched against folder path, subject, or note text.
//
// Covers all documented outscope features for O→G and G→O combinations.
const NOT_MIGRATED_LIMITATION_PATTERNS = [
  // ── O→G outscope ────────────────────────────────────────────────────────────
  { pattern: /legal.?hold/i,
    feature: 'Legal Hold data',
    reason: 'Legal Hold mailboxes are locked by the Microsoft API — messages cannot be read or migrated.' },
  { pattern: /mailbox.?polic/i,
    feature: 'Mailbox Policy',
    reason: 'Mailbox policy set by the Microsoft tenant prevents the migration API from reading these messages.' },
  { pattern: /in.?place.?arch|online.?arch/i,
    feature: 'In-Place Archive',
    reason: 'In-Place Archive is a separate mailbox, not a standard folder — it requires separate migration scope.' },
  { pattern: /conversation.?history|skype|lync/i,
    feature: 'Conversation History',
    reason: 'Conversation History (Skype/Teams/Lync chat history) is not a standard email folder and is excluded from mail migration.' },
  { pattern: /\bnotes?\b/i,
    feature: 'Notes folder',
    reason: 'Outlook Notes are not email content and are excluded from mail migration.' },
  { pattern: /recoverable.?items/i,
    feature: 'Recoverable Items',
    reason: 'Recoverable Items / Purges folder is not accessible via the migration API.' },
  { pattern: /rooms?\b|resources?\b/i,
    feature: 'Rooms / Resources',
    reason: 'Resource mailboxes (Rooms/Equipment) are excluded from user mail migration.' },
  { pattern: /recurring.?series|calendar.*recurring/i,
    feature: 'Calendar recurring series exceptions',
    reason: 'Individual exceptions to recurring calendar series are not migrated — only the master recurrence rule is transferred.' },
  { pattern: /shared.*calendar/i,
    feature: 'Shared calendar',
    reason: 'Shared or delegated calendars are not migrated as part of mailbox mail migration.' },
  { pattern: /to.?do.?list|tasks?\b/i,
    feature: 'To Do list / Tasks',
    reason: 'Outlook Tasks / Microsoft To Do items are not email content and are excluded from mail migration.' },
  // ── G→O outscope ────────────────────────────────────────────────────────────
  { pattern: /scheduled.?email|scheduled.?send/i,
    feature: 'Scheduled emails',
    reason: 'Gmail scheduled emails are system-managed and not migrated until sent.' },
  { pattern: /snoozed/i,
    feature: 'Snoozed emails',
    reason: 'Gmail snoozed emails have no Outlook equivalent and are not migrated.' },
  { pattern: /confidential.?mode|encrypted|gmail.*confidential/i,
    feature: 'Encrypted / Confidential Mode emails',
    reason: 'Gmail Confidential Mode / S-MIME encrypted emails cannot be decrypted and migrated.' },
  { pattern: /all.?mail\b/i,
    feature: 'All Mail',
    reason: 'Gmail "All Mail" is a virtual view, not a real folder — messages appear in their actual labels instead.' },
  { pattern: /past.*calendar|calendar.*past/i,
    feature: 'Past calendar events',
    reason: 'Past calendar events are intentionally excluded from calendar migration by default.' },
  // ── O→O outscope ────────────────────────────────────────────────────────────
  { pattern: /copy.?attachment|36.?mb.*attach|attach.*36.?mb/i,
    feature: 'Copy Attachment (>36MB)',
    reason: 'Attachments exceeding 36MB are not supported from Outlook as source in O→O migration.' },
  {
    combination: 'Outlook to Gmail',
    scope: 'outscope',
    name: 'Notes migration is not preserved',
    description: 'Notes are not migrated when Outlook is used as the source. This is because Notes in Outlook do not contain emails. They are personal notes created by the user and are not part of the mailbox data. The migration process only supports email and mailbox-related items, so Notes are not included in the migration.',
    matchFields: [],
    matchKinds: ['other'],
    matchKeywords: ["notes migration is not preserved","notes","migration","preserved"],
  },
  {
    combination: 'Outlook to Gmail',
    scope: 'outscope',
    name: 'contact lists/groups',
    description: 'Google Contacts does not support contact group structures, meaning there is no feature or equivalent in Google Contacts that can hold or represent a collection of contacts as a group. This is a Google-side limitation that prevents contact groups from being migrated to the destination.',
    matchFields: [],
    matchKinds: ['other'],
    matchKeywords: ["contact lists/groups","contact","lists/groups"],
  },
  {
    combination: 'Outlook to Gmail',
    scope: 'outscope',
    name: 'Attendees will not receive calendar events for past events after migration',
    description: 'When migrating past non-recurring calendar events, attendees will not receive the migrated event on their calendars because these events are intentionally migrated only for the creator/organizer, not for the attendees. Since the event has already occurred and will not repeat in the future, sending calendar invites to attendees\' post-migration would serve no practical purpose and would instead cause confusion by delivering notifications or calendar entries for events that have already passed. To avoid unnecessary disruption and inbox clutter for attendees, the migration tool is designed to restore past, non-recurring events solely to the creator\'s calendar as a historical record, while attendees\' calendars are left unchanged.',
    matchFields: [],
    matchKinds: ['other'],
    matchKeywords: ["attendees will not receive calendar events for past events after migration","attendees","will","receive","calendar","events","past","after","migration"],
  },
  {
    combination: 'Outlook to Gmail',
    scope: 'outscope',
    name: 'In place Achieve',
    description: 'In-Place Archive in Outlook is a secondary mailbox feature in Microsoft 365 (Exchange) that gives users extra storage for older or less frequently accessed emails — without leaving Outlook.',
    matchFields: [],
    matchKinds: ['other'],
    matchKeywords: ["in place achieve","place","achieve"],
  },
  {
    combination: 'Outlook to Gmail',
    scope: 'outscope',
    name: 'Rooms/ Resources',
    description: 'A Room in Outlook Calendar is a resource mailbox that allows users to book and manage meeting rooms automatically, preventing scheduling conflicts.',
    matchFields: [],
    matchKinds: ['other'],
    matchKeywords: ["rooms/ resources","rooms/","resources"],
  },
  {
    combination: 'Outlook to Gmail',
    scope: 'outscope',
    name: 'Calendar — Recurring Series',
    description: 'Modified and deleted occurrences in Outlook recurring series are not preserved in Google Calendar. Outlook stores exceptions within the series, but Google Calendar does not support an equivalent structure.',
    matchFields: [],
    matchKinds: ['other'],
    matchKeywords: ['calendar recurring series', 'calendar', 'recurring', 'series', 'recurring series'],
  },
];

/**
 * Check if a "not found" message matches a known outscope limitation.
 * Returns the limitation object or null.
 *
 * Matching order:
 *   1. Hard-coded regex patterns (NOT_MIGRATED_LIMITATION_PATTERNS)
 *   2. matchKeywords from local FEATURES registry
 *   3. Name/word matching against the merged outscope feature list (live + local)
 */
function matchNotFoundLimitation(mismatch, mergedOutscopeFeatures, combination) {
  const folder  = mismatch.structuredDiffs?.find((d) => d.fieldKey === 'folder')?.sourceExpected || '';
  const subject = String(mismatch.messageSubject || '');
  const note    = String(mismatch.actual || '');
  const blob    = `${folder} ${subject} ${note}`;
  const blobL   = blob.toLowerCase();

  // 1. Check hard-coded regex patterns (e.g. Legal Hold, In-Place Archive)
  for (const item of NOT_MIGRATED_LIMITATION_PATTERNS) {
    if (item.pattern.test(blob)) {
      return { feature: item.feature, reason: item.reason };
    }
  }

  // 2. Check matchKeywords from local FEATURES registry
  const localOutscope = combination
    ? getLocalFeatures(combination, 'outscope')
    : FEATURES.filter((f) => f.scope === 'outscope');

  for (const feat of localOutscope) {
    const keywords = feat.matchKeywords || [];
    if (keywords.some((kw) => blobL.includes(kw.toLowerCase()))) {
      return { feature: feat.name, reason: feat.description || 'Documented platform limitation.' };
    }
  }

  // 3. Name/word matching against the merged feature list (live + local)
  for (const feat of mergedOutscopeFeatures) {
    const name = String(feat.name || '').toLowerCase();
    const blobWords = name.split(' ').filter((w) => w.length > 4);
    if (blobL.includes(name) || blobWords.some((w) => blobL.includes(w))) {
      return { feature: feat.name, reason: feat.description || 'Documented platform limitation.' };
    }
  }

  return null;
}

// ── Main classifier ───────────────────────────────────────────────────────────

/**
 * Classify a single mismatch using the live CloudFuze docs API.
 *
 * @param {object} mismatch    ValidationResult mismatch object
 * @param {string} combination e.g. "Outlook to Gmail"
 * @param {{ outscope: object[], inscope: object[] }} features  Pre-fetched feature lists
 */
function classifyOne(mismatch, combination, features) {
  const field   = String(mismatch.field   || '').toLowerCase();
  const kind    = String(mismatch.kind    || '').toLowerCase();
  const subject = String(mismatch.messageSubject || '').toLowerCase();
  const actual  = String(mismatch.actual  || '').toLowerCase();
  const summary = String(mismatch.summaryLine    || '').toLowerCase();
  const blob    = `${field} ${kind} ${subject} ${actual} ${summary}`;

  // ── Hard rule 0: caller marked this as an EXPECTED outcome of the chosen ────
  // migration options (e.g. Archive folder not migrated because "Archive Mailbox" was OFF).
  // Preserve it as a known limitation instead of re-classifying as a bug.
  if (mismatch.isExpectedOutcome === true) {
    return {
      status:  'known_limitation',
      feature: mismatch.bugFeature || 'Expected (migration option)',
      reason:  mismatch.bugReason || mismatch.summaryLine || 'Expected outcome for the selected migration options.',
    };
  }

  // ── Hard rule 1: folder count mismatches are always migration bugs ─────────
  if (mismatch.category === 'comparison') {
    return {
      status:  'bug',
      feature: 'Folder / Label Structure',
      reason:  'Folder message count mismatch — messages were not migrated to destination.',
    };
  }

  // ── Hard rule 2: message not found in destination ─────────────────────────
  const isNotFound =
    mismatch.category === 'deepMail' &&
    (actual.includes('no gmail message') ||
     actual.includes('no outlook message') ||
     actual.includes('not found') ||
     actual.includes('destination message load failed'));

  if (isNotFound) {
    // Check docs to see if this specific message type is a known outscope case
    const limitation = matchNotFoundLimitation(mismatch, features.outscope, combination);
    if (limitation) {
      return {
        status:  'known_limitation',
        feature: limitation.feature,
        reason:  limitation.reason,
      };
    }
    // No documented reason → migration bug
    return {
      status:  'bug',
      feature: 'Message Migration',
      reason:  'Message was not migrated to destination. No documented outscope reason found — this is a migration bug.',
    };
  }

  // ── Check outscope features (field/metadata limitations) ─────────────────
  // features.outscope is already the merged list (live + local FEATURES).
  // For entries that originated from local FEATURES we also check matchFields
  // and matchKeywords for higher-precision matching.
  for (const feat of features.outscope) {
    const name      = String(feat.name        || '').toLowerCase();
    const nameWords = name.split(/\s+/).filter((w) => w.length > 3);

    // a) name / word match (works for both live and local entries)
    const nameMatch = nameWords.some((w) => blob.includes(w)) || blob.includes(name);

    // b) matchKeywords (local entries only — live entries won't have this field)
    const kwMatch = Array.isArray(feat.matchKeywords) &&
      feat.matchKeywords.some((kw) => blob.includes(kw.toLowerCase()));

    // c) matchFields — check against the mismatch field key
    const fieldMatch = Array.isArray(feat.matchFields) &&
      feat.matchFields.some((f) => field.includes(f.toLowerCase()));

    if (nameMatch || kwMatch || fieldMatch) {
      return {
        status:  'known_limitation',
        feature: feat.name,
        reason:  feat.description || 'Documented platform limitation.',
      };
    }
  }

  // ── Check live inscope features — if matched and failing → bug ────────────
  for (const feat of features.inscope) {
    const name    = String(feat.name        || '').toLowerCase();
    const nameWords = name.split(/\s+/).filter((w) => w.length > 3);
    const matched = nameWords.some((w) => blob.includes(w)) || blob.includes(name);
    if (matched) {
      return {
        status:  'bug',
        feature: feat.name,
        reason:  `"${feat.name}" is inscope for ${combination} — this failure is a real bug.`,
      };
    }
  }

  // ── Unknown: treat as bug by default ─────────────────────────────────────
  return {
    status:  'unknown',
    feature: null,
    reason:  'Feature not found in CloudFuze documentation. Treating as bug pending review.',
  };
}

/**
 * Classify an entire mismatches array.
 * Fetches the live outscope + inscope feature lists once, then classifies each mismatch.
 *
 * @param {object[]} mismatches
 * @param {string}   combination  e.g. "Outlook to Gmail"
 * @returns {Promise<object[]>}   Same array with bugStatus, bugFeature, bugReason added
 */
async function classifyMismatches(mismatches, combination) {
  const [outscope, inscope] = await Promise.all([
    fetchFeatures(combination, 'outscope'),
    fetchFeatures(combination, 'inscope'),
  ]);
  const features = { outscope, inscope };

  return mismatches.map((m) => {
    const result = classifyOne(m, combination, features);
    return { ...m, bugStatus: result.status, bugFeature: result.feature, bugReason: result.reason };
  });
}

/**
 * Derive the combination string from sourceProvider + destinationProvider.
 */
function getCombination(sourceProvider, destinationProvider) {
  const src = String(sourceProvider || '').toLowerCase();
  const dst = String(destinationProvider || '').toLowerCase();
  if (src === 'microsoft' && dst === 'google')    return 'Outlook to Gmail';
  if (src === 'google'    && dst === 'microsoft') return 'Gmail to Outlook';
  if (src === 'microsoft' && dst === 'microsoft') return 'Outlook to Outlook';
  if (src === 'google'    && dst === 'google')    return 'Gmail to Gmail';
  return `${src} to ${dst}`;
}

module.exports = { classifyMismatches, getCombination, FEATURES, getLocalFeatures, saveLastKnown, loadLastKnown };
