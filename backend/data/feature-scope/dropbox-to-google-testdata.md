# Test data specification — Dropbox to Google (My Drive & Shared Drive)

**Derived from:** the QA team's own cases in the Xray Test Repository, folders
`/Dropbox For Business to Google SharedDrive/*` and `/Dropbox For Business to Google Mydrive/*`
— **5,905 cases analysed**.

**Cross-referenced against:** `dropbox-to-google-inscope.md` (36 features).

> Why this file exists. The scope document says *what* must be validated. It does not say what data has
> to exist for a run to exercise it. The QA cases do — and they vary dimensions the scope document
> never mentions. A seeding agent written from the scope document alone produces data that most of
> these 5,905 cases cannot touch.

---

## What the QA cases actually vary

Counted from case summaries, so these are real weightings rather than guesses.

### Migration type — delta is the majority

| | cases |
|---|---|
| delta | **3,627** |
| onetime | 2,134 |

**61% of the cases are delta.** Every other content combination in this repo validates one-time only;
`ENABLE_DEEP_CONTENT_VALIDATION` has never been exercised against a delta run for content. Scope
feature 1.3 is not a minor row here — it is most of the test surface.

### Source → destination path pair — all nine, deliberately

| pair | cases |
|---|---|
| Root-Root | 1,021 |
| Folder-Folder | 932 |
| Folder-Subfolder | 924 |
| Folder-Root | 924 |
| Root-Folder | 922 |
| Root-Subfolder | 870 |
| Subfolder-Root | 303 |
| Subfolder-Folder | 303 |
| Subfolder-Subfolder | 303 |

Where the item sits in the source **and** where it lands are varied independently. This is why there
are 1,080 inner-file permission cases rather than a handful: the same permission is checked at every
combination of depth.

### Delta change type

| | cases |
|---|---|
| existing | 1,677 |
| renamed | 1,635 |
| newly added | 1,440 |
| content updated | 708 |
| moved | 39 |

A delta run has to be able to produce each of these against data the one-time run already migrated.

### Permission subject — groups outnumber users

| | cases |
|---|---|
| **CSV mapping** | **4,832** |
| group | 3,866 |
| internal user | 3,734 |
| Team folder | 1,128 |
| external | 616 |

Two things stand out:

- **CSV mapping appears in 82% of cases.** User mapping by CSV is the dominant path, not the
  exception. Compare the Shared Drive runs, where the wizard sent one pair and CloudFuze matched the
  rest itself.
- **Group grants outnumber user grants.** Any seeding that only grants to individuals leaves the
  larger half of the test surface untouched.

### Access level — exactly balanced

| | cases |
|---|---|
| view | 2,403 |
| edit | 2,403 |

Identical counts, so the balance is intentional. Dropbox has no commenter, which matches: two levels,
tested evenly.

### Item position

| | cases |
|---|---|
| subfolder | 3,568 |
| root folder | 1,656 |
| inner file | 1,136 |
| root file | 737 |

Maps onto scope features 2.1–2.4.

### Links

| | cases |
|---|---|
| editor link | 633 |
| viewer link | 633 |
| shared link (general) | 474 |
| **breaking point** | **144** |

---

## Test data the seeding must create

Each row states which scope feature it exercises and how many QA cases depend on it.

