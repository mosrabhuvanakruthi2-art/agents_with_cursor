# 004 — Dropbox → SharePoint Online (new content combination)

| Field | Value |
|---|---|
| **Status** | `Draft` |
| **Requested by** | Bala.Raviteja@cloudfuze.com |
| **Approved by** | |
| **Date** | 2026-09-09 |
| **Product** | content |
| **Migration server** | `qarelease.cloudfuze.com` |

---

## Problem

QA cannot run or validate a **Dropbox → SharePoint Online** migration at all. The combination is not
registered in `backend/src/orchestrator/agentRegistry.js` (it auto-loads
`orchestrator/combinations/content/*`, which today contains `dropboxToGoogledrive.js` and
`dropboxToGoogleshareddrive.js` but no SharePoint pair), so a run cannot be requested regardless of
what the wizard offers. Every Dropbox→SharePoint engagement is therefore verified by hand, while the
two halves needed to automate it already exist and are proven separately: the Dropbox source (seeding,
team-space path prefixing) and the SharePoint destination (validation agent, name/path rules, cleanup).

The cost of leaving it manual is not only labour. The two live SharePoint combinations exist precisely
because SharePoint silently rewrites names and refuses long paths; a human spot-check does not catch a
folder that arrived renamed with its children misplaced. That class of defect ships unnoticed today.

## Outcome

Observably true when done, without reading code:

- A QA engineer can select **Dropbox → SharePoint Online** in the run wizard, start a SMOKE, SANITY or
  E2E content run, and get a completed execution with a per-feature validation report.
- The report gives a per-feature verdict for every feature in a **Dropbox→SharePoint scope document
  that exists in `backend/data/feature-scope/`** — not a Google-shaped one.
- A run in which the destination was never read reports `FAILED` with zero `pass` verdicts. It is never
  possible to get `SUCCESS` from a run that compared nothing.
- `npm run lint` is clean and `npm test` passes, with at least one new test in the `&&` chain that
  fails if the combination stops validating deeply.

---

## Research findings (verified in the repo on 2026-09-09)

Evidence of what exists, not instructions.

**F1 — The Dropbox source half is essentially complete and proven.**
`backend/src/clients/dropboxClient.js` (**966** lines — the request said 911; 966 is the current count)
and `backend/src/agents/dropbox/DropboxTestDataAgent.js` (1,341 lines) exist and are exercised by the
two live Dropbox→Google combinations, seeding 32 folders / 35 files / 6 versions / 2 links / 9 grants.

**F2 — The team-space path fix is genuinely destination-independent. Confirmed.**
`applyDropboxTeamSpacePaths` is defined at `backend/src/clients/migrationClient.js:31` and called at
line 1276 under exactly one condition:

```js
if (/DROPBOX/i.test(String(context.sourceCloudName || ''))) {
  await applyDropboxTeamSpacePaths(units, logger);
}
```

The destination is not consulted in that guard or anywhere in the function body; the function's own
header states it is *"Gated by the CALLER on sourceCloudName containing DROPBOX"*. It will therefore
fire for a SharePoint destination with no change. The fix that took nine failed jobs to find is
inherited free.

**F3 — The SharePoint destination half is mature and is the default.**
`backend/src/agents/sharepoint/SharePointValidationAgent.js` (352 lines);
`backend/src/validation/destinations/sharepoint.js` (87 lines) is `DEFAULT` in
`validation/destinations/index.js` and is what `deepContentCore.js` uses when a combination names no
destination — so **no new destination-rules file is required**. `resolveDestPath` and the SharePoint
`toRootId` defaults exist in `migrationClient.js`; `AgentOrchestrator.js:792` and the content cleanup
path (`dstProvider === 'sharepoint'`, cleanup agent line 339) both already branch on SharePoint.

**F4 — The two destination agents share method names with incompatible signatures.** Verified line by
line. SharePoint is path-addressed within a site; Google is id-addressed:

