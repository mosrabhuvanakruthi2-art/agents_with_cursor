# Manual QA — Shared Drive → SharePoint permissions

Step-by-step manual verification of permissions, drive access and shared links for a
Google Shared Drive → SharePoint Online migration.

Every expected value below is the **real seeded value** from run `605ab6d5`
(googleshareddrive → sharepoint, 2 drives), so each check is pass or fail with no interpretation.

| | |
|---|---|
| Source account | `erik@filefuze.co` |
| Destination account | `granger@gajha.com` |
| Source drives | `QA_Team1` (open) · `QA_Team2` (restricted) |
| Destination | SharePoint site **QA** → Documents → `QA_Team1` / `QA_Team2` |
| Organization name | **Sync Orbit** |
| Seeded root folder | `Agent Shared Drive` |

---

## 00 — How to use this

Work top to bottom. Each test has an ID like `P2-01` — report results by ID.
Two tabs side by side is fastest: Google Drive left, SharePoint right.

- **Google (source):** drive.google.com → Shared drives → QA_Team1 / QA_Team2
- **SharePoint (dest):** QA site → Documents → QA_Team1 / QA_Team2

### Read this before judging anything

Permissions in a Shared Drive come from **two different places**, and confusing them is the
single biggest source of false reports.

- **Level 1 — drive membership.** Set on the drive itself. Google copies it onto *every* folder
  and file inside, so the same people appear everywhere.
- **Level 2 — folder sharing.** Set on one folder. Only that folder shows it.

So if two folders show identical people, that is Level 1 showing through on both — **not a bug**.
Only the folders in section P2 carry their own Level 2 sharing.

---

## 01 — Translation reference

A migration must change two things: the role name and the person's address. Neither side will
look identical to the other, and that is correct.

### Role names — Google → SharePoint

| Google (UI label) | Google (API name) | SharePoint must show |
|---|---|---|
| Viewer | `reader` | **Can view** |
| Commenter | `commenter` | **Can view** |
| Contributor | `writer` | **Can edit** |
| Content manager | `fileOrganizer` | **Can edit** |
| Manager | `organizer` | no equivalent — not migrated |

**Commenter → Can view is correct.** SharePoint has no comment level. Do not report as a downgrade.

### People — source → destination

| Google (source) | SharePoint (destination) |
|---|---|
| `erik@filefuze.co` | `granger@gajha.com` |
| `alex@filefuze.co` | `alex@gajha.com` |
| `mia@filefuze.co` | `mia@gajha.com` |
| `warner@snapbot.io` | `warner@gajha.com` |
| `everyone_at_exinent@filefuze.co` | `everyoneatexinent@gajha.com` |
| `qa-group-view@filefuze.co` | `qa-group-view` (group, name may vary) |
| `qa-group-edit@filefuze.co` | `qa-group-edit` (group, name may vary) |

Different address, same person = **PASS**. Groups migrate *as groups* and may lose their email,
showing only a display name — match on the name.

---

## P1 — Drive membership (Level 1)

This is what the wizard calls **Drive access**. The two drives were seeded deliberately
differently, and that difference is the test.

| Member | QA_Team1 (open) | QA_Team2 (restricted) |
|---|---|---|
| erik | Manager | Manager |
| alex | Content manager | Content manager |
| mia | Viewer | Viewer |
| qa-group-edit | Contributor | Contributor |
| qa-group-view | **Content manager** | **Commenter** |
| everyone_at_exinent | **present** | **absent — by design** |

### P1-01 — Is QA_Team1 open to everyone, and QA_Team2 not?

1. Google Drive → Shared drives → **QA_Team1**
2. Top right → gear icon → **Manage members**
3. Record every member and role, then repeat for **QA_Team2**

**Expected:** QA_Team1 lists `everyone_at_exinent` as Content manager. QA_Team2 does **not**
list it at all. Every other member matches the table above, including `qa-group-view` differing
between drives.

### P1-02 — Do the two drives use different people for the same role?

