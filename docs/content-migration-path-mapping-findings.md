> **STATUS: SOLVED 24 Aug 2026 — see "SOLVED" at the end of this file. The cause was a missing `fromRootId` on the create/job pair (commit `7804829`). Several conclusions in the body below were disproved and are corrected there.**

# Content migration: why it has never moved a file, and what is still missing

**Date:** 22 Aug 2026 · **Combination:** Google Shared Drive → SharePoint · **Server:** `qarelease.cloudfuze.com`

---

## Summary

Content migration has **never** worked in this project. 28 content runs since 22 June — Box→SharePoint
and Shared Drive→SharePoint — every one moved **zero** files. This is not a regression.

The cause is a step of the CloudFuze Team Migration flow that our client never implemented: the call
that maps **source folder → destination folder**. We only ever mapped **users**. CloudFuze therefore
knew *who* to migrate but never *what*, so its scan returned nothing and every job reported
`Total: 0 … 0.00 Bytes` while still creating the destination folder.

Two of the three parts are now fixed and verified. One remains, and it is a single named call.

---

## What was wrong

`backend/src/clients/migrationClient.js` documents the flow at the top of `triggerMigration`:

```
1. POST /mapping/user/path/csv — upload path-based CSV mapping
2. POST /move/newmultiuser/create/job
3. PUT  /move/newmultiuser/update/{jobId}
4. POST /move/newmultiuser/create/{jobId}
```

Step 1 was never written. The only CSV uploaded was `manualmapping/csv`, which maps users.

---

## Fixed and verified

### 1. Step 1 is now implemented

`POST /proxyservices/v1/mapping/user/path/csv?sourceCloudId=…&destCloudId=…`

Body (raw CSV, CRLF line endings):

```
Source User,Source Folder,Destination User,Destination Path
erik@filefuze.co,/Agent Shared Drive,granger@gajha.com,QA/Documents
```

### 2. `Content-Type` must be `*/*`

This is the non-obvious part. The endpoint silently ignores most content types — it returns
HTTP 200 with an empty result for a valid CSV, for garbage, and for an empty body alike:

| Content-Type | Result |
|---|---|
| `application/json` | 200, body **never read** (identical empty response for CSV / garbage / empty) |
| `text/csv`, `text/plain`, `application/octet-stream`, `application/csv` | 500 |
| `multipart/form-data` | parser reads the MIME headers as CSV rows, stops at the blank line before the content |
| **`*/*`** | **works — `cfMappingCachesList` returns populated** |

### 3. Confirmed correct values

With `*/*` the mapping registers cleanly (`mappings=1, errorLines=0`) and CloudFuze echoes:

```
sourceCloudDetails: emailId erik@filefuze.co   folderPath "/Agent Shared Drive"   rootFolderId "/"
destCloudDetails:   emailId granger@gajha.com  folderPath "/QA/Documents"         rootFolderId "200"
```

- The hardcoded `toRootId: "200"` for SharePoint is **correct**.
- CloudFuze normalises the destination path itself (`QA/Documents` → `/QA/Documents`).

---

### 4. The job-create pair was taking the wrong route (`folder` vs `isCSV`)

Obtained by reading CloudFuze's own wizard source — see *Reading the wizard source* below.

`multiUserMapping.js` builds the `create/job` pair two mutually exclusive ways:

| Route | Sent when | Payload |
|---|---|---|
| Folder-picker | the user picked a folder in the UI tree | `folder:"true"` + real `fromRootId`/`toRootId` |
| **Path CSV** | the pair came from a path CSV | **`isCSV:"true"`** + `sourceFolderPath`/`destFolderPath`, **no root ids** |

We were mixing them: uploading the path CSV, then asking for the folder-id route with
`folder:"true"`. That is why the registered mapping was never consumed (`mapped:false` — nothing
read it) and why the scan treated the Shared Drive folder id as one opaque object, reporting
`Total No of Files/Folders: 1`.

Fixed — `workspacePairs` in `migrationClient.js` now matches the UI's general isCSV shape exactly
(`multiUserMapping.js` ~16800): cloud ids, both paths, `destinationFolderName`, `teamFolder`,
`isCSV:"true"`, and nothing else. `fromMailId`/`toMailId` and both root ids are dropped — the UI
sends none of them on this route.

**The server now accepts the route** (job `6a8984ff7371a25e3aa6b48b`): the response echoes
`isCSV: true` and `previewDetail` is populated with the pair, where it was `null` before.
**Still 0 files migrated.**

---

## What is still missing

Two signals from the first isCSV job that were not visible before:

```
totalPairsCount : 0          ← pair is attached but carries no work
previewDetail   : [{ fromEmailId: erik@filefuze.co, fromProvision: false, toProvision: true }]
```

`fromProvision: false` is worth chasing: the wizard warns, in as many words,
*"Non provisoned users will not migrate"* (`multiUserMapping.js` step 6). Our own pre-flight check
passes the pair because `sourceCloudDetails.provisionedUser` is not `false` on the mapping row —
a different field from the `fromProvision` the job reports. Whether a Shared Drive source is
expected to be "provisioned" at all is a question for the team.

### Superseded: the pre-scan hypothesis

An earlier draft argued the source cloud was never pre-scanned (`preScanStatus: null`). The wizard
source shows no pre-scan call anywhere in the content flow, so that explanation is dropped. It was
an inference from the mail code, not evidence.

### Reading the wizard source (how to redo this)

No DevTools capture is needed. The Team Migration UI is unminified and served publicly:

```bash
curl -sO https://qarelease.cloudfuze.com/ajaxcalls/multiUserMapping.js
```

1.7 MB, readable. `grep -n 'apicallurl + "' multiUserMapping.js` lists every endpoint the UI calls;
`createJob` (~6146) and the mapping-row object builders (~16800) define the exact payload shapes.
This is the authoritative reference for anything the API does not document.

### Older note: the registered mapping stays unvalidated

```
mapped: false      validationStatus: false      isValidate: false
fromRootId: null   toRootId: null               pathRootFolderId: null  (both sides)
```

Something must **validate** the mapping — resolve `folderPath` into a real folder id and set
`mapped: true`. In the UI this is what fills the *Source Path Review* / *Destination Path Review*
columns. Until it happens the migration has nothing to act on.

### Strongest hypothesis: the source cloud has never been pre-scanned

CloudFuze's own record for the source cloud says it has no index of the content:

```
GOOGLE_SHARED_DRIVES (erik@filefuze.co)
   cloudStatus     = "ACTIVE"
   filesCount      = 0
   foldersCount    = 0
   syncStatusFlag  = false
   preScanStatus   = null        ← never pre-scanned
   lastRefreshTime = 2026-08-12
```

This matches a failure mode this repo already documents — for **mail**, in
`agents/migration/MigrationAgent.js`:

> "Indexes source mailbox folder structure so /email/move/initiate can resolve sub-folder IDs.
> **Without this, only root-level folders migrate** …"

Which is exactly what we see: the root folder arrives, nothing beneath it (`Total: 1`, the folder
alone). Mail solves this with `POST /email/mail/move/initiate/preScan`. **Content appears to need an
equivalent, and our flow never calls one** — `preScanStatus` is `null` on all three content clouds
(Shared Drives, SharePoint, Box), and none of them has ever migrated successfully.

Note `filesCount: 0` alone is not conclusive — the destination SharePoint cloud also reports 0 and
CloudFuze can clearly write to it. But combined with `preScanStatus: null` and the documented mail
behaviour, a missing content pre-scan is the best-supported explanation remaining.

### The question for the team

> **A path-CSV job (`isCSV: true`) is created and accepted, `previewDetail` shows the pair, but
> `totalPairsCount` stays 0 and nothing migrates. What attaches the work to the pair?**
> Related: the pair reports `fromProvision: false` for a Google Shared Drive source — is that
> expected, and does it silently skip the pair?

