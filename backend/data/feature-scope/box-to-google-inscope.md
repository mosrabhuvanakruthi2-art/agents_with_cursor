# Migration Feature Documentation

**Product Type:** Content
**Combination:** Box to Google (My Drive & Shared Drive)
**Scope:** In Scope
**Total Features:** 34
**Last Updated:** 2026-09-14
**Source:** `Content_BoxtoGoogle(MyDrive&SharedDrive)_(14-09-2026).pdf`

> Companion file: `box-to-google-outscope.md` — the documented limitations that must **not** fail a
> validation run. **Seven of its nine features also appear in this file** (10.2–10.6, 10.8, 10.13);
> that overlap is unresolved and is documented in the conflict section of the out-of-scope file.
> Read it before treating any Box Notes formatting feature below as a hard FAIL.
>
> **Covers both combinations.** The document is written for My Drive *and* Shared Drive together, so
> `box → googledrive` and `box → googleshareddrive` share this scope. Where a feature behaves
> differently between the two, that is called out on the feature.
>
> **The destination is Google, not Microsoft.** Google rejects almost no characters, reserves no
> names, and imposes no total-path limit, so features 7.1 and 8.1 read very differently here than in
> `google-shared-drive-to-sharepoint-inscope.md`. See `validation/destinations/googledrive.js`.
> Closest precedent for this combination is `dropbox-to-google-inscope.md` — same destination,
> different source.

---

## 1. Migration (3 features)

### 1.1 Data Migration (Files & Folders with structure)
CloudFuze ensures the seamless migration of the data from the source cloud to destination, preserving
the accuracy and integrity of the data structure.

### 1.2 One time Migration
The initial data migration from source to destination is considered as One-time migration.

### 1.3 Delta
Migration of incremental changes made in source during the onetime migration.

---

## 2. Permissions (5 features)

The document names four *positions* — root folder, sub-folder, root file, inner file — plus external
shares. Position matters: a run that only checks the root proves nothing about inheritance, which is
why each is a separate feature rather than one "permissions" row. Order below follows the document.

### 2.1 Root Folder Permissions
CloudFuze preserves all root folder permissions along with access levels.

### 2.2 Sub Folder Permissions
CloudFuze preserves all subfolder permissions along with access levels.

### 2.3 Root File Permissions
CloudFuze preserves all Root file permissions along with access levels.

### 2.4 Inner File Permissions
CloudFuze preserves all inner file permissions along with access levels.

### 2.5 External Shares
CloudFuze can migrate external permissions (Files/Folders shared with people of outside
organizations) of files/folders to the destination along with access levels.

**Role translation.** Read off the document's own figures (2.1.1–2.5.1), which show Box collaborator
roles on the left and the resulting Google sharing dialog on the right:

| Box | Google |
|---|---|
| Owner | owner — not re-granted, the destination account owns the copy |
| Editor | **Editor** |
| Viewer | **Viewer** |

Two cautions on this table:

- It is **derived from figures, not from a stated mapping.** The document gives no role-mapping
  prose for this combination. Only Owner, Editor and Viewer appear in the figures; Box's other
  collaborator roles (Previewer, Uploader, Previewer-Uploader, Viewer-Uploader, Co-owner) appear
  nowhere, so their destination role is **undocumented** — not "Viewer by default". Do not assume.
- Google `Commenter` is not an outcome of any role shown. Figure 10.7.1 shows `Content manager`,
  but that is a Shared Drive membership role in an unrelated screenshot, not a translation target.

Group principals do migrate: figure 2.4.1 shows `ERIK GROUP-AM` and `Biaku Group` as Box
collaborators arriving as Google grantees of the same name.

---

## 3. Versions (2 features)

### 3.1 Version History
Version history of files is migrated to the destination. Figure 3.1.1 shows a seven-version Box file
(V1–V7) arriving in Google with its version list intact.

### 3.2 Selective Versions
Migration of selective versions of files from source to destination. If we opt for five, the last
five versions will get migrates to the destination.

---

## 4. Meta Data (1 feature)

### 4.1 Meta Data
Maintaining the original timestamps, including creation and modification dates and times, when
transferring data to the destination cloud.

---

## 5. Shared Links (2 features)

### 5.1 Shared Links (Anyone with the Link)
CloudFuze migrates all shared links from source to destination and maintains the type of links.
People with the Link (Can edit/can view) will migrate as **'Anyone with the link (Viewer/ Editor)'**.
After migration, a CSV file is generated at the destination containing the source path, destination
path, and corresponding shared links.

### 5.2 Shared Links (Team Members)
CloudFuze migrates all shared links from source to destination and maintains the type of links.
'People in your company (Can view/ can edit)' will migrate as **'Sync Orbit (Viewer/Editor)'**. After
migration, a CSV file is generated at the destination containing the source path, destination path,
and corresponding shared links.