| SharePointValidationAgent | GoogleDriveValidationAgent |
|---|---|
| `resolveSite(context, siteHint)` :53 | `resolveDestinationRoot(context)` :74 |
| `findMigratedRoot(siteId, destBase, name, email)` :217 | `findMigratedRoot(rootId, driveId, destBase, name, email)` :132 |
| `readTree(siteId, rootPath, email, maxDepth)` :272 | `readTree(rootFolderId, email, opts)` :215 |
| `readPermissions(siteId, itemPath, email)` :278 | `readPermissions(fileId, email)` :237 |
| `listChildren(siteId, folderPath, email)` :284 | `listChildren(folderId, email, driveId)` :303 |
| `readTextLines(siteId, itemPath, email)` :296 | `readTextLines(item, email)` :327 |
| `readContent(siteId, itemPath, email)` :314 | `readContent(item, email)` :349 |
| `readVersionCount(siteId, itemPath, email)` :307 | `readVersionCount(fileId, email)` :303 |

**F5 — Consequence: the existing Dropbox validator cannot be re-parented.**
`validation/combinations/content/dropboxToGoogledrive.js` is 1,919 lines and mixes Dropbox source
reading with Google destination reading **by extending `GoogleDriveValidationAgent`**. Because of F4,
swapping the base class is not an equivalent substitution. Note also that
`orchestrator/combinations/content/dropboxToGoogleshareddrive.js:28` reuses that same validator
verbatim — reuse worked there only because both destinations are Google. That escape hatch is closed
here.

**F6 — There is a precedent for the symmetric extraction.** `validation/destinations/` was extracted
when Google became the first non-Microsoft **destination**; its index header records the motivation
("two people adding two destinations collided" on an 1100-line shared file). Dropbox is now the first
**source** used against two different destinations, so a matching source-side extraction is the obvious
candidate. **This document does not choose it.** See Risk R1 and OQ-4.

**F7 — The scope-document blocker. `backend/data/feature-scope/dropbox-to-sharepoint-inscope.md` does
not exist.** The directory contains only `dropbox-to-google-{inscope,outscope,testdata}.md`. The
in-scope document is explicitly Google-destination-shaped; its own header says:

> "**The destination is Google, not Microsoft.** … Google rejects almost no characters, reserves no
> names, and imposes no total-path limit — so features 5.1 and 7.1 read very differently here than
> they do in `google-shared-drive-to-sharepoint-inscope.md`."

It therefore **must not be reused, copied or templated on** for this combination. Its §10 is **19
Dropbox Paper features** — over half of its 36 — and its out-of-scope companion holds exactly **1**
feature (the in-line-comment CSV). It also carries an unresolved "Open question for the combination
owner" covering features 10.2, 10.6, 10.14, 10.15, 10.17 and 10.18.

**F8 — Paper conversion is Google-gated.** In `migrationClient.js` (~line 1837) `papertoGDoc=true`,
together with `sharedContent/fusionTables/drawings/unsupportedFiles=false`, is emitted only when
`isDropboxToGoogleDrive`. No SharePoint equivalent parameter is known to this repo.

**F9 — Deep validation is opt-in.** Only three files set `static supportsDeepValidation = true`
(`boxToSharepoint.js:152`, `dropboxToGoogledrive.js:369`, `googledriveToSharepoint.js:62`).
`AgentOrchestrator.js:930` reads it; without it the run falls back to `ContentReportValidationAgent`,
which compares nothing.

**F10 — The test chain is explicit.** `backend/package.json` `test` is a single `&&` chain of ~41
`node test/*.js` invocations. A file not named there never runs.

---

## Scope: In

- A new content combination `dropbox → sharepoint`, registered so it is runnable end to end.
- Seeding Dropbox source data using the existing Dropbox test-data path (no new seeding capability).
- Deep validation of the SharePoint destination: tree pairing, names, paths, permissions, shared links,
  versions, metadata, embedded links, Tier B byte-hash content comparison, per-feature checklist rollup.
- SharePoint-specific name and path rules applied to Dropbox-sourced names (feature areas 5.1 and 7.1).
- A Dropbox→SharePoint role / link-scope map.
- Per-combination tolerance bands.
- A Dropbox→SharePoint in-scope document and a non-empty (or explicitly-declared-empty) out-of-scope
  companion in `backend/data/feature-scope/`.
