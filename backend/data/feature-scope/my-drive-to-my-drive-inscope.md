# Migration Feature Documentation

**Product Type:** Content
**Combination:** My Drive to My Drive
**Scope:** In Scope
**Total Features:** 17
**Last Updated:** 2026-09-14
**Source:** `Content_MyDrivetoMyDrive_(14-09-2026).pdf`

> Companion files: `my-drive-to-my-drive-outscope.md` (7 documented limitations that must **not** fail
> a run) and `my-drive-to-my-drive-testdata.md` (what must exist in the source account).
>
> **This is Google → Google, and that makes it unlike every other content combination in this repo.**
> Source and destination expose the *same* role vocabulary, the same link audiences and the same
> native file types. Nothing is being translated into a foreign permission model, so the expected
> result for most features is **identity** — what went in comes out unchanged. Features 5.1 and 7.1
> in particular are near no-ops here, because the destination is the same platform that produced the
> data. See `validation/destinations/googledrive.js`.
>
> **It is cross-tenant, not same-account.** Every figure shows `@filefuze.co` on the left and
> `@cloudfuze.com` on the right, with different owners (Erik E → Mia M). So "My Drive to My Drive"
> means *one Workspace tenant's My Drive to another tenant's My Drive*, and user identities must be
> **mapped** between them. All nine permission cases in the Xray repository say "For Root to Root CSV
> mapping" — the CSV is the mapping mechanism, not an optional extra.

---

## 1. Migration (3 features)

### 1.1 Data Migration (Files & Folders with structure)
CloudFuze ensures the seamless migration of the data from the source cloud to destination, preserving
the accuracy and integrity of the data structure.

### 1.2 One Time Migration
The initial data migration from source to destination is considered as One-time migration.

### 1.3 Delta Migration
Migration of incremental changes made in source during the onetime migration.

---

## 2. Permissions (5 features)

The document names four *positions* — root folder, root file, sub-folder, inner file — plus external
shares. Position matters: a run that only checks the root proves nothing about inheritance, which is
why each is a separate feature rather than one "permissions" row.

### 2.1 Root Folder Permissions
CloudFuze preserves all root folder permissions along with access levels.

### 2.2 Root File Permissions
CloudFuze preserves all Root file permissions along with access levels.

### 2.3 Sub-folder permissions
CloudFuze preserves all subfolder permissions along with access levels.

### 2.4 Inner File Permissions
CloudFuze preserves all inner file permissions along with access levels.

### 2.5 External Shares
CloudFuze can migrate external permissions (Files/Folders shared with people of outside
organizations) of files/folders to the destination along with access levels.

**Role translation is identity — but the principal is not.** Google to Google, so the roles do not
change:

| Source (Google) | Destination (Google) |
|---|---|
| Owner | owner — not re-granted, the destination account owns the copy |
| Editor | **Editor** |
| Commenter | **Commenter** |
| Viewer | **Viewer** |

What *does* change is **who** holds the grant. Figure 2.1.1 shows `Alex A (alex@filefuze.co)` as
Viewer on the source arriving as `Anthony Raymond (anthony@cloudfuze.com)` as Viewer on the
destination; `Ben B` → `James J` likewise. The role is preserved, the identity is remapped. A
validator that compares grantee email addresses literally will fail every one of these.

Group principals are mapped the same way — figure 2.3.1 shows `harry-group-@filefuze.co` arriving as
`harry_group_@cloudfuze.com`. Note that in the same figure `kalyan_test_group_2@filefuze.co` appears
**unchanged on both sides**, so not every principal is remapped. Whether that is a mapping gap or a
deliberate cross-tenant grant is not stated.

> ⚠️ **Commenter is undocumented here but heavily tested.** No figure in this document shows a
> Commenter grant — only Viewer and Editor. Yet **three of the nine** permission cases in the Xray
> repository are commenter cases (internal, external and group). Commenter is a Google role that
> exists on both sides, so it should map to itself, but this document does not say so. Confirm before
> a validator treats commenter as in scope.

---

## 3. Shared Links (2 features)

### 3.1 Shared Links (Anyone with the Link)
CloudFuze migrates all shared links from source to destination and maintains the type of links.
Anyone with the link '(Viewer/ Editor)' will migrate as **'Anyone with the link (Viewer/ Editor)'**.

### 3.2 Shared Links (Sync Orbit)
CloudFuze migrates all shared links from source to destination and maintains the type of links.
'Sync Orbit (Viewer/Editor)' will migrate as **'Sync Orbit (Viewer/Editor)'**.

> ⚠️ **The prose and the figure disagree on 3.2.** The text says the audience stays `Sync Orbit`.
> Figure 3.2.1 shows the source general-access set to **`Sync Orbit`** and the destination set to
> **`cloudfuze.com`** — the destination tenant's own organisation, not the source's.
>
> The figure is the more plausible reading: `Sync Orbit` is the *source* Workspace's organisation
> name, and Google renders domain-restricted access as whatever the owning org is called. Across two
> tenants it therefore *cannot* stay "Sync Orbit" — the destination org has a different name. Treat
> the general rule as **"domain-restricted access stays domain-restricted, named for the destination
> org"**, and compare against the destination tenant's org name rather than the literal string
> `Sync Orbit`. The same wording appears in `box-to-google-inscope.md` 5.2 and needs the same reading.

