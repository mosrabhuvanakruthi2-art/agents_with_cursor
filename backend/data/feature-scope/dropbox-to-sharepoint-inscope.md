# Migration Feature Documentation

**Product Type:** Content
**Combination:** Dropbox to Microsoft (OneDrive & SharePoint)
**Scope:** In Scope
**Total Features:** 36
**Last Updated:** 2026-09-09
**Source:** `Content_DropboxtoMicrosoft(OneDrive&SharePoint)_(09-09-2026).docx`

> Companion file: `dropbox-to-microsoft-outscope.md` — the documented limitations that must **not**
> fail a validation run.
>
> **Covers both destinations.** The document is written for OneDrive *and* SharePoint together, so
> `dropbox → sharepoint` and `dropbox → onedrive` share this scope, exactly as
> `dropbox-to-google-inscope.md` covers My Drive and Shared Drive together.

---

## ⚠️ This is NOT the Dropbox → Google scope renumbered

Both documents describe a Dropbox source and both total 36 features, which makes them look
interchangeable. They are not. Three differences produce confident false verdicts if the Google
document is templated on:

1. **The numbering is completely different.** Google has no Folder Display; its Versions section is
   §9, here it is §3; its Paper section is §10, here it is §11. A validator reusing Google's ids
   reports ids that do not exist in the document a reviewer is holding.

   | | Dropbox → Google | Dropbox → Microsoft |
   |---|---|---|
   | Migration | §1 (3 features) | §1 (**2** features) |
   | Folder Display | — | **§2 (1) — no Google equivalent** |
   | Versions | §9 (2) | §3 (2) |
   | Permissions | §2 (5) | §4 (5) |
   | Shared Links | §3 (2) | §5 (2) |
   | Metadata | §4 (1) | §6 (1) |
   | Special Characters | §5 (1) | §7 (1) |
   | Long path | §7 (1) | §8 (1) |
   | Embedded Links | §8 (1) | §9 (1) |
   | Suppress notifications | §6 (1) | §10 (1) |
   | Dropbox Paper | §10 (19) | §11 (19) |

2. **The destination rules invert.** Google rejects almost no characters and imposes no total-path
   limit, so its 5.1 and 7.1 expect *no* replacement and *no* relocation. Microsoft replaces
   unsupported characters and enforces 400 characters, so **7.1 and 8.1 here expect exactly the
   behaviour the Google document rules out.** These are the shared SharePoint rules already in
   `validation/destinations/sharepoint.js` — use them, do not restate them locally.

3. **Paper converts to a different format.** Google: Google Docs. Microsoft: **Word `.docx`**. The
   `papertoGDoc=true` job flag in `migrationClient.js` is gated on a Google destination and is not
   the right flag here.

---

## 1. Migration (2 features)

### 1.1 One time migration
The initial data migration from source to destination is considered as Onetime migration.

### 1.2 Delta
Migration of incremental changes made in the source cloud after the onetime migration.

> **Note:** the Google document additionally carries a "Data Migration (Files & Folders with
> structure)" feature; this document does not. Structural correctness is still validated — it is the
> precondition for every other feature — but it is reported under 1.1 rather than as its own id.

---

## 2. Folder Display (1 feature)

### 2.1 Folder Display
Visual mapping of source and destination users through folder selection in the CloudFuze webapp.

> **Validation treatment.** This is a property of the CloudFuze **web app**, not of the migrated
> data: nothing about it can be observed by reading the destination cloud. It is therefore **not
> automatable** by this repo's destination comparison and must be reported `na` with that reason —
> never `pass`. Marking it passed because a run completed would be exactly the silent-pass this
> project exists to catch.

---

## 3. Versions (2 features)

### 3.1 Versions
Migration of all file versions from the source to the destination. CloudFuze migrates Dropbox file
versions **from the last 180 days** along with the latest version; **older versions are not
migrated**. All supported versions are preserved accurately. In SharePoint Online, **an extra version
may appear with the migration date/time — this is a system-generated entry, not a duplicate**. For
complete migration, all folders must be **owned by or shared with the Team Admin**; otherwise,
inaccessible content will be skipped.