This is deliberate. If permissions ever leaked between drives, identical members would hide it.

**Expected:** `qa-group-view` holds **Content manager** on QA_Team1 but **Commenter** on
QA_Team2. If both drives show the same role, report it.

> **Do not expect drive members to appear as folder permissions in SharePoint.**
> Drive *membership* is not a folder permission. The combination document scopes the permission
> feature to "folder and file-level permissions". Missing per-folder entries for these six is
> **not** a defect.

---

## P2 — Folder permissions (Level 2)

These four folders each carry their own sharing, one per role. This is the real permission test.

Path in both systems: `Agent Shared Drive → Permission Matrix → folder_<role>`

| Folder | Google shows | SharePoint must show |
|---|---|---|
| `folder_reader` | warner@snapbot.io — Viewer | `warner@gajha.com` — can view |
| `folder_commenter` | warner@snapbot.io — Commenter | `warner@gajha.com` — can view |
| `folder_writer` | warner@snapbot.io — Contributor | `warner@gajha.com` — can edit |
| `folder_fileOrganizer` | warner@snapbot.io — Content manager | `warner@gajha.com` — can edit |

### P2-01 — Does each folder carry the right role for warner?

1. Google: right-click folder → **Share**. Note warner's role.
2. SharePoint: same folder → **⋮** → **Manage access**.
3. Compare against the table. Repeat for all four folders, on both drives.

**Expected:** 8 checks total (4 folders × 2 drives), all matching.
`warner@snapbot.io` is an outside user, so it is the most reliable signal — it holds no drive
membership that could mask its folder role.

### P2-02 — Did the extra group grants arrive?

**Expected:**
- QA_Team1 — `folder_writer` also has `qa-group-manage` as Contributor → **can edit**
- QA_Team2 — `folder_commenter` also has `qa-group-manage` as Commenter → **can view**

> **Ignore these in Manage access — they are not migrated permissions:**
> - **QA Owners / QA Members / QA Visitors** — SharePoint's own site groups, on every item by default
> - Anything ending `@…onmicrosoft.com` — system accounts
> - **A person showing higher access than expected** — if a group on the same folder grants more,
>   SharePoint shows the higher effective level. Their own permission is still correct.
>   Report as an observation, never a failure.

---

## P3 — General access and shared links

"General access" is the row at the bottom of Google's Share dialog. It offers *Restricted*,
*Sync Orbit* (the organization), or *Anyone with the link* — and it is now driven by the
Drive access chosen for that row.

### P3-01 — Does General access match the drive's access mode?

1. Google → open **Agent Shared Drive** inside each drive
2. Right-click → **Share** → look at **General access** at the bottom

**Expected:**
- QA_Team1 (open) → `Anyone with the link — Viewer`
- QA_Team2 (restricted) → `Sync Orbit — Viewer`

If QA_Team2 still says "Anyone with the link", the seeding step did not run — **report it**.
A drive marked restricted showing "Anyone with the link" is publishing its whole tree to the
public internet.

### P3-02 — Did the link matrix survive with both scope and access level intact?

Path: `Agent Shared Drive → Shared Link Matrix`.
Folders: `link_folder_<scope>_<role>`, files: `link_file_<scope>_<role>`.
Scope is `anyone` or `domain`.

**Expected:**
- `domain` items → SharePoint link scope **organization** ("People in TNG" — the destination tenant’s own org name)
- `anyone` items → SharePoint link scope **anonymous** ("Anyone with the link")
- Access level must also match: reader/commenter → view, writer/fileOrganizer → edit

> **On the OPEN drive, expect an EXTRA anonymous link on every item.**
> QA_Team1's General access is "Anyone with the link", and Google propagates that to everything
> inside. So `link_folder_domain_writer` on QA_Team1 legitimately carries **two** links: its own
> `domain/writer` plus the inherited `anyone/reader`. Verified in the source — the migration copied
> it faithfully. On QA_Team2 (restricted) the same folder has only `domain/writer`.
> A second anonymous link on a QA_Team1 item is **not** a duplicate-link bug.
>
> **Anonymous vs organization — why it matters.**
> SharePoint is permitted to refuse **anonymous** links if the site blocks public sharing, so a
> missing anonymous link may be policy rather than a defect. It is **never** permitted to drop an
> **organization** link. A missing Sync Orbit link is always a real defect.

