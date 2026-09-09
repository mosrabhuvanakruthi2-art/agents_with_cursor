# Migration Feature Documentation

**Product Type:** Content
**Combination:** Google Shared Drive to SharePoint
**Scope:** In Scope
**Total Features:** 38
**Last Updated:** 2026-08-20
**Source:** `Content_SharedDrivetoSharePoint_(20-08-2026).docx`

> Companion file: `google-shared-drive-to-sharepoint-outscope.md` — the documented limitations that must
> **not** fail a validation run.
>
> **Manual QA ground truth:** the Test Repository holds 4,037 manually-executed cases for this
> combination under `/Google SharedDrive to SharePoint Online` (Jira/Xray, `xrayTestStatus: PASSED`),
> including a 63-case sanity set. Read them before changing this validator — they encode dimensions this
> document leaves implicit:
>
> | Dimension | Cases | Note |
> |---|---|---|
> | Group permissions | 2,204 | the majority principal — including "internal user should be in group", where access arrives via a group and SharePoint shows the group, not the person |
> | Delta migration | 2,603 | new vs **renamed existing** items, across Root-Subfolder / Subfolder-Root / Folder-Folder / Root-Folder / Folder-Root mappings |
> | Internal vs external user | 2,193 / 837 | tested as a pair at each access level |
> | Scope | root folder 1,109, sub folder 2,561, root file 777, inner file 288 | results are reported per scope, not in aggregate |
> | CSV mapping mode | root→root, folder→folder, folder→root | changes where items land |
> | Version file format | Google-format vs uploaded Microsoft-format | both are exercised |

---

## 1. Migration (2 features)

### 1.1 One Time Migration
The initial data migration from source to destination is considered as one-time migration.

### 1.2 Delta Migration
Migration of incremental changes made in the source after the one-time migration. Only newly added or
modified files and folders are transferred.

---

## 2. Files & Folder Migration (1 feature)

### 2.1 Files & Folder Migration
CloudFuze supports migration of folders and files of types (PDF, DOCX, XLSX, PPTX, images, etc.) from
Google Shared Drive to SharePoint Online while maintaining the original directory structure.

---

## 3. Preserving File/Folder structure (1 feature)

### 3.1 Preserving File/Folder structure
CloudFuze preserves the original file and folder hierarchy during migration from Google Shared Drive to
SharePoint Online. The complete parent-child structure, including nested folders and files, is accurately
replicated in the destination document library. This ensures structural consistency between source and
destination, subject to SharePoint Online path length and naming limitations.

---

## 4. Permissions (9 features)

### 4.1 Permissions
CloudFuze preserves folder and file-level permissions during migration from Google Shared Drive to
SharePoint Online, including root folder, root file, subfolder, and inner file permissions, provided users
are properly mapped and available in the destination tenant.

In Google Shared Drive:

- Folder shared link roles: Viewer, Commenter, Contributor, Content Manager
- File shared link roles: Viewer, Commenter, Editor

During migration these roles are mapped to the closest equivalent permission levels in SharePoint Online
(such as Read, Edit, or Full Control), based on SharePoint's permission model and inheritance structure.

Access levels of folders and files:

| Source role | Applies to | Destination access |
|---|---|---|
| Viewer | folder | can view |
| Commenter | folder | can view |
| Contributor | folder | can edit |
| Content Manager | folder | can edit |
| Viewer | file | can view |
| Commenter | file | can view |
| Editor | file | can edit |

Google Drive API role names differ from the Shared Drive UI labels above: `reader` = Viewer,
`commenter` = Commenter, `writer` = Contributor (Editor for files), `fileOrganizer` = Content Manager,
`organizer` = Manager. The `owner` role does not exist in shared drives.

### 4.2 Folder Permissions: Viewer
Viewer in Shared Drive migrated as Can View in SharePoint.

### 4.3 Folder Permissions: Commenter
Commenter in Shared Drive migrated as Can View in SharePoint. Commenter is not a distinct SharePoint role,
so it maps down to view access.

### 4.4 Folder Permissions: Contributor
Contributor in Shared Drive migrated as Can Edit in SharePoint.

### 4.5 Folder Permissions: Content Manager
Content Manager in Shared Drive migrated as Can Edit in SharePoint.

### 4.6 File Permissions: Viewer
Viewer in Shared Drive migrated as Can View in SharePoint.

### 4.7 File Permissions: Commenter
Commenter in Shared Drive migrated as Can View in SharePoint.