### What has been ruled out

- **Endpoint names probed** (`…/validate`, `…/review`, `…/mapplist`, `…/save`, `…/confirm`, POST and
  PUT variants) — all return `NoSuchMethodError … findTargetMethod`, i.e. the endpoint does not exist.
  *(On this server a missing JAX-RS method surfaces as HTTP 500, not 404 — useful discriminator.)*
- **Swagger / WADL** — `/proxyservices/v1/api-docs` exists but is broken:
  `NoClassDefFoundError: javassist/bytecode/ClassFile`. No API listing available.
- **`fromRootId: "/"`** (matching CloudFuze's own `rootFolderId`) — tried, no files.
- **Source path variants** — `/Agent Shared Drive`, `/QA_TeamDrive/Agent Shared Drive`,
  `QA_TeamDrive/Agent Shared Drive`, `/QA_TeamDrive`, `/` — the CSV records each verbatim without
  resolving any of them, so the upload is a record step only.
- **`preMigration=true`** as a job option — not accepted (absent from the job response).
- **~60 endpoint names** probed in total, including pre-scan / sync / refresh variants.
- **`pickInsideFolder=true`**, **`teamFoldersMigrate=true`**, **drive-id as `fromRootId`** — each tried
  individually; all produced `Total: 0` or `Total: 1` (the folder alone). Unproven; see below.

---

## Also found

**`unmapped/list` creates a duplicate mapping.** After the path CSV registers one row, our existing
`POST /mapping/user/unmapped/list` adds a **second** row (`cache/list` then returns 2). Neither is
validated. This should probably be removed once the validation call is known.

**`CONTENT_MIGRATION_SERVER_EMAIL` in `.env` was stale** — it pointed at an account whose `getClouds`
returns 403, which is why the app only worked with credentials typed into the wizard.

---

## Evidence — job IDs on qarelease

| Job | Change under test | CloudFuze report |
|---|---|---|
| `6a88539a7371a25e3aa6aad8` | baseline | `Total: 1` — the folder only, 0.00 Bytes |
| `6a885ddc7371a25e3aa6ab66` | `pickInsideFolder=true` | `Total: 0` |
| `6a8873097371a25e3aa6ab82` | drive id as `fromRootId` | `Total: 0` |
| `6a8877367371a25e3aa6ab8f` | `teamFoldersMigrate=true` | `Total: 0` |
| `6a896ed77371a25e3aa6b3f3` | path CSV added (wrong Content-Type) | `Total: 0` |
| `6a8978c37371a25e3aa6b427` | path CSV with `*/*` — mapping registers | 0 files |

Source in every case: `QA_TeamDrive / Agent Shared Drive`, 79 items / 37 files, verified present via
the Google Drive API.

---

## Reproducing quickly

`backend/scripts/content-migration-probe.js` runs **only** the migration step against existing data —
no seeding, no validation, no ticket. ~90 seconds instead of ~7 minutes.

```bash
cd backend && node scripts/content-migration-probe.js            # run it
cd backend && node scripts/content-migration-probe.js --dry-run  # resolve only, migrate nothing
```

It prints what is in SharePoint before and after, so the verdict is unambiguous.

---

## State of the code

Uncommitted. Verified changes worth keeping:

- `migrationClient.js` — path CSV upload with `Content-Type: */*` (**the main fix**)
- `migrationClient.js` — `isContentServer()`; skips five mail-only `/email/*` calls that returned
  HTTP 500 on the content server
- `googledriveToSharepoint.js` / `SharePointValidationAgent.js` — validation now reports failures
  truthfully instead of returning SUCCESS with nothing compared

Unproven experiments that should be reverted or clearly marked before committing:

- drive id as `fromRootId`
- `teamFoldersMigrate=true`
- `pickInsideFolder=true` (semantically right, but never demonstrated to change the outcome)

---

## Update — 24 Aug 2026: the validation call, and what it ruled out

Reproduced first (job `6a8bfbbd7371a25e3aa6b4b1`, #71): unchanged — `totalPairsCount: 0`, poll
`PROCESSED`, 0 items in SharePoint. Nothing had regressed.

### The mapping-validation call, found

The doc above asks what validates the registered mapping. It is a **pair** of calls, both POST, taken
from the wizard (`multiUserMapping.js` — `fetchCsvValidationStatus` ~22215,
`fetchNewValidationStatus` ~22253):

```
POST /mapping/download/csvcreator/{csvId}/asynchronous?userId=…&sourceAdminCloudId=…&destAdminCloudId=…&csvName=…&first=true
POST /mapping/check/csvvalidationstatus/{csvId}?userId=…&sourceAdminCloudId=…&destAdminCloudId=…
```

- `csvId` is the **small integer** `csvId` on the mapping row (e.g. 320), **not** the Mongo `id` — the
  Mongo id returns HTTP 500. `GET` returns 500 on both; it must be POST.
- The first call starts validation, the second polls it. Calling the second alone returns
  `"Your Request is under processing Total Saved Count :0"` and validates nothing. With the first, the
  count becomes `:1` and the poll answers `"CSV report is ready"` — usually on poll 1.
- Neither name appears in the ~60 endpoints probed earlier, which is why they were missed.

**It does not fix the migration.** With validation confirmed ready, `create/job` still returns
`totalPairsCount: 0` and `mapped` stays `false` (`fromRootId` / `toRootId` / `pathRootFolderId` all null).

### The mapping row states the reason a pair cannot migrate — and we never read it

The row carries `provisionedUser`, `licenced`, `failMapping`, `pathException` and a plain-English
`userErrorDescription`. None were read. Probing every known destination user:

| Destination user | provisionedUser | licenced | userErrorDescription |
|---|---|---|---|
| `granger@gajha.com` | true | false | *(none)* |
| `warner@gajha.com` | **false** | false | **"Please Make this  as Licensed user"** |

So `warner@gajha.com` is genuinely unusable as a destination until licensed. **But
`granger@gajha.com` passes CloudFuze's own provisioning check and its job still reports
`totalPairsCount: 0`** — so licensing does not explain the original failure. Both users show
`licenced: false`, so that field alone does not gate migration either.

### Also ruled out

- **Source access.** `GET /filefolder/userId/{userId}/cloudId/{srcCloud}?folderId={id}` returns the
  real tree — QA_TeamDrive contains "Agent Shared Drive", which contains its 10 subfolders. CloudFuze
  can read the Shared Drive. (`/displayfolder` returns 500 for this cloud; drilling by `folderId` works.)
- **`filesCount` / `preScanStatus` on the cloud record.** They stay `0` / `null` even after CloudFuze
  successfully enumerates the drive, so they do not indicate whether the source is indexed, and the
  pre-scan inference drawn from them does not hold.
- **`fromProvision: false` on the job.** The wizard only renders a "Not Provisioned" badge for
  `ONEDRIVE_BUSINESS_ADMIN` / `BOX_BUSINESS` sources (`multiUserMapping.js` ~13708), never for
  `GOOGLE_SHARED_DRIVES`, and even then it is an `alertSuccess` toast, not a block. The mapping row
  reports `provisionedUser: true` for the same user.
- **`POST /move/newmultiuser/rootfolderid/{jobId}`.** Looks like the missing path-resolution step;
  `migrationIntnRootFolder` is defined at `multiUserMapping.js:10373` and **never called**. Dead code.
- **`/mapping/user/path/csv/nonmapped`.** Used only for five specific combinations
  (`multiUserMapping.js` ~16323); `GOOGLE_SHARED_DRIVES → SHAREPOINT_ONLINE_BUSINESS` correctly takes
  the plain `path/csv` route already in use.

### Fixed in this pass — the run no longer reports success

Three independent places manufactured a green light. All three are now closed:

1. **`CSV VALIDATION … PASS ✓` was our own invention.** It was set whenever `unmapped/list` returned a
   row — which it does for an unvalidated mapping too. Replaced with the real csvcreator +
   csvvalidationstatus sequence, and the verdict now reads CloudFuze's fields. A null
   `sourcePathReview` / `destPathReview` reports **UNVALIDATED**, never PASS.
2. **The zero-pair guard read `previewDetail.length` (1), not `totalPairsCount` (0).** Every job in
   this project's history passed it. It now checks `totalPairsCount` and throws.
3. **A terminal `PROCESSED` with zero processed items was returned as success.** It now returns
   `PROCESSED_EMPTY`, wired into `CONTENT_STOP_STATUSES` in `MigrationAgent.js`.

Also: **`unmapped/list` was the source of the duplicate mapping row** noted earlier — it is gone, and
`cache/list` now reports 1 row for 1 uploaded pair. The `create/job` pair matches the wizard's `isCSV`
shape: `destinationFolderName` carries the row's real value (or actual `null`, not the string
`"null"`) and `teamFolder` is dropped — the wizard sends it only on the DROPBOX→G_SUITE variant.

Regression cover: `backend/test/contentMappingVerdict.test.js` pins the pass/fail rule against real
captured rows, wired into the `&&` chain in `backend/package.json`.

The probe gained `--read-as`, separating the Google account used to *read* the Shared Drive from the
user being *migrated*: an external member on another Google domain (e.g. `warner@snapbot.io`) has no
stored token here, so reading the tree as them failed before CloudFuze was reached.

### The question for the team — narrowed

> For `GOOGLE_SHARED_DRIVES → SHAREPOINT_ONLINE_BUSINESS`, a path-CSV mapping uploads cleanly
> (`errorLines: []`), CloudFuze's own validation completes (`"CSV report is ready"`), the destination
> user is provisioned with no `userErrorDescription`, and CloudFuze can enumerate the source folder
> via `/filefolder`. Yet the mapping row keeps `mapped: false` with
> `fromRootId` / `toRootId` / `pathRootFolderId` null, and the resulting `isCSV` job reports
> `totalPairsCount: 0`. **What sets `mapped: true` and resolves `folderPath` into `pathRootFolderId`?**
> Is the path-CSV route supported for this combination at all, or must this pair go through the
> folder-picker (`folder:"true"`) route?

### Still open, unrelated to the above

- The primary login 403s on every run (`/app/login`, md5-noEnt) and silently falls back to Basic auth
  via `validateUser` as a **different** account. It works by accident.
- The root `.env` defines `CONTENT_MIGRATION_SERVER_EMAIL` **twice** (lines 111 and 136) with
  different values and the same password; line 136 wins.
- `findCloudId` silently falls back to a cloud-name match when the email matches no cloud, so naming a
  per-user email that is not itself a registered cloud quietly runs as the admin cloud instead.
- `getPermissionMapping` returns HTTP 500 on this server.

---

## ROOT CAUSE — 24 Aug 2026: CloudFuze cannot see the destination site

The destination we have been migrating into does not exist as far as CloudFuze is concerned.

`GET /filefolder/userId/{userId}/cloudId/6a7c3b2691272c41fc9d7bcf?page_nbr=1&page_size=100` returns
**192 entries, all `type: SITE`**. The QA site is not one of them:

```
Graph QA site id : trydemos.sharepoint.com,8dbd2476-42fb-4e37-bbf9-8a49f99823af,184bda00-a152-4ef8-b959-0342bb959687
entries containing 8dbd2476-42fb-4e37-bbf9-8a49f99823af : 0
```

### Why — from CloudFuze's own response

A raw entry carries the pagination cursor it is walking:

```json
{
  "id": "/6a7c3b2691272c41fc9d7bcf/trydemos.sharepoint.com,464e6296-…,a5091e9c-…:SITE",
  "objectName": "Anonymous",
  "type": "SITE",
  "nextPageToken": "https://graph.microsoft.com/v1.0/gajha.com/users/cb41c31d-c08a-4fe0-91ab-283470949755/memberOf?$top=3&…:TEAM_SITE"
}
```

CloudFuze enumerates destination sites through **`/users/{destinationUser}/memberOf`** — only the
sites that user is a **member** of. `granger@gajha.com` is not a member of the QA site, so CloudFuze
never lists it, cannot resolve `QA/Documents`, and produces:

- `mapped: false` on the mapping row
- `destCloudDetails.pathRootFolderId: null`
- `totalPairsCount: 0` on the job, with the pair still echoed in `previewDetail`

Every symptom in this document follows from that one fact.

### Why it looked like the destination existed

Our own SharePoint reads use **app-only Graph credentials**, which are not scoped by user membership.
That is why `sharepointClient` can `getSite` the QA site, list `/Agent Shared Drive`, and create
folders there, while CloudFuze — acting as `granger@gajha.com` — cannot see the site at all. The
destination folder observed in earlier runs was created by our code, not by the migration.

### The fix

Add `granger@gajha.com` as a **member** (or owner) of the `trydemos.sharepoint.com/sites/QA` site, then
re-list: the site should appear among the destination entries. Alternatively, migrate into a site
granger already belongs to — any of the 192 already listed.

This is a tenant/permission change, not a code change. Until it is done, no mapping style can work,
because there is no resolvable destination.

### Consequence for the route choice

`toRootId: "200"`, hardcoded for SharePoint throughout `migrationClient.js`, is **not a valid id in any
case**. Real destination ids have the form:

```
/<cloudId>/<graphSiteId>:<TYPE>          TYPE ∈ { SITE, DOCUMENT_LIBRARY, FOLDER }
```

The wizard depends on that `:TYPE` suffix — for this exact combination it splits `toRootId` on `:` and
branches on `FOLDER` / `DOCUMENT_LIBRARY` (`multiUserMapping.js` ~16987):

```js
if (srccldname === "GOOGLE_SHARED_DRIVES" && dstncldname === "SHAREPOINT_ONLINE_BUSINESS") {
  if (dstnrt.split(':')[1] === "FOLDER" || dstnrt.split(':')[1] === "DOCUMENT_LIBRARY") {
    _obj = { fromCloudId, toCloudId, fromRootId, toRootId, sourceFolderPath, destFolderPath,
             destinationFolderName: "null", folder: "true",
             documentLibrary: <parentName> };      // extra field, only on this branch
  }
}
```

Note this is the **folder route** (`folder: "true"`), and on it `destinationFolderName` really is the
literal string `"null"` — unlike the `isCSV` route, which sends the mapping row's own value. The
`documentLibrary` field has never been sent by us at all.

So the sequencing is: fix the site membership first, then take the folder route with a real composite
`toRootId` obtained from `/filefolder` — not the path-CSV route, whose only job was to make CloudFuze
resolve a path it cannot resolve.

### Reproducing

```bash
cd backend && node scripts/content-migration-probe.js --dry-run
```

The site-visibility check is not yet in the probe; it was established with ad-hoc calls to
`/filefolder/userId/{userId}/cloudId/{destCloud}`. Worth adding as a pre-flight assertion: if the
destination site is absent from that list, fail immediately with "CloudFuze cannot see destination
site X — add {destUser} as a member" rather than starting a job that cannot move anything.

---

## Folder route tested with a real destination — and the second blocker

The destination-visibility finding above is real but is **not the only blocker**. Tested directly.

### The test

A site `granger@gajha.com` *is* a member of, with its `Documents` library id read from `/filefolder`:

```json
{
  "fromCloudId": { "id": "6a7cb057dd48f370c24ed292" },
  "toCloudId":   { "id": "6a7c3b2691272c41fc9d7bcf" },
  "fromRootId":  "1zSXdqgQA7zlSa-zMBrqv0gH6SyIwNHq5",
  "toRootId":    "/6a7c3b2691272c41fc9d7bcf/b!lmJORjvwqEmVu-dnGschxZweCaXI8MFKngpKnszh5t3IV6c-6TBiQr3IW3_COCc0:DOCUMENT_LIBRARY",
  "sourceFolderPath": "/Agent Shared Drive",
  "destFolderPath": "/",
  "destinationFolderName": "null",
  "folder": "true",
  "documentLibrary": "Documents"
}
```

Job `6a8c0b6b7371a25e3aa6b507`.

### What changed — the job actually ran

Every prior content job reached `PROCESSED` **instantly**, having done nothing. This one went
`NOT_PROCESSED → IN_PROGRESS` and stayed `IN_PROGRESS` for over three minutes before reaching
`PROCESSED`. CloudFuze was doing work for the first time. So the folder route with a resolvable
`toRootId` is materially better than the path-CSV route, and is the route to keep.

### What did not change

`totalPairsCount: 0` throughout; `/move/movereport` and `/move/filefolderinfo/movereport` both return
`[]`; 0 items at the destination.

### The second blocker — the source has never been indexed

`GET /move/newmultiuser/get/list/{jobId}` reports, on the **source** cloud:

```
folderStructureReport : "NOT_PROCESSED"
filesCount            : 0
foldersCount           : 0
filesFoldersCount      : 0
syncStatusFlag         : false
```

`folderStructureReport: NOT_PROCESSED` is a named, source-side indexing state — the content analogue of
mail's `POST /email/mail/move/initiate/preScan`, whose own comment in `MigrationAgent.js` reads
*"Without this, only root-level folders migrate."* That is this combination's exact symptom.

**This partly reinstates the pre-scan hypothesis** that the 22 Aug draft marked as superseded. The
earlier reasoning was dropped because it rested on `preScanStatus: null` and because the wizard has no
pre-scan call in the content flow. Both of those remain true — but `folderStructureReport` is a
different field, reported by the job rather than the cloud record, and it says NOT_PROCESSED.

Note this is *not* an access problem: `GET /filefolder/userId/{userId}/cloudId/{srcCloud}?folderId=…`
returns the real tree on demand. CloudFuze can read the Shared Drive when asked directly; it has simply
never built the stored index the migration scan consumes.

### Trigger not found

`folderStructureReport` appears in **neither** public wizard source —
`ajaxcalls/multiUserMapping.js` (1.7 MB) nor `ajaxcalls/CFManageCloudAccounts.js` (473 KB). Probed and
absent: `manageCloudAccounts.js`, `cloudAccounts.js`, `managecloud.js`, `migrationReport.js`,
`reports.js` (all 404). So whatever populates it is server-side, or is triggered by a UI flow outside
these two files — most plausibly re-adding or refreshing the cloud in Manage Cloud Accounts.

### Suggested next action — a human check, not a code change

In the CloudFuze UI, re-add or refresh the `GOOGLE_SHARED_DRIVES` cloud for `erik@filefuze.co`, then
re-read `/move/newmultiuser/get/list/{jobId}` (or the cloud record) and see whether `filesCount`,
`foldersCount` and `folderStructureReport` populate. If they do, re-run the folder route above — it is
already known to reach `IN_PROGRESS`.

### Two blockers, stated separately

| # | Blocker | Status |
|---|---|---|
| 1 | Destination site invisible to CloudFuze — it lists sites via `/users/{destUser}/memberOf`, and `granger@gajha.com` is not a member of the QA site | **Understood.** Bypassable today by migrating into any of the 192 sites granger already belongs to, or fixed permanently by adding granger to the QA site |
| 2 | Source Shared Drive never indexed — `folderStructureReport: NOT_PROCESSED`, `filesCount: 0` | **Open.** Trigger not found in any public source; needs a CloudFuze-side answer or a cloud refresh |

Blocker 1 alone does not explain the 0-file result, because bypassing it still moved nothing. Blocker 2
is the better candidate for the remaining failure.

---

## Correction: `folderStructureReport` is inert — and the folder-route matrix

### `folderStructureReport` / `filesCount` are not signals

The previous section proposed `folderStructureReport: NOT_PROCESSED` as the second blocker. **That is
withdrawn.** All **10** clouds on this account report the same thing, across every provider, including
ones untouched since 2025:

```
BOX_BUSINESS                erik@filefuze.co    files=0 folders=0 fsReport=NOT_PROCESSED sync=false  refresh=2026-08-17
EGNYTE_ADMIN                erik@filefuze.co    files=0 folders=0 fsReport=NOT_PROCESSED sync=false  refresh=2025-11-10
GOOGLE_SHARED_DRIVES        erik@filefuze.co    files=0 folders=0 fsReport=NOT_PROCESSED sync=false  refresh=2026-08-12
G_SUITE                     erik@filefuze.co    files=0 folders=0 fsReport=NOT_PROCESSED sync=false  refresh=2025-09-19
G_SUITE                     mia@cloudfuze.com   files=0 folders=0 fsReport=NOT_PROCESSED sync=false  refresh=2025-11-07
ONEDRIVE_BUSINESS_ADMIN     erik@voohalu.co     files=0 folders=0 fsReport=NOT_PROCESSED sync=false  refresh=2025-09-25
ONEDRIVE_BUSINESS_ADMIN     erik@filefuze.co    files=0 folders=0 fsReport=NOT_PROCESSED sync=false  refresh=2025-09-25
ONEDRIVE_BUSINESS_ADMIN     granger@gajha.com   files=0 folders=0 fsReport=NOT_PROCESSED sync=false  refresh=2026-08-10
SHAREPOINT_ONLINE_BUSINESS  granger@gajha.com   files=0 folders=0 fsReport=NOT_PROCESSED sync=false  refresh=2026-08-12
SHAREPOINT_ONLINE_BUSINESS  erik@voohalu.co     files=0 folders=0 fsReport=NOT_PROCESSED sync=false  refresh=2026-08-12
```

These fields are never populated on this server, so they carry no information about whether a source is
indexed. Re-adding the `GOOGLE_SHARED_DRIVES` cloud did not change them, and did not move
`lastRefreshTime` off 2026-08-12.

Together with the earlier finding that `preScanStatus` also stays null while `/filefolder` reads the
drive fine, **the pre-scan line of inquiry is now closed in both its forms.**

### Folder-route matrix — all three variants accepted, all move nothing

Destination fixed to a `DOCUMENT_LIBRARY` in a site `granger@gajha.com` *is* a member of:

| Job | `fromRootId` | `teamFolder` | Job lifecycle | Result |
|---|---|---|---|---|
| `6a8c0b6b7371a25e3aa6b507` | folder id `1zSXdqgQA…` | absent | `NOT_PROCESSED → IN_PROGRESS` ~3 min → `PROCESSED` | 0 files |
| `6a8c0da87371a25e3aa6b50f` | drive id `0AJoAzUBzPvRXUk9PVA` | absent | `IN_PROGRESS` ~3 min → `PROCESSED` | 0 files |
| `6a8c0ebf7371a25e3aa6b516` | drive id | `"true"` | `IN_PROGRESS` ~3 min → `PROCESSED` | 0 files |

The folder route is still clearly better than the path-CSV route — those jobs reached `PROCESSED`
instantly, these actually scan for minutes — but the outcome is unchanged.

### CloudFuze stores the pair correctly, then scans nothing

`GET /move/newmultiuser/get/list/{jobId}` on the workspace shows every field arriving intact:

```
fromRootId           : "0AJoAzUBzPvRXUk9PVA"
toRootId             : "/6a7c3b26…/b!lmJORjvwqEmVu-dnGschxZwe…:DOCUMENT_LIBRARY"
sourceFolderPath     : "/Agent Shared Drive"
destFolderPath       : "/"
folder               : true
documentLibrary      : "Documents"
teamFoldersMigrate   : true
moveFileStatus       : "COMPLETE"
totalFolders         : 0
totalFilesAndFolders : 0
processedCount       : 0
notProcessedCount    : 0
errorDescription     : null
exceptionMessage     : null
```

`moveFileStatus: COMPLETE` with `totalFilesAndFolders: 0` and **no error anywhere** — the scan ran to
completion and enumerated zero items, in a folder that `/filefolder` lists as containing 10 subfolders
on demand.

At this point everything on our side is verifiably correct: the payload matches the wizard's own
GSD→SharePoint branch, the ids are real and CloudFuze echoes them back unchanged, the destination is
resolvable, and both users are provisioned. The remaining fault is inside CloudFuze's scan.

### ⚠️ Safety: `deleteOriginalFiles: true`

The workspace record carries:

```
"deleteOriginalFiles": true
```

The string `deleteOriginalFiles` appears in **neither** `ajaxcalls/multiUserMapping.js` nor anywhere in
`backend/src/` — nobody sets it, so it is a **server-side default** on `MOVE_WORKSPACE`. Because no
content migration has ever moved a file, this default has never been exercised.

**Before the first successful content run, confirm what it does.** If it means what it says, a working
migration could delete the source Shared Drive content. The current source is disposable seeded test
data (`Agent Shared Drive`), so the first successful run is the safe place to check — but check it
deliberately, on a copy, rather than discovering it on real data.

### The question for the team — final form

> `GOOGLE_SHARED_DRIVES → SHAREPOINT_ONLINE_BUSINESS`, folder route. CloudFuze accepts and stores
> `fromRootId` (the Shared Drive id), `toRootId` (a `:DOCUMENT_LIBRARY` id in a site the destination user
> is a member of), `sourceFolderPath`, `folder: true` and `documentLibrary`. The job runs for ~3 minutes
> and finishes `moveFileStatus: COMPLETE`, `totalFilesAndFolders: 0`, `errorDescription: null` — while
> `GET /filefolder/userId/{userId}/cloudId/{srcCloud}?folderId=<same id>` returns the folder's 10
> subfolders. **Why does the migration scan enumerate zero items from a Shared Drive folder the same
> server can list on demand?** Tried and made no difference: `fromRootId` as the folder id vs the drive
> id, and `teamFolder: "true"`.
>
> Secondary: is `deleteOriginalFiles: true` really the default for a content `MOVE_WORKSPACE`?

---

## Correction: destination visibility is NOT the cause either

The "ROOT CAUSE" section above is **withdrawn**. It was tested and disproven.

### Test 1 — source type makes no difference

Same path CSV, same destination, only the source cloud type changed:

| Source cloud | validation | `mapped` | `pathRootFolderId` (src / dst) | `totalPairsCount` |
|---|---|---|---|---|
| `G_SUITE` (My Drive) `68cd31645462b14dc6f61610` | (saved count 0) | false | null / null | **0** |
| `GOOGLE_SHARED_DRIVES` `6a7cb057dd48f370c24ed292` | `CSV report is ready` | false | null / null | **0** |

**My Drive fails identically.** The bug is not Shared-Drive-specific, so the earlier plan to narrow it that
way is closed — it is broader than Team Drives.

### Test 2 — a destination the user IS a member of fails the same way

The 192 sites CloudFuze lists for the destination cloud are the sites `granger@gajha.com` belongs to.
One of them resolves via Graph as:

```
https://trydemos.sharepoint.com/sites/Anonymous/Shared%20Documents
```

(hence `objectName: "Anonymous"` on the CloudFuze row — it is the site *name*, not an access note.)

Re-running the path CSV with `Destination Path = Anonymous/Shared Documents` — a site granger is
definitively a member of — gives job `6a8c27747371a25e3aa6b5c5`:

```
mapped=false   source pathRootFolderId=null   destination pathRootFolderId=null   totalPairsCount=0
```

Identical. **Site membership was not the blocker.** The `/users/{destUser}/memberOf` observation is
still factually correct about how CloudFuze builds its site list, but it does not explain the failure.

### The one constant across every test

`mapped: false`, and **`pathRootFolderId` null on BOTH sides**. CloudFuze registers the CSV row, runs
its own validation to `"CSV report is ready"`, and still resolves neither the source path nor the
destination path to a folder id. With no resolved ids the job attaches 0 pairs.

### Eliminated — do not re-spend time on these

| Hypothesis | Verdict |
|---|---|
| Wrong CSV header | Fixed earlier; the row registers, `errorLines: []` |
| Validation never triggered | `csvcreator` + `csvvalidationstatus` now run and report ready |
| Source is a Shared Drive | My Drive (`G_SUITE`) fails identically |
| Destination site not visible to the user | A member site fails identically |
| Destination user unlicensed / unprovisioned | `provisionedUser: true`, no `userErrorDescription` |
| Source not indexed (`folderStructureReport`) | Field is inert — `NOT_PROCESSED` on all 10 clouds since 2025 |
| Pre-scan missing | No such call exists in the content flow; `/filefolder` reads the tree on demand |
| `fromRootId` folder id vs drive id | Both tried, 0 pairs |
| `teamFolder: "true"` | Tried, 0 pairs |
| `folder:"true"` route with a real `:DOCUMENT_LIBRARY` id | Tried; job runs ~3 min, `totalFilesAndFolders: 0` |
| `duplicate mapping row` from `unmapped/list` | Removed; `cache/list` now returns 1 row |

### The question for the team — current form

> `GOOGLE_SHARED_DRIVES → SHAREPOINT_ONLINE_BUSINESS` **and** `G_SUITE → SHAREPOINT_ONLINE_BUSINESS`,
> path-CSV route. `POST /mapping/user/path/csv` returns the row with `errorLines: []`.
> `POST /mapping/download/csvcreator/{csvId}/asynchronous` reports `Total Saved Count :1` and
> `POST /mapping/check/csvvalidationstatus/{csvId}` reports `"CSV report is ready"`. Both users are
> `provisionedUser: true` with no `userErrorDescription`. Yet the mapping row keeps `mapped: false`
> with `pathRootFolderId` **null on both sides**, and every resulting job reports
> `totalPairsCount: 0`.
>
> **What resolves `folderPath` into `pathRootFolderId`?** It is not the source type, not destination
> site membership, not licensing, and not the validation calls above — all four were tested and
> eliminated. Is the path-CSV route supported for Google → SharePoint on this build at all?

### Report behaviour while this is unresolved

A run now completes rather than aborting, and produces the QA report with an honest verdict:

```
overallStatus : FAIL
tally         : 8 FAIL · 27 NA · 3 PASS  →  after the zero-paired fix: 11 FAIL · 27 NA · 0 PASS
summary       : 316 source items scanned, 0 paired
MIGRATION     : FAILED — totalPairsCount=0
```

No Neutara tickets are filed when the migration moved nothing — every finding would just restate
"the destination is empty", which is what produced the five misleading tickets on 22 Aug.

---

# SOLVED — 24 Aug 2026. Everything above this line is superseded.

**Google Shared Drive → SharePoint migrates. The cause was ours: `fromRootId` was missing from the
`create/job` pair.** Fixed in commit `7804829`.

Read this section first. Several conclusions above were wrong and are corrected here.

## The cause

CloudFuze recorded the reason on the **workspace** record, in a field nothing in this repo ever read:

```
errorDescription : "Migration not Allowed for wrong CSV paths"
processStatus    : CONFLICT
```

It is not returned by `create/job`, `update/{jobId}` or `create/{jobId}` — only by
`GET /move/newmultiuser/get/list/{jobId}`. Every one of the ~90 jobs was being explicitly **rejected**,
and because nothing read that field the rejection looked like silence. That is the single reason this
took two months.

## How it was found

By diffing our jobs against the only content jobs on this server that ever moved data — Box →
SharePoint, same `isCSV` route:

| Job | source | `fromRootId` | `totalFilesAndFolders` |
|---|---|---|---|
| `6a84316c06ed135add8c6d7a` | `BOX_BUSINESS` `/` | `"0"` | **55** |
| `6a843cf4b20c7e3667152977` | `BOX_BUSINESS` `/LFN` | `"409671580491"` | **20** |
| ours, before | `GOOGLE_SHARED_DRIVES` `/Agent Shared Drive` | **`null`** | **0** |

`fromRootId` must be **the id of the folder named in `sourceFolderPath`**. The Team-Migration wizard's
generic `isCSV` builder omits it, which is why it had been removed — but the wizard fails this
combination too (job `6a8c3b777371a25e3aa6bde6`, same CONFLICT), so the wizard is not a reliable
reference for this route. The working Box jobs are.

## The fix — `migrationClient.js`

1. **`fromRootId`** = the folder's own id, kept separately from the Shared Drive id (`fromRootId`
   elsewhere prefers the drive id for the folder-picker route; using it here makes the scan look at
   the drive root and find nothing).
