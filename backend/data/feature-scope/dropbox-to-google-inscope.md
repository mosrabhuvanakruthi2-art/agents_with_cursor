# Migration Feature Documentation

**Product Type:** Content
**Combination:** Dropbox to Google (My Drive & Shared Drive)
**Scope:** In Scope
**Total Features:** 36
**Last Updated:** 2026-09-01
**Source:** `Content_DropboxtoGoogle(MyDrive&SharedDrive)_(01-09-2026).pdf`

> Companion file: `dropbox-to-google-outscope.md` — the documented limitations that must **not** fail
> a validation run.
>
> **Covers both combinations.** The document is written for My Drive *and* Shared Drive together, so
> `dropbox → googledrive` and `dropbox → googleshareddrive` share this scope. Where a feature behaves
> differently between the two, that is called out on the feature.
>
> **The destination is Google, not Microsoft.** Every other content combination in this repo migrates
> into SharePoint or OneDrive, and the rules are not the same. Google rejects almost no characters,
> reserves no names, and imposes no total-path limit — so features 5.1 and 7.1 read very differently
> here than they do in `google-shared-drive-to-sharepoint-inscope.md`. See
> `validation/destinations/googledrive.js`.

---

## 1. Migration (3 features)

### 1.1 Data Migration (Files & Folders with structure)
CloudFuze ensures the seamless migration of the data from the source cloud to destination, preserving
the accuracy and integrity of the data structure.

### 1.2 One Time Migration
The initial data migration from source to destination is considered as One-time migration.

### 1.3 Delta Migration
Migration of incremental changes made in source during the one-time migration.

---

## 2. Permissions (5 features)

The document names four *positions* — root folder, root file, sub-folder, inner file — plus external
shares. Position matters: a run that only checks the root proves nothing about inheritance, which is
why each is a separate feature rather than one "permissions" row.

### 2.1 Root Folder Permissions
CloudFuze preserves all root folder permissions along with access levels.

### 2.2 Root File Permissions
CloudFuze preserves all root file permissions along with access levels.

### 2.3 Sub-folder permissions
CloudFuze preserves all subfolder permissions along with access levels.

### 2.4 Inner file permissions
CloudFuze preserves all inner file permissions along with access levels.

### 2.5 External Shares
CloudFuze can migrate external permissions (files/folders shared with people of outside
organizations) of files/folders to the destination along with access levels.

**Role translation.** Dropbox exposes `Can edit` / `Can view` (and an owner). Google exposes
`Editor` / `Commenter` / `Viewer` (and an owner). From the document's own figures:

| Dropbox | Google |
|---|---|
| Can edit | **Editor** |
| Can view | **Viewer** |
| owner | owner — not re-granted, the destination account owns the copy |

Note this is a *two-level* source, unlike Google→SharePoint where four Drive roles collapse into two
SharePoint ones. There is no Dropbox equivalent of `Commenter`, so a destination `Commenter` is not
an expected outcome of any source role.

---

## 3. Shared Links (2 features)

### 3.1 Shared Links (Anyone with the Link)
CloudFuze migrates all shared links from source to destination and maintains the type of links.
Anyone with the link *(Link for viewing / Link for Editing)* will migrate as **Anyone with the link
(Viewer / Editor)**. After migration, a CSV file is generated at the destination containing the
source path, destination path, and corresponding shared links.

### 3.2 Shared Links (Team Members)
CloudFuze migrates all shared links from source to destination and maintains the type of links. *Team
members (Link for viewing / Link for Editing)* will migrate as **Sync Orbit (Viewer / Editor)**.
After migration, a CSV file is generated at the destination containing the source path, destination
path, and corresponding shared links.

**"Sync Orbit" is the destination organisation's own name**, shown in Google's General access row. It
is the Google equivalent of a domain-scope link, i.e. `type: 'domain'` in the Drive API and
`organization` in the SharePoint vocabulary the shared validator uses. A run in a different tenant
will show that tenant's name instead — match on the SCOPE, never on the literal string "Sync Orbit".

