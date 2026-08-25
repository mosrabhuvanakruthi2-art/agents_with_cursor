# 001 — Google Drive → SharePoint: Shared Drive & Share-Link Content Validation

| | |
|---|---|
| **Status** | Draft |
| **Requested by** | Srinidh Perla |
| **Approved by** | *(leave blank until signed off)* |
| **Date** | 2026-08-19 |
| **Branch** | *(not yet created)* |

---

## Problem

QA has no automated way to verify that **Google Shared Drive (Team Drive) content** and
**Drive "share link" (anyone-with-the-link) files** land correctly after a Google Drive →
SharePoint migration. Today, `googledriveToSharepoint.js`
(`backend/src/validation/combinations/content/googledriveToSharepoint.js`) is an 11-line
stub extending `ContentReportValidationAgent` — it does no comparison at all and only
reports whatever counts the CloudFuze migration tool itself returns. A run against this
combination can show `SUCCESS` while validating nothing, which `CLAUDE.md` §1 explicitly
calls out as a bug in this system's own terms.

Meanwhile `DriveTestDataAgent.js` already seeds exactly this kind of test data — public
"anyone with the link" files (`sharedLinksSetup`, lines ~475–561) and named-collaborator
files — so the raw material to validate against already exists; nothing currently reads
it back from the destination.

## Outcome

A person with no access to the code can run a Drive→SharePoint QA execution and, from the
dashboard's Validation Results page, see individual pass/fail line items for: Shared
Drive folder structure, named-user permission mapping, and share-link (anyone-with-link)
survival — the same level of detail already visible for Box→SharePoint runs today.

## Scope

**In:**
- Real validation logic added to `googledriveToSharepoint.js` (Google Drive → SharePoint only)
- Shared Drive (Team Drive) folder/file structure comparison — source Drive vs destination
  SharePoint document library
- Named-user permission mapping validation (viewer/writer/owner → SharePoint role), reusing
  the existing `context.permissionMapping` / email-mapping mechanism already used by
  `boxToSharepoint.js`
- Share-link ("anyone with the link") validation — confirms the destination item is
  reachable per the expected sharing policy after migration
- My Drive (regular, non-Shared-Drive) files that also carry share links, since
  `DriveTestDataAgent`'s `sharedLinksSetup` seeds these outside Shared Drives too

**Out:**
- Google Drive → OneDrive (`googledriveToOnedrive.js` stays a stub — separate spec if needed)
- Box → anything (already built, not touched)
- Deep file-content comparison (byte-for-byte / hash) — mirrors what mail's Tier B does,
  but content validation in this repo has never done this for any combination; not adding
  it here either
- Migrating or creating share links — this spec is validation-only; seeding already exists
  in `DriveTestDataAgent`
- Retroactively validating past migration runs — this only applies to new runs going forward
- Any change to the CloudFuze `/content/initiate` migration call itself

---

## Behaviour

1. When a Drive→SharePoint execution includes at least one Shared Drive test folder, the
   validator confirms every top-level and nested folder present in the source Shared Drive
   exists at the corresponding path in the destination SharePoint document library.
2. When a source folder/file has a named-user permission (viewer, commenter, or writer/owner
   in Drive terms), the validator resolves the destination email via the existing user-email
   mapping and asserts the destination SharePoint item lists that mapped user with the
   expected role, using this mapping: Drive `owner`/`writer` → SharePoint `write`; Drive
   `commenter` → SharePoint `read` (SharePoint has no native "comment-only" role, so this is
   the closest equivalent — flagged as an assumption below); Drive `reader` → SharePoint `read`.
3. When a source file was shared as "anyone with the link" (`type: 'anyone'` permission in
   `DriveTestDataAgent`), the validator checks the destination SharePoint item's sharing
   link and reports FAIL if the destination item has no anonymous/organization-wide link at
   all, and WARN (not FAIL) if the link exists but the specific permission level differs —
   because "anyone" sharing policy is frequently restricted org-wide by the destination
   tenant's SharePoint admin settings, which is expected and outside this tool's control.
