'use strict';

/**
 * SharePoint DESTINATION-side validation agent — the content counterpart of
 * agents/outlook/OutlookValidationAgent.js.
 *
 * Mail already works this way: every combination that lands in Outlook shares one destination-side
 * agent, so "how do we read Outlook" is answered in exactly one place. Content had no equivalent —
 * each SharePoint combination re-implemented site resolution, the migrated-root probe, and the
 * permission/version/content reads. Two combinations doing that independently is two combinations
 * that can drift apart in what they believe SharePoint does.
 *
 * This class owns the DESTINATION half only:
 *   - resolving the site
 *   - finding where a migrated folder actually landed (renames, dedup counters)
 *   - reading the tree, permissions, links, versions, timestamps and file bytes
 *
 * The SOURCE half — which cloud the data came from, its roles, its mime types — stays in the
 * per-combination file under validation/combinations/content/, as CONTRIBUTING requires.
 *
 * Subclass it, don't edit it for one combination:
 *   class GoogledriveToSharepointValidationAgent extends SharePointValidationAgent
 */

const ContentReportValidationAgent = require('../content/ContentReportValidationAgent');
const sharepointClient = require('../../clients/sharepointClient');
const outlookClient = require('../../clients/outlookClient');
const core = require('../../validation/shared/deepContentCore');
const env = require('../../config/env');
const logger = require('../../utils/logger');

/** How many "name N" dedup variants to probe when CloudFuze appends a counter. */
const DEDUP_MAX = 5;

/** Subjects Microsoft 365 uses when a file or folder is shared (features 9.1 / 9.2). */
const SHARING_MAIL_SUBJECT =
  /shared\s+(a\s+)?(file|folder|document)|shared\s+".*"\s+with\s+you|has\s+shared|invited\s+you\s+to/i;

class SharePointValidationAgent extends ContentReportValidationAgent {
  constructor(name = 'SharePointValidationAgent') {
    super(name);
  }