- Wizard/UI exposure of the combination.
- `node + assert` tests wired into the `&&` chain.

## Scope: Out

- **Dropbox → OneDrive.** Same destination engine, different combination; not requested here.
- **Dropbox Paper conversion behaviour at a SharePoint destination.** Blocked on OQ-2; nothing in this
  work invents a conversion target.
- **Any change to `dropbox → googledrive` or `dropbox → googleshareddrive`** — including their
  validator, orchestrator files, tolerance bands or scope documents. Editing another combination's
  files is forbidden by CONTRIBUTING.
- **Any behavioural change to the mail or message products.**
- **New CloudFuze migration parameters.** If the destination needs a job parameter this repo does not
  send today, that is a separate, evidenced change — not a guess inside this one.
- **Retro-validation of executions recorded before this combination exists.**
- **Delta migration** as a distinct validated feature, unless OQ-1's document says otherwise.
- Deployment, CI/CD, infrastructure. Always out of scope for GStack.
- Adding any new dependency, test runner or build step.

---

## Behaviour

Numbered, each independently testable.

### Registration and runnability

1. `agentRegistry.resolve('content', 'dropbox', 'sharepoint')` returns a handler set containing both a
   `TestDataAgent` and a `ValidationAgent`. Before this change it returns `undefined`.
2. The combination is introduced as **new files only** — an orchestrator combination file
   (`orchestrator/combinations/content/dropboxToSharepoint.js`), a validation combination file
   (`validation/combinations/content/dropboxToSharepoint.js`), a tolerance file
   (`utils/contentTolerance/dropboxToSharepoint.js`) and a Dropbox→SharePoint role map. No existing
   combination's orchestrator or validation file is modified. A diff that changes
   `dropboxToGoogledrive.js`, `dropboxToGoogleshareddrive.js`, `boxToSharepoint.js` or
   `googledriveToSharepoint.js` fails this rule.
3. The validation combination class declares `static supportsDeepValidation = true`. A test asserts
   this directly: if the flag is absent, `AgentOrchestrator` falls back to
   `ContentReportValidationAgent` and the run compares nothing while still reporting a verdict.
4. Requesting a Dropbox→SharePoint run returns `202` with an `executionId`, and
   `GET /api/agents/executions/:id` reflects its progress, matching the existing content-run contract.

### Honest reporting

5. A run in which the destination tree could not be read (site unresolvable, root not found, zero items
   returned) reports execution status `FAILED` and **zero** `pass` verdicts. It must never report
   `SUCCESS`, and must never emit a checklist in which features are marked pass without being exercised.
6. Every feature in the Dropbox→SharePoint in-scope document appears in the checklist rollup with
   exactly one of `pass`, `fail`, `info`, `not_exercised`. A feature the run did not attempt is
   `not_exercised`, never `pass`.
7. Every item in the Dropbox→SharePoint **out-of-scope** document is reported at `INFO` with the
   document's own wording and never contributes to a `FAIL`, per CLAUDE.md.
8. A difference the run cannot classify is reported as `unknown`, not as `bug`. Only findings classified
   `bug` may produce a ticket.

### SharePoint name and path rules (feature areas 5.1 and 7.1)

These revert to SharePoint's rules; the Google document's treatment does not apply.

9. A Dropbox source name containing any of `" * : < > ? / \ |` is expected at the destination with those
   characters replaced by `_` or `-` and surrounding whitespace trimmed, per
   `validation/destinations/sharepoint.js`. The validator reports `pass` when the destination matches
   the sanitized prediction and `fail` naming the item when it does not. Characters `~ # % & { }` are
   **valid** and must be expected unchanged — predicting them replaced is itself a defect.
10. A source name that is a SharePoint reserved name (`.lock`, `con`, `prn`, `aux`, `nul`,
    `desktop.ini`, `forms`, `com0`–`com9`, `lpt0`–`lpt9`, anything starting `~$`, anything containing
    `_vti_`, or a folder name beginning `゛`/`ဗ`) is expected to arrive altered, and its unaltered
    absence is not reported as data loss.
