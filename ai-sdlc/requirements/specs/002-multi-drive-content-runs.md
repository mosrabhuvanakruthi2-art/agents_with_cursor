# 002 — Multi-Drive Content Runs: N Shared Drives → One SharePoint Destination, with Drive-Level Permission Validation

| | |
|---|---|
| **Status** | Draft |
| **Requested by** | Srinidh Perla (relaying QA team requirement) |
| **Approved by** | *(leave blank until signed off)* |
| **Date** | 2026-08-27 |
| **Branch** | *(not yet created)* |

---

## Problem

A content run can target exactly **one** Google Shared Drive. Three independent places in the
code enforce that:

- `GOOGLE_SHARED_DRIVE_NAME` in the root `.env` is a single global value
  (`backend/src/config/env.js` line ~552).
- `context.sourceDriveId` is a single field, set once from the first seeding pass
  (`backend/src/orchestrator/AgentOrchestrator.js` line ~568).
- In `backend/src/clients/migrationClient.js` (lines ~1089–1123) the one global
  `sharedDriveRootId` **overrides** every per-row `sourceRootId`, so even multiple transfer
  units all read from the same drive.

The wizard has the same limit from the other end: per-user folder overrides are stored keyed by
source email (`contentUserFolders[email]` in `frontend/src/hooks/useRunWizard.js` lines ~113–131)
and the table renders one row per selected user pair
(`frontend/src/components/runwizard/steps.jsx` lines ~680–698). Two CSV rows for the same source
user therefore collapse into one — the second silently overwrites the first.

Two consequences:

1. **A real customer cannot be represented.** Customers routinely have many Shared Drives with
   deliberately different membership (`Finance 2024`, `HR Confidential`, `Marketing Assets`).
   Testing one drive per run does not exercise that.
2. **The security-relevant property is never checked.** Nothing verifies that a *restricted*
   Shared Drive stays restricted after migration. If CloudFuze widened access on a confidential
   drive, this QA system would not catch it.

Separately, **drive-level ("Level 1") permissions are never seeded by the tool at all.** Every
`shareFile()` call in `backend/src/agents/drive/DriveTestDataAgent.js` targets a folder id or a
file id (lines 437, 451, 526, 551, 562, 583); none targets the drive id. The drive id is used only
as a *parent* for placing content (lines 211, 219). The drive-level grants visible in run
`61a9d486`'s report (`everyone_at_exinent@filefuze.co` as `fileOrganizer`) were added by hand in
the Google UI, not by this system.

Two related defects surfaced while establishing the above and are in scope because this work
touches the same code paths:

- **The Map Users CSV import misreads a 4-column content CSV.** `importUserMappingsCsv`
  (`useRunWizard.js` line ~337) takes `cols[1] || cols[cols.length - 1]` as the destination
  email. For a row `erik@filefuze.co,/QA_Team1,granger@gajha.com,/QA/Documents` that yields the
  destination `"/qa_team1"` — a folder path stored as an email address, reported to the user as
  a successful import. The inline comment states the intent was "dest is the 2nd non-empty", but
  the expression never reaches the fallback, and the fallback would pick column 4 rather than the
  destination user in column 3.
- **An unresolvable drive name falls back to My Drive silently.** `DriveTestDataAgent.js`
  line ~206 logs a warning and seeds into My Drive instead. The run then reports on the wrong
  location while appearing to succeed. This is not hypothetical: the root `.env` currently names
  `QA_TeamDrive`, which no longer exists (it was renamed to `QA_Team1`).

## Outcome

A QA engineer with no access to the code imports one CSV naming several source Shared Drives and
one destination base path, starts a single run, and receives one report in which each drive is
reported separately — including an explicit verdict on whether an open drive arrived open and a
restricted drive arrived no broader than it started.

The same feature serves a two-drive lab test and a fifty-drive customer rehearsal without code or
`.env` changes.

## Scope

**In:**

- Per-row **source drive** on content runs, for any number of rows (1..N), replacing the single
  global drive name
- Destination = one **base path** supplied once, plus a per-row wrapper folder named after the
  drive, created by CloudFuze via the existing `migrateFolderName` job field
- Wizard changes: folder rows stored as a list rather than keyed by email; CSV import retains
  every row; row count reflects rows; add-row control; per-row delete control; "Reset to base"
  restyled to match "Import CSV"