| # | Data | Scope | Why |
|---|---|---|---|
| 1 | A root **team folder** with both user and group grants | 2.1 | 1,656 root-folder + 1,128 team-folder cases |
| 2 | A **root file** with user and group grants at view and edit | 2.2 | 737 cases |
| 3 | **Sub-folders** with their own grants, at two depths | 2.3 | 3,568 cases — the largest single group |
| 4 | **Inner files** inside those sub-folders with their own grants | 2.4 | 1,136 cases |
| 5 | Items shared with an **external** address (outside the team) | 2.5 | 616 cases |
| 6 | **Group** grants at every position above, view and edit | 2.1–2.4 | 3,866 cases |
| 7 | Links with audience **Anyone with the link** — viewing and editing | 3.1 | 633 + 633 |
| 8 | Links with audience **Team members** — viewing and editing | 3.2 | same, and the Sync Orbit mapping |
| 9 | Files with distinct **created and modified** timestamps | 4.1 | 44 timestamp cases |
| 10 | Names containing characters Dropbox allows | 5.1 | Google accepts nearly all — see the caution below |
| 11 | A **long path crossing the "breaking point"**, with items either side | 7.1 | 144 cases — **and it contradicts our current assumption** |
| 12 | A document containing a **link to another file in scope**, plus one **out of scope** | 8.1 / 10.8 | 336 embedded-link cases; 10.8 makes the out-of-scope case meaningful |
| 13 | Files with **multiple versions** | 9.1 | 27 cases |
| 14 | The same, with a **selective version count** set on the job | 9.2 | 45 cases |
| 15 | **Dropbox Paper** documents covering the 10.x elements | 10.1–10.19 | 50 cases in `/Smoke Test cases/PAPER DROPBOX` |
| 16 | A **user-mapping CSV** | — | 4,832 cases run through CSV mapping |

### For delta (3,627 cases) the run must additionally be able to

- **rename** an item that already migrated
- **update the content** of an item that already migrated
- **add** a new item
- **move** an item between folders
- leave an item **unchanged**, and confirm it is not re-migrated

---

## Two things to resolve before writing the seeding

### 1. The "breaking point" contradicts `destinations/googledrive.js`

144 QA cases exercise a breaking point in long file/folder names, with items deliberately placed
*before* and *after* it. But `validation/destinations/googledrive.js` currently declares
`pathLengthLimit: Infinity`, taken from Google's documentation and marked **NOT YET EXERCISED**.

Both cannot be right. Either:

- Google (or CloudFuze) imposes a limit these cases target — then `googledrive.js` is wrong and must
  carry the real number; or
- the cases were inherited from a SharePoint combination and do not apply — then they should not be
  run for this pair.

Getting this backwards is not cosmetic. Assuming a limit that does not exist would excuse missing
data as a documented placeholder; assuming none when one exists would fail intact data. **Read the
expected result on a few of those cases before the seeding is written.**

### 2. Groups and team folders are not in the role map yet

`validation/roleMaps/dropbox_to_google.js` covers user-level `Can edit` / `Can view` only. The cases
show **3,866 group** and **1,128 team-folder** grants — the larger share of the permission surface.
Dropbox team folders and group membership need adding before the permission validator is written, or
it will validate the smaller half and report a pass.

---

## Coverage check against the scope document

| Scope feature | QA cases | Data specified |
|---|---|---|
| 1.1 Data Migration | all | ✅ items 1–4 |
| 1.2 One Time | 2,134 | ✅ |
| 1.3 Delta | 3,627 | ✅ delta section — **new capability** |
| 2.1 Root folder permissions | 1,656 | ✅ 1, 6 |
| 2.2 Root file permissions | 737 | ✅ 2, 6 |
| 2.3 Sub-folder permissions | 3,568 | ✅ 3, 6 |
| 2.4 Inner file permissions | 1,136 | ✅ 4, 6 |
| 2.5 External shares | 616 | ✅ 5 |
| 3.1 Anyone with the link | 633 | ✅ 7 |
| 3.2 Team members → Sync Orbit | 633 | ✅ 8 |
| 4.1 Metadata | 44 | ✅ 9 |
| 5.1 Special characters | — | ✅ 10 (expect no replacement) |
| 6.1 Suppress notifications | 24 | ✅ needs the job setting declared |
| 7.1 Long path | 144 | ⚠️ 11 — **blocked on the question above** |
| 8.1 Embedded links | 336 | ✅ 12 |
| 9.1 Version history | 27 | ✅ 13 |
| 9.2 Selective versions | 45 | ✅ 14 |
| 10.1–10.19 Dropbox Papers | 50 | ✅ 15 — 19 features, the largest single block |

Every in-scope feature has data specified. One is blocked on a factual question rather than on effort.