> **Three concrete validation rules, all stated by the document itself:**
>
> - **A 180-day window.** A source version older than 180 days is expected **absent**. Counting it
>   missing fails a correct migration.
> - **A +1 tolerance at the destination.** SharePoint adds one system version stamped with the
>   migration time. `destCount === srcCount + 1` is a **pass**, not an extra.
> - **Team Admin access gates completeness.** Content not owned by or shared with the Team Admin is
>   skipped by design. A gap explained by this is reported, not failed — but the run must say so
>   explicitly rather than silently reconciling.

### 3.2 Selective Versions
Migration of selected versions of files. For example, choosing five versions will migrate the last
five versions to the destination.

---

## 4. Permissions (5 features)

The document names four *positions* — root folder, sub folder, root file, inner file — plus external
shares. Position matters: a run that only checks the root proves nothing about inheritance, which is
why each is a separate feature rather than one "permissions" row.

### 4.1 Root Folder Permissions
CloudFuze preserves all root folder permissions and access levels in the destination cloud.

### 4.2 Sub Folder Permissions
CloudFuze preserves all subfolder permissions and access levels in the destination cloud.

### 4.3 Root File Permissions
CloudFuze preserves all root file permissions and access levels in the destination cloud.

### 4.4 Inner File Permissions
Preservation of all inner file permissions and access levels in the destination cloud.

### 4.5 External Shares
CloudFuze can migrate external permissions (files/folders shared with users outside the
organization) to the destination, maintaining access levels.

**Role translation.** Dropbox is a *two-level* source: `Can edit` / `Can view`, plus an owner.

| Dropbox | Microsoft |
|---|---|
| Can edit | **Edit** |
| Can view | **Read / View** |
| owner | owner — not re-granted; the destination account owns the migrated copy |

There is no Dropbox equivalent of a comment-only role, so a destination role granting more than the
source did is an **escalation** and must be reported as one.

> **Known account limits, measured on `erik@filefuze.co` and recorded so they are not mistaken for
> defects.** These belong to the source account, not the product, and the seeding agent reports them
> as NOT SEEDED so no verdict can be issued on evidence that was never created:
> file-member `editor` fails with `no_permission` while folder-member `editor` succeeds; editor
> *links* fail on both files and folders (`settings_error/invalid_settings`) while viewer links
> succeed; and `cant_share_outside_team` blocks external shares, making **4.5 untestable** until an
> admin enables external sharing.

---

## 5. Shared Links (2 features)

### 5.1 Shared Links (Anyone with the Link)
CloudFuze migrates all shared links from the source to the destination while maintaining the type of
links. *Anyone with the link (Link for viewing / Link for Editing)* will migrate as **Anyone with the
link (can view / can Edit)**. After migration, a CSV file is generated at the destination containing
the source path, destination path, and corresponding shared links.

### 5.2 Shared Links (Team Members)
CloudFuze migrates all shared links from source to destination and maintains the type of links.
*Team members (Link for viewing / Link for Editing)* will migrate as **People in organization with
the link (Can view / can Edit)**.  After migration, a CSV file is generated at the destination
containing the source path, destination path, and corresponding shared links.

> **Both axes must be asserted.** A link has a *scope* (who it reaches) and a *type* (what they can
> do). Checking only one passes a link that reaches the whole world read-only when it should have
> reached the organisation with edit.
>
> The destination wording differs from the Google pair: **"People in organization with the link"**,
> not the organisation's display name. Matching on a tenant's own name would be wrong here.
>
> **The CSV is evidence, not decoration.** Both features state a CSV is written at the destination.
> It is an ordinary file and can be read directly — the Google pair's out-of-scope document records
> that two features were marked "not automated — no API for the CSV" for months while the files sat
> in the destination the whole time.

---

## 6. Metadata (1 feature)

### 6.1 Metadata
Maintaining the original timestamps, including creation and modification dates and times, when
transferring data to the destination cloud. **By default, CloudFuze updates only `ModifiedTime`
during migration because the Microsoft Graph API supports only this field. Other metadata fields like
`CreatedBy`, `ModifiedBy` and `CreatedTime` are not supported via Graph API.** To update all metadata
fields, the SharePoint REST API must be enabled with admin consent, required permissions, and a small
configuration change. Once enabled, all metadata (`CreatedBy`, `ModifiedBy`, `CreatedTime`,
`ModifiedTime`) can be fully preserved after migration.

