'use strict';

/**
 * Google Drive DESTINATION-side validation agent — the Google counterpart of
 * agents/sharepoint/SharePointValidationAgent.js.
 *
 * Same reasoning as that file: every combination that lands in Google should answer "how do we read
 * Google" in exactly one place. Google is the first non-Microsoft destination in this repo (added for
 * the Dropbox → Google combinations), so this is where its destination behaviour lives.
 *
 * This class owns the DESTINATION half only:
 *   - resolving the destination root (My Drive, or a named Shared Drive)
 *   - finding where a migrated folder actually landed
 *   - reading the tree, permissions, link permissions, revisions, timestamps and file bytes
 *
 * The SOURCE half — which cloud the data came from, its roles, its mime types — stays in the
 * per-combination file under validation/combinations/content/, as CONTRIBUTING requires.
 *
 * Subclass it, don't edit it for one combination:
 *   class DropboxToGoogledriveValidationAgent extends GoogleDriveValidationAgent
 *
 * Four Google-specific facts drive most of what follows, and each has bitten a SharePoint-shaped
 * assumption:
 *
 *   1. **My Drive's root id is the literal string 'root'**, while a Shared Drive's root id IS the
 *      drive id. One code path, two kinds of id.
 *   2. **Permissions are per-file, not inherited from a folder** the way SharePoint's are. A file
 *      inside a shared folder carries its own permission entries, so reading the folder alone
 *      reports nothing about its children.
 *   3. **A "link" is a permission**, not a separate object: `type: 'anyone'` or `type: 'domain'` in
 *      the same permissions list as user grants. Filtering those out of the user comparison is
 *      mandatory, or every anyone-with-link file reads as an unexpected extra grant.
 *   4. **Native Google docs report no meaningful size and cannot be downloaded** — they must be
 *      exported to a concrete format. Hashing one against its source bytes is not possible.
 */

const ContentReportValidationAgent = require('../content/ContentReportValidationAgent');
const driveClient = require('../../clients/driveClient');
const core = require('../../validation/shared/deepContentCore');
const logger = require('../../utils/logger');

/** How many "name N" / "name (N)" dedup variants to probe when CloudFuze appends a counter. */
const DEDUP_MAX = 5;

/** Google's own MIME type for a folder. */
const FOLDER_MIME = 'application/vnd.google-apps.folder';

/**
 * Permission `type` values that describe a LINK rather than a person or group.
 *
 * `anyone`  — "Anyone with the link"      (Dropbox scope 3.1)
 * `domain`  — "<organisation>"            (Dropbox scope 3.2, shown as the org's name)
 */
const LINK_PERMISSION_TYPES = new Set(['anyone', 'domain']);

class GoogleDriveValidationAgent extends ContentReportValidationAgent {
  constructor(name = 'GoogleDriveValidationAgent') {
    super(name);
  }

  /**
   * Resolve where the migration landed on the Google side.
   *
   * `destinationProvider` decides the shape:
   *   - `googledrive`       → My Drive, rootId 'root', no driveId
   *   - `googleshareddrive` → a Shared Drive resolved BY NAME, rootId = driveId = the drive's id
   *
   * Returns `{ rootId, driveId, label }`. Throws when a named Shared Drive cannot be found, because
   * validating against the wrong root would compare the source with an unrelated tree and report
   * every item missing — a failure that looks like a migration defect but is a configuration error.
   */
  async resolveDestinationRoot(context) {
    const email = context.destinationEmail;
    const provider = String(context.destinationProvider || 'googledrive').toLowerCase();

    if (provider === 'googleshareddrive') {
      const name = String(
        context.destinationSharedDriveName || context.destinationFolderName || ''
      ).trim();
      if (!name) {
        throw new Error(
          'Destination is a Google Shared Drive but no drive name was supplied. Set the run\'s '
          + 'destination folder/drive name — a Shared Drive cannot be resolved without it.'
        );
      }
      const drive = await driveClient.resolveSharedDriveByName(name, email);
      if (!drive) {
        const available = await driveClient.listSharedDrives(email).catch(() => []);
        throw new Error(
          `Google Shared Drive "${name}" not found for ${email}. Available: `
          + (available.map((d) => d.name).join(', ') || '(none)')
        );
      }
      // A Shared Drive's id doubles as its root folder id.
      return { rootId: drive.id, driveId: drive.id, label: `Shared Drive "${drive.name}"` };
    }

    return { rootId: 'root', driveId: null, label: 'My Drive' };
  }