  /**
   * Resolve the destination site.
   * @param {object} context
   * @param {string|null} [siteHint] site named by the migration destination path. When present it
   *   wins over SHAREPOINT_SITE_PATH: validating the configured site while the data went to a
   *   different one compares two unrelated places and reads as a clean miss.
   * @returns {{ siteId: string|null, hostname: string, sitePath: string, check: object }}
   *   `check` is a ready-to-push row so every combination reports site access identically.
   */
  async resolveSite(context, siteHint = null) {
    const configuredHost = context.sharepointHostname || env.SHAREPOINT_HOSTNAME;
    const configuredPath = context.sharepointSitePath || env.SHAREPOINT_SITE_PATH;
    const email = context.destinationEmail;

    const normName = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const configuredName = normName(String(configuredPath || '').split('/').filter(Boolean).pop());
    const hintName = normName(siteHint);
    const sitePath = configuredPath;

    // The destination path names a different site than the configured one — resolve that site instead.
    if (hintName && hintName !== configuredName) {
      const tried = [];
      let searchError = null;
      // Direct path lookups first: /sites/{slug} needs only the read permission the run already
      // uses, whereas the search endpoint needs Sites.Read.All and 403s without it. The slug is not
      // the display name (SharePoint drops spaces), so the plausible forms are each probed.
      const bare = String(siteHint).trim();
      const slugs = [...new Set([bare.replace(/[ ]+/g, ''), bare.replace(/[ ]+/g, '-'), bare])];
      for (const prefix of ['/sites', '/teams']) {
        for (const slug of slugs) {
          const candidate = `${prefix}/${slug}`;
          tried.push(candidate);
          try {
            const site = await sharepointClient.getSite(configuredHost, candidate, email);
            if (site?.id) {
              logger.info(`[SharePoint] destination path names site "${siteHint}" — validating ${candidate}`);
              return {
                siteId: site.id,
                hostname: configuredHost,
                sitePath: candidate,
                check: {
                  name: 'SharePoint site accessible',
                  status: 'PASS',
                  detail: `${configuredHost}${candidate} — resolved from the migration destination `
                    + `path "${siteHint}" (SHAREPOINT_SITE_PATH is ${configuredPath})`,
                },
              };
            }
          } catch { /* 404 for a slug that does not exist — try the next form */ }
        }
      }
      try {
        const found = await sharepointClient.findSiteByName(siteHint, email);
        if (found?.id) {
          const hostname = String(found.webUrl || '').replace(/^https?:[/][/]/, '').split('/')[0] || configuredHost;
          const foundPath = `/${String(found.webUrl || '').split('/').slice(3).join('/')}`;
          logger.info(`[SharePoint] destination path names site "${siteHint}" — validating ${found.webUrl} `
            + `instead of the configured ${configuredPath}`);
          return {
            siteId: found.id,
            hostname,
            sitePath: foundPath,
            check: {
              name: 'SharePoint site accessible',
              status: 'PASS',
              detail: `${found.webUrl} — resolved from the migration destination path "${siteHint}" `
                + `(SHAREPOINT_SITE_PATH is ${configuredPath})`,
            },
          };
        }
      } catch (err) {
        // 403 here means the app has no Sites.Read.All — say so, rather than reporting 'not found'.
        searchError = err;
        logger.warn(`[SharePoint] site search for "${siteHint}" failed: ${err.message}`);
      }
      // Falling through to the configured site would validate somewhere the data never went.
      return {
        siteId: null,
        hostname: configuredHost,
        sitePath: configuredPath,
        check: {
          name: 'SharePoint site accessible',
          status: 'FAIL',
          detail: `The migration wrote to site "${siteHint}", which could not be reached for ${email}. `
            + `Tried ${tried.join(', ')}`
            + (searchError ? `; name search failed (${searchError.response?.status || searchError.message})`
              + ' — grant Sites.Read.All to let the site be found by name' : '; name search returned no match')
            + `. Refusing to validate the configured site ${configuredPath} instead — it is a different site.`,
        },
      };
    }

    const attempt = async (hostname) => {
      const site = await sharepointClient.getSite(hostname, sitePath, email);
      return site?.id ? { siteId: site.id, hostname } : null;
    };

    let firstError = null;
    try {
      const hit = await attempt(configuredHost);
      if (hit) {
        return {
          ...hit,
          sitePath,
          check: { name: 'SharePoint site accessible', status: 'PASS', detail: `${hit.hostname}${sitePath}` },
        };
      }
    } catch (err) {
      firstError = err;
    }

    // The configured hostname may belong to a different tenant than the destination account — that
    // returns an opaque Graph 400 that looks like a permissions problem. Ask Graph for the account's
    // own SharePoint hostname and retry the same site path before giving up.
    try {
      const discovered = await sharepointClient.resolveTenantHostname(email);
      if (discovered && discovered !== configuredHost) {
        const hit = await attempt(discovered);
        if (hit) {
          logger.warn(`[SharePoint] configured hostname "${configuredHost}" did not resolve for ${email}; `
            + `used the account's own tenant hostname "${discovered}" instead. Set SHAREPOINT_HOSTNAME to it.`);
          return {
            ...hit,
            sitePath,
            check: {
              name: 'SharePoint site accessible',
              status: 'PASS',
              detail: `${hit.hostname}${sitePath} (configured "${configuredHost}" did not resolve — `
                + 'this account\'s tenant hostname was used instead)',
            },
          };
        }
        return {
          siteId: null,
          hostname: configuredHost,
          sitePath,
          check: {
            name: 'SharePoint site accessible',
            status: 'FAIL',
            detail: `neither "${configuredHost}${sitePath}" nor "${discovered}${sitePath}" resolved for `
              + `${email}. The account's tenant serves SharePoint at "${discovered}" — check the site path.`,
          },
        };
      }
    } catch (err) {
      logger.warn(`[SharePoint] could not read the tenant hostname for ${email}: ${err.message}`);
    }

    return {
      siteId: null,
      hostname: configuredHost,
      sitePath,
      check: {
        name: 'SharePoint site accessible',
        status: 'FAIL',
        detail: firstError ? firstError.message : 'getSite returned no id',
      },
    };
  }

  /**
   * Find where a migrated source folder actually landed.
   *
   * CloudFuze may rename it (SharePoint-invalid characters → `_` or `-`) and may append a counter
   * when a folder of that name already exists, so the expected path is probed in order:
   * unchanged → each sanitized form → "name 1".."name N".
   *
   * @param {string} siteId
   * @param {string} destBase          path within the drive the folder should sit under
   * @param {string} sourceFolderName  '' for a whole-account/root migration
   * @param {string} email             destination account
   * @returns {{ item: object|null, path: string|null, renameNote: string }}
   */
  async findMigratedRoot(siteId, destBase, sourceFolderName, email) {
    // Whole-account migration: items land directly under the destination path.
    if (!sourceFolderName) {
      const path = destBase || '/';
      const item = await sharepointClient.getFolderItem(siteId, path, email).catch(() => null);
      // Return null when the destination root genuinely could not be read — substituting a
      // placeholder here made the caller report "Destination location: PASS" for a path it never
      // found.
      return { item: item || null, path: item ? path : null, renameNote: '' };
    }

    const candidates = [core.joinPath(destBase, sourceFolderName)];
    for (const replacement of ['_', '-']) {
      const renamed = core.sanitizeForSharePoint(sourceFolderName, replacement);
      if (renamed !== sourceFolderName) candidates.push(core.joinPath(destBase, renamed));
    }
    const baseRenamed = core.sanitizeForSharePoint(sourceFolderName, '_');
    for (let n = 1; n <= DEDUP_MAX; n++) {
      candidates.push(core.joinPath(destBase, `${baseRenamed} ${n}`));
    }

    const noteFor = (item) => (
      /[ ][0-9]+$/.test(item.name) && core.normKey(item.name) !== core.normKey(sourceFolderName)
        ? ' (CloudFuze appended a counter — a folder of that name already existed)'
        : ''
    );

    // More than one candidate can exist at once: a failed run leaves an empty shell behind, and the
    // next run lands its content in "<name> 1". Returning the first match would then compare against
    // the empty shell and report a migration that worked as a total loss. So when several exist, the
    // one holding content is the migrated root — an empty one is accepted only when it is the only
    // candidate, because a genuinely empty migration must still be reported as empty.
    const found = [];
    for (const candidate of candidates) {
      const item = await sharepointClient.getFolderItem(siteId, candidate, email).catch(() => null);
      if (item) found.push({ item, path: candidate, renameNote: noteFor(item) });
    }
    if (found.length === 0) return { item: null, path: null, renameNote: '' };
    if (found.length === 1) return found[0];

    for (const hit of found) {
      const children = await sharepointClient
        .listFolderChildren(siteId, hit.path, email)
        .catch(() => []);
      if (children.length === 0) continue;
      if (hit.path !== found[0].path) {
        logger.info(`[SharePoint] ${found.length} candidate roots exist; "${found[0].path}" is empty, `
          + `using "${hit.path}" which holds ${children.length} item(s)`);
      }
      return hit;
    }
    return found[0];
  }