11. An item whose full **encoded** destination path exceeds **400** characters is expected to arrive as
    a Folder/File Path Link **placeholder link**, not as content. The validator reports `pass` when the
    placeholder is present and `fail` naming the item when neither content nor placeholder exists. A
    placeholder where content was expected (under 400 characters) is a `fail`.
12. A single path segment longer than **255** characters is expected truncated; a destination segment
    matching the first **60** characters of the source segment counts as the truncated form of it and is
    paired, not reported missing.
13. Rules 9–12 are evaluated against the shared SharePoint rules module rather than re-implemented in
    the combination file, so a future change to SharePoint's character set changes one place.

### Permissions

14. A Dropbox→SharePoint role map exists exposing the same four functions the shared comparison calls,
    following the `validation/roleMaps/dropbox_to_google.js` pattern — a new file in that scan-loaded
    directory, not an edit to `validation/contentRoleMap.js`.
15. Dropbox exposes only `owner`, `editor`/`can edit`/`write` and `viewer`/`can view`/`read` — **there
    is no commenter**. A destination grant that is read-level where the source was Editor is reported
    `fail` as a downgrade; the map must not accept a SharePoint read-level role as a valid outcome for a
    Dropbox Editor.
16. Each of the 9 seeded grants is paired to a destination grant and given an individual verdict naming
    the item and the principal. A permission section reporting a single aggregate verdict fails this
    rule.

### Team-space paths

17. For a Dropbox source the member-folder prefix is applied to migration unit paths regardless of
    destination. A test asserts the same unit set produces identical prefixed paths with
    `destinationProvider = 'sharepoint'` as with `'googledrive'`.
18. When Dropbox team members cannot be listed, paths are left unprefixed and the run logs a warning and
    reports the resulting `CONFLICT` / zero-item scan explicitly, rather than reporting a clean pass.

### Documentation prerequisite

19. `backend/data/feature-scope/dropbox-to-sharepoint-inscope.md` exists, states its destination is
    SharePoint Online, and is not a copy of the Google document. A validator shipped without it is not
    complete: the checklist has nothing to enumerate.
20. `backend/data/feature-scope/dropbox-to-sharepoint-outscope.md` exists and either lists at least one
    documented limitation or states in its header, explicitly, that there are none.
21. Where the in-scope document leaves a feature's verdict genuinely ambiguous, the validator reports it
    at `INFO` with the document's own wording — the position already taken by the Dropbox→Google
    document's "Open question for the combination owner". Ambiguity is never resolved by guessing.

### Tests

22. New `node + assert` test files are added under `backend/test/` **and appended to the `&&` chain** in
    the `test` script of `backend/package.json`. A test file absent from that chain never runs and does
    not count as delivered.
23. `npm run lint` reports **0 errors**.

---

## Combinations affected

| Combination | Product | Effect |
|---|---|---|
| Dropbox → SharePoint Online | content | **New.** All new files. |
| Dropbox → Google My Drive | content | Unchanged. Regression-verify (shares `dropboxClient`, `DropboxTestDataAgent`, the team-space prefix, and — until the architect decides otherwise — 1,919 lines of source-reading logic). |
| Dropbox → Google Shared Drive | content | Unchanged. Regression-verify; reuses the My Drive validator verbatim. |
| Box → SharePoint | content | Unchanged. Regression-verify: shares `SharePointValidationAgent` and `validation/destinations/sharepoint.js`. |
| Box → OneDrive | content | Unchanged. Regression-verify: `onedrive` is an alias of the SharePoint rules. |
| Google My Drive → SharePoint | content | Unchanged. Regression-verify: shares `SharePointValidationAgent`. |
| Google My Drive → OneDrive | content | Unchanged. Regression-verify. |
| Google Shared Drive → SharePoint | content | Unchanged. Regression-verify: shares `SharePointValidationAgent` and `deepContentCore`. |
| Gmail → Outlook | mail | Not affected. |
| Outlook → Gmail | mail | Not affected. |
| Gmail → Gmail | mail | Not affected. |
| Outlook → Outlook | mail | Not affected. |
| Slack ↔ Teams ↔ Google Chat | message | Not affected. |

