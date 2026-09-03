# Session handoff — content migration QA, 27 Aug – 1 Sep 2026

Carried over from the VS Code Claude Code session `b3eb84f3-b701-4329-a69b-29794743b40b`
(2,026 messages). Written so any later session — in any client — can pick the work up without
re-reading that transcript.

Full searchable transcript: <https://claude.ai/code/artifact/19b4c8e7-a8fe-460d-91cc-44f3e5238521>

---

## 1. Where things stand

Branch `srinidh`, in sync with `origin/srinidh`. The Shared Drive → SharePoint work is committed
through `84d96b8`.

**Staged, not yet committed** — a `/api/scope` hardening pass:

```
backend/package.json                 (test wired into the && chain)
backend/src/routes/scopeRoutes.js
backend/src/services/scopeService.js
backend/test/scopeService.test.js    (new)
```

Suite green (26 files), lint 0 errors. Blocked only on the human commit approval:

```powershell
New-Item -ItemType File .claude\COMMIT_APPROVED
```

The GStack guard hook was found **fully commented out** on 1 Sep — every enforcement line disabled.
The user restored it. It is active again; verify `.claude/hooks/gstack-guard.js` starts with a live
shebang, not `// #!`, before trusting any guard claim.

---

## 2. Shared Drive → SharePoint — settled findings

Last full run: **30 pass · 3 fail · 4 NA · 1 info**, two independent validations agreeing exactly.

### Confirmed CloudFuze defects — report these, do not try to fix

| # | Defect |
|---|---|
| `12.1` | File conversion. `.doc/.xls/.ppt` are not upgraded to `.docx/.xlsx/.pptx`. Identical on both drives. |
| `11.1` / `11b` | Content relocated for exceeding the 400-char path limit **loses its sharing**. Proved on QA_Team2: SharePoint may legitimately refuse an *anonymous* link, so QA_Team1 alone proved nothing — but an *organization* link cannot be refused, and QA_Team2 lost that too. |

### Validator bugs found and fixed in our own code

- User permissions auto-passed — any group on an item could satisfy a missing user grant, and
  `QA Members` / `QA Owners` sit on every item.
- Inherited source grants were counted per item (no `permissionDetails`), inflating totals to
  618/878 from a handful of real grants.
- A library-root grant to the everyone-group made all folders show identical access, so the
  permission test proved nothing until it was removed in SharePoint.
- Graph omits the download URL when it is named in `$select` — a latent bug that would have
  silently broken Tier B file verification.
- PDF report: text overlap (27 → 0, measured) and rows splitting across pages. Locked in by
  `contentPdfReport.test.js`, which fails against the old code.
- The organization-link idempotency check returned early and skipped removal, so a public link
  survived every run.

### Expected WARNs — have the answer ready

- `8d` effective access exceeds the migrated role (2 users) — a group on the same folder grants
  more than the person's own permission. The migrated permission is correct; SharePoint's
  *Manage Access* screen shows the effective total. Not a failure.
- `8e` drive-wide roles inherited by every item — informational, Google's own behaviour.
- `Long File Names` folder — created by CloudFuze on every run, documented behaviour, now in the
  cleanup allowlist so copies stop accumulating.

---

## 3. Next piece of work — Dropbox

Two new combinations, split between the user and a teammate:

```
user:     dropbox → google shared drive
teammate: dropbox → google my drive
```

**This is the first time the destination is not Microsoft.** Every existing content combination
targets SharePoint or OneDrive.

### Already done

- `backend/data/feature-scope/dropbox-to-google-inscope.md` — 36 features
- `backend/data/feature-scope/dropbox-to-google-outscope.md` — 1
- `backend/data/feature-scope/dropbox-to-google-testdata.md` — mined from 5,905 Xray cases under
  `/Dropbox For Business to Google SharedDrive/` and `/…Mydrive/`. Note: **delta is the majority
  of those cases, not a footnote.**

### Collision problem — solved for destinations, not for roles

Destination rules were hard-coded to SharePoint inside `deepContentCore.js`. They are now extracted
to one file per destination, auto-loaded:

```
backend/src/validation/destinations/index.js
backend/src/validation/destinations/sharepoint.js   ← default, so nothing changed
backend/src/validation/destinations/googledrive.js
```

SharePoint stays the default, which is why `box→sharepoint` and `googledrive→sharepoint`
behaviour is provably unchanged — verified against a 159-line behavioural baseline
(`backend/bl.tmp.js`, scratch, do not commit) plus `backend/test/destinationRules.test.js`.

Adding a destination is now a new file, never an edit to shared code.

**Still shared and still a collision risk:** `backend/src/validation/contentRoleMap.js` holds
per-pair role tables in one file. Same treatment would fix it.

### Does not exist yet — someone must build it

| File | Owner |
|---|---|
| `backend/src/clients/dropboxClient.js` | one person builds, both use |
| `backend/src/agents/dropbox/DropboxTestDataAgent.js` | one person builds, both use |

