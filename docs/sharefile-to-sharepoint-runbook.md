# ShareFile → SharePoint — run this migration

Written 2026-09-10. Every fact below was verified against the live tenants, not inferred.

---

## 1. Where things stand

| Piece | State |
|---|---|
| ShareFile source | connected as `zara@storefuze.com` on `syncgalaxy.sf-api.com` |
| Seeded test data | **156 items** (54 folders, 102 files, 26.4 MB) in zara's **Personal Folders → QA-Automation** |
| CloudFuze | `qarelease.cloudfuze.com`, logged in, both cloud IDs pinned |
| Validator | runs against both live systems; 11-feature checklist |
| Migrations completed | **none yet** — two attempts, both `PROCESSED_EMPTY` |

Nothing has reached either SharePoint site. The folders visible in
`trydemos.sharepoint.com/sites/QA` (`QA-dropbox-sharepoint`, `QA-Automation-Dropbox-Dest`,
`tosharedrive`, `QA_Team1/2`) are from the team's earlier Dropbox and Drive runs.

---

## 2. Why both attempts moved nothing

CloudFuze was told to migrate **`alex@filefuze.co`, source folder `/`**.

Alex's ShareFile home returns `404` and is not readable by the connected account. His root is empty,
so CloudFuze correctly reported `totalFilesAndFolders=0`. The migration engine behaved properly —
it was pointed at the wrong user's folders.

The seeded data is in **zara's** Personal Folders, and Personal Folders are private to one user.

---

## 3. The decision you have to make

There are two sites called **QA**, in different tenants. Pick one.

### Option A — filefuze QA  ·  ready now, no re-seeding

`filefuze.sharepoint.com/sites/QA` (currently empty, currently pinned)

Zara resolves to a real destination user against this cloud, so the already-seeded data can migrate
as-is.

**Wizard settings**

| Step | Value |
|---|---|
| Source & Destination | ShareFile → SharePoint |
| Map Users | **`zara@storefuze.com` → `zara@storefuze.com`** — untick anything else |
| Options | tick **`useExistingSource`** |

Nothing else to change. Expect ~156 items in `filefuze.sharepoint.com/sites/QA`.

### Option B — trydemos QA  ·  matches the documented setup, needs a re-seed

`trydemos.sharepoint.com/sites/QA` (where the team's other migrations land)

Zara resolves to `null` on this cloud, so the source must be `alex` or `ben` — and their Personal
Folders are unreachable. The data has to move to **Shared Folders**, which all of them can see. That
is exactly the layout every figure in the feature document shows (`Shared Folders / Asma`).

**Requires first (ask, and it will be done):**

1. `CONTENT_DEST_CLOUD_ID` → back to `6a7c3b2691272c41fc9d7bcf` (granger@gajha.com)
2. `SHAREPOINT_HOSTNAME` → back to `trydemos.sharepoint.com`
3. Re-seed the 156 items into **Shared Folders / QA-Automation** (~4 minutes)

**Then wizard settings**

| Step | Value |
|---|---|
| Map Users | **`alex@filefuze.co` → `alex@filefuze.co`** |
| Options | tick **`useExistingSource`** |

---

## 4. Settings that are wrong by default — check every run

**Map Users auto-matching will not help you.** It matches on first name, and ShareFile stores these
display names as `z, zara` / `A, Alex`, so the "first name" is a single letter and nothing lines up.
Map by hand every time.

**Never leave the destination as `Granger@qatestagent.com`.** CloudFuze resolves only four users
against the current cloud:

```
alex@filefuze.co       →  alex@filefuze.co       ✅
ben@filefuze.co        →  ben@filefuze.co        ✅
frankie@fuzebot.co     →  frankie@fuzebot.co     ✅
zara@storefuze.com     →  zara@storefuze.com     ✅
hannarr@storefuze.com  →  null                   ❌
```

`Granger@qatestagent.com` is not among them and has no SharePoint cloud registered.

**Tick `useExistingSource`.** Without it the run re-seeds (~4 min, mostly the 25 MB file). With it,
the orchestrator pins the source to `/QA-Automation` instead of the account root.

---

## 5. Reading the result

The report gives an **11-feature checklist**, not 38 — this combination's document defines eleven.

Two entries are `na` **by design**, and that is correct rather than a gap:

- **2.1–2.4 permissions** — no published ShareFile→SharePoint role mapping exists, so the validator
  reports instead of guessing. The ~20 QA cases **are** now seeded: the seeder plants a permission
  ladder (view / +upload / +download / +delete / +admin, each at root level and sub level, for a user
  and for a group) under `09-Permissions/ladder-root` and `09-Permissions/ladder-sub`, granting to
  principals discovered from the connected account. The grants are read at both ends and printed side
  by side; the verdict stays `na` until a mapping table is published. `permissionLadder.applied` in
  the seeding result says how many landed — an account with no groups plants ten, not twenty, and
  that is not a failure.

  **Delete and admin are swapped relative to the Xray wording, deliberately.** Verified on the live
  tenant: ShareFile accepts `CanManagePermissions` without `CanDelete` with HTTP 200 and then stores
  it without the manage flag, which would make rung 4 a byte-identical copy of rung 3. `CanAddFolder`
  is omitted for the same reason — readable in an ACL, not settable through one. Both are asserted in
  `test/sharefileToSharepoint.test.js` so nobody restores the documented-but-impossible order.
- **parts of 5.1** — ShareFile strips `: * ? " < > |` and trims leading/trailing spaces on write, so
  those cases cannot be exercised from a ShareFile source at all. The report names them.

**Version counts will look wrong and are not.** Expect roughly **2× the source count** at the
destination: CloudFuze writes a `SharePoint App` placeholder version beside each real one
(figure 4.1.1). Only *lost* history fails; excess is reported.

**`PROCESSED_EMPTY` means CloudFuze moved nothing**, and the validator suppresses bug-raising — every
finding underneath it would merely restate that the destination is empty.

---

## 6. If it fails again

| Symptom | Cause | Fix |
|---|---|---|
| `PROCESSED_EMPTY`, `totalFilesAndFolders=0` | source user's folder is empty or unreachable | check the mapped source user owns `/QA-Automation` |
| CSV row in `errorLines` | destination user not resolvable by CloudFuze | map to one of the four users listed above |
| "no existing ShareFile folder could be resolved" | `useExistingSource` on, folder name wrong | check `SHAREFILE_TEST_ROOT`, or untick to re-seed |
| Every item reports missing | Graph host ≠ pinned destination cloud's tenant | `SHAREPOINT_HOSTNAME` must match `CONTENT_DEST_CLOUD_ID`'s tenant |
| "ShareFile is not connected" | the connected account was disconnected | Connect Clouds → Content → Citrix ShareFile |

**The last row is the one that bites silently.** The cloud ID decides where CloudFuze *writes*;
`SHAREPOINT_HOSTNAME` decides where the validator *reads*. If they disagree the run looks
catastrophic — 156 items "missing" — while the migration was fine.

---

## 7. Useful commands

```bash
cd backend

# what ShareFile account is connected, and can it read?
node -e "require('./src/clients/sharefileClient').verifyConnection().then(r=>console.log(r))"

# what clouds does CloudFuze have, and their IDs
npm run list-clouds

# gates
npm test          # 42 files
npm run lint      # must be 0 errors
```
