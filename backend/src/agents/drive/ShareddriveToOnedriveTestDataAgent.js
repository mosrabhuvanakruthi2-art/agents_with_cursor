/**
 * Source seeding for Google Shared Drive → OneDrive for Business.
 *
 * A thin subclass of DriveTestDataAgent. Everything that agent seeds is still seeded, and then
 * three things are added that this combination needs and the shared agent does not provide:
 *
 *   1. the collaborators are put on the Shared Drive AS MEMBERS  (_ensureDriveMembership)
 *   2. each collaborator is mapped to a destination identity      (_publishPermissionMapping)
 *   3. an item exists at each of the four judged positions        (below)
 *
 * (1) IS THE PERMISSION TEST DATA. What migrates from a Shared Drive is the drive membership,
 * not item ACLs — two full runs (27a74447, 708f4eca) seeded direct item grants to NON-members,
 * both jobs reported PROCESSED 99/99 with every permission option on, and every migrated item
 * arrived carrying only the destination owner. The working drives QA_Team1 and QA_Team2 carry
 * mia:reader, alex:fileOrganizer, qa-group-view:fileOrganizer, qa-group-edit:writer, and the
 * team's migrations from them produced alex@gajha.com:write and mia@gajha.com:read at the
 * destination — their drive roles, applied to each item.
 *
 * WHY A SUBCLASS AND NOT AN EDIT TO DriveTestDataAgent.
 *
 * That agent is shared by googleshareddrive→sharepoint, googledrive→sharepoint and
 * googledrive→onedrive. Its permission scenarios were built for those feature lists, and a measured
 * seed proves they do not cover this one. Reading the freshly seeded tree back:
 *
 *   items carrying a DIRECT comparable grant
 *     [folder] /Permission Matrix/folder_commenter      warner@snapbot.io:commenter
 *     [folder] /Permission Matrix/folder_fileOrganizer  warner@snapbot.io:fileOrganizer
 *     [folder] /Permission Matrix/folder_reader         warner@snapbot.io:reader
 *     [folder] /Permission Matrix/folder_writer         warner@snapbot.io:writer, group:writer
 *
 * Every one is a FOLDER two segments deep, so feature 2.2 (sub-folder) was exercised and 2.1
 * (root folder), 2.3 (root file) and 2.4 (inner file) were not — three of this combination's eight
 * features, and half its permission half, silently unexercised. The only root-level file the agent
 * seeds, `root_readme.txt`, carries no grant at all.
 *
 * Adding those four to the shared agent would change what three other combinations seed and
 * validate. So they are added here instead, where only this combination sees them.
 *
 * WHAT IS SEEDED, and why each one exists:
 *
 *   /00-OneDrive-Perms                      folder, root level  -> 2.1
 *   /00-OneDrive-Perms/Sub-Level            folder, nested      -> 2.2 (deterministic, not borrowed)
 *   /00-root-file-permissions.txt           file,   root level  -> 2.3
 *   /00-OneDrive-Perms/inner-file.txt       file,   nested      -> 2.4
 *
 * Roles are picked to cover the mapping the scope document records rather than to be uniform:
 * writer and reader map cleanly onto OneDrive's `write` and `read`, and commenter is the one that
 * loses information (Microsoft has no comment-only role), so it is seeded deliberately on the inner
 * file where a collapse to `read` is visible rather than hidden among folder inheritance.
 */
const DriveTestDataAgent = require('./DriveTestDataAgent');
const driveClient = require('../../clients/driveClient');
const onedriveClient = require('../../clients/onedriveClient');
const env = require('../../config/env');
const logger = require('../../utils/logger');
const fs = require('fs');
const path = require('path');

const ROOT_PERM_FOLDER = '00-OneDrive-Perms';
const FILES_HOLDER = '00-OneDrive-Perm-Files';
const SUB_PERM_FOLDER = 'Sub-Level';
const ROOT_PERM_FILE = '00-root-file-permissions.txt';
const INNER_PERM_FILE = 'inner-file.txt';

const SAMPLE = 'Seeded by ShareddriveToOnedriveTestDataAgent for scope 2.1-2.4.\n';