Then each person owns their own, never touching the other's:

```
orchestrator/combinations/content/dropboxTo<Dest>.js
validation/combinations/content/dropboxTo<Dest>.js
utils/contentTolerance/dropbox_to_<dest>.js
```

This is the pattern the repo already uses — `BoxTestDataAgent` serves 2 combinations,
`DriveTestDataAgent` serves 3. Box is the closest template.

A new external integration routes through GStack (`new-feature.yaml`), not direct mode.

**The teammate must branch from `srinidh`, not `main`.**

---

## 3b. Dropbox → Google Shared Drive — built 1 Sep, seeding proven live

**Combination (2 new files, no shared logic copied)**

- `orchestrator/combinations/content/dropboxToGoogleshareddrive.js` — registration reusing
  `DropboxTestDataAgent` + the My Drive validator, mirroring how `googleshareddriveToSharepoint`
  reuses `googledriveToSharepoint`.
- `test/dropboxToGoogleshareddrive.test.js` — 5 checks, wired into the `&&` chain.

**One-line wiring fix.** `destinationSharedDriveName` was read by
`GoogleDriveValidationAgent.resolveDestinationRoot()` and set by nothing in the repo — the source
side has full wiring, the destination side had none. It now falls back to the first segment of the
run's `destinationPath`, which the wizard already collects. Scoped to the `googleshareddrive`
branch, so no SharePoint combination and no My Drive run can reach it.

**Four seeding bugs found on the first live Dropbox run and fixed** — 6 errors → **0**:

| Bug | Fix |
|---|---|
| `createFolder` returned `type: 'file'` — `files/create_folder_v2` sends bare FolderMetadata with no `.tag`, so every folder grant went to `add_file_member` → `access_error/is_folder`, silently losing all folder permissions | supply the tag the endpoint omits (`dropboxClient.js`) |
| `desktop.ini` in `RESERVED_STYLE_NAMES` — Dropbox refuses it (`path/disallowed_name`), an unguarded throw that killed the run at row 10 of 12 | moved to `DROPBOX_DISALLOWED_NAMES`, reported via `notSeeded` |
| `share_folder` → `bad_path/already_shared` on the second grant to any folder, losing every group grant | treat as success, read `shared_folder_id` from `files/get_metadata` (**not** `sharing/list_folders` — it omits `path_lower` for unmounted folders) |
| Account restrictions reported as errors every run | classified as `notSeeded` with the measured reason |

**Two account limits, measured not assumed.** Folder member editor works; **file** member editor
fails (`no_permission`), and **editor links fail on both files and folders**
(`settings_error/invalid_settings`) while viewer links succeed on both. Also
`cant_share_outside_team` — the team policy blocks external folder shares, so scope 2.5 is
untestable until an admin enables it. All reported as NOT SEEDED so the validator can never mark
these as passing on evidence that was never created.

**Verified live** (`erik@filefuze.co`, `/QA-Automation`): 32 folders, 35 files, 6 versions, 2 links,
9 grants, **0 errors**, 10 documented gaps. Root folder members read back as
`erik owner · ben editor · QA-Automation group viewer`.

**Still blocked on one thing:** the destination Shared Drive does not exist. Create it with a
collision-proof name — Erik sees 1,000+ drives and `resolveSharedDriveByName` takes the **first**
name match silently, with **40 duplicate names** already in that tenant. Then set the wizard's
destination path to `/<that name>`.

## 3c. Dropbox connector in the UI — built 1 Sep

Dropbox showed "coming soon" in Connect Clouds and had no card in the run wizard, so it could not be
selected as a source. Three gaps, all closed by mirroring the **Box** OAuth flow rather than
inventing a new pattern:

| Gap | Fix |
|---|---|
| no card to click | `steps.jsx` `cardFor('dropbox')`; `ConnectClouds.jsx` tile gains `account: 'dropbox'` |
| no account would appear | `oauthTokenStore` gains a `dropbox` section (read defaults, Mongo hydrate, get/set/remove/status, `getAllConnectedAccounts`) |
| Step 2 could not list users | `USER_LISTING_PROVIDER.dropbox = 'dropbox'` + a branch calling `dropboxClient.listTeamMembers()`, filtering out `invited` members who cannot receive a share |

New routes `GET /api/auth/dropbox/url`, `GET /api/auth/dropbox/callback`,
`POST /api/auth/dropbox/signout` in `authRoutes.js`. `connectBox`/`connectDropbox` in the wizard hook
now share one `connectViaPopup(getUrl)` helper instead of two copies of the same polling loop.

Two Dropbox-specific details, both of which fail misleadingly when wrong:
`token_access_type=offline` (without it Dropbox returns only a 4-hour token and no refresh token),
and `users/get_current_account` rejecting any `Content-Type` header on an argument-less RPC.

**Requires a one-time Dropbox app setting:** the redirect URI
`http://localhost:5000/api/auth/dropbox/callback` must be added under the app's OAuth 2 Redirect
URIs, or the popup fails with a redirect-uri mismatch.