- Fix `importUserMappingsCsv` to read the destination user from the correct column of a 4-column
  content CSV
- Trim leading **and** trailing slashes plus surrounding whitespace from drive and folder names
- Replace the silent My-Drive fallback with an explicit per-row failure
- **Drive-level (Level 1) permission seeding**, per row, in one of two declared access modes:
  `open` (a configured everyone-group at the drive root) or `restricted` (only named principals)
- One new documented feature, **4.10 Shared Drive membership: open vs restricted**, added to
  `backend/data/feature-scope/google-shared-drive-to-sharepoint-inscope.md` and to the content
  functionality checklist
- `CleanupAgent` handling one destination wrapper folder per row
- Validation reporting per drive rather than merged

**Out:**

- **Creating Shared Drives.** The Google Drive API is not called to create drives; there is no
  `drives.create` in this repo and none is added. Drives are created by hand and named in the CSV.
- **Explicit per-item grants for the everyone-group.** Open mode grants once at the drive root and
  relies on Google inheritance — see Assumptions.
- **Distinguishing inherited from direct permissions.** `listPermissions`
  (`backend/src/clients/driveClient.js`) does not request Google's `permissionDetails` field, so
  an inherited grant is indistinguishable from a direct one today. Out of scope here; recorded as
  a Risk because it caps what feature 4.10 can assert.
- **External sharing changes.** Explicitly withdrawn by the requester. Feature 4.9 continues to
  behave as it does today.
- The mail and message products, and every mail combination.
- Box, OneDrive and My Drive combinations beyond inheriting the same row shape without behaviour
  change.
- The two known CloudFuze defects from run `61a9d486` (legacy Office formats not converted;
  organization links with edit permission not created). Reported separately; not fixed here.
- The destination library's "Require documents to be checked out" setting and the resulting
  invisible files. That is destination configuration, not code.

---

## Behaviour

1. A content run accepts one or more **source-drive rows**. With one row, behaviour is identical
   to today's single-drive run.
2. Each row resolves its **own** Shared Drive by name to its own drive id. No row's drive
   influences another row's scan root.
3. Drive and folder names are matched after trimming surrounding whitespace and both leading and
   trailing `/`. `"/QA_Team1/"`, `"QA_Team1"` and `" QA_Team1 "` all resolve to the drive named
   `QA_Team1`.
4. If a row's named drive cannot be resolved for the source account, **that row fails explicitly**
   with the drive name in the message. The run does not seed that row into My Drive, and does not
   report the row as passing.
5. Every row seeds the **same** source folder name, so the data in each drive is identical. The
   folder name is a single shared field, not per row.
6. The destination for a row is the shared **base path** plus a wrapper folder named after that
   row's drive. Given base `/QA/Documents` and drive `QA_Team1`, migrated content lands under
   `/QA/Documents/QA_Team1/`. The requester supplies only the base path.
7. No two rows share a destination wrapper folder. Two rows naming the same drive is a validation
   error at submit time, not a silent merge.
8. Each row declares a drive-level **access mode**:
   - `open` — the configured everyone-group is granted `fileOrganizer` (Content Manager) at the
     drive root, once.
   - `restricted` — only the named principals for that row are granted at the drive root, and the
     everyone-group is **not** granted.
9. `organizer` (Manager) is never part of an expectation. The in-scope document maps Viewer,
   Commenter, Contributor, Content Manager and the three file roles, and deliberately gives
   Manager no destination access. A source Manager grant arriving as no access at the destination
   is correct and is reported as informational, never as a failure.
10. Feature **4.10** reports:
    - PASS when every `open` row's everyone-group grant is present at the destination with edit
      access, **and** no `restricted` row's destination access is broader than its source.
    - FAIL when a `restricted` row's destination grants access to a principal that had none at the
      source — the data-exposure case.
    - INFO when a run contains no `restricted` row, since the comparison cannot be made.
11. The report identifies every per-item result by its row, so two drives holding identically
    named files are never conflated.
12. Importing a CSV into the per-user folder table retains **every** data row. A CSV with three
    rows produces three table rows, and the row count in the section heading shows `3`.
13. Importing a 4-column content CSV into **Map Users** reads the source user from column 1 and
    the destination user from column 3. Column 2 (source path) is never treated as an email.
14. A row can be added manually and any row can be deleted, without re-importing the CSV.
15. `CleanupAgent` removes each row's destination wrapper folder and empties each row's source
    folder, leaving folders that no row names untouched.