2. **`destFolderPath`** echoed back exactly as CloudFuze registered it — `/QA/Documents`, with the
   leading slash it adds. Sending the un-normalised `QA/Documents` contributed to the same rejection.
3. **`destinationFolderName: ''`**, not `null`.
4. **`migrateFolderName`** empty in the update call, not `/`.
5. **`pickInsideFolder` / `teamFoldersMigrate`** are now opt-in (`CONTENT_PICK_INSIDE_FOLDER`,
   `CONTENT_TEAM_FOLDERS_MIGRATE`). Both were forced on; both are omitted by the wizard, and this
   document's own evidence had `pickInsideFolder=true` producing `Total: 0` where omitting it gave 1.
6. **`errorDescription` is read and logged** after every start, so a rejection can never be silent again.

## Verified result

```
395 source items scanned, 71 paired
/Agent Shared Drive 1 → 56 items, real files with real bytes
   qa_archive.zip 149 B · qa_config.json 778 B · qa_employees.csv 857 B · qa_logo.png 70 B · qa_manual.pdf 331 B
```

## Corrections to the sections above

- **"Content migration has never worked in this project"** — wrong. It works.
- **"CloudFuze cannot see the destination site" / `memberOf`** — wrong. Tested with a site the
  destination user is a member of: identical failure. Withdrawn.