If the architect's design touches `validation/shared/deepContentCore.js`, every content row above
becomes a *changed* combination and each must be verified individually before the QA gate.

## Products / test types affected

| | SMOKE | SANITY | E2E |
|---|---|---|---|
| **content** | Yes — combination selectable, completes with a real verdict | Yes | Yes — full seeded set (32 folders / 35 files / 6 versions / 2 links / 9 grants) |
| **mail** | No | No | No |
| **message** | No | No | No |

Rules 1–23 hold for all three content test types. Where a test type seeds less data, unexercised
features are `not_exercised` (rule 6), never `pass`.

## Data changes

- New execution records carry `sourceProvider: 'dropbox'`, `destinationProvider: 'sharepoint'`. No
  change to the shape of `MigrationContext` or `ValidationResult` is requested; if the design needs one,
  it returns to this gate for re-approval.
- **Records written before this change are untouched and are not re-validated.** No backfill, no
  migration script.
- Executions in `RUNNING`, `CANCELLED` or `INTERRUPTED` at release keep their status; the new
  combination does not reinterpret them. `COMPLETED` records are read-only history.
- The JSON fallback store under `backend/data/` must keep working when `getDb()` returns `null` — a
  Dropbox→SharePoint execution persists and is readable with Mongo down.
- New: two scope documents under `backend/data/feature-scope/` (checked in; not runtime state).

## Interface changes

- **Wizard/UI:** Dropbox → SharePoint Online appears as a selectable content combination.
- **Endpoints:** none added or changed; existing content run + polling endpoints are reused.
- **Env vars:** none new expected. The combination consumes existing `DROPBOX_APP_KEY`,
  `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN`, `DROPBOX_ACCESS_TOKEN`, `DROPBOX_TEST_ROOT`,
  `DROPBOX_TEST_INTERNAL_USER`, `DROPBOX_TEST_EXTERNAL_USER`, `DROPBOX_TEST_GROUP`,
  `SHAREPOINT_HOSTNAME`, `SHAREPOINT_SITE_PATH`. Any genuinely new variable goes into the root
  `.env.example` as a placeholder and is called out at the design gate.

## Edge cases

| Input | Expected |
|---|---|
| Source name `Special !@#$%^&*()-_+=[] Folder` | Destination `Special !@#$%^&-()-_+=[] Folder`: only `*` replaced; `# % &` preserved. `pass`. |
| Source folder named `con` or `forms` | Reserved; altered arrival expected, unaltered absence is not data loss. `pass`. |
| Source file named `~$budget.xlsx` | Reserved by prefix; same treatment. |
| Encoded destination path = 399 chars | Content expected. Placeholder instead → `fail`. |
| Encoded destination path = 401 chars | Placeholder link expected. Neither content nor placeholder → `fail` naming the item. |
| Segment of 300 chars | Truncated; paired on a 60-char prefix match. Not "missing". |
| Emoji / non-BMP characters in a name | Valid in SharePoint; expected unchanged. Any replacement is `fail`. |
| Two source items whose sanitized names collide (`a:b` and `a?b` → `a_b`) | Both must exist at the destination. Silent single-item arrival is `fail`, not a pass on the survivor. |
| Zero-byte file | Migrated and paired; Tier B hash of empty content matches. Not skipped. |
| A `.paper` file | **Blocked on OQ-2.** Until answered, report `INFO` "expected outcome undefined for a SharePoint destination"; never `pass`, never `fail`. |
| Dropbox source folder empty | Run completes; content features are `not_exercised`; execution is not `SUCCESS` with an unexercised checklist. |
| Dropbox team member missing for a seeded user | Path left unprefixed, warning logged, resulting zero-item scan reported explicitly (rule 18). |
| Destination site already holds a previous run's tree | Cleanup runs first; if it cannot, the run reports the collision rather than pairing against stale data. |
| Very large file (above the seeded band) | Compared within the declared tolerance band; a difference outside the band is `fail` with both numbers. |
| Duplicate grant on the same item to the same principal | Deduplicated before pairing; not counted twice toward the 9 grants. |
| Negative / zero item count returned by the destination read | Treated as "read failed" per rule 5, not as an empty-but-valid destination. |

## Failure modes