  /** The destination tree, with paths relativized to the migrated root so it compares to the source. */
  async readTree(siteId, rootPath, email, maxDepth) {
    const raw = await sharepointClient.buildFolderTree(siteId, rootPath, email, maxDepth);
    return core.relativize(raw, rootPath);
  }

  /** Permissions and link permissions on one item. Never throws — an unreadable item reads as empty. */
  async readPermissions(siteId, itemPath, email) {
    return sharepointClient.getItemPermissions(siteId, itemPath, email)
      .catch(() => ({ permissions: [], links: [] }));
  }

  /** Items directly in one folder. Never throws — an unreadable folder reads as empty. */
  async listChildren(siteId, folderPath, email) {
    return sharepointClient.listFolderChildren(siteId, folderPath, email).catch(() => []);
  }

  /**
   * One destination file, split into non-empty lines.
   *
   * Used for the CSV reports CloudFuze writes into the library root (features 5.16 / 6.2). Those
   * were long reported as "no API for the CSV" — there is no special API, they are ordinary items
   * and read like any other file. Never throws: an unreadable report reads as empty, which the
   * caller reports rather than mistaking for a pass.
   */
  async readTextLines(siteId, itemPath, email) {
    try {
      const buf = await sharepointClient.downloadItemContent(siteId, itemPath, email);
      return buf.toString('utf8').split(/\r?\n/).filter((l) => l.trim() !== '');
    } catch (err) {
      logger.warn(`[SharePointValidationAgent] could not read ${itemPath}: ${err.message}`);
      return [];
    }
  }

  /** Version count for one item. Never throws. */
  async readVersionCount(siteId, itemPath, email) {
    const res = await sharepointClient.getItemVersions(siteId, itemPath, email)
      .catch(() => ({ totalVersions: 0 }));
    return Number(res?.totalVersions) || 0;
  }

  /** File bytes for Tier B hashing. Throws — tierBHashes turns the failure into a reported skip. */
  async readContent(siteId, itemPath, email) {
    return sharepointClient.downloadItemContent(siteId, itemPath, email);
  }

  /**
   * Features 9.1 / 9.2 — suppress email notifications.
   *
   * After a migration with suppression on, the destination user must have received NO SharePoint
   * sharing or invitation mail. Mail from the SOURCE side (sent when the permission was originally
   * granted) is expected and is not a suppression failure, so only destination-side notifications
   * count, and only those that arrived at or after the run started.
   *
   * @returns {{ ok: boolean, leaks: string[], error: string|null }}
   */
  async findSharingNotifications(destinationEmail, startedAtIso) {
    try {
      const messages = await outlookClient.getMessages(destinationEmail, 'inbox', 100);
      const startedAt = Date.parse(startedAtIso || '') || null;
      const leaks = (messages || []).filter((m) => {
        const subject = String(m.subject || '');
        const from = String(m.from?.emailAddress?.address || '').toLowerCase();
        const isSharingMail = SHARING_MAIL_SUBJECT.test(subject) || from.endsWith('@sharepointonline.com');
        if (!isSharingMail) return false;
        if (!startedAt) return true;
        const received = Date.parse(m.receivedDateTime || '');
        return Number.isNaN(received) ? true : received >= startedAt;
      }).map((m) => `"${m.subject}" from ${m.from?.emailAddress?.address || 'unknown'} at ${m.receivedDateTime}`);

      return { ok: true, leaks, error: null };
    } catch (err) {
      logger.warn(`[SharePointValidationAgent] could not read ${destinationEmail}'s mailbox: ${err.message}`);
      return { ok: false, leaks: [], error: err.message };
    }
  }
}

module.exports = SharePointValidationAgent;
module.exports.DEDUP_MAX = DEDUP_MAX;
module.exports.SHARING_MAIL_SUBJECT = SHARING_MAIL_SUBJECT;