  /**
   * Find the folder the migration actually created under the destination root.
   *
   * CloudFuze may land the content under the source folder's name, under a configured destination
   * folder name, or with a dedup counter appended when something of that name already existed.
   * Probing the variants here means a renamed landing folder does not read as "everything missing".
   *
   * @returns {{ id, name, path }|null} null when nothing plausible exists — the caller reports that
   *   as an empty destination rather than throwing, because "the migration created nothing" is a
   *   real and reportable outcome.
   */
  async findMigratedRoot(rootId, driveId, destBase, sourceFolderName, email) {
    const base = String(destBase || '').trim();
    const opts = { rootId, driveId };

    // An explicit destination path wins when it resolves.
    if (base && base !== '/') {
      const hit = await driveClient.resolveFolderByPath(base, email, opts).catch(() => null);
      if (hit) return hit;
    }

    const name = String(sourceFolderName || '').trim();
    if (!name) {
      // No name to look for: the destination root itself is the comparison root.
      return { id: rootId, name: '(destination root)', path: '/' };
    }

    const candidates = [name];
    for (let i = 1; i <= DEDUP_MAX; i++) {
      candidates.push(`${name} ${i}`, `${name} (${i})`);
    }

    for (const candidate of candidates) {
      const found = await driveClient.findByName(candidate, rootId, email).catch(() => null);
      if (found) return { id: found.id, name: found.name, path: `/${found.name}` };
    }
    return null;
  }

  /**
   * The destination tree, with paths relativized to the migrated root so it compares to the source.
   *
   * `driveClient.buildFolderTree` already returns this repo's canonical item shape, so no
   * normalisation happens here — which is the point of having one destination agent.
   */
  async readTree(rootFolderId, email, opts = {}) {
    const { driveId = null, maxDepth = 25, rootPath = '' } = opts;
    const raw = await driveClient.buildFolderTree(rootFolderId, email, { driveId, maxDepth });
    return rootPath ? core.relativize(raw, rootPath) : raw;
  }

  /**
   * Permissions on one item, split into people and links.
   *
   * Splitting is not a convenience — it is required for correctness. In Drive a shared link IS a
   * permission entry (`type: 'anyone'` / `'domain'`), so leaving them in the user list makes every
   * link look like an extra grant to an unknown principal, and every user comparison then reports a
   * discrepancy it should not.
   *
   * Never throws: an unreadable item reads as empty, which the caller reports rather than mistaking
   * for a pass.
   *
   * @returns {{ permissions: Array, links: Array }}
   *   permissions — [{ email, roles: [], principalType, displayName }] in the shape
   *                 deepContentCore.comparePermissions expects
   *   links       — [{ scope, type, role }] in the shape compareSharedLinks expects
   */
  async readPermissions(fileId, email) {
    let raw;
    try {
      raw = await driveClient.listPermissions(fileId, email);
    } catch (err) {
      logger.warn(`[GoogleDriveValidationAgent] could not read permissions for ${fileId}: ${err.message}`);
      return { permissions: [], links: [] };
    }

    const permissions = [];
    const links = [];

    for (const p of Array.isArray(raw) ? raw : []) {
      const type = String(p.type || '').toLowerCase();
      const role = String(p.role || '').toLowerCase();

      if (LINK_PERMISSION_TYPES.has(type)) {
        links.push({
          // 'anonymous'/'organization' is the vocabulary the shared comparator and the
          // dropbox_to_google role map both speak, so translate Google's wording once, here.
          scope: type === 'anyone' ? 'anonymous' : 'organization',
          type: role === 'writer' || role === 'organizer' || role === 'fileorganizer' ? 'edit' : 'view',
          role,
          // Google reports the org's display name for a domain link (e.g. "Sync Orbit"). Kept for
          // the report only — matching is always on SCOPE, never on this string, because it differs
          // per tenant.
          domain: p.domain || null,
        });
        continue;
      }

      permissions.push({
        email: String(p.emailAddress || '').toLowerCase(),
        displayName: p.displayName || '',
        roles: [role],
        principalType: type === 'group' ? 'group' : 'user',
        deleted: Boolean(p.deleted),
      });
    }

    return { permissions, links };
  }