| Dependency down | What the user sees |
|---|---|
| **Microsoft Graph / SharePoint** unauthenticated or 5xx | Retry with backoff via `utils/retry.js`; on exhaustion the execution is `FAILED` with an error naming Graph and the operation. **Not** `SUCCESS`, and no partial checklist marked pass. |
| **SharePoint site path unresolvable** (`SHAREPOINT_HOSTNAME`/`SITE_PATH` wrong) | `FAILED` before any pairing, error naming the site path. Zero `pass` verdicts (rule 5). |
| **Dropbox API** 401 / expired refresh token | `FAILED` at seeding with an error naming Dropbox auth. (The Google 7-day-token failure mode does not apply to this combination.) |
| **Dropbox team-member listing** fails | Warning; paths unprefixed; conflict reported explicitly; run not passed (rule 18). |
| **MongoDB** down (`getDb()` returns `null`) | Run still starts and completes; the execution persists to the `backend/data/` JSON fallback and is readable through the existing endpoints. No 500 to the user. |
| **`qarelease.cloudfuze.com`** unreachable or rejects the job | `FAILED` with the CloudFuze status/message surfaced; no validation verdicts emitted. |
| **`qarelease.cloudfuze.com`** accepts the job but reports 0 files/folders scanned | Reported as a migration failure with the scan count, not as a clean destination. |
| **Gmail / Google APIs** | Not used by this combination; a Google outage must not affect a Dropbox→SharePoint run. If it does, that is a coupling defect. |
| **OpenAI / Anthropic** (AI analysis) unavailable | Advisory only. Validation verdicts unaffected; the report notes analysis unavailable. |
| **Jira Xray** unavailable | No ticket filed; the run's verdict is unchanged and the failure to file is logged. |

## Test plan

QA tests these by name.

**Registration and wiring**
- `TC-DBSP-01 Combination resolves` — `resolve('content','dropbox','sharepoint')` returns both agents.
- `TC-DBSP-02 Deep validation opt-in` — the validation class exposes `supportsDeepValidation === true`.
- `TC-DBSP-03 No foreign combination files modified` — the diff touches no other combination's
  orchestrator/validation/tolerance file.
- `TC-DBSP-04 Test chain wiring` — every new `backend/test/*.test.js` appears in the `&&` chain.
- `TC-DBSP-05 Lint clean` — `npm run lint` returns 0 errors.

**Honest reporting**
- `TC-DBSP-06 Unread destination fails` — destination read stubbed empty → `FAILED`, zero `pass`.
- `TC-DBSP-07 No unexercised pass` — a SMOKE run marks unseeded features `not_exercised`.
- `TC-DBSP-08 Out-of-scope never fails` — every out-of-scope item yields `INFO` only.

**SharePoint rules**
- `TC-DBSP-09 Valid special characters preserved` — `# % & { } ~` unchanged.
- `TC-DBSP-10 Invalid characters sanitized` — `" * : < > ? / \ |` → `_`/`-`, trimmed.
- `TC-DBSP-11 Reserved names` — each reserved form treated per rule 10.
- `TC-DBSP-12 400-char boundary` — 399 → content, 401 → placeholder link.
- `TC-DBSP-13 255-char segment truncation and 60-char pairing`.
- `TC-DBSP-14 Sanitization collision` — colliding names both present or `fail`.

**Permissions**
- `TC-DBSP-15 Role map exists and is scan-loaded`.
- `TC-DBSP-16 Editor is never satisfied by a read-level SharePoint role`.
- `TC-DBSP-17 No commenter outcome accepted`.
- `TC-DBSP-18 Nine grants, nine individual verdicts`.

**Team space**
- `TC-DBSP-19 Prefix applied for SharePoint destination` — identical prefixed paths for `sharepoint`
  and `googledrive` destinations from the same units.
- `TC-DBSP-20 Member listing failure reported, not passed`.

**Failure and persistence**
- `TC-DBSP-21 Graph 5xx → FAILED, zero pass`.
- `TC-DBSP-22 Mongo down → execution persists to JSON fallback and is readable`.
- `TC-DBSP-23 CloudFuze rejects job → FAILED with server message`.