> **This is the single most important validation rule in the document, and it is easy to get
> backwards.** In the default configuration **only `ModifiedTime` is expected to be preserved**.
> Comparing `CreatedTime`, `CreatedBy` or `ModifiedBy` and failing on a mismatch reports a defect
> against documented, expected behaviour.
>
> Note also that Dropbox exposes **no creation time for files at all** (`dropboxClient.toItem` sets
> `createdAt: null`), so there is no source value to compare even if Graph accepted one.
>
> A run must therefore compare `ModifiedTime` only, and report the other three fields as `na` with
> this reason. If the SharePoint REST API is later enabled for the tenant, that is a **change of
> expectation** and belongs in this document before the validator changes.

---

## 7. Special Character Replacement (1 feature)

### 7.1 Special Character Replacement
Special characters not supported by the destination cloud will be automatically replaced with
underscores (`_`) or hyphens (`-`). This ensures that the integrity of the data is maintained during
migration.

> **Use the shared destination rules — do not restate the character class.** The authority is
> `validation/destinations/sharepoint.js`. Its invalid set is `" * : < > ? / \ |`.
>
> **`~ # % & { }` are VALID and must be expected preserved.** Treating them as replaced is a
> recorded, costly error: run `6a8d53d2` produced four wrong findings from exactly that one wrong
> character class. `boxToSharepoint.js` still carries a local `SP_INVALID_CHARS` that includes them
> — it is a hazard to avoid copying, not a reference.
>
> Because the document names **both** `_` and `-`, a destination name must be matched against both
> replacements rather than assuming one.

---

## 8. Long Folder/File path (1 feature)

### 8.1 Long Folder/File path
During Dropbox to Microsoft migrations, Microsoft enforces a **400-character maximum file path
length**. Files or folders exceeding this limit cannot be migrated directly.

To handle this, CloudFuze's X-Change engine identifies such items and creates **placeholder links**
in the destination that redirect to the original content. It also generates a **"Long File Names
Folder"** listing all affected items, enabling admins to review and take corrective actions like
renaming or restructuring. After migration, a CSV file is generated at the destination containing the
source path and destination path.

> **The expected outcome over the limit is a placeholder link, not the item.** An item past 400
> characters reported "missing" is a false failure — `deepContentCore.expectPlaceholderLink` already
> routes these to their own bucket.
>
> The limit is measured on the **URL-encoded** path (a space costs 3 characters, not 1) with each
> segment capped at 255, and it applies to the **full destination path**, so the destination root
> prefix counts toward it.
>
> The **"Long File Names Folder"** is created by CloudFuze on every run where it applies. It is
> documented behaviour and belongs in the cleanup allowlist — otherwise copies accumulate and the
> next run reports them as extras.

---

## 9. Embedded Links (1 feature)

### 9.1 Embedded Links
The system retains links within files that point to other cloud files and converts them to the
correct destination format during migration. After migration, a CSV file is generated at the
destination that maps the source URLs to their corresponding destination URLs.

> Conversion is expected **only for referenced files that were themselves part of the migration** —
> the same condition the document states explicitly for Paper inserts in 11.8. A link to a file
> outside the job legitimately still points at Dropbox.

---

## 10. Suppress Email Notification (1 feature)

### 10.1 Suppress Email Notification
The system will automatically prevent the generation of email notifications for collaborations on
folders/files originating from the destination cloud.

> Validated by checking the destination mailbox received no sharing notifications for the migrated
> items. Requires mailbox access; where that is unavailable the feature is `na`, never `pass`.

---

## 11. Dropbox Papers (19 features)

**Paper is 19 of the 36 features — more than half this document.** It also cannot be seeded by API:
Dropbox retired the Paper authoring endpoints, and uploading a `.paper` file produces an ordinary
file, not a Paper document. `DropboxTestDataAgent._reportPaperManualSteps()` returns the manual steps
and marks these NOT SEEDED rather than pretending to cover them.

### 11.1 Dropbox Papers Migration
Dropbox Paper documents are collaborative, cloud-based files stored within Dropbox. During migration,
these documents are converted and migrated as **Microsoft Word (`.docx`) files** in the target
environment.

> The destination extension is `.docx`. A Paper is a **converted** item: its bytes are produced by a
> converter, so a byte-for-byte hash against the source can never match and must not be attempted —
> `deepContentCore.isHashable` already excludes converted items.

### 11.2 Text Formatting
Most text formatting was retained — bold, strikethrough, headings (H1, H2), hyperlinks, and overall
document structure. **Minor variations were observed, particularly with text highlight colours, which
were not preserved.**