## Interaction with existing behaviour

- A single-row run must produce a report structurally identical to today's single-drive run.
  Existing executions in Mongo are not migrated or re-interpreted.
- `GOOGLE_SHARED_DRIVE_NAME` remains supported as the default drive name for a row that names
  none, so existing configurations keep working. It stops being the only way to name a drive.
- Box, OneDrive and My Drive content runs gain the row shape but no behaviour change: rows for
  those providers carry no drive, and the destination wrapper is not applied.
- The mail and message products are untouched.

---

## Combinations affected

| Combination | Effect |
|---|---|
| `googledrive→sharepoint` (Shared Drive source) | Full feature. Primary target. |
| `box→sharepoint` | Row shape only; no drive column, no wrapper. Must be re-verified unchanged. |
| `googledrive→onedrive`, `box→onedrive` | Report-only stubs today; row shape must not break them. |
| All four mail combinations | Not affected. |
| Message combinations | Not affected. |

---

## Data changes

- Each per-user folder row gains `sourceDriveName`, and at runtime `sourceDriveId` once resolved,
  plus `accessMode` (`open` or `restricted`) and the row's named principals for `restricted`.
- `contentUserFolders` changes from an object keyed by source email to an ordered list of rows,
  each with a stable local id. This is the change that permits two rows for one user.
- `userFolderMappings` entries carry the resolved per-row drive id and the row's wrapper folder
  name, so `migrationClient` no longer needs a global.
- `MigrationContext` gains the row collection; `context.sourceDriveId` is retained for
  single-drive compatibility but is no longer authoritative when rows carry their own.
- Persisted execution documents gain the per-row fields. Reading an older document without them
  must not throw.

## Interface changes

- **Wizard, folder step:** drive column, add-row control, per-row delete, row count, restyled
  reset link. No new page or route.
- **CSV contract:** the existing 4-column content CSV
  (`Source Cloud,Source Path,Destination Cloud,Destination Path`) is retained unchanged. Column 2
  names the **drive** for a Shared Drive source. No new column is introduced.
- **API:** the run payload carries the row list. Existing single-drive payloads remain valid.
  Error shape stays `{ error: '…' }`; long operations keep returning `202` with an `executionId`.
- **Env vars:** no new required variable. `GOOGLE_SHARED_DRIVE_NAME` becomes a default rather than
  the only source. The everyone-group used by `open` mode reuses `GOOGLE_TEST_GROUP_EMAIL`.
- **Access:** unchanged — every execution stays scoped to `req.userEmail` via `ownsExecution()`.

---

## Edge cases

