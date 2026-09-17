# Migration Feature Documentation

**Product Type:** Content
**Combination:** Box to Google (My Drive & Shared Drive)
**Scope:** In Scope
**Total Features:** 34
**Last Updated:** 2026-09-12
**Source:** `Content_BoxtoGoogle(MyDrive&SharedDrive)_(12-09-2026).pdf`

> Companion file: `box-to-google-outscope.md` — the documented limitations that must **not** fail a
> validation run.
>
> **My Drive only, for now.** `box_to_googledrive` is the only combination this document currently
> backs — there is no `box_to_googleshareddrive` combination in this repo yet. Add one, and extend
> `validation/roleMaps/box_to_google.js`'s `combinations` list, only alongside actually building it.
>
> **The destination is Google, not Microsoft.** Box's other content combinations
> (`box→sharepoint`, `box→onedrive`) migrate into SharePoint/OneDrive, and several rules read
> differently here for the same reason `dropbox-to-google-inscope.md` differs from the SharePoint
> combinations: Google rejects almost no characters and imposes no total-path limit. See
> `validation/destinations/googledrive.js`.

---

## 1. Migration (3 features)

### 1.1 Data Migration (Files & Folders with structure)
CloudFuze ensures the seamless migration of the data from the source cloud to destination, preserving
the accuracy and integrity of the data structure.

### 1.2 One time Migration
The initial data migration from source to destination is considered a one-time migration.

### 1.3 Delta
Migration of incremental changes made in the source after the one-time migration completed. A
**SEPARATE pass**, run only after a one-time migration has already landed — the same reasoning as
Dropbox's `applyDeltaChanges`, which is why `BoxToGoogledriveTestDataAgent.applyDeltaChanges` is not
called from `execute()`.

---

## 2. Permissions (5 features)

The document names four *positions* — root folder, sub folder, root file, inner file — plus external
shares. Position matters: a run that only checks the root proves nothing about inheritance, which is
why each is a separate feature rather than one "permissions" row.

### 2.1 Root Folder Permissions
CloudFuze preserves all root folder permissions along with access levels.

### 2.2 Sub Folder Permissions
CloudFuze preserves all sub-folder permissions along with access levels.

### 2.3 Root File Permissions
CloudFuze preserves all root file permissions along with access levels.

### 2.4 Inner File Permissions
CloudFuze preserves all inner file permissions along with access levels.

### 2.5 External Shares
CloudFuze can migrate permissions granted to people outside the organization, along with access
levels.

**Role translation.** Box exposes an eight-role collaboration ladder — `owner, co-owner, editor,
viewer, previewer, uploader, previewer uploader, viewer uploader` — considerably wider than Dropbox's
two-level `Can edit` / `Can view`. Google exposes `Editor` / `Commenter` / `Viewer` (and an owner).

| Box role | Google | Comparable? |
|---|---|---|
| owner | owner — not re-granted, the destination account owns the copy | No |
| co-owner | **Editor** (the ceiling Google can actually grant a non-owning collaborator on My Drive) | Yes, with a documented nuance — see below |
| editor | **Editor** | Yes |
| viewer | **Viewer** | Yes |
| previewer | **Viewer** (no distinct "preview, no download" role exists on Google) | Yes, with a documented nuance |
| previewer uploader | **Viewer** (the upload half has no Google equivalent) | Yes, with a documented nuance |
| viewer uploader | **Viewer** (the upload half has no Google equivalent) | Yes, with a documented nuance |
| uploader | — grants no read access to existing content at all | **No** — no Google role represents this |