class ShareddriveToOnedriveTestDataAgent extends DriveTestDataAgent {
  constructor(name = 'ShareddriveToOnedriveTestDataAgent') {
    super(name);
  }

  async execute(context) {
    const result = await super.execute(context);

    // FIRST, and unconditionally — before any early return below.
    //
    // The base agent has already seeded its permission and link matrices by this point, so their
    // grantees need mapping whatever happens to the four positional grants. Leaving this until
    // after the positional seeding meant a run that could not seed positions also shipped an
    // unmapped migration, losing the matrix grants as well as the positional ones.
    await this._publishPermissionMapping(context, result);

    // THE permission test data for a Shared Drive source. Item-level grants are seeded below
    // as well, but they are secondary: Google absorbs them into membership, and a grant to a
    // non-member does not migrate at all.
    await this._ensureDriveMembership(context, result);

    const sourceEmail = context.sourceEmail;
    const rootId = this.results && this.results.rootFolderId;

    if (!rootId) {
      logger.warn('[ShareddriveToOnedrive] no seeded root folder id — positional permission '
        + 'seeding skipped, so features 2.1-2.4 will report as not exercised');
      return result;
    }

    // FOUR ITEMS, ONE PER POSITION — so 2.1-2.4 each have something of the right shape to judge.
    //
    // The base agent grants only on FOLDERS two segments deep, so without these, 2.1 (root folder),
    // 2.3 (root file) and 2.4 (inner file) have no item at their position at all and read as "not
    // exercised" however well the migration behaved.
    //
    // THE ITEMS MATTER; THE ITEM-LEVEL GRANTS BARELY DO. On a Shared Drive the access that migrates
    // is the drive's MEMBERSHIP (see _ensureDriveMembership), and Google absorbs a member's
    // item-level grant into that membership — every grant on these four items reads
    // `inherited=true` once the collaborators are members. An item grant is still attempted for a
    // principal who happens not to be a member, because a direct grant is extra evidence when it
    // exists, but nothing here depends on one.
    //
    //   /00-OneDrive-Perms             folder, root level   -> 2.1
    //   /00-OneDrive-Perm-Files        plain container
    //     └ Sub-Level                  folder, nested       -> 2.2
    //     └ inner-file.txt             file,   nested       -> 2.4
    //   /00-root-file-permissions.txt  file,   root level   -> 2.3
    const members = await this._driveMembers(rootId, sourceEmail);
    const nonMembers = [...new Set([
      context.nonMemberEmail || env.GOOGLE_TEST_NONMEMBER_EMAIL || '',
      context.externalEmail || env.GOOGLE_TEST_EXTERNAL_EMAIL || '',
    ].map((e) => String(e).trim().toLowerCase()).filter(Boolean))]
      .filter((e) => !members.has(e));

    // Not a warning. With membership seeded correctly this is the EXPECTED state, and the old code
    // treated it as a failure that skipped creating the items — which then cost the positions the
    // very items they are judged on.
    if (nonMembers.length === 0) {
      logger.info('[ShareddriveToOnedrive] no non-member principal available for a direct item '
        + 'grant, which is expected once the collaborators are drive members — the four positional '
        + 'items are still created, and 2.1-2.4 are judged on drive membership reaching them');
    }
    const editor = nonMembers[0] || '';
    const viewer = nonMembers[1] || nonMembers[0] || '';

    try {
      const rootFolder = await this._folder(ROOT_PERM_FOLDER, rootId, sourceEmail);
      await this._grant(rootFolder.id, editor, 'writer', sourceEmail, '2.1 root folder');

      const holder = await this._folder(FILES_HOLDER, rootId, sourceEmail);

      const subFolder = await this._folder(SUB_PERM_FOLDER, holder.id, sourceEmail);
      await this._grant(subFolder.id, viewer, 'reader', sourceEmail, '2.2 sub folder');

      const rootFile = await this._fileOnce(
        ROOT_PERM_FILE, `${SAMPLE}Position: root file (2.3)\n`, rootId, sourceEmail
      );
      await this._grant(rootFile.id, editor, 'writer', sourceEmail, '2.3 root file');

      const innerFile = await this._fileOnce(
        INNER_PERM_FILE, `${SAMPLE}Position: inner file (2.4)\n`, holder.id, sourceEmail
      );
      await this._grant(innerFile.id, viewer, 'commenter', sourceEmail, '2.4 inner file');

      logger.info('[ShareddriveToOnedrive] created an item at all four positions '
        + '(2.1 root folder, 2.2 sub folder, 2.3 root file, 2.4 inner file)');
    } catch (err) {
      this._note(result, 'positional items (scope 2.1-2.4)',
        `Creating the four positional items failed: ${err.message}. Any position left without an `
        + 'item will report as not exercised rather than passing on absent evidence.');
      logger.warn(`[ShareddriveToOnedrive] positional item seeding failed: ${err.message}`);
    }
    return result;
  }