### 11.3 Inserted Images
Inserted images were carried over successfully, with positioning and overall layout consistent after
migration.

### 11.4 Inserted Media
Inserted media elements transferred successfully and display correctly.

### 11.5 Clipboard Images
Clipboard images transferred successfully and are properly retained and displayed.

### 11.6 GIFs
**GIFs were not transferred as expected.** In the destination document they appear as unsupported
elements and are not displayed correctly.

### 11.7 Links
Hyperlinks transferred successfully; all links remain intact and fully clickable.

### 11.8 Inserted Dropbox Files
Links to inserted files were updated to destination URLs **only when the referenced files were
included in the migration**. If the referenced files were not part of the migration, the links
remained unchanged and continued to point to the original Dropbox URLs.

> **Documentation defect, recorded not silently corrected.** The source document reads "updated to
> destination **(Google Drive)** URLs" in this feature — text carried over from the Dropbox → Google
> document. This is the Microsoft combination, so the destination is OneDrive/SharePoint. Raise it
> with the document owner; do not validate against "Google Drive".

### 11.9 Tables
Table structures transferred with limits aligned to Word constraints. **With minimal content per
cell, up to 63 columns are migrated; with richer or larger cell content, up to 62.** Beyond the
limit, content from additional columns is **merged into the last supported column**, affecting table
structure.

> Testable as stated: a table at or below the limit is expected intact; one above it is expected
> merged. Both are documented outcomes — the merge is not a defect.

### 11.10 Inserted Time Line
Inserted timeline elements were **converted into table format** at the destination. Structure
preserved, with Title, Dates, Assigned To and Description retained accurately.

### 11.11 TO-DO List
**To-Do list elements were not preserved in their original structured format.** Checklist items
converted into plain text, losing their structure and usability as checklist entries.

### 11.12 Bulleted List
Bulleted lists transferred successfully; structure and formatting preserved.

### 11.13 Numbered List
Numbered lists transferred successfully; numbering sequence, structure and formatting preserved.

### 11.14 Section Breaks
**Section breaks were not carried over.** No equivalent formatting or visual separators are present
in the destination document.

### 11.15 Code Block
Content within code blocks transferred successfully. **The code block formatting — background
styling, borders, structured layout — was not fully preserved**, resulting in plain text at the
destination.

### 11.16 Emojis
Emojis transferred successfully and display correctly.

### 11.17 Mentions
**User mentions were not migrated as expected.** They display as plain, editable text at the
destination rather than proper mentions, and **the link appears as an invalid link**.

### 11.18 Comments
**Comments were not migrated.** The destination item does not contain any of the original comments
from the source.

### 11.19 Versions for Dropbox Papers
Version history for Dropbox Paper files is **not visible at the source**. At the destination, version
history is present in the UI; however, these versions appear to be **created at the API level during
migration** rather than preserving original source history.

> So a destination Paper version count is **not** evidence that source history migrated, and the
> source has no count to compare against. This feature is reported informationally; it cannot pass or
> fail on a count.

---

## ⚠️ Eight documented deviations that are NOT in the out-of-scope document

Features **11.2** (highlight colours), **11.6** (GIFs), **11.11** (TO-DO lists), **11.14** (section
breaks), **11.15** (code block formatting), **11.17** (mentions), **11.18** (comments) and **11.19**
(Paper version history) each describe behaviour that did **not** migrate as a user would expect — yet
all eight appear in this IN-scope document, while `dropbox-to-microsoft-outscope.md` lists only the
in-line comment CSV.

**They are deliberately not treated as accepted limitations.** Doing so would silently convert eight
potential defects into expected behaviour on a validator author's judgement, which is not a call this
file gets to make. Until the combination owner rules, each is reported at **INFO** carrying the
document's own wording — neither hiding a defect nor inventing one.

If the owner confirms they are accepted limitations, get them added to the official out-of-scope
document first, then move them there with the reasoning. If the owner confirms they are defects, they
belong in the report as failures.

*Precedent:* `dropbox-to-google-outscope.md` carries the identical open question for six Paper
features, and `google-shared-drive-to-sharepoint-outscope.md` carries a section marked "validator
assumption — NOT confirmed" that is explicitly inert, so no run can excuse a real absence against a
rule the company has not written.
