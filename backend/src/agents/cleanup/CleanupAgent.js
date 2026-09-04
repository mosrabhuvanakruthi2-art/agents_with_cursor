const { BaseAgent } = require('../core/BaseAgent');
const outlookClient = require('../../clients/outlookClient');
const gmailClient   = require('../../clients/gmailClient');
const logger        = require('../../utils/logger');
const env           = require('../../config/env');
const { normalizeDriveName } = require('../../utils/driveNames');

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
  // DESTINATION-ONLY, and created by CloudFuze rather than migrated from the source: when a path
  // exceeds SharePoint's 400-character limit the content is relocated into "Long File Names" beside
  // the migrated root, and a .url placeholder is left behind. It is our own run's output, so it has
  // to be cleaned like the rest — left in place it survived every run, the next migration relocated
  // into it again, and the copies stacked up as "… 1", "… 2".
  //
  // It never exists in the SOURCE (verified: both Shared Drive roots hold only the seeded root),
  // so source cleanup cannot match it by accident. Destination cleanup only ever scans the library
  // root and each row's own destination folder, so the blast radius is this run's own test area.
  'Long File Names',

  // Dropbox → Google seeded tree, from the paths DropboxTestDataAgent actually creates rather
  // than guessed names. Without these the destination allowlist matched nothing, so a Google
  // destination was never cleaned and every run migrated on top of the last.
  '01-Root-Folder-Permissions', '02-root-file-editor.txt', '02-root-file-viewer.txt',
  '03-File-Formats', '04-Shared-Links', '05-External-Shares', '06-Metadata-Timestamps',
  '07-Special-Characters', '08-Long-Paths', '09-Embedded-Links', '10-Versions',
  // 12-Delta is seeded only on a delta run, so a live tree does not always show it. Listed
  // anyway: cleanup must remove whatever the agent CAN create, not just what one run happened
  // to leave behind. Caught by the cross-check in dropboxTeamSpacePath.test.js.
  '12-Delta',
  // The permission matrix and the access-mode folder. Numbered 13/14 because 06 and 07 are already
  // 06-Metadata-Timestamps and 07-Special-Characters. Both are seeded on every run, so leaving them
  // off the allowlist meant cleanup skipped them and each run migrated on top of the last —
  // the same defect the Google destination branch above was added to fix.
  '13-Permission-Matrix', '14-Access-Mode',
  // 11-Paper holds the hand-authored Dropbox Paper doc. It is PRESERVED at the SOURCE
  // (DROPBOX_PRESERVE_ON_WIPE) because Paper cannot be re-seeded by API — but the DESTINATION copy
  // is an ordinary migrated artefact and must be cleaned like any other. Leaving it off this list
  // meant run 85a41244 found TWO folders named 11-Paper at the destination, one per run, which the
  // structure check then reported as extra items.
  '11-Paper',
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
      // EVERY drive the run touches, not just GOOGLE_SHARED_DRIVE_NAME.
      //
      // Reading the env var alone meant a two-drive run only ever emptied the folder in the FIRST
      // drive. The second drive's folder kept the previous run's data and gained the new seed on top,
      // so its source held every folder twice — run c4722d01 measured 24 children in QA_Team2 against
      // 12 in QA_Team1. The migration then faithfully copied the duplicates, and validation reported
      // 14 missing / 11 extra / 73 misplaced against a migration that had done nothing wrong.
      //
      // An empty id set means "no drive filter" (My Drive), which is the pre-existing behaviour.
      const driveIds = new Set();
      if (srcProvider === 'googleshareddrive') {
        const wantedDrives = [...new Set([
          ...(Array.isArray(context.contentUserFolders) ? context.contentUserFolders : [])
            .map((u) => normalizeDriveName(u && u.sourceDriveName)),
          ...(Array.isArray(context.userFolderMappings) ? context.userFolderMappings : [])
            .map((u) => normalizeDriveName(u && u.sourceDriveName)),
          normalizeDriveName(context.sourceSharedDriveName),
          normalizeDriveName(env.GOOGLE_SHARED_DRIVE_NAME),
        ].filter(Boolean))];
        for (const name of wantedDrives) {
          try {
            const drive = await driveClient.resolveSharedDriveByName(name, context.sourceEmail);
            if (drive) driveIds.add(drive.id);
            else log.warn(`CleanupAgent: Shared Drive "${name}" not visible — nothing to clean there`);
          } catch (dErr) {
            summary.sourceContent.errors.push(`resolve drive ${name}: ${dErr.message}`);
          }
        }
        log.info(`CleanupAgent: source drives in play: ${wantedDrives.map((n) => `"${n}"`).join(', ')} `
          + `(${driveIds.size} resolved)`);
      }
      const roots = (await Promise.all(folderNames.map((n) => driveClient.findFoldersByName(n, context.sourceEmail))))
        .flat()
        .filter((h) => (driveIds.size > 0 ? driveIds.has(h.driveId) : true));
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
  // Destination: Google My Drive / Shared Drive, under the same allowlist rule as SharePoint.
  //
  // This did not exist: `sharepoint` was the ONLY destination branch, so a googledrive or
  // googleshareddrive destination was never cleaned. Every re-run migrated on top of the previous
  // one, and validation then reported the leftovers as extra/misplaced against a migration that
  // had done nothing wrong — the same failure this file's header records for the source side
  // (70 extra, 260 misplaced on one run).
  //
  // The blast radius is deliberately narrow, because a Shared Drive here can be one the wider
  // team uses: only allowlisted names are deleted, only inside the run's own destination folder,
  // and the destination folder itself is kept — it may have pre-dated this run.
  if (['googledrive', 'googleshareddrive'].includes(dstProvider) && context.destinationEmail) {
    try {
      const destPaths = [...new Set([
        ...(Array.isArray(context.contentUserFolders) ? context.contentUserFolders : [])
          .map((u) => u && u.destinationPath),
        context.destinationPath,
      ].map((x) => String(x || '').trim()).filter(Boolean))];

      if (destPaths.length === 0) {
        log.info('CleanupAgent: no destination path in context — nothing to clean on the Google side');
      }

      for (const destPath of destPaths) {
        const segments = destPath.split('/').map((x) => x.trim()).filter(Boolean);
        if (segments.length === 0) {
          // A drive root with no folder named. Refused rather than scanned: the destination
          // account sees 1,000+ Shared Drives, and a whole-drive scan here would put other
          // teams' data inside the blast radius.
          log.warn(`CleanupAgent: destination "${destPath}" names no folder — skipped, refusing to `
            + 'scan a drive root');
          continue;
        }

        // Resolve the root the way GoogleDriveValidationAgent does: for a Shared Drive the FIRST
        // path segment IS the drive, resolved by name.
        let parentId = null;
        let startAt = 0;
        if (dstProvider === 'googleshareddrive') {
          const driveName = normalizeDriveName(segments[0]);
          let drive = null;
          try {
            drive = await driveClient.resolveSharedDriveByName(driveName, context.destinationEmail);
          } catch (dErr) {
            summary.destContent.errors.push(`resolve dest drive ${driveName}: ${dErr.message}`);
            continue;
          }
          if (!drive) {
            log.info(`CleanupAgent: destination Shared Drive "${driveName}" not visible — nothing `
              + 'to clean there');
            continue;
          }
          parentId = drive.id;
          startAt = 1;                        // segment 0 was the drive itself
        } else {
          parentId = 'root';                  // My Drive
        }

        // Walk to this run's own destination folder. A segment that does not exist yet is the
        // normal first-run case, not an error.
        let missing = false;
        for (let i = startAt; i < segments.length; i += 1) {
          const kids = await driveClient.listChildren(parentId, context.destinationEmail);
          const hit = kids.find((k) => String(k.name) === segments[i]);
          if (!hit) {
            log.info(`CleanupAgent: destination "${destPath}" — "${segments[i]}" does not exist `
              + 'yet, nothing to clean');
            missing = true;
            break;
          }
          parentId = hit.id;
        }
        if (missing) continue;

        const children = await driveClient.listChildren(parentId, context.destinationEmail);
        const targets = children.filter((k) => isSeededContentName(k.name, folderNames));
        log.info(`CleanupAgent: destination "${destPath}" has ${children.length} item(s); `
          + `${targets.length} seeded item(s) to delete, ${children.length - targets.length} `
          + 'left untouched');
        for (const t of targets) {
          try {
            await driveClient.deleteFile(t.id, context.destinationEmail);
            summary.destContent.foldersDeleted += 1;
          } catch (err) {
            summary.destContent.errors.push(`${destPath}/${t.name}: ${err.message}`);
          }
        }
      }
      log.info(`CleanupAgent: deleted ${summary.destContent.foldersDeleted} destination item(s) `
        + `across ${destPaths.length} location(s)`);
    } catch (err) {
      summary.destContent.errors.push(err.message);
      log.warn(`CleanupAgent: Google destination cleanup failed (non-blocking): ${err.message}`);
    }
  }
  // Destination: delete only the seeded/migrated items, by allowlist.
  if (dstProvider === 'sharepoint' && context.destinationEmail) {
    try {
      const deepContentCore = require('../../validation/shared/deepContentCore');
      const site = await sharepointClient.getSite(env.SHAREPOINT_HOSTNAME, env.SHAREPOINT_SITE_PATH, context.destinationEmail);

      // A multi-drive run puts each source drive in its own destination sub-folder, so the seeded
      // tree is no longer at the library root — it is at "/QA_Team1/Agent Shared Drive". Scanning
      // only the root would leave every previous run's data in place and the next run would then
      // migrate on top of it, which is what produced 70 extra / 260 misplaced items on an earlier
      // run. So scan the root AND each row's destination folder.
      //
      // Read from contentUserFolders, not userFolderMappings: cleanup runs BEFORE seeding, and the
      // mappings do not exist yet at this point.
      const destRoots = [...new Set([
        '/',
        ...(Array.isArray(context.contentUserFolders) ? context.contentUserFolders : [])
          .map((u) => deepContentCore.inDrivePath(u && u.destinationPath))
          .filter((p) => p && p !== '/'),
      ])];

      for (const base of destRoots) {
        let children;
        try {
          children = await sharepointClient.listFolderChildren(site.id, base, context.destinationEmail);
        } catch (listErr) {
          // A destination folder that does not exist yet is the normal case on a first run.
          log.info(`CleanupAgent: destination "${base}" not readable (${listErr?.response?.status || listErr.message}) — nothing to clean there`);
          continue;
        }
        const targets = children.filter((k) => isSeededContentName(k.name, folderNames));
        log.info(`CleanupAgent: destination "${base}" has ${children.length} item(s); ${targets.length} seeded `
          + `item(s) to delete, ${children.length - targets.length} left untouched`);
        // The wrapper folder itself is deliberately NOT deleted — it may have existed before this
        // run with unrelated content. Only names on the seeded allowlist are removed.
        for (const t of targets) {
          const path = `${base === '/' ? '' : base}/${t.name}`;
          try {
            await sharepointClient.deleteItemByPath(site.id, path, context.destinationEmail);
            summary.destContent.foldersDeleted += 1;
          } catch (err) {
            summary.destContent.errors.push(`${path}: ${err.message}`);
          }
        }
      }
      log.info(`CleanupAgent: deleted ${summary.destContent.foldersDeleted} destination item(s) across ${destRoots.length} location(s)`);
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