### 4.8 File Permissions: Editor
Editor in Shared Drive migrated as Can Edit in SharePoint.

### 4.9 External Shares
CloudFuze supports migration of external sharing permissions (files and folders shared with users outside
the organization) to SharePoint Online, provided external sharing is enabled in the destination tenant.
Access levels of "Can edit" and "Can view" map to the closest equivalent permissions in SharePoint.

Migration of external shares depends on proper user mapping and Microsoft 365 external sharing policies.
If external sharing is restricted or disabled in SharePoint, those permissions may not be applied in the
destination.

*(The source document describes this feature using Box terminology; the behavior applies to the Shared
Drive source of this combination.)*

---

## 5. Shared Links (16 features)

### 5.1 Shared Links
Some source shared link settings may not have direct equivalents in SharePoint. Links are migrated to the
closest supported SharePoint sharing configuration.

Two link scopes exist on the source side and both are preserved:

- **Anyone with link** → SharePoint "Anyone with the link" (anonymous scope)
- **Sync Orbit** (the source Google organization) → SharePoint "People in filefuze with the link"
  (organization scope)

### 5.2 Shared Links for Folders: Anyone with link - Viewer
"Anyone with link - Viewer" in Shared Drive migrated as "Anyone with the link can View".

### 5.3 Shared Links for Folders: Anyone with link - Commenter
"Anyone with link - Commenter" in Shared Drive migrated as "Anyone with the link can View".

### 5.4 Shared Links for Folders: Anyone with link - Contributor
"Anyone with link - Contributor" in Shared Drive migrated as "Anyone with the link can Edit".

### 5.5 Shared Links for Folders: Anyone with link - Content Manager
"Anyone with link - Content Manager" in Shared Drive migrated as "Anyone with the link can Edit".

### 5.6 Shared Links for Folders: Sync Orbit - Viewer
"Sync Orbit - Viewer" in Shared Drive migrated as "People in filefuze with the link can View".

### 5.7 Shared Links for Folders: Sync Orbit - Commenter
"Sync Orbit - Commenter" in Shared Drive migrated as "People in filefuze with the link can View".

### 5.8 Shared Links for Folders: Sync Orbit - Contributor
"Sync Orbit - Contributor" in Shared Drive migrated as "People in filefuze with the link can Edit".

### 5.9 Shared Links for Folders: Sync Orbit - Content Manager
"Sync Orbit - Content Manager" in Shared Drive migrated as "People in filefuze with the link can Edit".

### 5.10 Shared Links for Files: Anyone with link - Viewer
"Anyone with link - Viewer" in Shared Drive migrated as "Anyone with the link can View".

### 5.11 Shared Links for Files: Anyone with link - Commenter
"Anyone with link - Commenter" in Shared Drive migrated as "Anyone with the link can View".

### 5.12 Shared Links for Files: Anyone with link - Editor
"Anyone with link - Editor" in Shared Drive migrated as "Anyone with the link can Edit".

### 5.13 Shared Links for Files: Sync Orbit - Viewer
"Sync Orbit - Viewer" in Shared Drive migrated as "People in filefuze with the link can View".

### 5.14 Shared Links for Files: Sync Orbit - Commenter
"Sync Orbit - Commenter" in Shared Drive migrated as "People in filefuze with the link can View".

### 5.15 Shared Links for Files: Sync Orbit - Editor
"Sync Orbit - Editor" in Shared Drive migrated as "People in filefuze with the link can Edit".

### 5.16 Shared Link CSV generation
The Shared Links CSV is generated during migration when files or folders have active sharing permissions
(internal or external). This report helps track all shared items from the source.

---

## 6. Embedded Links (2 features)

### 6.1 Embedded Links
CloudFuze preserves embedded links within files that reference other cloud files during migration.
Internal link addresses are automatically updated and transformed to the appropriate SharePoint Online URL
format, ensuring continued accessibility after migration. This applies to supported file types where link
rewriting is technically feasible.

### 6.2 Embedded Link CSV generation
The Embedded Links CSV is a system-generated report created during migration or link scanning when files
contain embedded or referenced links inside documents. This report helps identify internal and external
references inside files.

---

## 7. Special Character Replacement (1 feature)

### 7.1 Special Character Replacement
CloudFuze automatically replaces special characters that are not supported by SharePoint Online with
compatible characters such as underscores (`_`) or hyphens (`-`) during migration. This ensures successful
file and folder creation in the destination while maintaining data integrity and minimizing migration
failures caused by naming restrictions.