Verified live: the authorize URL builds correctly, `/api/auth/status` reports the dropbox key, and
the user-listing endpoint returns the 8 active team members.

## 3d. Dropbox migration blocker — 6 backend runs, 2 Sep

**The blocker is CloudFuze's Dropbox source scan, not our code.** Every job reaches `PROCESSED` /
`PARTIALLY_COMPLETED` with `totalFilesAndFolders=0` and `totalPairsCount=0`, while `previewDetail`
does list the erik→erik pair. The downloaded CSV report calls it `CONFLICT` with no end time.

Contrast on the same server:

| pair | result |
|---|---|
| `DROPBOX_BUSINESS → GOOGLE_SHARED_DRIVES` | 5 jobs, total 0 |
| `DROPBOX_BUSINESS → G_SUITE` (My Drive) | 1 job, total 0 |
| `GOOGLE_SHARED_DRIVES → SHAREPOINT_ONLINE_BUSINESS` | COMPLETED, 108k–126k items |

**Ruled out with evidence, not assumption:**

- `fromRootId` — tried the path, a real Dropbox folder id, and omitted entirely
- `destinationFolderName` — `""` and the string `"null"`
- `pickInsideFolder`, `teamFoldersMigrate`, `papertoGDoc`, `sharedContent/fusionTables/drawings/unsupportedFiles`
- the `preview` call before start (HTTP 200; added to the code, harmless)
- **destination type** — My Drive fails identically, so the destination is not the variable
- `mapped=false` — appears in all 73 log occurrences, including the runs that moved 126,165 items
- `Source Path Review: UNVALIDATED` — correlates with the **route**, not with success: the FOLDER
  route reports PASS/CREATED, every isCSV job reports UNVALIDATED, and Box→SharePoint isCSV jobs
  did scan

Our create/job payload is byte-identical to the wizard's own, captured from its `FolderChecked`
localStorage key while configuring this exact pair.

**Not yet done, and it is the decisive test:** no UI-started Dropbox job has ever run. Job
`6a97e901…` / `Onetime-DBFB-…-132` reached Preview and stopped, so it is absent from the job list.

**Two open leads for whoever owns the CloudFuze content service:**

1. `mapping/user/clouds/get/permissions` reports **`provisionedUser: false`** for erik on both
   sides of this pair. `contentMappingVerdict` treats a literal `false` as a blocker, but the
   `cache/list` row omits the field, so our validation passes. An unprovisioned user may be why the
   scan has no member context.
2. Our `/QA-Automation` lives in erik's **member** Dropbox (seeded with `Dropbox-API-Select-User`).
   If the scanner reads the team space instead, it would find nothing — exactly what is observed.

The one call the wizard makes that we still do not: `PUT move/newmultiuser/update/restriction/<jobId>`.
Its body was never captured; an empty `{}` returns HTTP 500, so it is deliberately not sent.

### Also fixed on 2 Sep

- **`findCloudId` resolved `googledrive` to BOX.** My Drive registers as `G_SUITE`; the provider key
  shares no prefix with it, so the cross-type fallback picked the first cloud carrying the same
  email. A `dropbox → googledrive` run would have **migrated into Box** with only a warning — this
  hits the My Drive combination, which has never run live. Fixed with a hint alias; Shared Drive and
  Box resolution unchanged.
- **`useExistingSource` had no Dropbox branch**, so it fell through to migrating `/` — the whole
  account. Added, with member context and a refusal on the account root.
- Iterating is now `node scripts/tmp-run-dropbox-gsd.js reuse` (skip seeding, ~1.2 min) and
  `… reuse mydrive` (swap the destination). That script is a throwaway harness — delete before commit.

## 4. Environment gotchas that cost time before

- **Google OAuth tokens expire every 7 days.** An `invalid_grant` on a Google-source run is an
  expired token, not a code regression. Reconnect in wizard Step 1.
- **MongoDB Atlas is IP-allowlisted.** From outside the office network, replaying a saved execution
  fails — that run lives only in Atlas. Everything else works.
- `erik@filefuze.co` does **not** support Domain-Wide Delegation, so the "admin email, no sign-in"
  modal cannot add it.
- Use `localhost:3000`, not `127.0.0.1:3000` — Vite binds IPv6 only.
- Step 2 user pairing is really a **mail** concept. Content needs exactly one pair: the admin.
  `erik` must be in it; the 5 auto-matched users are not a substitute.

---

## 5. Open, none blocking

- `backend/data/executions.json` is **tracked on `main`** — 343,043 lines of runtime execution data
  in git history. Branch `srinidh` deletes it, which is right, but deletion does not remove it from
  history. Team decision.
- `/api/scope` had a missing-auth hole; the staged change addresses it. The route probably wants
  `requireUser` too — flagged, deliberately not done, since auth changes route through GStack.
- `backend/bl.tmp.js` is a scratch baseline script. Delete or keep untracked; never commit.