See `validation/roleMaps/box_to_google.js` for the full reasoning behind each nuance — in particular
why `co-owner` is compared at Editor rather than at an unreachable "above Editor" level on My Drive,
and why `uploader` is not comparable at all (the same treatment Dropbox's `owner` gets).

---

## 3. Versions (2 features)

### 3.1 Version History
Migration of all file versions from source to destination.

### 3.2 Selective Versions
Migration of only the last N versions is a **job setting**, not a constant — the same treatment as
Dropbox scope 9.2. The seeded version count is reported; the validator compares it against what the
job actually requested rather than against a fixed number.

---

## 4. Meta Data (1 feature)

### 4.1 Meta Data
CloudFuze preserves the original creation and modification timestamps when migrating to the
destination.

**Both halves are comparable for this pair.** Box exposes `content_created_at` **and**
`content_modified_at` on every file — unlike Dropbox, which exposes no creation time at all. The
validator therefore compares both timestamps (`createdComparable: true`), not just modified.

---

## 5. Shared Links (2 features)

### 5.1 Shared Links (Anyone with the Link)
Box's "open" shared link migrates as Google's **"Anyone with the link"** (Viewer). After migration, a
CSV file is generated at the destination containing the source path, destination path and the shared
link.

### 5.2 Shared Links (Team Members)
Box's "company" shared link (people in your company) migrates as Google's
**"&lt;organization&gt;"** domain-scope link (Viewer). After migration, a CSV file is generated at the
destination the same way as 5.1.

**Only Viewer is ever expected, for both features.** Box's shared_link object has no edit-vs-view
axis at all — only `access` (open/company/collaborators) and `permissions.can_download` /
`can_preview`, never `can_edit`. Editing always requires a real collaboration, never a link. See
`boxClient.createSharedLink` and `validation/roleMaps/box_to_google.js`'s `expectedLinkType`, which is
unconditionally `'view'` for exactly this reason — a validator that expected an "Editor" outcome from
a Box link would be expecting something Box cannot produce.

Box's `collaborators` access is a **third** value with no comparable Google scope at all: it restricts
the link to people who already have collaborator access, granting no new access the way `open` /
`company` do. It is reported at INFO, claimed by neither 5.1 nor 5.2.

---

## 6. In-Line Comment (1 feature)

### 6.1 In-Line Comment
Box file comments migrate to the destination as a **CSV file** (username, comment, timestamp) — not
as native comments on the destination item. A migrated file with no comments on it is correct, not a
loss; the CSV is the evidence the feature worked. Same treatment as Dropbox's in-line-comment
out-of-scope note.

---

## 7. Long File/Folder Path (1 feature)

### 7.1 Long File/Folder Path
Google Drive imposes no total-path limit, so — as with `dropbox-to-google-inscope.md` 7.1 — the
expected outcome for this pair is the long path arriving **intact**: no placeholder link, no
relocation. Contrast with SharePoint, where exceeding 400 characters relocates the item behind a link.

---

## 8. Special Character Replacement (1 feature)

### 8.1 Special Character Replacement
Google accepts almost every character Box allows in a name, so — as with `dropbox-to-google-inscope.md`
5.1 — the expected outcome for this pair is **no replacement at all**. A validator applying
SharePoint's character set here would predict a rename that never occurs and report a correctly
migrated tree as broken.

---

## 9. Embedded Links (1 feature)

### 9.1 Embedded Links
Links inside a migrated file that point at other files are rewritten to destination URLs — but **only
when the referenced file is itself inside the migration scope**. A link to an out-of-scope file
remains pointing at Box. After migration, a CSV mapping report (source URL → destination URL) is
generated at the destination. Same conditional as Dropbox scope 8.1/10.8.

---

## 10. Box Notes (16 features)

Box Notes are a source-only Box document format. **The source document states the migrated format
plainly: "Migration of Box Notes files in the .DOCX format to the destination cloud" — unlike Dropbox
Paper, whose own scope document explicitly says Paper converts to a Google Doc (`.gdoc`).** Do not
assume Google-native conversion here by analogy with Paper; 10.1's pass condition is that the Note
arrives at the destination, not that it arrives as a native Google Doc.

Real Box Notes ARE seeded for this combination, via Box's `POST /2.0/notes/convert` API (released May
2026 — see `boxClient.createNote` and `BoxToGoogledriveTestDataAgent._seedBoxNotes`), which converts
Markdown into a genuine `.boxnote` file. That corrects an earlier assumption in this repo that no such
API existed. What remains true is that Box has **no public *export* endpoint** for reading a Note's
content back out, so — unlike Dropbox Paper, where `paperMarkdownStructure`/`googleDocStructure` do an
automated structural comparison — content-fidelity here (10.2-10.16) cannot be *measured* by API even
though most of it can now be *seeded* by API. See `box-to-google-outscope.md` and `_seedBoxNotes`'s
`notSeeded` entry for exactly which of the 15 still need a human eye, and which five (10.3, 10.6, 10.8,
10.9, 10.13) have no Markdown equivalent at all and so cannot be seeded either. Per-feature outcome,
taken directly from the source document:

### 10.1 Box Notes Migration
Box Notes migrate to the destination cloud in the **.DOCX format**.

### 10.2 Text Formatting
Bold, italic and underline are preserved. Strikethrough, text alignment and inline code are **not**
retained — they render as normal text at the destination.

### 10.3 Font Size and Text Color
**Not preserved** — the destination renders uniform size and default color.

### 10.4 Checklist, Numbered list, Bulleted list
**Not preserved** — all convert to plain text, losing structure and functionality.

### 10.5 Tables
**Not migrated correctly** — structure, alignment and formatting are broken; the layout is distorted
and unreadable.

### 10.6 Insert Image (upload from computer)
**Not preserved** — images uploaded directly from a computer are lost.

### 10.7 Insert Image (Box Shared Link)
Migrates successfully — structure is preserved. The one image-insertion method that survives.

### 10.8 Insert Image (Insert Link Preview)
**Not preserved** — loss of content.

### 10.9 Clipboard Images
**Not preserved** — loss of visual content.

### 10.10 Emojis
Migrate successfully and display correctly.

### 10.11 GIFs
**Not preserved** — rendered incorrectly / as unsupported elements at the destination.

### 10.12 Unicode Symbols
Migrate successfully, no data loss.

### 10.13 Mentions
**Not migrated** — missing completely, a loss of reference information.

### 10.14 Box Notes Comments
Migrate successfully as a **CSV** at the destination (username, created_date, comments, email) — the
same "CSV is the evidence" treatment as feature 6.1, not as native destination comments.

### 10.15 Links
Migrate successfully and remain clickable.

### 10.16 Hyperlinks
Migrate successfully — the URL redirects to the destination file.

---

## 11. Suppressing Email Notification (1 feature)

### 11.1 Suppressing Email Notification
No email notifications are generated for destination-side collaborations created by the migration.
Only judgeable when suppression was actually requested — see `CONTENT_MIGRATION_SUPPRESSES_NOTIFICATIONS`
in `.env.example`. Report NOT VERIFIED rather than a guessed pass when it cannot be confirmed from the
Google side, exactly as `GoogleDriveValidationAgent.findSharingNotifications` already documents (that
method is inherited unchanged — see `agents/googledrive/GoogleDriveValidationAgent.js`).

---

**Total: 3 + 5 + 2 + 1 + 2 + 1 + 1 + 1 + 1 + 16 + 1 = 34.**