**Link scope mapping:**

| Dropbox link audience | Google General access |
|---|---|
| Anyone with the link | **Anyone with the link** (`anyone`) |
| Team members | **&lt;organisation&gt;** (`domain`) |

---

## 4. Metadata (1 feature)

### 4.1 Metadata
Maintaining the original timestamps, including creation and modification dates and times, when
transferring data to the destination cloud.

---

## 5. Special Characters Replacement (1 feature)

### 5.1 Special Characters Replacement
Special characters **not supported by the destination cloud** will be automatically replaced with
underscores (`_`) or hyphens (`-`). This ensures that the integrity of the data is maintained during
the migration process.

**Read the condition carefully.** The rule is "not supported by the destination cloud", and the
destination here is Google, which accepts characters SharePoint rejects — including `" * : < > ? |`.
The document's own figure shows `!@#$%^&*()_+[]{};:,.<>?` arriving **unchanged** at Google.

So for this combination the expected outcome is normally **no replacement at all**. A validator that
applied SharePoint's character set here would predict a renamed folder that never occurs, report it
missing, report its real name extra, and report every child misplaced — the exact four-way failure
that one wrong character class produced on run 6a8d53d2 of the Shared Drive combination.

---

## 6. Suppressing email notifications (1 feature)

### 6.1 Suppressing email notifications
The system will automatically prevent the generation of email notifications for collaborations on
folders/files originating from the destination cloud.

**Only judgeable when suppression was requested.** Without it, notification mail is the correct
outcome and must not be failed — see `CONTENT_MIGRATION_SUPPRESSES_NOTIFICATIONS` in `.env.example`.

---

## 7. Long-File/folder path (1 feature)

### 7.1 Long-File/folder path
**If the destination cloud has a long folder path limitation**, the system automatically adjusts the
destination's path as per the limitation.

**Conditional, and the condition is not met here.** Google Drive imposes no total-path limit, so no
adjustment is expected and no placeholder link is created. This feature is exercised only in the
sense that a long path must arrive intact.

Contrast with SharePoint, where exceeding 400 characters produces a Folder/File Path Link URL and the
content is relocated. Expecting that behaviour on a Google destination would report intact data as
wrongly handled.

---

## 8. Embedded Links (1 feature)

### 8.1 Embedded Links
The system retains the addresses of links present within a file, which point to other files in the
cloud. These links' addresses will be transformed into appropriate destination formats during
migration. After migration, a CSV file is generated at the destination that maps the source URLs to
their corresponding destination URLs.

See also **10.8**, which records the limit of this: transformation happens only when the referenced
file is itself inside the migration scope.

---

## 9. Versions (2 features)

### 9.1 Version History
Migration of all file versions from source to destination.

### 9.2 Selective Versions
Migration of selective versions of files from source to destination. If we opt for five, the last
five versions will get migrated to the destination.

**So the expected count is a job setting, not a constant.** A run configured for five versions and
delivering five is correct; so is a run configured for all versions delivering all. The count alone
cannot be judged without knowing which was requested.

---

## 10. Dropbox Papers (19 features)

Dropbox Paper is a source-only document format with no Google equivalent, so every Paper is
**converted** to a Google Doc. That conversion is lossy in specific, documented ways. The document
records what was observed feature by feature — including several elements that do **not** survive.

> **Those observations are recorded here, not in the out-of-scope file.** Whether a documented
> "not migrated" is an accepted limitation or an open defect is a decision for the combination owner,
> not for the validator. Until that is ruled on, each is reported with the document's own wording and
> does not contribute to a FAIL. See the note at the end of this section.

### 10.1 Dropbox Papers Migration
Dropbox Paper documents are collaborative, cloud-based files stored within Dropbox. During migration,
these documents are converted and migrated as Google Docs (`.gdoc`) files in the target environment.