  /** Upload only if absent, so a re-seed does not stack "file (1)" copies beside the last run's. */
  async _fileOnce(name, body, parentId, email) {
    const found = await driveClient.findByName(name, parentId, email).catch(() => null);
    if (found) return found;
    return driveClient.uploadFile(name, 'text/plain', Buffer.from(body), parentId, email);
  }

  /**
   * Tell the migration who every seeded collaborator BECOMES at the destination.
   *
   * THIS IS THE STEP WHOSE ABSENCE COST EVERY PERMISSION VERDICT.
   *
   * Seeding a grant is only half of creating permission test data. CloudFuze builds its
   * permission-mapping CSV from the run's `userEmailMappings` (migrationClient, "Upload OUR
   * permission mapping"), and a run that carries only the migrating pair has told it nothing about
   * the collaborators. It then has no destination identity to grant to, so it drops the grant.
   *
   * Measured on run 27a74447, whose job requested every permission flag
   * (`rootFolderPerms=true rootFilePerms=true innerFolderPerms=true innerFilePerms=true
   * withPermissions=true`) and whose source items carried the grants:
   *
   *     CloudFuze permission mapping CSV uploaded (manualmapping/csv): 1 pair(s)
   *     CloudFuze PERMISSION MAPPING applied to this run (1 user(s)):
   *
   *   -> 21 of 21 grants across all four positions arrived as "no grant for this principal",
   *      every migrated item holding `granger@gajha.com:owner` and nobody else.
   *
   * The QA team's own hand-run migrations into the same OneDrive show the shape a mapped run
   * produces — `/premissions_data/file_example_XLS_50.xls` carries `harry@gajha.com:read
   * alex@gajha.com:write mia@gajha.com:read` — each source collaborator arriving as its counterpart
   * in the destination tenant's own domain. So this was our data, not the product.
   *
   * WHY HERE. This agent is Step 1 and MigrationAgent is Step 2, so a pair added to the context now
   * reaches the CSV the job is built from. Doing it in the validator would be far too late, and
   * doing it in the wizard would ask a human to retype what the seeder already knows.
   *
   * WHAT IS NOT DONE HERE. The migrating pair is never touched: `erik@filefuze.co` resolves by
   * local part to `erik@gajha.com`, and overriding erik -> granger with that would repoint the
   * whole migration. Only principals with no mapping yet are added.
   */
  async _publishPermissionMapping(context, result) {
    const destEmail = String(context.destinationEmail || '').toLowerCase();
    if (!destEmail) return;

    if (!Array.isArray(context.userEmailMappings)) context.userEmailMappings = [];
    const alreadyMapped = new Set(
      context.userEmailMappings
        .map((m) => String(m?.sourceEmail || '').toLowerCase())
        .filter(Boolean)
    );

    // Every principal that ends up holding a grant on the seeded tree: the two this agent uses for
    // positions 2.1-2.4, and the ones DriveTestDataAgent's permission and link matrices use. All of
    // them need mapping, because the matrix items are validated for 2.2 and 2.4 as well.
    const candidates = [...new Set([
      context.nonMemberEmail || env.GOOGLE_TEST_NONMEMBER_EMAIL || '',
      context.editorEmail || env.GOOGLE_TEST_EDITOR_EMAIL || '',
      context.viewerEmail || env.GOOGLE_TEST_VIEWER_EMAIL || '',
      context.externalEmail || env.GOOGLE_TEST_EXTERNAL_EMAIL || '',
      ...String(context.groupEmail || env.GOOGLE_TEST_GROUP_EMAIL || '').split(','),
    ].map((e) => String(e).trim().toLowerCase()).filter(Boolean))];

    // AN EXPLICIT MAPPING BEATS LOCAL-PART MATCHING, and for groups it is the only thing that
    // works. `group-mapping.csv` at the repo root already records what the team uses:
    //
    //   qa-group-view@filefuze.co   -> mia@gajha.com
    //   qa-group-edit@filefuze.co   -> alex@gajha.com
    //   qa-group-manage@filefuze.co -> dan@gajha.com
    //
    // A GROUP MAPS TO A USER, which local-part matching can never find: there is no principal
    // called "qa-group-view" in the destination tenant, so the seeder reported all three as
    // having no counterpart and skipped them on every run. That warning was wrong, and it was
    // wrong about the three principals holding drive-level roles.
    const explicit = this._readGroupMapping();

    const added = [];
    const unmapped = [];
    for (const source of candidates) {
      if (alreadyMapped.has(source)) continue;
      const override = explicit.get(source);
      const hit = override
        ? { address: override, kind: 'explicit', exact: true }
        : await onedriveClient.resolveCounterpart(source, destEmail).catch(() => null);
      if (!hit) {
        unmapped.push({ source, reason: 'no principal with this local part exists in the '
          + 'destination tenant' });
        continue;
      }
      context.userEmailMappings.push({ sourceEmail: source, destinationEmail: hit.address });
      alreadyMapped.add(source);
      added.push({ source, dest: hit.address, kind: hit.kind, internal: hit.exact });
    }

    for (const a of added) {
      logger.info(`[ShareddriveToOnedrive] permission mapping: ${a.source} -> ${a.dest}`
        + ` (${a.kind}${a.internal ? '' : ', NOT in the destination domain'})`);
    }
    if (added.length > 0) {
      logger.info(`[ShareddriveToOnedrive] added ${added.length} collaborator pair(s) to the run's `
        + 'permission mapping — without these the migration has no destination identity to grant to '
        + 'and drops every grant');
    }

    // Recorded on the result, not just logged. A grantee with no counterpart is a fact about the
    // test accounts that the validator must be able to state — otherwise its grant reads as a
    // product defect, which is exactly the wrong verdict.
    const target = (result && result.data) || this.results || {};
    target.permissionMapping = { added, unmapped };
    if (unmapped.length > 0) {
      logger.warn(`[ShareddriveToOnedrive] ${unmapped.length} seeded grantee(s) have no `
        + `destination counterpart and CANNOT migrate: ${unmapped.map((u) => u.source).join(', ')}`
        + ' — create matching principals in the destination tenant, or accept that grants to them '
        + 'are not evidence about the product');
      this._note(result, 'permission mapping',
        `${unmapped.map((u) => u.source).join(', ')} have no principal with the same local part in `
        + `${destEmail.split('@')[1]}, so CloudFuze has nobody to grant to and their grants cannot `
        + 'arrive. Grants to them are not evidence about the migration.');
    }
  }