| Input | Expected |
|---|---|
| One row (today's case) | Identical behaviour and report structure to the current single-drive run |
| Row names a drive the source account cannot see | That row fails explicitly, naming the drive. No My-Drive fallback. Other rows still run |
| Row's drive name has a trailing slash | Trimmed and resolved normally |
| Two rows name the same drive | Rejected at submit with a clear message; no silent merge |
| Two drives exist with the same name | Row fails as ambiguous rather than picking the first match |
| Destination base path does not exist in SharePoint | Reported as a destination error, not as missing source data |
| `restricted` row with no principals configured | Feature 4.10 reports INFO "not exercised", never PASS |
| `open` row with no everyone-group configured | Feature 4.10 reports INFO "not exercised", never PASS |
| A drive is empty at scan time | WARN "nothing to verify" for that row, not FAIL |
| CSV with a blank line or a header-only file | Ignored rows; zero imported reported honestly |
| CSV row whose destination user is not a fetched mailbox (a group) | Kept as typed, as the current import already does for groups |
| Older execution document without the new fields | Reads and renders without error |

## Failure modes

| Dependency down | User sees |
|---|---|
| Google Drive API | The affected row reports "source unreadable" with the API message; never a silent PASS |
| Microsoft Graph / SharePoint | That row's destination checks FAIL with the Graph error surfaced; other rows continue |
| CloudFuze `qarelease` server | Migration step fails for the run as it does today; validation reports no destination rather than passing |
| CloudFuze ignores `migrateFolderName` | Rows collide in one folder. Detected by rule 7's uniqueness check and reported; see Assumptions |
| MongoDB | Result still returns in-memory; only history persistence is affected (existing app-wide fallback) |

---

## Test plan

1. Single row, one drive → report structurally identical to run `61a9d486`'s shape
2. Two rows, `QA_Team1` + `QA_Team2`, identical folder name → both drives seeded, both migrated,
   two separate sets of per-item results
3. Two rows → destination shows `/QA/Documents/QA_Team1/…` and `/QA/Documents/QA_Team2/…`, created
   automatically, requester having supplied only `/QA/Documents`
4. Row naming `"/QA_Team1/"` → resolves to `QA_Team1`
5. Row naming a non-existent drive → that row fails naming the drive; nothing seeded into My Drive
6. Two rows naming the same drive → rejected at submit
7. `open` row: everyone-group present at destination with edit → 4.10 PASS
8. `restricted` row: only the named few at destination → 4.10 PASS
9. `restricted` row where the destination grants a principal absent at source → 4.10 FAIL
   (the data-exposure case; must be demonstrated deliberately)
10. Source Manager grant → reported informational, never FAIL (rule 9)
11. 3-row CSV import → 3 table rows, heading shows `3`
12. 4-column CSV imported into Map Users → destination user is `granger@gajha.com`, never
    `/qa_team1`
13. Add a row manually, delete a row → row list behaves without re-import
14. Cleanup after a two-row run → both destination wrappers removed, unrelated destination folders
    untouched
15. `box→sharepoint` regression → unchanged verdict against a prior run
16. Existing execution document from before this change → Validation Results page renders
17. `npm run lint` clean in `backend/` and `frontend/`; `npm run build` clean in `frontend/`;
    every new `node+assert` test wired into the `&&` chain in `backend/package.json`

## Assumptions

- **Open mode relies on Google inheritance, not explicit per-item grants.** The requester's phrase
  was "for all levels", which is ambiguous. This spec reads it as: grant the everyone-group once at
  the drive root and let folders and files inherit, exactly as `QA_Team1` behaves today.
  **Flag for confirmation at sign-off** — the explicit reading would mean roughly seventy extra
  grants per drive per run and would additionally require the `permissionDetails` work listed under
  Risks before it could be verified at all.
- **`migrateFolderName` creates the destination wrapper folder on `qarelease.cloudfuze.com`.** The
  field exists and the job accepts it, but every run to date has sent it blank, so it has never
  been exercised on this server. **Requires one confirming run before design is finalised.** If it
  does not create the folder, the fallback is a full per-row destination path
  (`/QA/Documents/QA_Team1`), which changes the design but not the requirement.
- The everyone-group `everyone_at_exinent@filefuze.co` genuinely contains all staff. Nothing in the
  code verifies group membership; the name is taken at face value.
- The principals used by `restricted` mode already map to destination accounts. Confirmed for
  `alex@`, `mia@`, `warner@snapbot.io` and the three `qa-group-*` groups from run `61a9d486`.
  An unmapped principal is a configuration problem, reported as such, not a product defect.
- Feature numbering `4.10` does not clash with a customer document revision adding its own 4.10.

## Risks

- **`listPermissions` cannot distinguish inherited from direct grants.** It requests
  `permissions(id,type,role,emailAddress,domain,allowFileDiscovery,deleted)` and omits Google's
  `permissionDetails`. Inherited grants are therefore counted on every item — which is why run
  `61a9d486` reported 193 grants from a handful of actual grants. Feature 4.10 can assert that
  access **exists** and that restricted access is **not broader**, but cannot assert *where* a
  grant was set. If the team wants the explicit reading of "all levels", this must be built first.
- Changing `contentUserFolders` from a keyed object to a list touches every consumer of that state,
  including the summary step and the run payload. Regression risk in the wizard is the main
  implementation risk.
- `migrationClient.js` is shared by every content combination. The change that stops the global
  drive id overriding per-row values must be verified against `box→sharepoint` explicitly.
- Adding feature 4.10 changes the denominator in the report's feature tally (currently 38), so
  historical "x of 38" figures will not be comparable.
- Seeding N drives multiplies run time and Google API calls by N. No cap is specified here; if it
  becomes a problem, band it in a later spec rather than blocking this one.

## Not doing

- Creating or deleting Shared Drives programmatically
- Automating the destination library's check-out setting
- Fixing the legacy-Office conversion defect or the edit-level organization link defect
- Building the `permissionDetails` inherited-versus-direct distinction
- Any change to the mail or message products
- Any new dependency, framework, or test runner