**Regression (each combination named individually)**
- `TC-DBSP-24 dropbox→googledrive unchanged`
- `TC-DBSP-25 dropbox→googleshareddrive unchanged`
- `TC-DBSP-26 box→sharepoint unchanged`
- `TC-DBSP-27 box→onedrive unchanged`
- `TC-DBSP-28 googledrive→sharepoint unchanged`
- `TC-DBSP-29 googledrive→onedrive unchanged`
- `TC-DBSP-30 googleshareddrive→sharepoint unchanged`

**Documents**
- `TC-DBSP-31 In-scope document exists, names SharePoint, is not a copy of the Google document`.
- `TC-DBSP-32 Out-of-scope document exists and is non-empty or explicitly declares itself empty`.

## Assumptions

Written down rather than asked, because none of these changes the design.

- **A1** — "SharePoint" means SharePoint **Online** against the existing `SHAREPOINT_HOSTNAME` /
  `SHAREPOINT_SITE_PATH` site, the same target the two live SharePoint combinations use. Not SharePoint
  Server / on-premises.
- **A2** — The source is Dropbox **Business** (team namespace), the same account shape the two live
  Dropbox combinations seed; the team-space prefix logic is required, not optional.
- **A3** — The migration server is `qarelease.cloudfuze.com`, as for every other content combination.
- **A4** — The provider key is `dropbox` (already in use) and the destination key `sharepoint` (already
  in use). No new provider key is introduced, so this is one new combination, not two.
- **A5** — The seeded Dropbox data set is reused as-is (32 folders / 35 files / 6 versions / 2 links /
  9 grants). No new seeding capability is requested; if the SharePoint scope document demands data the
  seeder does not produce, that is new scope, not a silent extension.
- **A6** — OneDrive behaves identically to SharePoint for name/path rules, per the alias in
  `validation/destinations/sharepoint.js`. Relied on only for regression reasoning, not for shipping a
  Dropbox→OneDrive combination.
- **A7** — Existing content-run wizard, endpoints, polling and per-user `ownsExecution` scoping apply
  unchanged; no auth work is in this change.
- **A8** — Tolerance bands need real numbers. Until measured on a live run they are assumed to start
  from the Box→SharePoint bands, which share this destination — a starting point to be confirmed by the
  architect and a first run, not a validated value.
- **A9** — The `dropbox-to-google` open question (features 10.2, 10.6, 10.14, 10.15, 10.17, 10.18) is
  **not** inherited. The SharePoint scope document must answer for itself.
- **A10** — Delta migration is out of scope for the first release unless OQ-1's document says otherwise.
- **A11** — The combination is exposed to all users who can run content migrations today; no new
  permission or feature flag is introduced.

## Open questions

### Blocking — the work cannot be called complete until these are answered

- **OQ-1 (blocking) — Who supplies `dropbox-to-sharepoint-inscope.md` and
  `dropbox-to-sharepoint-outscope.md`, and by when?** Without them there is no feature list to enumerate
  and no documented-limitation list, so rules 6, 7, 19, 20 and 21 cannot be satisfied and the checklist
  rollup has nothing to roll up. The Google document must not be reused (F7). A source PDF equivalent to
  `Content_DropboxtoGoogle(MyDrive&SharedDrive)_(01-09-2026).pdf` is presumably needed.
  *Owner: QA / product.*
- **OQ-2 (blocking) — What is the expected destination outcome for each of the 19 Dropbox Paper features
  at a SharePoint destination?** `papertoGDoc=true` is Google-gated (F8) and this repo knows of no
  SharePoint equivalent. Possible answers — converted to `.docx`, migrated as an unconverted `.paper`
  file, skipped entirely, or out of scope — produce different verdicts for over half the Google
  document's features. **This is not an engineering guess.** *Owner: QA / product / CloudFuze.*
- **OQ-3 (blocking) — Is a Dropbox→SharePoint test-data document needed?**
  `dropbox-to-google-testdata.md` (195 lines) is the seeding contract for the Google pair. If the
  SharePoint scope adds features, the seeded set (A5) may not cover them. *Owner: QA.*

