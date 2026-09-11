# Migration Feature Documentation

**Product Type:** Content  **Combination:** SharePoint to Shared Drive  **Scope:** In Scope
**Total Features:** 17

Source of record: `Content_SharePointtoSharedDrive_(09-09-2026).docx`. Transcribed here so the
validator and the reviewer read the same numbering — the checklist in
`validation/combinations/content/sharepointToGoogleshareddrive.js` uses these ids verbatim.

Read together with `sharepoint-to-google-shared-drive-outscope.md`, which lists the documented
limitations. An out-of-scope behaviour is reported as INFO and **must never fail a run**.

| Id | Feature | How this suite answers it |
|---|---|---|
| 1.1 | Onetime | structure comparison, under a FULL run |
| 1.2 | Delta | structure comparison, under a DELTA run |
| 2.1 | Preserving File/Folder structure | Tier A tree comparison |
| 3.1 | Root Folder Permissions | Tier C, grants on a folder at the source root |
| 4.1 | Root File Permissions | Tier C, grants on a file at the source root |
| 5.1 | Sub-folder permissions | Tier C, grants on a folder below the root |
| 6.1 | Inner file permissions | Tier C, grants on a file below the root |
| 7.1 | Shared links | link scope **and** type compared on both axes |
| 8.1 | External Shares | Tier C, by principal — an address outside the source tenant |
| 9.1 | Metadata | created/modified timestamps within the drift band |
| 10.1 | Version History | history PRESENT at the destination; counts not asserted |
| 11.1 | Special Characters Replacement | negative test — Google replaces nothing |
| 12.1 | Long-folder path | negative test — Google has no path limit |
| 13.1 | Suppress email notifications | NOT VERIFIED from the Google side (see below) |
| 14.1 | Embedded Links | hyperlink targets inside the migrated document |
| 15.1 | Custom Library | a non-default SharePoint library and its contents |
| 16.1 | CrossLinks | a link that crosses libraries, re-pointed at the copy |

---

## 1. Migration (2 features)

### 1.1 Onetime
The initial data migration from source to destination is considered a one-time migration.

### 1.2 Delta
Migration of incremental changes made in the source during the one-time migration.

## 2. Preserving File/Folder structure (1 feature)

### 2.1 Preserving File/Folder structure
CloudFuze migrates data from the source cloud to the destination preserving the accuracy and
integrity of the data structure.

## 3. Root Folder Permissions (1 feature)

### 3.1 Root Folder Permissions
CloudFuze preserves all root folder permissions along with access levels.

## 4. Root File Permissions (1 feature)

### 4.1 Root File Permissions
CloudFuze preserves all root file permissions along with access levels.

## 5. Sub-folder permissions (1 feature)

### 5.1 Sub-folder permissions
CloudFuze preserves all sub-folder permissions along with access levels.

## 6. Inner file permissions (1 feature)

### 6.1 Inner file permissions
CloudFuze preserves all inner file permissions along with access levels.

## 7. Shared links (1 feature)

### 7.1 Shared links
CloudFuze migrates all shared links from source to destination and maintains the type of links.

**Expected translation** (`validation/roleMaps/sharepoint_to_google.js`):

| SharePoint link scope | Google General access |
|---|---|
| Anyone with the link (`anonymous`) | Anyone with the link |
| People in your organization (`organization`) | the organisation, shown by its own name |
| Specific people (`users`) | not a link — an ordinary per-user grant, judged under 3.1–6.1 |

Link **type** travels separately: `edit` → edit, everything else (`view`, `embed`, review,
block-download) → view. Both axes must match; a view link arriving as an edit link is a failure.

## 8. External Shares (1 feature)

### 8.1 External Shares
CloudFuze can migrate external permissions — files/folders shared with people outside the
organisation — along with access levels.

## 9. Metadata (1 feature)

### 9.1 Metadata
The original timestamps, including creation and modification dates and times, are maintained at the
destination.

Identity metadata ("Created By" / "Modified By") is **out of scope** — see the out-of-scope
document. It is recorded on each item row and never compared.

## 10. Version History (1 feature)

### 10.1 Version History
Migration of all file versions from source to destination.

Exact version COUNTS are not asserted: Google merges revisions on its side, and selective version
migration is out of scope for this combination. What is judged is that a file with history at the
source arrives with history at the destination.

## 11. Special Characters Replacement (1 feature)

### 11.1 Special Characters Replacement
Special characters not supported by the destination cloud are automatically replaced with
underscores (`_`) or hyphens (`-`), so the integrity of the data is maintained.

**For this destination the expected outcome is no replacement at all.** Google Drive forbids no
character and rewrites nothing (`validation/destinations/googledrive.js`), so a name that arrives
rewritten is the defect — the reverse of every SharePoint-destination combination.

## 12. Long-File/folder path (1 feature)

### 12.1 Long-folder path
If the destination cloud has a long-folder-path limitation, the system automatically adjusts the
destination path to fit it.

**Google imposes no total-path limit**, so nothing is relocated and no placeholder link is created.
A deep path must arrive at the same depth, intact.

## 13. Suppress email notifications (1 feature)

### 13.1 Suppress email notifications
The system prevents the generation of email notifications for collaborations on folders/files
originating from the destination cloud.

**Reported as NOT VERIFIED, never as a pass.** Confirming it needs Gmail read scope on the
destination account, which the content flow does not request. Check by hand: the destination user's
inbox and the Google admin account, which Google notifies on share by default (out-of-scope item
13). Seeding creates every source grant with `sendInvitation: false`, so any notification found is
the destination's own.

## 14. Embedded Links (1 feature)

### 14.1 Embedded Links
The system retains the addresses of links inside a file that point to other files in the cloud.
Those addresses are transformed into the appropriate destination form during migration.

Seeding writes a real `.docx` with a real hyperlink to another seeded file, because the feature is
about links CloudFuze can rewrite — a URL typed into a `.txt` is not one.

## 15. Custom Library (1 feature)

### 15.1 Custom Library
Custom libraries are supported for migration; their content and permissions migrate successfully.

Observed behaviour recorded in the source document:

- Custom libraries created in SharePoint Online are detected and migrated.
- Files, folders and library structure are preserved at the destination.
- File-level and folder-level permissions migrate where supported.
- The hierarchy and accessibility of the custom library content are maintained.

A custom library is a **separate drive**, so it is checked on its own rather than as part of a
transfer unit's tree. Requires `SHAREPOINT_SOURCE_LIBRARY`; without it the feature reports as not
exercised.

## 16. CrossLinks (1 feature)

### 16.1 CrossLinks
Cross links are supported and function after migration.

Observed behaviour recorded in the source document:

- Cross-linked files and folders within scope migrate successfully.
- CloudFuze identifies the linked source content and maps it to the corresponding migrated
  destination content in Google Shared Drive.
- After migration the links reference the migrated destination files/folders instead of the
  original source paths.
- In Microsoft, cross links are links between files, folders or documents within the tenant/site
  structure. CloudFuze migrates the content first, tracks the relationship between linked objects,
  and remaps the links once the destination objects exist.

Seeded as a `.docx` in the default library linking into the custom library, so the link genuinely
crosses libraries. Without a custom library the scenario is skipped and 16.1 reports as not
exercised — it is never answered by 14.1's evidence.
