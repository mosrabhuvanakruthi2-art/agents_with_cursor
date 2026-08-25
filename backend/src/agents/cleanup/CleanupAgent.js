const { BaseAgent } = require('../core/BaseAgent');
const outlookClient = require('../../clients/outlookClient');
const gmailClient   = require('../../clients/gmailClient');
const logger        = require('../../utils/logger');
const env           = require('../../config/env');

/**
 * Full-wipe helpers for Outlook accounts.
 * These delete EVERY rule/setting — not just QA-prefixed ones — so the mailbox
 * starts from an absolute zero state before each migration run.
 *
 * Outlook full wipe covers:
 *   • All inbox rules (Settings → Mail → Rules)
 *   • All OWA conditional formatting rules (Settings → Mail → Conditional formatting)
 *   • All search folders (Settings → Mail → Search folders)
 *   • All messages, custom folders, calendar events, recoverable items  ← via cleanMailbox()
 *
 * Gmail full wipe covers:
 *   • All messages (including Spam & Trash)
 *   • All drafts
 *   • All custom labels
 *   • All calendar events / owned calendars
 *   • All Gmail filters (Settings → Filters and Blocked Addresses)  ← step 5 in cleanGmailMailbox()
 */
async function wipeOutlookSettings(email, log) {
  log.info(`CleanupAgent [${email}]: wiping ALL Outlook settings (inbox rules, conditional formatting, search folders)...`);

  try {
    const n = await outlookClient.deleteAllInboxRules(email);
    log.info(`CleanupAgent [${email}]: deleted ${n} inbox rule(s)`);
  } catch (err) {
    log.warn(`CleanupAgent [${email}]: inbox rules wipe failed (non-blocking): ${err.message}`);
  }

  try {
    await outlookClient.deleteAllConditionalFormattingRules(email);
    log.info(`CleanupAgent [${email}]: conditional formatting rules cleared`);
  } catch (err) {
    log.warn(`CleanupAgent [${email}]: conditional formatting wipe failed (non-blocking): ${err.message}`);
  }

  try {
    const n = await outlookClient.deleteAllSearchFolders(email);
    log.info(`CleanupAgent [${email}]: deleted ${n} search folder(s)`);
  } catch (err) {
    log.warn(`CleanupAgent [${email}]: search folders wipe failed (non-blocking): ${err.message}`);
  }
}

/**
 * Folder and file names DriveTestDataAgent seeds. Content cleanup deletes ONLY these (and the
 * " 1"…" N" copies CloudFuze creates when a name is already taken), so anything else at the
 * destination — another team's folder, CloudFuze's own report files — is never touched.
 */
const SEEDED_CONTENT_NAMES = [
  'Agent Files', 'Agent Native Files', 'Agent Permissions', 'Agent Versions',
  'Agent Shared Links', 'Permission Matrix', 'Shared Link Matrix', 'File Formats',
  'Long Folder Path', 'Over Limit Path', 'root_readme.txt',
];

/** True when `name` is a seeded item, or a counter/duplicate copy of one. */
/**
 * @param {string} name              item name at the destination
 * @param {string|string[]} roots    the migrated root folder name(s) actually in use
 */
function isSeededContentName(name, roots) {
  const rootNames = (Array.isArray(roots) ? roots : [roots])
    .map((r) => String(r || '').trim())
    .filter(Boolean);
  const base = String(name || '')
    .replace(/ \d+$/, '')                          // "Agent Files 3"      -> "Agent Files"
    .replace(/\(\d+\)(\.[A-Za-z0-9]+)$/, '$1');     // "root_readme(2).txt" -> "root_readme.txt"
  if (rootNames.includes(base)) return true;
  if (SEEDED_CONTENT_NAMES.includes(base)) return true;
  if (/^Long Name Folder A+$/.test(base)) return true;   // the 200-character folder
  // Must require actual special characters between the words. /^Special .*Folder$/ also matched a
  // folder literally named "Special Folder", which could belong to anyone — a false positive here
  // deletes someone else's data.
  if (/^Special [^A-Za-z0-9 ]+ Folder$/.test(base)) return true;
  return false;
}

/**
 * Content cleanup — the Drive/SharePoint equivalent of the mailbox wipes above.
 *
 * This did not exist. The orchestrator skipped CleanupAgent for content entirely, on the stated
 * grounds that there was "no test data to clean", and /api/agents/clean-content supports Box only.
 * So every content run seeded on top of the last and migrated on top of the last migration: the
 * source grew 316 -> 395 -> 474 items, the destination accumulated `Agent Files`, `Agent Files 1`
 * … `Agent Files 4` holding identical files, and validation attributed all of it to the migration
 * as "extra" and "misplaced" (70 extra, 260 misplaced on one run). None were real defects.
 */
