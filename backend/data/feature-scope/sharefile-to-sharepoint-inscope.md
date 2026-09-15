# Migration Feature Documentation

**Product Type:** Content
**Combination:** ShareFile to SharePoint
**Scope:** In Scope
**Total Features:** 11
**Last Updated:** 2026-09-09
**Source:** `Content_ShareFiletoSharePoint_(02-09-2026).docx`

> Companion file: `sharefile-to-sharepoint-outscope.md` — read it before writing a validator. It
> records that **no official out-of-scope document exists for this combination**, which changes how
> every mismatch must be classified.
>
> **The destination is SharePoint Online**, so the destination rules already implemented for
> `box → sharepoint` and `googledrive → sharepoint` apply unchanged: the invalid-character set,
> reserved names, the ~400-character encoded-path limit, and the rename/dedup counter behaviour all
> live in `validation/destinations/sharepoint.js` and `agents/sharepoint/SharePointValidationAgent.js`.
> Do not restate them here and do not copy them into the combination file.
>
> **Only the source side is new.** ShareFile's own roles, item model, root resolution and version
> semantics belong in `validation/combinations/content/sharefileToSharepoint.js`.

---

## 1. Migration (2 features)

### 1.1 Preserving File/Folder structure
CloudFuze ensures the seamless migration of the data from the source cloud to destination, preserving
the accuracy and integrity of the data structure.

**Validation treatment.** Tier A tree pairing: every source item present at the expected destination
path, under the expected parent, after SharePoint's rename rules are applied.

### 1.2 Onetime
The initial data migration from source to destination is considered as One-time migration.

**Validation treatment.** Note what the document does **not** say: unlike almost every other content
combination, Delta migration is **not listed** for ShareFile → SharePoint. Only One-time is in scope.
A Delta run is therefore unspecified for this combination — it must not be reported as passing, and it
must not be reported as a defect either. Treat it as not assessed until the combination owner rules.

---

## 2. Permissions (4 features)

### 2.1 Root Folder Permissions
CloudFuze preserves all root folder permissions along with access levels.

### 2.2 Sub-folder permissions
CloudFuze preserves all subfolder permissions along with access levels.

### 2.3 Group Permissions
Group Migration in CloudFuze ensures seamless transfer of user groups, memberships, and permissions
from source to destination, preserving access control and collaboration structure.

**Validation treatment.** A group migrates **as a group** — it is not mapped through Map Users to a
person. Match group-to-group at the destination on the normalised local part and display name, the
way `deepContentCore.comparePermissions` already does. Mapping a group to a user is a known way to
produce a whole run of false failures.

### 2.4 External Shares
CloudFuze can migrate external permissions (files/folders shared with people outside the
organization) to the destination along with access levels.

**Validation treatment.** Requires external sharing to be enabled in the destination tenant. If it is
disabled, the failure is a destination configuration gap, not a migration defect — report it as such.

> **Scope gap worth noting.** The document lists permissions for the **root folder**, **sub-folders**,
> **groups** and **external shares** — but says nothing about **file-level** permissions, and gives no
> per-role mapping table (ShareFile role → SharePoint role). Both are specified explicitly for
> `google-shared-drive-to-sharepoint`. Until a mapping is documented, a ShareFile role must not be
> silently assumed equivalent to a Drive role: see the note in the outscope companion.

---

## 3. Metadata (1 feature)

### 3.1 Metadata
Maintaining the original timestamps, including creation and modification dates and times, when
transferring data to the destination cloud.

---

## 4. Version History (1 feature)

### 4.1 Version History
Migration of all file versions from source to destination.

**Validation treatment.** "All" versions — the document does **not** offer Selective Versions for this
combination, and there is no documented merge/consolidation caveat of the kind Google has. So a
version-count mismatch here is a candidate defect, not an expected limitation.

---

## 5. Special Characters Replacement (1 feature)

### 5.1 Special Characters Replacement
Special characters not supported by the destination cloud will be automatically replaced with
underscores (`_`) or hyphens (`-`). This ensures that the integrity of the data is maintained during
the migration process.

**Validation treatment.** Match the destination name against **both** replacements — already handled
by `deepContentCore.expectedDestName` / `namesMatch`.

---

## 6. Long-File/folder path (1 feature)

### 6.1 Long-File/folder path
If the destination cloud has a long folder path limitation, the system automatically adjusts the
destination's path as per the limitation.

**Validation treatment.** SharePoint's ~400-character encoded-path limit. Relocated content is
expected at an adjusted path — but note the confirmed defect recorded for the Shared Drive
combination, where relocated content **lost its sharing**. Check permissions on relocated items
specifically rather than assuming relocation alone is success.

---

## 7. Suppress email notifications (1 feature)

### 7.1 Suppress email notifications
The system will automatically prevent the generation of email notifications for collaborations on
folders/files originating from the destination cloud.

---

## Features documented for other combinations but NOT listed here

Stated so nobody assumes them and so nobody quietly adds them. None of the following appear in the
ShareFile → SharePoint document, so none may be validated as in-scope for this combination:

- Delta migration
- File-level permissions, and any ShareFile-role → SharePoint-role mapping table
- Shared Links (and the Shared Link CSV)
- Embedded Links (and the Embedded Link CSV)
- In-line comments
- Selective Versions
- Folder Display
- File Conversion (`.doc` → `.docx` etc.)