- **"The destination user is unlicensed"** — wrong for `granger@gajha.com` (`provisionedUser: true`).
  Genuinely true for `warner@gajha.com`, but not the cause.
- **"`folderStructureReport: NOT_PROCESSED` means the source is unindexed"** — wrong. Inert on all 10
  clouds since 2025.
- **"`totalPairsCount: 0` proves no work is attached"** — wrong. That field is 0 in the
  create/update/start responses even for a healthy job; it populates only in
  `GET /move/newmultiuser/get/moveJob`. A guard built on it failed every run on a non-problem.
- **"The path-CSV route may be unsupported for Google → SharePoint"** — wrong. It works, with `fromRootId`.

## The trap that hid the success for hours

`scripts/content-migration-probe.js` checked **only** `/<FOLDER_NAME>` at the destination. CloudFuze
appends a counter when that name already exists — and it did exist, as an empty shell left by our own
seeding. So after the fix the probe still reported "nothing arrived" while the migration had landed
56 items in `Agent Shared Drive 1`.

`SharePointValidationAgent.findMigratedRoot` already handled this correctly (it probes `name`,
sanitised variants, then `name 1..N`, and prefers the candidate holding content). Only the probe was
naive. It now lists every candidate with its item count and picks the one with content.

**Lesson for anyone debugging this next: list the destination library root. Do not probe one path.**