4. Each check (#1 folder structure, #2 named permissions, #3 share-links) reports
   independently as its own line item — PASS / FAIL / WARN — in the same
   `push('PASS'|'FAIL'|'WARN', label, detail)` pattern `boxToSharepoint.js` already uses, so
   the Validation Results UI needs no changes to render this.
5. If the source execution has zero Shared Drive folders and zero share-linked files (a
   plain My Drive migration with only named-user permissions), checks #1 and #3 report
   WARN "nothing to verify" rather than being silently skipped — consistent with how
   `boxToSharepoint.js` line 354 handles "no collaborators to verify".
6. A folder or file that exists at the destination but was never present at the source is
   not flagged — this validator only checks source→destination presence, not
   destination→source (extra items are out of scope; migrations can legitimately create
   destination-side system folders).

## Interaction with existing behaviour

- `googledriveToSharepoint.js` currently extends `ContentReportValidationAgent` and inherits
  `skipValidation`-driven report-only behaviour from `AgentOrchestrator`
  (`ContentReportValidationAgent.js` lines 6–17). This spec's implementation stops extending
  that base for this one combination and instead implements `execute(context)` directly —
  exactly the extension point that class's own doc comment describes ("a combination simply
  overrides execute() ... no change to the orchestrator or other combinations").
  `googledriveToOnedrive.js` is untouched and keeps the report-only stub behaviour.
- Reuses `context.permissionMapping` and the destination-email resolution helper already
  built for Box→SharePoint (`boxToSharepoint.js` lines 109–115) rather than building a new
  mapping mechanism — per `CONTRIBUTING.md`'s "edit only your combination's files" rule,
  this spec does not modify `boxToSharepoint.js` or shared permission-mapping code unless a
  genuine bug in the shared helper is found during implementation, in which case that
  becomes a separate PR against `validation/shared/`.

---

## Combinations affected

| Combination | Affected? | Expected result |
|---|---|---|
| Google Drive → SharePoint | Yes | Real validation added (this spec) |
| Google Drive → OneDrive | No | Remains a report-only stub |
| Box → SharePoint | No | Unchanged, used only as a reference pattern |
| Box → OneDrive | No | Unchanged |
| Mail (all combinations) | No | Not touched |
| Message (all combinations) | No | Not touched |

---

## Data changes

**MongoDB:** No schema change. Validation results are attached to the existing execution
record the same way `boxToSharepoint.js` results already are — no new collection.

**Migration needed?** No.

**Existing records:** Past Drive→SharePoint executions keep whatever report-only result
they already have; this only changes behaviour for new runs after deployment.

## Interface changes

**Endpoints:** None. This is internal validator logic invoked by the existing orchestrator;
no new or changed HTTP routes.

**UI:** None required — the Validation Results page already renders arbitrary
PASS/FAIL/WARN line items per combination; no new component needed as long as the output
shape matches what `boxToSharepoint.js` already produces.

**Access:** No change — same as any other execution, scoped to `req.userEmail` via
`ownsExecution()`.

**Env vars:** None new. Uses the existing `CONTENT_MIGRATION_SERVER_URL` / SharePoint Graph
credentials already required for any content combination.

---

## Edge cases

| Input | Expected |
|---|---|
| Empty Shared Drive (no files/folders) | WARN "nothing to verify", not FAIL |
| Nested Shared Drive folders (multiple levels) | Each level checked individually, same as Box's `depthOf(path)` pattern |
| Share-link revoked/expired before validation runs | FAIL — destination has no valid link; error message states link was expected but absent |
| Share link permission downgraded by SharePoint tenant policy (e.g. "anyone" forced to "org-only") | WARN, not FAIL (see Behaviour #3) |
| File with both a share link AND named-user permissions | Both check #2 and #3 run independently on the same item |
| Destination SharePoint item missing entirely (migration failed to copy it) | FAIL under folder-structure check (#1); permission/link checks for that item report "not found", not a false negative pass |
| Very large Shared Drive (hundreds of nested folders) | No hard cap in this spec; if performance becomes an issue, follow `mailTolerance/`-style banding as a future spec, not blocking this one |

## Failure modes

| Dependency down | User sees |
|---|---|
| Microsoft Graph API (SharePoint) | Validation step for that item reports FAIL with the Graph error message surfaced, not a generic crash — same pattern as `sharepointClient.getItemPermissions(...).catch(() => ({ permissions: [] }))` in `boxToSharepoint.js` |
| Google Drive API | Cannot read source structure — execution logs an error and the validator reports "source unreadable", does not silently report PASS |
| MongoDB | Execution result still returns to the caller in-memory; only persistence to history is affected (existing app-wide fallback behaviour, unchanged by this spec) |

---

## Test plan

1. Shared Drive with 3 nested folders, all present at destination → all folders report PASS
2. Shared Drive folder missing at destination (simulate incomplete migration) → that folder reports FAIL, others still evaluated independently
3. File with `writer` collaborator, mapped destination email exists → PASS with mapped role `write`
4. File with `commenter` collaborator → PASS with mapped role `read`, and the WARN/assumption about the role-mapping approximation is visible in the detail text
5. File shared as "anyone with the link", destination link present with matching accessibility → PASS
6. File shared as "anyone with the link", destination link present but restricted by tenant policy → WARN, not FAIL
7. File shared as "anyone with the link", no destination link at all → FAIL
8. Drive→SharePoint execution with zero Shared Drive content and zero share links (plain named-permission-only migration) → checks #1 and #3 both WARN "nothing to verify", check #2 still runs normally
9. Confirm `googledriveToOnedrive.js` behaviour is unchanged (still report-only) after this change ships

## Assumptions

- Drive `commenter` role has no exact SharePoint equivalent; mapping it to SharePoint `read`
  is the closest fit and is called out to the requester as a judgment call, not a verified
  business requirement — **flag for review during sign-off**.
- It is unconfirmed whether the CloudFuze `qarelease.cloudfuze.com` content migration tool
  itself actually migrates Shared Drive (Team Drive) content today — no Shared-Drive-specific
  code was found in `migrationClient.js`. This spec assumes the destination side is
  populated by the time validation runs (per the in-scope claim in
  `backend/data/feature-scope/google-my-drive-to-one-drive-inscope.md` §8); if that
  migration path turns out not to work at all, this validator will correctly and usefully
  report FAIL across the board rather than needing to be rewritten — no design change
  required either way.
- "Share link" in this spec means Drive's `permissions.create({ type: 'anyone' })` pattern
  exactly as seeded by `DriveTestDataAgent.js` lines 539–541 — not Drive's separate
  "shared with specific people via link" variant, which is covered by the named-user
  permission check (#2) instead.
- Reuses the existing `context.permissionMapping` / user-email-mapping mechanism as-is;
  this spec does not add a new mapping table.

## Risks

- **Highest-risk file:** `backend/src/validation/combinations/content/googledriveToSharepoint.js`
  (currently an 11-line stub, growing to real logic — mistakes here directly affect what QA
  trusts for every future Drive→SharePoint run)
- Google Drive's API requires different parameters (`supportsAllDrives: true`, `driveId`,
  `corpora: 'drive'`) to even see Shared Drive content vs. regular My Drive calls — if this
  is missed, the validator will silently see an empty Shared Drive and report false FAILs;
  needs explicit test coverage (Test plan #1–2) to catch this during implementation.
- SharePoint Graph permission APIs are rate-limited the same way `boxToSharepoint.js`
  already handles via `retry.js` — reusing that utility is required, not optional, to avoid
  flaky failures under load.

## Not doing

- Not building Drive → OneDrive validation in this spec (separate spec if prioritized)
- Not touching how CloudFuze performs the actual content migration
- Not adding byte-level file content verification (hash comparison) — no combination in this
  repo does this for content today, and it's a materially larger scope than this request
- Not building a generic "permission mapping" UI or config screen — reuses the existing
  code-level mapping mechanism