async function cleanContentSides(context, log, summary) {
  const driveClient = require('../../clients/driveClient');
  const sharepointClient = require('../../clients/sharepointClient');

  const srcProvider = String(context.sourceProvider || '').toLowerCase();
  const dstProvider = String(context.destinationProvider || '').toLowerCase();
  // The wizard leaves the BASE folder empty when every user has a per-user override — the summary
  // screen shows "Agent Box Data" there only as a placeholder. Reading context.sourceFolderName
  // alone therefore found nothing to clean on exactly the runs that needed cleaning. Gather every
  // folder name actually in play.
  const folderNames = [...new Set([
    ...(Array.isArray(context.contentUserFolders) ? context.contentUserFolders : [])
      .map((u) => u && u.sourceFolderName),
    ...(Array.isArray(context.userFolderMappings) ? context.userFolderMappings : [])
      .map((u) => u && u.sourcePath && String(u.sourcePath).replace(/^\/+/, '')),
    context.sourceFolderName,
  ].map((n) => String(n || '').trim()).filter(Boolean))];
  if (folderNames.length === 0) {
    log.info('CleanupAgent: no source folder name in context — skipping content cleanup');
    return;
  }
  log.info(`CleanupAgent: content roots in play: ${folderNames.map((n) => `"${n}"`).join(', ')}`);

  // Refuse to clean while another execution is still seeding the same source account. In run
  // f51cb73c a prior run was mid-seed when this cleanup deleted the folder underneath it, and its
  // remaining uploads failed with "File not found: <parent id>" — 9 unseeded scenarios instead of
  // the usual 6. Cleaning is an optimisation; corrupting a live run is not worth it.
  try {
    const executionService = require('../../services/executionService');
    const clash = executionService.getAll()
      // Field names matter here: the record uses `executionId`, and the source account lives on
      // the nested `context`, not at the top level.
      .filter((e) => e.executionId !== context.executionId
        && e.status === 'RUNNING'
        && String((e.context && e.context.sourceEmail) || '').toLowerCase()
          === String(context.sourceEmail || '').toLowerCase());
    if (clash.length > 0) {
      log.warn(`CleanupAgent: ${clash.length} other execution(s) still RUNNING on `
        + `${context.sourceEmail} (${clash.map((e) => e.executionId).join(', ')}) — skipping content cleanup `
        + 'so their seeding is not deleted mid-flight');
      summary.sourceContent.errors.push('skipped: concurrent execution on the same source account');
      return;
    }
  } catch (err) {
    log.warn(`CleanupAgent: could not check for concurrent executions (${err.message}) — continuing`);
  }

  // Source: EMPTY the seeded root, do not delete it.
  //
  // Deleting and recreating the root gives it a NEW Drive folder id on every run, which churns the
  // id that CloudFuze is asked to migrate. Emptying keeps the id stable across runs while still
  // giving each run clean data, and DriveTestDataAgent already does find-or-create on the root
  // (DriveTestDataAgent.js:208) so it refills the same folder.
  //
  // Do NOT read this as the cure for the 0-pairs problem. It was first written on the theory that
  // the delete invalidated a CloudFuze-side path cache; probe job 6a8c86a6 disproved that — the
  // mapping came back mapped=false with both pathRootFolderId null against a folder that had
  // existed, untouched, for 28 minutes. No run in logs/ has ever had mapped=true. Stable ids are
  // worth having on their own; the mapping failure is a separate, still-open problem.
  if (['googledrive', 'googleshareddrive'].includes(srcProvider) && context.sourceEmail) {
    try {
      let driveId = null;
      if (srcProvider === 'googleshareddrive') {
        const drive = await driveClient.resolveSharedDriveByName(env.GOOGLE_SHARED_DRIVE_NAME, context.sourceEmail);
        driveId = drive ? drive.id : null;
      }
      const roots = (await Promise.all(folderNames.map((n) => driveClient.findFoldersByName(n, context.sourceEmail))))
        .flat()
        .filter((h) => (driveId ? h.driveId === driveId : true));
      for (const root of roots) {
        const children = await driveClient.listChildren(root.id, context.sourceEmail);
        for (const child of children) {
          try {
            await driveClient.deleteFile(child.id, context.sourceEmail);
            summary.sourceContent.itemsDeleted += 1;
          } catch (err) {
            summary.sourceContent.errors.push(`${child.name}: ${err.message}`);
          }
        }
        summary.sourceContent.foldersEmptied += 1;
        log.info(`CleanupAgent: emptied source folder "${root.name}" (${root.id}) — `
          + `${children.length} child item(s) removed, folder kept so CloudFuze keeps resolving it`);
      }
      if (roots.length === 0) {
        log.info(`CleanupAgent: no source folder matching ${folderNames.join(' / ')} — seeding will create it`);
      }
    } catch (err) {
      summary.sourceContent.errors.push(err.message);
      log.warn(`CleanupAgent: source content cleanup failed (non-blocking): ${err.message}`);
    }
  }
  // Destination: delete only the seeded/migrated items, by allowlist.
  if (dstProvider === 'sharepoint' && context.destinationEmail) {
    try {
      const site = await sharepointClient.getSite(env.SHAREPOINT_HOSTNAME, env.SHAREPOINT_SITE_PATH, context.destinationEmail);
      const root = await sharepointClient.listFolderChildren(site.id, '/', context.destinationEmail);
      const targets = root.filter((k) => isSeededContentName(k.name, folderNames));
      log.info(`CleanupAgent: destination root has ${root.length} item(s); ${targets.length} seeded `
        + `item(s) to delete, ${root.length - targets.length} left untouched`);
      for (const t of targets) {
        try {
          await sharepointClient.deleteItemByPath(site.id, `/${t.name}`, context.destinationEmail);
          summary.destContent.foldersDeleted += 1;
        } catch (err) {
          summary.destContent.errors.push(`${t.name}: ${err.message}`);
        }
      }
      log.info(`CleanupAgent: deleted ${summary.destContent.foldersDeleted} destination item(s)`);
    } catch (err) {
      summary.destContent.errors.push(err.message);
      log.warn(`CleanupAgent: destination content cleanup failed (non-blocking): ${err.message}`);
    }
  }
}