## Open, and genuinely open

- **Office formats do not migrate.** `.doc`, `.xls`, `.ppt` — 0 of 5 each; `.txt` 65 of 75. A real
  finding, cause unknown.
- **Duplicates.** ~25 diagnostic runs on 24 Aug stacked content at the destination
  (`Agent Files`, `Agent Files 1`…`4`, identical files) and repeated seeding grew the source from 316
  to 395 items. The report's "70 extra, 260 misplaced" is mostly that, not a product defect. Clean
  both sides and re-run once for a trustworthy baseline.
- **`deleteOriginalFiles: true`** is still set by the server on every content workspace. A migration
  that copied 56 items deleted nothing from the source (verified: 395 items before and after), so it
  appears inert — but it is unexplained and worth asking CloudFuze about.
- **Primary login 403s** every run and falls back to Basic auth via `validateUser` as a different
  account. It works by accident.

---

## 2026-08-24 — the source cloud is not fully registered on qarelease

Reading the registered cloud list (`GET /users/{id}/get/all/cloud`, 10 clouds) turns up the first
difference between our failing source and the pairs that work. This is the strongest lead so far and it
does **not** point at our code.

| Cloud | `cloudAddingStatus` | `statusCode` | `clientEmail` (service account) | `rootFolderId` |
|---|---|---|---|---|
| `BOX_BUSINESS` erik@filefuze.co | `true` | `200` | n/a | `0` |
| `SHAREPOINT_ONLINE_BUSINESS` granger@gajha.com | `true` | `200` | n/a | `/` |
| **`GOOGLE_SHARED_DRIVES` erik@filefuze.co** | **`false`** | **`0`** | **absent** | `/` |
| `G_SUITE` erik@filefuze.co | `false` | `0` | `gsuiteamdriveenterpirse1@...gserviceaccount.com` | `0ALMGyUBuCZSgUk9PVA` |