---

## P4 — Long names and long paths

Two different rules, often confused.

| Rule | Trigger | What happens |
|---|---|---|
| **Long name** | one folder or file name too long | name is **shortened**, item stays where it is |
| **Long path** | whole path over **400 characters** | content is **moved** to a short path, a `.url` shortcut is left behind |

### P4-01 — Did the 200-character folder arrive, shortened but in place?

**Expected:** `Agent Shared Drive → Long Name Folder AAAA…` exists in SharePoint, name truncated
to about 97 characters, still **inside** `Agent Shared Drive`. Truncation is correct, not data loss.

### P4-02 — Where did the over-limit content go, and can it be opened by link?

1. SharePoint → `QA_Team1` (and `QA_Team2`) → note the folder **Long File Names** sitting
   *beside* `Agent Shared Drive`
2. Open `Agent Shared Drive → Over Limit Path` and drill down — you should find a
   `FolderPathLink….url` shortcut instead of the real file
3. Open `Long File Names` and drill down — the real `over_limit_target.txt` is here
4. On **Long File Names**: **⋮** → **Manage access**. Check whether any shareable link exists.

**Expected:** `Long File Names` is created by CloudFuze, **not** migrated from Google — it is
**not** leftover junk and should not be deleted. The real file must be inside it.

The open question is step 4: in Google this content carried a shareable link. If
`Long File Names` has **no link**, the link did not travel with the relocated content — that is
defect 2 below.

---

## 06 — Known defects: confirm, don't rediscover

Two defects are already established. Confirm each independently; if either does **not**
reproduce, that is worth reporting just as much.

### DEFECT 1 — Legacy Office files are not converted

Path: `Agent Shared Drive → File Formats`

Expected by the combination document (#38): `.doc → .docx`, `.xls → .xlsx`, `.ppt → .pptx`.
Actual: files arrive with the original extension.

Check `legacy_document.doc`, `legacy_workbook.xls`, `legacy_deck.ppt` on both drives.

**The files are present** — only the format is wrong. Do not report as missing data.

### DEFECT 2 — Relocated over-limit content loses its shared link

When a path exceeds 400 characters, CloudFuze moves the content to `Long File Names` — but the
shared link does not move with it. The `.url` shortcut left behind points at content that cannot
be opened by link.

Confirmed on QA_Team2, where the source link was **organization** scope — the scope SharePoint is
not permitted to refuse. That rules out site policy and makes it a genuine product defect.

### Expected behaviour — do NOT raise these

- **Version counts differ** between source and destination. The Google API merges small
  revisions; SharePoint may add one for the migration timestamp. Documented out of scope.
- **Google Docs / Sheets / Slides arrive as `.docx` / `.xlsx` / `.pptx`** with a larger file
  size. That is the conversion working.
- **Sharing emails arrived at the destination account.** Suppression was not requested for this
  run, and without it SharePoint sends standard notifications.
- **Special characters replaced** — e.g. `*` becomes `-`. SharePoint forbids them.

---

## 07 — How to report back

One line per test ID. Where something fails, include both sides so it can be acted on without
re-testing.

```
P2-01 · QA_Team2 · folder_writer — FAIL
   Google:     warner Contributor
   SharePoint: warner can view  (expected: can edit)
```

Use **PASS** / **FAIL** / **OBSERVATION** / **NOT TESTABLE**.

Anything you could not check — a folder that would not open, a permission dialog that would not
load — must be reported as **NOT TESTABLE**, never as a pass.

---

*Expected values are the seeded values from run `605ab6d5`. If the source data is re-seeded, the
people holding each role may rotate between drives — re-read Manage members before judging P2.*