> `Sync Orbit` is the Google Workspace **organization name of the tenant used for the document's
> screenshots**, not a literal string to assert against. The general rule is: Box's "People in your
> company" becomes Google's domain-restricted general access, which the Google UI renders as the
> destination org's own name. A validator must compare against the destination tenant's org name,
> not the word "Sync Orbit".

**Evidence is the CSV, not only the item.** Both features state a CSV report is written into the
destination. Same shape as 6.1 and 9.1: CloudFuze writes a report rather than reproducing the data
natively. That CSV is an ordinary file in the destination and can be read directly — there is no
special API for it. (Two features on the Google Shared Drive combination sat marked "not automated —
no API for the CSV" for months while the files were in the destination the whole time.)

---

## 6. In- Line Comment (1 feature)

### 6.1 In- Line Comment
Inline file comments of the box will be migrated to the destination cloud. All the file comments will
preserve in the CSV formatted file in the destination.

**Validation treatment.** Figure 6.1.1 shows comments arriving as *native Google Docs comments* as
well, which goes further than the prose. Assert on the CSV — that is what the text promises. A
migrated file carrying no native comments is not on its own a failure of this feature.

---

## 7. Long File/Folder Path (1 feature)

### 7.1 Long File/Folder Path
If the destination cloud has a long folder path limitation, the system automatically adjusts the
destination's path as per the limitation.

**Google imposes no total-path limit.** Unlike SharePoint/OneDrive, Google Drive has no 400-character
path ceiling — only a per-name limit. So the expected outcome here is that paths arrive **unchanged**
and no adjustment is triggered. Figure 7.1.1 shows an eight-level SUBFOLDER1…SUBFOLDER8 chain
arriving intact. A run that reports "path shortened" against Google is more likely a defect than a
feature working.

---

## 8. Special Character Replacement (1 feature)

### 8.1 Special Character Replacement
Special characters not supported by the destination cloud will be automatically replaced with
underscores (_) or hyphens (-). This ensures that the integrity of the data is maintained during the
migration process.

**Google rejects almost nothing.** Figure 8.1.1 shows a folder named from a long run of punctuation
(`! " # $ % & ( ) * + , - . : ; < = ? @ [ ] ^ _ { | } ~`) arriving in Google Drive **unchanged,
including the characters SharePoint would reject**. As with 7.1, the expected outcome on this
destination is *no replacement*. Treat a replaced character as the finding, not as proof the feature
works.

---

## 9. Embedded Links (1 feature)

### 9.1 Embedded Links
The system retains the addresses of links present within a file, which point to other files in the
cloud. These links' addresses will be transformed into appropriate destination formats during
Migration.

Figure 9.1.1 shows a spreadsheet cell whose `app.box.com/s/...` link is rewritten to a
`drive.google.com/file/d/...` address. The feature is the **rewrite**, so an unrewritten Box URL
surviving in a migrated file is the failure mode to look for — not a missing link.

---

## 10. Box Notes (16 features)

Box Notes convert to **.DOCX** (10.1), so every feature below is really a question about what
survives the Notes → DOCX → Google Docs conversion. The document records six as working and nine as
lossy.

> **Overlap warning.** 10.2 (strikethrough portion), 10.3, 10.4, 10.5, 10.6, 10.8 and 10.13 are ALSO
> listed in `box-to-google-outscope.md`, where the rule is INFO-never-FAIL. Two of those overlaps
> additionally *contradict* the out-of-scope wording (10.4 and 10.13). Do not hard-fail any of them
> until the combination owner rules — see that file's conflict section.

### 10.1 Box Notes Migration
Migration of Box Notes files in the .DOCX format to the destination cloud.

### 10.2 Text Formatting
Text formatting migration for Box Notes for Box to Google (My Drive/Shared Drive). Most formatting
elements such as bold, italic, underline were preserved after migration. However, differences were
observed in **strikethrough, alignment, and inline code** formatting, which are not retained as in
the source and appear as normal text in the destination.

### 10.3 Font Size and Text Color
Font size and text color migration for Box Notes for Box to Google (My Drive/Shared Drive). Content
was migrated successfully; however, font size variations and text colors from the source are not
fully preserved. Most of the text appears in a uniform size and default color in the destination,
leading to loss of original formatting differences.

### 10.4 Checklist, Numbered list, Bulleted list
Checklist, numbered list, and bulleted list migration for Box Notes for Box to Google (My
Drive/Shared Drive). Content was migrated; however, these list formats were not preserved as
expected. All items are converted into **plain text** in the destination, resulting in loss of
original list structure and functionality.

> ⚠️ The out-of-scope document (7.1) says the same feature converts to a **numbered list only**, and
> names the destination as Microsoft. Contradiction — unresolved.

### 10.5 Tables
Table content migration from Box Notes to **Google Docs**. Table content is not migrated as expected;
structure, alignment, and formatting are broken in the destination, resulting in distorted and
unreadable table layout.

> ⚠️ The out-of-scope document (9.1) describes the identical outcome but names **Microsoft Docs**.

### 10.6 Insert Image or file: (Upload images from your computer)
"Upload images from computer" migration for Box Notes for Box to Google (My Drive/Shared Drive).
Images were not preserved as expected to the destination resulting in loss of visual content.

### 10.7 Insert Image or file: (Insert Image from Box Shared Link) ✅
"Insert image from Box shared link" migration for Box Notes for Box to Google (My Drive/Shared
Drive). Images inserted using shared links are migrated successfully and appear as expected in the
destination, with structure preserved.

**This is the one image path that works.** 10.6, 10.8 and 10.9 — the other three ways to get an
image into a Box Note — all lose content. Any test data for Box Notes images must cover all four
separately; a single "images migrate" check would pass or fail for the wrong reason.

### 10.8 Insert Image or file: (Insert Link Preview)
"Insert Link Preview" migration for Box Notes for Box to Google (My Drive/Shared Drive). Links were
not preserved as expected to the destination resulting in loss of content.

### 10.9 Clipboard Images:
"Clipboard Images" migration for Box Notes for Box to Google (My Drive/Shared Drive). Images were not
preserved as expected to the destination resulting in loss of visual content.

### 10.10 Emojis ✅
Emojis migration for Box Notes for Box to Google (My Drive/Shared Drive). Emojis are successfully
migrated and displayed correctly in the document.

### 10.11 GIFs
GIFs migration for Box Notes for Box to Google (My Drive/Shared Drive). GIFs are not preserved as
expected and incorrectly rendered in the destination, resulting in loss of proper display.

### 10.12 Unicode Symbols ✅
Unicode symbols migration for Box Notes for Box to Google (My Drive/Shared Drive). Unicode symbols
are migrated successfully and appear as expected in the destination without any data loss.

### 10.13 Mentions
Mentions migration for Box Notes for Box to Google (My Drive/Shared Drive). Mentions are **not
migrated to the destination and are missing completely**, resulting in loss of reference information.

> ⚠️ The out-of-scope document (3.1) says mentions migrate **as normal text**. Missing entirely and
> present-as-plain-text are different destination states requiring different assertions.
> Contradiction — unresolved.

### 10.14 Box Notes Comments ✅
Comments migration for Box Notes for Box to Google (My Drive/Shared Drive). Comments are successfully
migrated, and a CSV file is generated in the destination containing comment details such as
**username, timestamp, and content**. Figure 10.14.1 shows the CSV columns as
`USERNAME, CREATED_DATE, COMMENTS, EMAIL`.

### 10.15 Links ✅
Links migration for Box Notes for Box to Google (My Drive/Shared Drive). Links are successfully
migrated and remain clickable in the document.

### 10.16 Hyperlinks ✅
Hyperlinks migration for Box Notes for Box to Google (My Drive/Shared Drive). Links are successfully
migrated and the URL redirecting to the destination file.

> 10.15 vs 10.16: 10.15 is a **bare URL** that stays clickable; 10.16 is **anchored text** whose
> target is rewritten to the migrated destination file (the same rewrite as 9.1). Different
> assertions — do not collapse them into one check.

---

## 11. Suppressing Email Notification (1 feature)

### 11.1 Suppressing Email Notification
The system will automatically prevent the generation of email notifications for collaborations on
folders/files originating from the destination cloud.

**Evidence is an absence**, which nothing in the destination Drive can show. Validating this needs
the destination users' mailboxes, not the Drive API — the same shape as the equivalent feature on the
other content combinations. If that is out of reach for a run, report it as not-automated with the
reason, rather than passing it silently.

---

## Feature count

| Section | Features |
|---|---|
| 1. Migration | 3 |
| 2. Permissions | 5 |
| 3. Versions | 2 |
| 4. Meta Data | 1 |
| 5. Shared Links | 2 |
| 6. In- Line Comment | 1 |
| 7. Long File/Folder Path | 1 |
| 8. Special Character Replacement | 1 |
| 9. Embedded Links | 1 |
| 10. Box Notes | 16 |
| 11. Suppressing Email Notification | 1 |
| **Total** | **34** |

Matches the document's stated total.

**No `box-to-google-testdata.md` exists yet.** The other Google-destination combination has one
(`dropbox-to-google-testdata.md`) specifying what must exist in the source account for a run to
exercise these features at all. Until a Box equivalent is written, a run against a thin Box account
can report "pass" on features it never touched — notably the four separate Box Notes image paths
(10.6–10.9), the five Box collaborator roles not covered by the figures (2.x), and selective
versions (3.2), which needs a file with more than five versions to mean anything.