Cloud id `6a7cb057dd48f370c24ed292` is the source of every failing job. It is the only cloud in the pair
with `cloudAddingStatus: false`, and it is the only **Google** cloud on the server with no `clientEmail`.
A Google cloud without a service account has no credential to impersonate the user and read Drive.

This fits every observed symptom without needing any of the theories already eliminated above:

- the destination folder IS created (the SharePoint cloud is healthy, `statusCode: 200`)
- the source is never enumerated, so the job scans exactly **1 item** — the root folder itself
- **no `errorDescription`** is set on the workspace: from CloudFuze's side nothing threw

### Status: STRONG BUT NOT PROVEN

Stated plainly so nobody over-reads it. What is verified is the table above — those are field values read
off the server. What is *inferred* is that the missing service account is what stops the scan. An attempt
to confirm it independently by asking CloudFuze to list each cloud's root was **inconclusive**: four
guessed endpoint shapes returned 404/500 for the Box cloud too, so the negative result carries no signal.
Confirming it needs either CloudFuze's real browse endpoint or someone with qarelease UI access.

### What to ask the CloudFuze team

> The `GOOGLE_SHARED_DRIVES` cloud for `erik@filefuze.co` on qarelease (id `6a7cb057dd48f370c24ed292`)
> has `cloudAddingStatus: false`, `statusCode: 0`, and no `clientEmail`, while the Box and SharePoint
> clouds in the same account show `true` / `200`. Was this cloud ever fully added and authorized with a
> service account? Migrations from it are accepted, report no `errorDescription`, and scan exactly one
> item — the root folder — which then arrives empty at the destination.
>
> Reproducing jobs: `6a8c830c7371a25e3aa6dd18`, `6a8c86a67371a25e3aa6dd34`, `6a8c89447371a25e3aa6dd42`.