### 10.2 Text Formatting
Most formatting elements — bold, strikethrough, headings (H1, H2), links, and overall text structure
— are preserved correctly after migration. **Minor differences, such as highlight colours, are not
migrated.**

### 10.3 Inserted Images
Inserted images are successfully migrated and retained in the document. Image positioning and overall
layout are preserved.

### 10.4 Inserted Media
Inserted media is successfully migrated and displayed correctly in the document.

### 10.5 Clipboard Images
Clipboard images are successfully migrated and displayed correctly in the document.

### 10.6 GIFs
**GIFs are not properly migrated** and appear as unsupported elements in the destination document.

### 10.7 Links
Links are successfully migrated and remain clickable in the document.

### 10.8 Insert Dropbox Files
Inserted file links are updated to destination URLs **only if the referenced files are included in
the migration scope**. If the referenced files are not migrated, the links remain unchanged and
continue pointing to the source (Dropbox) URLs.

*Note: link transformation is dependent on file inclusion in the migration job.* This is the
condition on feature 8.1, and it means a link still pointing at Dropbox is only a defect when its
target was in scope.

### 10.9 Tables
Up to **62 columns** migrate reliably, aligning with Google Docs limitations. With minimal content
per cell, up to **63** migrate. At 64 columns the content of the 64th merges into the 63rd and
continues accordingly. When cells contain extensive data, only up to 62 migrate; beyond that,
overflow columns merge into the last column, affecting table structure.

### 10.10 Inserted Timeline
An inserted timeline from the source is migrated as a **table** at the destination. All visible
columns (Title, Dates, Assigned To, Description) are preserved.

### 10.11 TO-DO list
To-do list items migrate as standard checklist content. Checkbox states and text content are
preserved.

### 10.12 Bulleted List
Bulleted lists migrate successfully; formatting and structure are preserved.

### 10.13 Numbered List
Numbered lists migrate successfully with numbering, structure and formatting preserved.

### 10.14 Section Break
**Section breaks are not migrated** — no corresponding formatting or separators are present at the
destination.

### 10.15 Code Block
The content inside the code block migrates successfully. **The code block formatting (background,
borders, structured layout) is not fully preserved**, resulting in plain text representation.

### 10.16 Emojis
Emojis migrate successfully and display correctly.

### 10.17 Mentions
**User mentions are not migrated as expected.** They appear as plain, editable text at the
destination rather than proper mentions, and the link appears as an invalid link.

### 10.18 Comments
**Comments are not migrated.** The destination item does not contain any of the original comments
from the source.

### 10.19 Versions of Dropbox Papers
Version history for Paper files is **not visible at the source**. At the destination version history
is present in the UI, but those versions appear to be created or updated at the API level during
migration rather than preserving the original history.

So a version count on a migrated Paper describes the migration, not the source, and the two cannot be
compared.

---

## Open question for the combination owner

Six features above record behaviour that did not migrate: **10.2** (highlight colours), **10.6**
(GIFs), **10.14** (section breaks), **10.15** (code block formatting), **10.17** (mentions) and
**10.18** (comments). They are listed in the IN-scope document, yet the out-of-scope document contains
only one item — the in-line comment CSV.

That leaves a genuine ambiguity, and it changes verdicts:

- If these are **accepted limitations**, they belong in the out-of-scope file and must be reported at
  INFO, never failing a run.
- If they are **open defects**, they belong in the report as failures and should go to the CloudFuze
  dev team.

Until the owner rules, the validator reports each at INFO with the document's own wording. That is
the honest position: it neither hides a defect nor invents one. **Do not resolve this by guessing** —
on the Shared Drive combination, a guessed rule produced a false failure on 92 ordinary notification
emails, and a separate guessed rule produced a pass reading "handled as documented" directly above a
FAIL for the same thing.