  /** Items directly in one folder. Never throws — an unreadable folder reads as empty. */
  async listChildren(folderId, email, driveId = null) {
    return driveClient.listChildrenDetailed(folderId, email, driveId).catch(() => []);
  }

  /**
   * Revision count for one item.
   *
   * Reported, not judged, for the Dropbox pair: scope 9.2 makes the expected count a JOB SETTING,
   * and 10.19 records that a migrated Paper's history is created during migration rather than
   * carried over. Never throws.
   */
  async readVersionCount(fileId, email) {
    const revs = await driveClient.listRevisions(fileId, email).catch(() => []);
    return Array.isArray(revs) ? revs.length : 0;
  }

  /**
   * One destination file, split into non-empty lines.
   *
   * This is how the CSV reports CloudFuze writes into the destination are read (Dropbox scope 3.1,
   * 3.2, 8.1 and the out-of-scope in-line comments). Those are ordinary files — there is no special
   * API for them, a point worth restating because two features on another combination were marked
   * "not automated — no API for the CSV" while the files sat in the destination the whole time.
   *
   * A CSV that CloudFuze wrote as a Google Sheet is exported rather than downloaded, since a native
   * doc cannot be downloaded directly.
   */
  async readTextLines(item, email) {
    const fileId = typeof item === 'string' ? item : item?.id;
    const mimeType = typeof item === 'string' ? null : item?.mimeType;
    if (!fileId) return [];
    try {
      const buf = core.isGoogleNative(mimeType)
        ? await driveClient.exportNativeFile(fileId, 'text/csv', email)
        : await driveClient.downloadFile(fileId, email);
      return buf.toString('utf8').split(/\r?\n/).filter((l) => l.trim() !== '');
    } catch (err) {
      logger.warn(`[GoogleDriveValidationAgent] could not read ${fileId}: ${err.message}`);
      return [];
    }
  }

  /**
   * File bytes for Tier B hashing. Throws — `tierBHashes` turns the failure into a reported skip.
   *
   * A native Google doc has no original bytes to hash: it must be exported, and the export is a
   * NEW rendering whose bytes will never equal the source's. So this refuses rather than returning
   * export bytes that would produce a guaranteed, meaningless hash mismatch.
   */
  async readContent(item, email) {
    const fileId = typeof item === 'string' ? item : item?.id;
    const mimeType = typeof item === 'string' ? null : item?.mimeType;
    if (core.isGoogleNative(mimeType)) {
      throw new Error(
        'native Google doc — no original bytes exist to hash; an export is a new rendering and '
        + 'could never match the source hash'
      );
    }
    return driveClient.downloadFile(fileId, email);
  }

  /**
   * Scope 6.1 — suppress email notifications, judged from the Google side.
   *
   * Deliberately NOT implemented as a mailbox scan. The SharePoint agent can read the destination
   * user's Outlook inbox over Graph, but the Google equivalent needs Gmail scopes on the destination
   * account, which the content flow does not request. Rather than guess, this reports that the check
   * was not performed and says what it would take — the alternative is a check that silently always
   * passes, which is worse than an honest gap.
   *
   * @returns {{ ok: false, leaks: [], error: string }}
   */
  async findSharingNotifications() {
    return {
      ok: false,
      leaks: [],
      error:
        'Not checked: verifying suppressed notifications on a Google destination requires Gmail '
        + 'read scope on the destination account, which the content flow does not request. Feature '
        + '6.1 must be confirmed manually, and is reported as NOT VERIFIED rather than as a pass.',
    };
  }

  /** True for a Drive folder. */
  static isFolder(item) {
    return item?.mimeType === FOLDER_MIME || item?.type === 'folder';
  }
}

module.exports = GoogleDriveValidationAgent;
module.exports.DEDUP_MAX = DEDUP_MAX;
module.exports.FOLDER_MIME = FOLDER_MIME;
module.exports.LINK_PERMISSION_TYPES = LINK_PERMISSION_TYPES;