Re-adding the cloud is a change on qarelease, which QA has asked us not to touch — so this is a request,
not something to fix from here.

### Possible workaround, untested

The `G_SUITE` cloud for the same user DOES carry a service account and a real Shared Drive
`rootFolderId` (`0ALMGyUBuCZSgUk9PVA`, a different drive from our `QA_TeamDrive`
`0AJoAzUBzPvRXUk9PVA`). Driving the migration from `G_SUITE` instead of `GOOGLE_SHARED_DRIVES` may work,
but it changes the combination under test from `googleshareddrive->sharepoint` to
`googledrive->sharepoint` and has not been tried.

### Corrections to earlier entries in this document

Three causes were asserted in this file during the 2026-08-24 session and each was disproved by its own
follow-up test. They are listed here so the next reader does not re-run them:

1. **"Deleting the seeded source folder invalidates a CloudFuze path cache."** Disproved by job
   `6a8c86a6`: the folder had existed untouched for 28 minutes and the mapping still came back
   `mapped=false` with both `pathRootFolderId` null.
2. **"The CSV validation poll ceiling (15 x 4s) times out before the path resolves."** Disproved by job
   `6a8c8932`: after clearing stale mappings, validation answered "CSV report is ready" on poll **1** of
   60 — and the row was still `mapped=false`.
3. **"Our validation checks the wrong destination path."** Disproved by a full Graph sweep of
   `trydemos.sharepoint.com/sites/QA`: exactly one document library exists, holding only
   `Agent Shared Drive`, `Agent Shared Drive 1`, `Agent Shared Drive 2` (all **0 items**, one per probe
   run) plus the pre-existing `Test/` and `Long File Names.csv`. The validator was looking in the right
   place; the files are genuinely absent.

Also worth recording: **no run in `backend/logs/` has ever logged `mapped=true`.** The path mapping has
never resolved for this combination, before or after any change made in this session.

---

## 2026-08-25 — `mapped=false` is NOT the defect. Control experiment.

This retracts the framing used throughout the entries above, including yesterday's.

Every prior entry treated `mapped=false` with null `pathRootFolderId` as the smoking gun. A control run
against the **known-working Box combination** — same code path, same destination, same CloudFuze account,
only the source cloud changed — produced the identical mapping verdict:

```
job 6a8d0b9e7371a25e3aa6dd9b   BOX_BUSINESS -> SHAREPOINT_ONLINE_BUSINESS
  "did not resolve the mapping ... (mapped=false, source pathRootFolderId=null,
   destination pathRootFolderId=null)"
```

`mapped=false` therefore appears on a combination that migrates successfully. It is normal output of this
endpoint, not a fault signal. **The warning text in `migrationClient.js` overstates its meaning** — it
says the job "will attach 0 pairs and migrate nothing", which the Box control shows is not implied.

### What actually separates the two

| | Box (works) | Google Shared Drive (fails) |
|---|---|---|
| `mapped` | `false` | `false` |
| `pathRootFolderId` | `null` | `null` |
| job runtime | **still running after 10 min** | **finishes in ~40 s** |
| `totalFilesAndFolders` | populated (55 and 20 on the two documented jobs) | `0` |
| cloud `cloudAddingStatus` | `true` | `false` |
| cloud `statusCode` | `200` | `0` |

The request *shape* is not the difference. Historical working Box jobs `6a84316c` (`sourceFolderPath "/"`,
`fromRootId "0"`, 55 items) and `6a843cf4` (`sourceFolderPath "/LFN"`, `fromRootId "409671580491"`,
20 items) are structurally identical to our failing Drive jobs — a named subfolder with that folder's own
id as `fromRootId`. Box does it and reads the folder; Drive does it and reads nothing.

### Surviving hypothesis, now the only one

The cloud-registration difference recorded in the 2026-08-24 entry is the last explanation still standing:
the `GOOGLE_SHARED_DRIVES` cloud has `cloudAddingStatus: false`, `statusCode: 0`, and no `clientEmail`,
while Box and SharePoint in the same account are `true` / `200`. A source cloud that cannot authenticate
to Google cannot enumerate the folder, which is exactly "accepted, no error, 0 files, finishes fast".

### Caveats on today's two experiments — neither is clean

- **G_SUITE substitution** (job `6a8d0b477371a25e3aa6dd8a`, `PROCESSED_EMPTY`) is **confounded**: that
  cloud's `rootFolderId` is `0ALMGyUBuCZSgUk9PVA`, a different Shared Drive from the `QA_TeamDrive`
  (`0AJoAzUBzPvRXUk9PVA`) holding the seeded data. It could not have seen our folder regardless of health.
- **Box control** delivered nothing to the destination either, but `/Agent Box Data` was never re-seeded
  and the Box API token is currently `401`, so its source folder may not exist. The control is valid for
  the `mapped=false` conclusion (that value is read at mapping time, before any source read) and
  **inconclusive** for anything about delivery.

### Next step that would settle it

Have someone with qarelease UI access open the Google Shared Drives cloud for `erik@filefuze.co` and
either confirm it is fully authorized or re-add it. Everything reachable from our side has been tried.

---

## 2026-08-25 — `teamFoldersMigrate` eliminated, and the env whitelist bug that hid it

### A real bug: the opt-in flags could never be turned on

`src/config/env.js` is an explicit whitelist and never spreads `process.env`. Any var referenced only as
`env.FOO`, with no line in that export object, is permanently `undefined`. Two content flags were in
exactly that state:

```js
...(env.CONTENT_PICK_INSIDE_FOLDER   === 'true' ? ['pickInsideFolder=true']   : []),
...(env.CONTENT_TEAM_FOLDERS_MIGRATE === 'true' ? ['teamFoldersMigrate=true'] : []),
```

Both were introduced as "opt-in" guarded against `'true'` while missing from `env.js`, which made the
opt-in unreachable and pinned both flags to `false` on every run since. `CONTENT_MIGRATE_FOLDER_NAME` and
the `CONTENT_CSV_VALIDATION_*` vars had the same defect. All five are now declared, with a comment in
`env.js` explaining why a line there is mandatory.

This mattered because a comment in `migrationClient.js` claims that with `teamFoldersMigrate` false
against a `GOOGLE_SHARED_DRIVES` cloud "the scan found the folder but never its contents" — which is a
verbatim description of the observed failure. It looked like the regression.

### It is not the cause

First attempt (job `6a8d1675`) was invalid — the env var was set in the shell but, because of the bug
above, never reached the request: the job record shows `"teamFoldersMigrate":false`. After fixing
`env.js`, job `6a8d1785` sent `teamFoldersMigrate=true` (confirmed both in the update URL and as
`"teamFoldersMigrate":true` in the job record) and the outcome was unchanged:

```
workspace scanned 1 item(s)   →   0 item(s) in the migrated root
```

**`teamFoldersMigrate` is eliminated.** The `migrationClient.js` comment describing it as the reason the
scan misses folder contents is not supported by this test.

### Flag matrix, now complete

| `fromRootId` | `pickInsideFolder` | `teamFoldersMigrate` | scanned |
|---|---|---|---|
| folder id | false | false | 1 |
| drive id | false | false | 0 |
| folder id | **true** | false | 0 |
| folder id | false | **true** | **1** |

Every combination reachable from our side has now been tried. None migrates content.

### Destination left clean

The five empty `Agent Shared Drive`…`Agent Shared Drive 4` folders accumulated by probe runs were removed
via the cleanup allowlist, which correctly spared `Test/` (pre-existing, 5 items) and
`Long File Names.csv`. The library root is back to those two items only.

---

## 2026-08-25 — the qarelease account has no active migration entitlement

Found by logging into the portal with Playwright (the project's existing `qareleaseBrowserClient`
credentials) and reading what the Team Migration page asks about the account. Read-only; no job created.