SharePoint Online / OneDrive reject the characters `" * : < > ? / \ |` in item names, disallow leading and
trailing spaces, and reserve certain names (`.lock`, `CON`, `PRN`, `AUX`, `NUL`, `COM0`–`COM9`,
`LPT0`–`LPT9`, `_vti_` anywhere in the name, `desktop.ini`, any name beginning `~$`, and `forms` at the
root of a library). Some tenants additionally do not support `#` and `%`.

---

## 8. Versions or Selective Versions (1 feature)

### 8.1 Versions or Selective Versions
CloudFuze supports migration of file version history from Google Shared Drive to SharePoint Online,
provided versioning is enabled in the destination library. All versions or a selective number of recent
versions (for example, the last five) can be migrated based on configuration.

In SharePoint Online a single source version may appear as **two** versions in the destination — one
representing the actual source version and another reflecting the migration timestamp update.
Additionally, due to Google limitations, even if multiple versions exist for a file in Google Shared
Drive, only the earliest version and the current/latest version may be available for migration.

**Note:** This behavior is platform-dependent and does not indicate data loss during migration. See the
out-of-scope companion file — version count and version timestamp differences must never fail a run.

---

## 9. Suppress Email Notifications (2 features)

### 9.1 Suppress Email Notifications
CloudFuze provides an option to suppress email notifications during migration to SharePoint Online, to
prevent automatic alerts triggered by file uploads or permission assignments. CloudFuze allows separate
suppression settings for internal and external users.

- If suppression is enabled for both, no sharing or invitation emails are sent from the destination.
- If suppression is disabled, users receive standard SharePoint sharing notifications.

In Microsoft 365, when a file or folder is shared with a new user an invitation email is sent; when
permissions are granted to an existing user they receive a "file shared with you" notification. Mail
received from the source side when permission was granted is expected and is not a suppression failure.

### 9.2 Suppress Email Notifications: Email from Destination Part
After the migration completes, no mail should be received from the destination side. This is the expected
behavior. If the suppress-email-notification feature fails, mail arrives from the destination.

---

## 10. Metadata (1 feature)

### 10.1 Metadata
CloudFuze keeps important file details during migration from Google Shared Drive to SharePoint Online,
such as the original created date and last modified date and time. This helps maintain the original file
history after migration. Metadata preservation may depend on SharePoint settings and configuration in the
destination environment.

---

## 11. Long Folder/File path (1 feature)

### 11.1 Long Folder/File path
During Google to SharePoint migrations, path length is a critical technical consideration due to
Microsoft's platform limitations.

Both OneDrive for Business and SharePoint Online support a maximum file path length of **400 characters**,
calculated from the root directory through all nested folders to the final file or folder name. Special
characters are URL-encoded in SharePoint and the encoded form counts toward the limit, so a path that
looks short in a browser may consume more characters than expected. Each individual path segment is
additionally limited to 255 characters.

To address this constraint, CloudFuze's X-Change migration engine proactively scans and identifies files
and folders in Google that exceed the supported path length before or during migration. Instead of failing
the migration for these items, CloudFuze applies an intelligent handling mechanism:

- When the path length limit is reached, a Folder/File Path Link URL is created.
- This link acts as a placeholder in the destination.
- Clicking the link redirects users to the corresponding file or folder location.

A validation run must therefore expect a placeholder link — not the item itself — for any source path over
the limit, and must not report such items as missing.

---

## 12. File Conversion (1 feature)

### 12.1 File Conversion
The File Conversion feature enables automatic transformation of source file formats into compatible or
standardized formats within SharePoint Online during migration.

Converted formats:

| Source | Destination |
|---|---|
| `.doc` | `.docx` |
| `.xls` | `.xlsx` |
| `.ppt` | `.pptx` |

Formats migrated unchanged: `.xlsm`, `.docm`, `.pptm`, `.one`, `.vsdx`, `.pdf`, `.txt`, `.csv`, `.xml`,
`.json`, `.jpg`, `.png`, `.mp4`, `.mp3`, `.zip`, `.rar`.

Google native formats have no byte-level equivalent in SharePoint and are exported during migration —
Google Docs to `.docx`, Sheets to `.xlsx`, Slides to `.pptx`. Because the destination file is produced by
a converter, its bytes legitimately differ from the source and a content hash comparison does not apply to
these items.