Unlike the Box and Dropbox combinations, **neither feature here mentions a CSV report** being written
for shared links. Only 8.1 does. Do not assume a links CSV exists for this pair.

---

## 4. Metadata (1 feature)

### 4.1 Metadata
Maintaining the original timestamps, including creation and modification dates and times, when
transferring data to the destination cloud.

Figure 4.1.1 shows a folder listing where every `Date modified` matches between source and
destination, including a same-day `2:43 PM` entry — so the check is to the minute, not the day.

---

## 5. Special Characters Replacement (1 feature)

### 5.1 Special Characters Replacement
Special characters not supported by the destination cloud will be automatically replaced with
underscores (_) or hyphens (-). This ensures that the integrity of the data is maintained during the
migration process.

**Expect no replacement at all.** The destination is Google, which is also the source, so by
definition every character in the source is already accepted by the destination. Figure 5.1.1 shows a
punctuation-heavy file name arriving **byte-identical**. This feature is boilerplate carried over from
the SharePoint combinations; on this pair a *replaced* character is the finding, not the pass
condition.

---

## 6. Suppressing email notifications (1 feature)

### 6.1 Suppressing email notifications
The system will automatically prevent the generation of email notifications for collaborations on
folders/files originating from the destination cloud.

**Evidence is an absence**, which nothing in the destination Drive can show. Validating this needs the
destination users' mailboxes, not the Drive API. If that is out of reach for a run, report it as
not-automated with the reason rather than passing it silently. No figure is provided for this feature.

---

## 7. Long-File/folder path (1 feature)

### 7.1 Long-File/folder path
If the destination cloud has a long folder path limitation, the system automatically adjusts the
destination's path as per the limitation.

**Google imposes no total-path limit**, and here the source is Google too — so any path that exists in
the source is by construction legal in the destination. Figure 7.1.1 shows a `TEST01…TEST09` chain
arriving intact. As with 5.1, expect **no adjustment**; a shortened path is the finding.

> `validation/destinations/googledrive.js` declares `pathLengthLimit: Infinity` and marks it **NOT YET
> EXERCISED**. On this combination that value is not merely unexercised, it is *unfalsifiable* — no
> source path can exceed it. The open "breaking point" question in `dropbox-to-google-testdata.md`
> cannot be answered from this pair.

---

## 8. Embedded Links (1 feature)

### 8.1 Embedded Links
The system retains the addresses of links present within a file, which point to other files in the
cloud. These links' addresses will be transformed into appropriate destination formats during
Migration. **and a csv is also generated.**

Figures 8.1.1–8.1.3 show a spreadsheet cell whose `drive.google.com/file/d/1SuKpCE…` link is rewritten
to `drive.google.com/file/d/1O9OW…` — a *different file id on the same host*. This is the one feature
where Google-to-Google is **harder** to validate than a cross-platform pair: the URL shape does not
change, only the id, so a naive "does it still look like a Drive link" check passes even when nothing
was rewritten. Compare against the destination file's actual id.

Figure 8.1.3 shows the generated report as `Erik E-EmbeddedLinks.csv` with columns
`Original File Name, Original File Path, Link Text Name, Linked File Path, Source url, Destination url`.
That CSV is an ordinary file in the destination and can be read directly — there is no special API
for it.

---

## 9. Versions (2 features)

### 9.1 Version History
Migration of **all** file versions from source to destination.

> Note the wording is stronger than the other combinations, which say only that version history is
> preserved. Figure 9.1.1 shows just two versions (`Current version` + `Version 1`), so "all" is
> asserted by the text, not demonstrated by the evidence. Seed a file with enough versions to make the
> claim testable — see the testdata file.

### 9.2 Selective Versions
Migration of selective versions of files from source to destination. If we opt for five, the last five
versions will get migrates to the destination.

> Figure 9.2.1 is the **same two-version screenshot as 9.1.1**. A five-version selection cannot be
> demonstrated by a file that only has two versions, so this feature is effectively unevidenced in the
> document. It needs a file with more than five versions to mean anything.

---

## Feature count

| Section | Features |
|---|---|
| 1. Migration | 3 |
| 2. Permissions | 5 |
| 3. Shared Links | 2 |
| 4. Metadata | 1 |
| 5. Special Characters Replacement | 1 |
| 6. Suppressing email notifications | 1 |
| 7. Long-File/folder path | 1 |
| 8. Embedded Links | 1 |
| 9. Versions | 2 |
| **Total** | **17** |

Matches the document's stated total.

**No validator exists for this pair yet.** `validation/combinations/content/` has no
`googledriveToGgoogledrive.js`, and `validation/roleMaps/` has no Google→Google map. The role map is
the smaller job than it looks — roles are identity (see 2.x) — but the **principal remapping** across
tenants is new work that no existing role map does.