/**
 * CleanupAgent — wipes EVERYTHING from source and destination test accounts
 * before each run so every migration starts from a complete zero state.
 *
 * Outlook source/destination: inbox rules + CF rules + search folders THEN
 *   all messages, custom folders, calendar events, recoverable items.
 *
 * Gmail source/destination: all messages, drafts, custom labels,
 *   calendar events, and Gmail filters (complete nil account).
 *
 * Set context.skipCleanup = true to opt out for a single run.
 */
class CleanupAgent extends BaseAgent {
  constructor() {
    super('CleanupAgent');
  }

  async execute(context) {
    const log = logger.child({ agent: this.name, executionId: context.executionId });

    if (context.skipCleanup === true) {
      log.info('CleanupAgent: skipped (context.skipCleanup=true)');
      return { skipped: true };
    }

    const summary = {
      sourceOutlook: { messagesDeleted: 0, foldersDeleted: 0, eventsDeleted: 0, errors: [] },
      destGmail:     { messagesDeleted: 0, foldersDeleted: 0, eventsDeleted: 0, errors: [] },
      sourceContent: { foldersEmptied: 0, itemsDeleted: 0, errors: [] },
      destContent:   { foldersDeleted: 0, errors: [] },
    };

    // Content runs clean files and folders, not mailboxes. Falling through to the mail branches
    // below would be actively wrong: for a content run sourceProvider is 'googleshareddrive', so
    // `!isOutlookSrc` is true and the Gmail branch would wipe the source account's entire MAILBOX.
    if (context.mode === 'content') {
      log.info('CleanupAgent: content run — cleaning seeded folders on both sides');
      await cleanContentSides(context, log, summary);
      return summary;
    }

    const isOutlookSrc = context.sourceProvider === 'microsoft';
    const isGmailDst   = context.destinationProvider === 'google';

    // ── Source cleanup ────────────────────────────────────────────────────────
    if (isOutlookSrc && context.sourceEmail) {
      log.info(`CleanupAgent: FULL WIPE — Outlook source: ${context.sourceEmail} (all mail, rules, CF rules, search folders)`);
      // Wipe settings BEFORE messages so rules cannot fire during cleanup
      await wipeOutlookSettings(context.sourceEmail, log);
      try {
        const result = await outlookClient.cleanMailbox(context.sourceEmail);
        summary.sourceOutlook.messagesDeleted = result.messagesDeleted || 0;
        summary.sourceOutlook.foldersDeleted  = result.foldersDeleted  || 0;
        summary.sourceOutlook.eventsDeleted   = result.eventsDeleted   || 0;
        summary.sourceOutlook.errors.push(...(result.errors || []));
      } catch (err) {
        summary.sourceOutlook.errors.push(err.message);
        log.warn(`CleanupAgent: Outlook source wipe error (non-blocking): ${err.message}`);
      }
      outlookClient.clearFolderCache(context.sourceEmail);

      // Delete all M365 Groups whose displayName starts with 'QA ' (tenant-level cleanup)
      try {
        const groupsDeleted = await outlookClient.deleteQAGroups(context.sourceEmail);
        log.info(`CleanupAgent [${context.sourceEmail}]: deleted ${groupsDeleted} QA M365 group(s)`);
      } catch (err) {
        log.warn(`CleanupAgent [${context.sourceEmail}]: QA groups cleanup failed (non-blocking): ${err.message}`);
      }

    } else if (!isOutlookSrc && context.sourceEmail) {
      // Gmail source (Gmail→Outlook or Gmail→Gmail)
      // cleanGmailMailbox performs a full wipe incl. filters (step 5)
      log.info(`CleanupAgent: FULL WIPE — Gmail source: ${context.sourceEmail} (all mail, labels, calendar, filters)`);
      try {
        const result = await gmailClient.cleanGmailMailbox(context.sourceEmail);
        summary.sourceOutlook.messagesDeleted = result.messagesDeleted || 0;
        summary.sourceOutlook.foldersDeleted  = result.foldersDeleted  || 0;
        summary.sourceOutlook.eventsDeleted   = result.eventsDeleted   || 0;
        summary.sourceOutlook.errors.push(...(result.errors || []));
      } catch (err) {
        summary.sourceOutlook.errors.push(err.message);
        log.warn(`CleanupAgent: Gmail source wipe error (non-blocking): ${err.message}`);
      }
    }

    // ── Destination cleanup ───────────────────────────────────────────────────
    if (isGmailDst && context.destinationEmail) {
      // cleanGmailMailbox performs a full wipe incl. filters (step 5)
      log.info(`CleanupAgent: FULL WIPE — Gmail destination: ${context.destinationEmail} (all mail, labels, calendar, filters)`);
      try {
        const result = await gmailClient.cleanGmailMailbox(context.destinationEmail);
        summary.destGmail.messagesDeleted = result.messagesDeleted || 0;
        summary.destGmail.foldersDeleted  = result.foldersDeleted  || 0;
        summary.destGmail.eventsDeleted   = result.eventsDeleted   || 0;
        summary.destGmail.errors.push(...(result.errors || []));
      } catch (err) {
        summary.destGmail.errors.push(err.message);
        log.warn(`CleanupAgent: Gmail destination wipe error (non-blocking): ${err.message}`);
      }

    } else if (!isGmailDst && context.destinationEmail) {
      // Outlook destination (Gmail→Outlook or Outlook→Outlook)
      log.info(`CleanupAgent: FULL WIPE — Outlook destination: ${context.destinationEmail} (all mail, rules, CF rules, search folders)`);
      await wipeOutlookSettings(context.destinationEmail, log);
      try {
        const result = await outlookClient.cleanMailbox(context.destinationEmail);
        summary.destGmail.messagesDeleted = result.messagesDeleted || 0;
        summary.destGmail.foldersDeleted  = result.foldersDeleted  || 0;
        summary.destGmail.eventsDeleted   = result.eventsDeleted   || 0;
        summary.destGmail.errors.push(...(result.errors || []));
      } catch (err) {
        summary.destGmail.errors.push(err.message);
        log.warn(`CleanupAgent: Outlook destination wipe error (non-blocking): ${err.message}`);
      }
      outlookClient.clearFolderCache(context.destinationEmail);
    }

    log.info(
      `CleanupAgent done (COMPLETE NIL STATE) — ` +
      `source: ${summary.sourceOutlook.messagesDeleted} msgs, ${summary.sourceOutlook.foldersDeleted} folders, ${summary.sourceOutlook.eventsDeleted} events | ` +
      `dest: ${summary.destGmail.messagesDeleted} msgs, ${summary.destGmail.foldersDeleted} folders, ${summary.destGmail.eventsDeleted} events`
    );
    return summary;
  }
}

module.exports = CleanupAgent;
// Exported for tests: this predicate decides what content cleanup DELETES, so it is pinned.
module.exports.isSeededContentName = isSeededContentName;
module.exports.SEEDED_CONTENT_NAMES = SEEDED_CONTENT_NAMES;