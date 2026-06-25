# Migration Feature Documentation

**Product Type:** Content
**Combination:** Google My Drive to One Drive
**Scope:** Out of Scope
**Total Features:** 10
**Last Updated:** 2026-06-08

---

## 1. Google Native Formats (4 features)

### 1.1 Google Forms
Google Forms are not migrated. There is no equivalent native format in OneDrive/SharePoint. Forms must be recreated manually in Microsoft Forms.

### 1.2 Google Sites
Google Sites pages are not migrated. There is no direct conversion path to SharePoint pages or OneDrive content.

### 1.3 Google Drawings
Google Drawings files are not migrated as editable drawings. They may be exported as static images (.png) on a best-effort basis, but the vector editing capability is lost.

### 1.4 Google My Maps
Google My Maps files are not migrated. There is no equivalent format in the Microsoft 365 ecosystem.

---

## 2. Sharing & Permissions (3 features)

### 2.1 Shared Link URLs
Shared link URLs generated in Google Drive are not preserved. New sharing links must be generated in OneDrive after migration.

### 2.2 External User Permissions
Permissions granted to users outside the organization (external collaborators) are not migrated. Only internal domain users with mapped destination accounts are included.

### 2.3 Commenter Permissions
Users with Commenter-only access in Google Drive are not migrated with commenter role. Commenter is not a distinct sharing role in OneDrive.

---

## 3. Other Content (3 features)

### 3.1 File Comments and Annotations
Comments, suggestions, and annotation threads attached to Google Drive files are not migrated. Only the file content is transferred.

### 3.2 Trashed Items
Files and folders that have been moved to Google Drive Trash are not migrated. Only active (non-trashed) content is included.

### 3.3 Shortcuts (Drive Shortcuts)
Google Drive Shortcuts (pointers to files/folders in other locations) are not migrated as shortcuts. The target file/folder itself is migrated if it is within scope, but the shortcut link is not recreated in OneDrive.