# Migration Feature Documentation

**Product Type:** Content
**Combination:** Google Shared Drive → OneDrive for Business
**Scope:** In Scope
**Total Features:** 8
**Last Updated:** 2026-09-17
**Source:** `Content_ShareddrivetoOnedrive_(17-09-2026).pdf`

> Companion file: `google-shared-drive-to-onedrive-outscope.md` — four features the document puts
> OUT of scope, which must therefore never fail a run here.
>
> **This combination is deliberately narrow.** Eight features: four migration, four permissions.
> The sibling `google-shared-drive-to-sharepoint` combination tests versions, shared links,
> timestamps and external shares as well — here the document places all four out of scope. A check
> that fails one of them is reporting against a promise this document does not make.
>
> **The destination is OneDrive for Business, not SharePoint.** OneDrive is a personal site
> (`<tenant>-my.sharepoint.com/personal/<user>`), so it is reached as a user's drive rather than a
> site's document library. It still runs on SharePoint Online underneath, so SharePoint's naming and
> path-length limits apply exactly as they do for a SharePoint destination — see the note on 1.4.

---

## 1. Migration (4 features)

### 1.1 One Time Migration
The initial data migration from source to destination is considered as One-time migration.

### 1.2 Delta Migration
Migration of incremental changes made in source during the one-time migration.

**Only judgeable on a delta run.** A one-time run has no incremental change to carry, so this
feature is not exercised and must be reported as such rather than passed. The test repository's
`Mydrive to Onedrive` folder records what a delta run is expected to cover: renaming a root file,
renaming a sub-folder, moving a sub-file to root level, copying a sub-file to root level, and adding
collaborators or group permissions to existing and renamed folders.

### 1.3 Files & Folder Migration
CloudFuze supports migration of folders and files of types (PDF, DOCX, XLSX, PPTX, Images, etc.)
from Shared Drive to OneDrive while maintaining the original directory structure.

**The file types are named, so they are the population.** A run that moves only `.txt` files has not
exercised this feature however many items it moved.

### 1.4 Preserving File/Folder structure
CloudFuze preserves the original file and folder hierarchy during migration from Google Shared Drive
to OneDrive. The complete parent-child structure, including nested folders and files, is accurately
replicated in the destination document library. This ensures structural consistency between source
and destination, **subject to SharePoint Online path length and naming limitations**.

**That qualifier is the whole difficulty.** Google accepts characters and path lengths that
SharePoint Online rejects, so a renamed or relocated item at the destination can be correct
behaviour rather than a defect. The rules live in `validation/destinations/` and must be applied
here exactly as they are for a SharePoint destination — the opposite mistake (applying Google's
permissive rules to a Microsoft destination) is what produced a four-way structure failure on run
6a8d53d2 of another combination.

---

## 2. Permissions (4 features)

The document names four positions — root folder, sub-folder, root file, inner file. Position
matters: a run that only checks the root proves nothing about inheritance, which is why each is a
separate feature rather than one "permissions" row.

### 2.1 Root Folder Permissions
CloudFuze preserves all root folder permissions along with access levels.

### 2.2 Subfolder Permissions
CloudFuze preserves all subfolder permissions along with access levels.

### 2.3 Root File Permissions
CloudFuze preserves all Root file permissions along with access levels.

### 2.4 Inner file permissions
CloudFuze preserves all inner file permissions along with access levels.

**Role translation.** Google exposes three collaborator roles; OneDrive exposes two. From the
document's own figures, where Google `Contributor`/`Content manager` and `Editor` both arrive as
OneDrive **Can edit**, and the source owner arrives as **Owner**:

| Google Drive | OneDrive for Business |
|---|---|
| owner | **Owner** — not re-granted; the destination account owns the copy |
| organizer / fileOrganizer / writer | **Can edit** (`write`) |
| commenter | **Can view** (`read`) — see the note below |
| reader | **Can view** (`read`) |

**This is the table `validation/contentRoleMap.js` already uses** for Google Drive → SharePoint
(`DRIVE_ROLE_LEVEL`), and it is reused here unchanged rather than restated. OneDrive for Business
runs on SharePoint Online and exposes the same `owner` / `write` / `read` roles, so the same mapping
applies. Two content validators must not disagree about what a Google role becomes on a Microsoft
destination.

**Commenter is the one that loses information.** Google has a comment-only role and Microsoft does
not, so a Commenter grant collapses to `read` — the reader keeps access but loses the ability to
comment. The map treats that as the expected outcome rather than a defect. The test repository
carries explicit cases for it ("Verify root file permissions with Commenter access"), so it IS
exercised; if the combination owner decides the collapse should be reported as a loss, that is a
change to the shared map and to both combinations, not a local rule invented here.

**Owner is not comparable.** `DRIVE_ROLES_NOT_COMPARABLE` excludes it deliberately: the destination
account owns its own copy, so the source owner has nothing to map onto and a comparison would
always differ.

**Group grants.** The test repository also covers group permissions ("Verify inner file permissions
and group permissions with editor access"), so a group is part of the population for 2.1–2.4, not a
separate feature.