```
GET /proxyservices/v1/subscription/all/68cd22665462b14dc6f60ff5   -> 200  []
GET /proxyservices/v1/subscription/status/68cd22665462b14dc6f60ff5 -> 200  false
GET /proxyservices/v1/move/limit/active                            -> 400
     {"error":{"error_summary":"Exception while getUserActiveDataLimit","statusCode":400}}
GET /proxyservices/v1/users/validateUser?searchUser=bhuvana.mosra@cloudfuze.com
     role="SUBSCRIBER"  isActive=true  expiresIn=1760866150984
```

`expiresIn` is **2025-10-19T09:29:10Z** — 310 days before the jobs run on 2026-08-25. The Team Migration
page itself renders "Subscribe Now" / "Choose a different Plan".

### Why this explains everything the other theories could not

| Observation | Accounted for |
|---|---|
| job accepted, `processStatus` fine, **no `errorDescription`** | job creation is not gated by the data limit |
| workspace scans exactly **1 item**, `totalFilesAndFolders=0` | no data allowance to move |
| destination root folder IS created, but empty | folder creation does not consume data allowance |
| job finishes in ~40 s instead of running for minutes | nothing to transfer |
| **the Box control also delivered nothing** | same account — the cloud-registration theory cannot explain this |

That last row matters most. The 2026-08-24 entry proposed the `GOOGLE_SHARED_DRIVES` cloud's
`cloudAddingStatus: false` / missing `clientEmail` as the cause. That may still be a real defect, but it
cannot explain Box — a cloud with `cloudAddingStatus: true` and `statusCode: 200` — also moving zero
files. An expired account-level entitlement explains both with one cause.

### Status: STRONG, NOT PROVEN

Stated plainly, because three earlier theories in this document were asserted and then disproved. What is
**verified** is the four API responses above — those are read straight off the server. What is
**inferred** is that the expiry is what stops the transfer. The proof would be the same pair migrating
under an account with an active subscription, which is not something we can arrange from here.

### The ask

> The qarelease CloudFuze account `bhuvana.mosra@cloudfuze.com` (userId `68cd22665462b14dc6f60ff5`) has
> no active subscription: `subscription/all` returns `[]`, `subscription/status` returns `false`,
> `move/limit/active` returns HTTP 400 "Exception while getUserActiveDataLimit", and `validateUser`
> reports `expiresIn` = 2025-10-19, i.e. expired 310 days ago. Migration jobs are still accepted and
> report no error, but transfer zero files — for Google Shared Drive AND for Box.
>
> Can the subscription / data limit be restored on this account? Reproducing jobs:
> `6a8c830c7371a25e3aa6dd18`, `6a8c86a67371a25e3aa6dd34`, `6a8c89447371a25e3aa6dd42`,
> `6a8d16757371a25e3aa6ddef` (teamFoldersMigrate=true), `6a8d0b9e7371a25e3aa6dd9b` (Box control),
> `6a8d1e7f7371a25e3aa6de12` (after an explicit filefolder cache refresh).

### Also eliminated today

**CloudFuze's file/folder cache.** The portal POSTs
`/filefolder/refresh/cache/user/{uid}/cloud/all` on every login; our API flow never did, which looked
like a strong lead. Re-issuing it with the portal's own `Authorization` header returned **HTTP 202**,
then after a 90-second wait job `6a8d1e7f` still scanned 1 item. Not the cause.

**`/filefolder/user/{uid}/cloud/{cloudId}`** returns `[]` for all four clouds — the suspect Shared Drive
and the healthy Box, SharePoint, and G_SUITE alike — so it is not a cloud-health discriminator either.

---

# SOLVED — 2026-08-25. A Shared Drive migrates as the DRIVE, not as a folder inside it.

Verified end to end with no environment overrides: job `6a8d4e39` reached `PROCESSED` and put
**62 items (37 files, 25 folders)** into `trydemos.sharepoint.com/sites/QA` under
`/Agent Shared Drive`, with real byte sizes. Source verified intact afterwards — 11 children, nothing
deleted.

## How it was found

By asking CloudFuze for its own job history and diffing the one Shared Drive job that ever moved data
against ours. Both records read from `/move/newmultiuser/get/list/{jobId}`:

| field | `6a8c4f2d` — **moved 396 items** | our failing jobs |
|---|---|---|
| `sourceFolderPath` | **`/QA_TeamDrive`** (the drive) | `/Agent Shared Drive` (a folder in it) |
| `fromRootId` | **`0AJoAzUBzPvRXUk9PVA`** (the drive id) | `1Jtyvw…` (the folder id) |
| `pickFilestoDate` | **`null`** | `1787616000000` |
| `teamFoldersMigrate` | **`true`** | varied |
| `pickInsideFolder` | **`true`** | varied |
| `totalFilesAndFolders` | **396** | 0 |

Four conditions must hold **together**. Each had been tested in isolation and dismissed, which is
precisely why the investigation stalled for two days: every single-variable test failed, so every
variable looked innocent.

- the path and the root id must describe the **same object** — passing the drive id while still naming a
  subfolder as the path scans nothing
- `teamFoldersMigrate` and `pickInsideFolder` are required as a **pair** — either alone still scans 1 item
- any `toDate` cutoff must not exclude freshly seeded data

## The date filter was our own bug

`toDate` was computed as `new Date().toISOString().slice(0,10) + ' 00:00:00'` — **today at midnight**.
Seeding runs minutes before the migration, so every seeded file was newer than our own cutoff and was
filtered out. Job `6a8c4f2d` moved data only because its source had been seeded on an earlier day and so
fell inside the window. Shared Drive now sends no cutoff (matching the proven job); other sources use
tomorrow's date.

## What changed in `migrationClient.js`

- Shared Drive sources: `sourcePath` becomes `/<driveName>` and `fromRootId`/`folderRootId` the drive id.
  The caller still names the seeded folder; the client promotes it. The seeded folder still arrives as a
  folder at the destination because it is a child of the drive and the tree is preserved, so the
  validator's expectations are unchanged.
- `pickInsideFolder` and `teamFoldersMigrate` are forced on for Shared Drive, still opt-in for
  Box/OneDrive/My Drive whose working jobs (`6a84316c`, 21 MB) carry neither.
- `toDate`: `null` for Shared Drive, tomorrow elsewhere, `CONTENT_MIGRATION_TO_DATE` to override.

## Operational consequence — read before changing the source

Because the whole drive is the migration unit, **anything in the Shared Drive root is migrated**. The
drive must hold only QA data. A leftover `ZZ Seeding Fix Check` folder from a seeding test was migrated
for exactly this reason and has been removed from both sides.

## Theories asserted and disproved during this investigation

Recorded so none is retried. Each was stated as a cause and then killed by its own follow-up test:

1. Deleting/recreating the source folder invalidates a CloudFuze path cache — killed by job `6a8c86a6`.
2. The CSV validation poll ceiling times out before the path resolves — killed by `6a8c8932` (ready on
   poll 1, still `mapped=false`).
3. Our validator checks the wrong destination path — killed by a full Graph sweep of the site.
4. `teamFoldersMigrate` alone is the missing flag — killed by `6a8d1785`.
5. The account's expired subscription blocks transfers — killed by the fact that seeded files
   (`qa_archive.zip`, `qa_config.json`, `qa_employees.csv`, `qa_logo.png`, `qa_manual.pdf`) reached
   SharePoint **after** the 2025-10-19 expiry. The subscription findings in the previous section are
   accurate as data but are **not** the cause of zero-byte migrations.
6. `mapped=false` / null `pathRootFolderId` indicates failure — killed by the Box control (`6a8d0b9e`),
   which reports the same values. Normal output of that endpoint; the warning has been downgraded to
   INFO.