### Non-blocking — resolve at the design gate

- **OQ-4** — How is the 1,919-line Dropbox source-reading logic shared between two destinations without
  copying it? The constraint is F4/F5; the precedent is F6 (`validation/destinations/` extraction). The
  architect chooses; this document only forbids two near-identical 1,900-line files.
- **OQ-5** — Does CloudFuze need any job parameter for a Dropbox→SharePoint pair that this repo does not
  send today (the analogue of `pickInsideFolder` / `papertoGDoc` for the Google pair)? Evidence should be
  a network capture of the wizard's own call, not inference.
- **OQ-6** — Should Dropbox → OneDrive follow immediately, given the alias relationship (A6)? Out of
  scope here; asked so it is a decision rather than a surprise.
- **OQ-7** — Should the tolerance bands start from the Box→SharePoint bands (A8), or be measured from a
  first live run before any band is written down?

## Risks

- **R1 (highest) — the shared-source extraction.** The highest-risk file this touches is
  `backend/src/validation/combinations/content/dropboxToGoogledrive.js` (1,919 lines): it is the only
  home of the Dropbox source-reading logic **and** it is used verbatim by two live combinations (both
  `dropboxToGoogledrive.js` and `dropboxToGoogleshareddrive.js` require it). Any extraction to share it
  with SharePoint changes a file two passing combinations depend on. Mitigation: TC-DBSP-24 and
  TC-DBSP-25 must pass before the QA gate, and the design must state explicitly whether that file
  changes.
- **R2 — `deepContentCore.js` blast radius.** If the design touches it, all seven content combinations
  are affected and each must be verified individually. Its own header records that this was the original
  collision point.
- **R3 — shipping without the scope document.** Building a validator against an assumed feature list
  produces a checklist that passes on the wrong things. The recent Dropbox→Google commits are a record of
  exactly this: "six wrong verdicts … all found by comparing the report against the live destination
  rather than trusting it". OQ-1 is blocking for this reason.
- **R4 — guessed Paper verdicts.** The Google in-scope document records that a guessed rule produced a
  false failure on 92 ordinary notification emails, and another produced a pass reading "handled as
  documented" directly above a FAIL for the same thing. OQ-2 must not be guessed.
- **R5 — silent fallback to `ContentReportValidationAgent`.** Forgetting `supportsDeepValidation` yields
  a run that completes, reports, and compares nothing. Rule 3 and TC-DBSP-02 exist solely to catch it.
- **R6 — invisible tests.** A test file not appended to the `&&` chain in `backend/package.json` never
  runs and creates false confidence. Rule 22 and TC-DBSP-04.
- **R7 — combination invisible until restart.** `agentRegistry.js` populates once at first require, so a
  newly added combination file is not visible to a running server. Operational, but it will look like a
  bug to whoever tests first.

## Not doing

Explicitly rejected, recorded so they do not return as scope creep.

- **Copying `dropboxToGoogledrive.js` to `dropboxToSharepoint.js`.** Two near-identical 1,900-line files
  will drift, and a fix landing in one will not reach the other.
- **Copying or templating `dropbox-to-google-inscope.md` into a SharePoint version.** Its own header says
  features 5.1 and 7.1 "read very differently" for a Google destination; a renamed copy would encode the
  wrong expected behaviour for exactly the two features SharePoint is strictest about.
- **Inventing a Paper→SharePoint conversion target.** See OQ-2 and R4.
- **Adding a `papertoSharepoint`-style CloudFuze parameter on the theory that one exists.** See OQ-5.
- **Shipping Dropbox → OneDrive in the same change.** See OQ-6.
- **Modifying `validation/contentRoleMap.js`** to add the Dropbox→SharePoint pair. The scan-loaded
  `validation/roleMaps/` directory exists to avoid exactly that collision.
- **Backfilling or re-validating existing execution records.**
- **Adding a test runner, assertion library or any new dependency.**
- **Any deployment, CI or infrastructure work.** Out of scope for GStack by design.

---

*Status: `Draft`. Not approved. Requires a named human approver at the Requirements approval gate, and
answers to OQ-1, OQ-2 and OQ-3 before the work can be called complete.*
