/**
 * ShareFile → SharePoint role and link-scope translation.
 *
 * Per `data/feature-scope/sharefile-to-sharepoint-inscope.md`, section 2.
 *
 * ── Where this table comes from, and why that matters ──────────────────────────────────────────
 *
 * It is MEASURED, not published. The feature document still lists four permission features — root
 * folder, sub-folder, group and external shares — and still gives no role mapping table, which is
 * why this file compared nothing until 2026-09-12.
 *
 * The mapping below was read off a completed migration: the seeder plants a permission ladder of
 * five access levels for a user and a group, and the destination was then read back per rung.
 * Source flags on the left, the SharePoint role that actually arrived on the right:
 *
 *     CanView                                               → read
 *     CanView+CanUpload                                     → write
 *     CanView+CanUpload+CanDownload                         → write
 *     CanView+CanUpload+CanDownload+CanDelete               → write
 *     CanView+CanUpload+CanDownload+CanDelete+CanManage…    → write
 *
 * Identical at root level and sub level, and stable across rungs. So the rule is simply: VIEW ONLY
 * becomes Read, and any write-ish flag becomes Edit.
 *
 * ── The mapping is LOSSY, and the checks are written to admit it ───────────────────────────────
 *
 * Five source access levels collapse into two destination roles. SharePoint has no way to express
 * "upload but not download", and no way to distinguish delete or manage-permissions from ordinary
 * Edit. A destination `write` is therefore consistent with FOUR different source grants, and this
 * map cannot tell you which one arrived.
 *
 * What it CAN state, and all that it claims:
 *   - a grant that should have arrived is present, at or above the level it needs
 *   - a grant that did not arrive at all is missing            ← the defect this was built to catch
 *   - the destination holds MORE access than the source gave   ← reported as an escalation
 *
 * It deliberately does NOT claim that delete or admin rights were preserved. They are invisible at
 * the destination, so any verdict on them would be invention. That limitation is repeated in the
 * report text rather than left in this file where nobody reads it.
 *
 * ── What this replaced ─────────────────────────────────────────────────────────────────────────
 *
 * Reporting everything as not-comparable was the right call while the behaviour was unknown — a
 * guessed table would have expected four distinct roles for rungs 2-5 and produced three false
 * failures per item. But "not assessed" hid a real defect: group grants present on every source
 * rung, and absent on every destination one. Silence on a failing feature is worse than a wrong
 * verdict, because nobody argues with it.
 *
 * If an official table is ever published and disagrees with this one, the document wins — and the
 * disagreement is itself worth reporting.
 * ──────────────────────────────────────────────────────────────────────────────────────────────
 */

/** Shared ladder, matching contentRoleMap so levels stay comparable across maps. */
const LEVEL = { FULL: 4, EDIT: 3, READ: 2, NONE: 0 };

/** The ShareFile flags that imply more than reading. Any one of them lands as Edit. */
const WRITE_FLAGS = ['CanUpload', 'CanDownload', 'CanDelete', 'CanManagePermissions', 'CanAddFolder'];

/** Flags arrive as a '+'-joined summary from sharefileClient.listAccessControls. */
function flagsOf(role) {
  return String(role || '').split('+').map((f) => f.trim()).filter(Boolean);
}

/**
 * Comparable when the grant says anything at all.
 *
 * `none` is the summary listAccessControls produces for a principal row carrying no flags — there
 * is no access to verify, so it is reported rather than compared.
 */
function isComparableDriveRole(role) {
  const flags = flagsOf(role);
  return flags.length > 0 && !(flags.length === 1 && flags[0].toLowerCase() === 'none');
}

/** Why a grant was not compared. Carried into the report so a skip is never read as a pass. */
function nonComparableReason(role) {
  const r = String(role || '').trim();
  return r && r.toLowerCase() !== 'none'
    ? `ShareFile access "${r}" carries no recognised flag, so no destination role can be expected `
      + 'from it. Reported rather than guessed.'
    : 'this ShareFile principal holds no access flags — there is no grant to verify';
}

/** Source level: view-only reads, anything else edits. Measured — see the header. */
function driveRoleLevel(role) {
  const flags = flagsOf(role);
  if (flags.length === 0) return LEVEL.NONE;
  if (flags.some((f) => WRITE_FLAGS.includes(f))) return LEVEL.EDIT;
  return flags.includes('CanView') ? LEVEL.READ : LEVEL.NONE;
}

/** Destination level. SharePoint's own vocabulary, highest role wins. */
function spRolesLevel(roles) {
  const list = (Array.isArray(roles) ? roles : []).map((r) => String(r).toLowerCase());
  if (list.some((r) => r === 'owner' || r === 'fullcontrol' || r === 'full control')) return LEVEL.FULL;
  if (list.some((r) => r === 'write' || r === 'edit' || r === 'contribute')) return LEVEL.EDIT;
  if (list.some((r) => r === 'read' || r === 'restrictedread')) return LEVEL.READ;
  return LEVEL.NONE;
}

/** The SharePoint role a source grant should produce, for the report's "expected" column. */
function expectedLabel(role) {
  const lvl = driveRoleLevel(role);
  if (lvl >= LEVEL.EDIT) return 'write (Edit)';
  if (lvl === LEVEL.READ) return 'read (Can view)';
  return '(no access expected)';
}

/**
 * Compare one grant.
 *
 * AT OR ABOVE, not equal. Two reasons, both measured rather than assumed: the mapping is lossy, so
 * an exact match is not a question SharePoint can answer; and the destination legitimately holds
 * higher roles for site groups the migration never touched. A destination that grants MORE is
 * reported as an escalation — visible, but not a failure of the migration to carry the grant.
 */
function compareDriveAccess(sourceRole, destRoles) {
  const expected = driveRoleLevel(sourceRole);
  const actual = spRolesLevel(destRoles);
  return {
    match: actual >= expected && actual !== LEVEL.NONE,
    overGranted: actual > expected,
    expectedSpLabel: expectedLabel(sourceRole),
    destRoles: Array.isArray(destRoles) ? destRoles : [],
  };
}

/**
 * Shared links are not an in-scope feature for this combination — the document lists no Shared Links
 * section, unlike Box→SharePoint and Drive→SharePoint. Reported, never failed.
 */
function compareSharedLink(sourceLink) {
  return {
    match: false,
    notAssessed: true,
    reason: 'Shared Links are not listed as an in-scope feature for ShareFile → SharePoint — '
      + 'not assessed. See data/feature-scope/sharefile-to-sharepoint-inscope.md, '
      + '"Features documented for other combinations but NOT listed here".',
    sourceLink: sourceLink || null,
  };
}

module.exports = {
  pair: 'sharefile_to_sharepoint',
  combinations: ['sharefile_to_sharepoint'],
  label: 'ShareFile → SharePoint',

  /**
   * Permissions ARE assessed now. Kept as an explicit `false` rather than deleted: the validator and
   * its test both read this flag, and its absence would read as undefined — falsy by accident rather
   * than by decision.
   */
  permissionsNotAssessed: false,

  /**
   * True where the table came from measurement rather than a published document. The report cites
   * it, so a reader knows the basis of the verdict they are being given.
   */
  mappingIsMeasured: true,

  LEVEL,
  WRITE_FLAGS,
  flagsOf,
  isComparableDriveRole,
  nonComparableReason,
  driveRoleLevel,
  spRolesLevel,
  expectedLabel,
  compareDriveAccess,
  compareSharedLink,
};