  /**
   * Source -> destination pairs the team maintains by hand, from `group-mapping.csv`.
   *
   * Kept as a file rather than env vars because it is data the QA team edits, and it already
   * existed in the repo before this combination did. Absent or unreadable is not an error: the
   * caller falls back to local-part matching, which is right for ordinary users.
   *
   * @returns {Map<string,string>} lowercased source address -> destination address
   */
  _readGroupMapping() {
    const out = new Map();
    const file = path.join(__dirname, '..', '..', '..', '..', 'group-mapping.csv');
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return out;
    }
    for (const line of raw.split(/\r?\n/).slice(1)) {
      const [src, dst] = line.split(',').map((x) => String(x || '').trim().toLowerCase());
      if (src && dst) out.set(src, dst);
    }
    if (out.size > 0) {
      logger.info(`[ShareddriveToOnedrive] group-mapping.csv: ${out.size} explicit pair(s)`);
    }
    return out;
  }
  /**
   * Put the test collaborators on the Shared Drive AS MEMBERS. This is the permission test data.
   *
   * THE PREVIOUS APPROACH WAS BUILT ON A WRONG MODEL, and it is worth recording why, because the
   * wrong model is the intuitive one.
   *
   * It granted item-level roles to principals chosen for NOT being drive members — because Google
   * absorbs a member's item grant into their drive membership, and a direct grant is what a
   * validator can see. That produced exactly the grants the old validator wanted to read, and data
   * that could not migrate. Two full runs proved it: 27a74447 and 708f4eca both seeded direct
   * non-member grants, both jobs reported PROCESSED 99/99 with every permission option enabled and
   * the permission mapping forced onto destination identities, and every migrated item arrived
   * carrying `granger@gajha.com:owner` and nobody else. Fifty minutes later, still nothing.
   *
   * What migrates from a Shared Drive is the DRIVE'S MEMBERSHIP. Measured on the working drives:
   *
   *   QA_Team1   mia:reader  alex:fileOrganizer  qa-group-view:fileOrganizer  qa-group-edit:writer
   *   QA_Team2   mia:reader  alex:fileOrganizer  qa-group-view:commenter      qa-group-edit:writer
   *
   * and in the destination OneDrive those runs produced `alex@gajha.com:write mia@gajha.com:read`
   * on the migrated items — their DRIVE roles mapped through the role table, applied at every
   * position. A drive whose only member is the migrating user has nothing to migrate, which is what
   * `QA-SharedDrive-To-OneDrive` looked like when it was created by hand.
   *
   * So this seeds membership, mirroring the drives that work, and does NOT try to create direct
   * item-level grants: once these principals are members, Google reports every item grant as
   * `inherited=true` anyway. Raising a member's role on one item is not a way around it either —
   * `permissions.create` answered "Cannot set the requested role for that user as they lack the
   * necessary license" for mia, so the higher-role-on-an-item trick is not available on these
   * accounts.
   *
   * Idempotent: an existing member is left exactly as they are. Re-running must not quietly change
   * a role someone else's run is relying on.
   */
  async _ensureDriveMembership(context, result) {
    const sourceEmail = context.sourceEmail;
    const driveId = this.results && this.results.sharedDrive && this.results.sharedDrive.id;
    if (!driveId) {
      logger.warn('[ShareddriveToOnedrive] no Shared Drive id on the seed result — membership not '
        + 'checked, so features 2.1-2.4 may report as not exercised');
      return;
    }

    // Roles copied from QA_Team1, not invented: mia low so a `read` outcome is observable, alex
    // high so an `edit` outcome is, and the two groups so a group grant is part of the population
    // the scope document says it should be.
    const WANT = [
      { email: context.viewerEmail || env.GOOGLE_TEST_VIEWER_EMAIL, role: 'reader', type: 'user' },
      { email: context.editorEmail || env.GOOGLE_TEST_EDITOR_EMAIL, role: 'fileOrganizer', type: 'user' },
      ...String(context.groupEmail || env.GOOGLE_TEST_GROUP_EMAIL || '').split(',')
        .map((g) => String(g).trim())
        .filter(Boolean)
        .map((g, i) => ({ email: g, role: i === 0 ? 'fileOrganizer' : 'writer', type: 'group' })),
    ].filter((w) => w.email);

    const existing = new Map();
    try {
      const perms = await driveClient.listPermissions(driveId, sourceEmail);
      for (const g of (perms && perms.grants) || []) {
        if (g.email || g.name) existing.set(String(g.email || g.name).toLowerCase(), g.role);
      }
    } catch (err) {
      logger.warn(`[ShareddriveToOnedrive] could not read drive membership: ${err.message}`);
    }

    const added = [];
    const failed = [];
    for (const w of WANT) {
      const who = String(w.email).toLowerCase();
      if (existing.has(who)) continue;
      try {
        // permissions.create directly, because driveClient.shareFile hardcodes `type: 'user'`
        // and two of these principals are GROUPS. driveClient is shared by three other
        // combinations, so a group-capable helper is not added there for this one caller.
        const api = await driveClient.getDriveClient(sourceEmail);
        await api.permissions.create({
          fileId: driveId,
          requestBody: { type: w.type, role: w.role, emailAddress: w.email },
          fields: 'id,role,type',
          sendNotificationEmail: false,
          supportsAllDrives: true,
        });
        added.push(`${w.email}:${w.role}`);
        existing.set(who, w.role);
      } catch (err) {
        failed.push(`${w.email} (${err.message})`);
      }
    }

    const roster = [...existing.entries()].map(([e, r]) => `${e}:${r}`).join(', ');
    logger.info(`[ShareddriveToOnedrive] drive membership: ${roster}`);
    if (added.length > 0) {
      logger.info(`[ShareddriveToOnedrive] added ${added.length} drive member(s): ${added.join(', ')}`
        + ' — a Shared Drive migrates its membership, so without these there is no permission for '
        + 'features 2.1-2.4 to judge');
    }
    if (failed.length > 0) {
      logger.warn(`[ShareddriveToOnedrive] could not add ${failed.length} member(s): ${failed.join('; ')}`);
      this._note(result, 'drive membership (scope 2.1-2.4)',
        `Could not add ${failed.join('; ')} as drive member(s). A Shared Drive migrates its `
        + 'membership, so any position judged only by these principals will report as not '
        + 'exercised rather than passing on absent evidence.');
    }

    const target = (result && result.data) || this.results || {};
    target.driveMembership = [...existing.entries()].map(([email, role]) => ({ email, role }));
  }

  /**
   * Who already has access through DRIVE membership rather than through this item.
   *
   * Read off the seeded root folder rather than the drive object: every drive-level member shows up
   * there as an inherited grant carrying `inheritedFrom = <drive id>`, which is exactly the set a
   * new item-level grant would be absorbed into.
   */
  async _driveMembers(rootId, sourceEmail) {
    const out = new Set();
    try {
      const perms = await driveClient.listPermissions(rootId, sourceEmail);
      for (const g of (perms && perms.grants) || []) {
        if (g.inherited && g.email) out.add(String(g.email).toLowerCase());
      }
    } catch (err) {
      // An unreadable membership list must not silently become "nobody is a member", which would
      // pick a grantee whose grant then vanishes into inheritance.
      logger.warn(`[ShareddriveToOnedrive] could not read drive membership: ${err.message}`);
    }
    return out;
  }

  /** Find or create a folder, so a re-seed does not stack duplicates beside the last run's. */
  async _folder(name, parentId, email) {
    const found = await driveClient.findByName(name, parentId, email).catch(() => null);
    if (found) return found;
    return driveClient.createFolder(name, parentId, email);
  }

  /**
   * Grant one role, and record a refusal instead of letting it pass silently.
   *
   * A grant the source refuses must be visible: the alternative is a validator later marking the
   * feature as passing on evidence that was never created, which is worse than a failure.
   */
  async _grant(fileId, email, role, ownerEmail, label) {
    if (!email) return;
    try {
      await driveClient.shareFile(fileId, email, role, ownerEmail);
      logger.info(`[ShareddriveToOnedrive] ${label}: granted ${role} to ${email}`);
    } catch (err) {
      // NOT rethrown. The item-level grant is secondary evidence — the access that migrates
      // from a Shared Drive is its membership — so a refused grant must not abort the creation
      // of the remaining positional items, which is what 2.1-2.4 actually need.
      logger.info(`[ShareddriveToOnedrive] ${label}: no direct grant to ${email} (${err.message})`
        + ' — the position is still judged on drive membership');
    }
  }

  /** Attach a not-seeded note to whatever shape the base agent returned. */
  _note(result, feature, reason) {
    const target = (result && result.data) || this.results || {};
    if (!Array.isArray(target.notSeeded)) target.notSeeded = [];
    target.notSeeded.push({ feature, reason });
  }
}

module.exports = ShareddriveToOnedriveTestDataAgent;
module.exports.ROOT_PERM_FOLDER = ROOT_PERM_FOLDER;
module.exports.FILES_HOLDER = FILES_HOLDER;
module.exports.SUB_PERM_FOLDER = SUB_PERM_FOLDER;
module.exports.ROOT_PERM_FILE = ROOT_PERM_FILE;
module.exports.INNER_PERM_FILE = INNER_PERM_FILE;
