# Migration Feature Documentation

**Product Type:** Content
**Combination:** Google My Drive to One Drive
**Scope:** In Scope
**Total Features:** 18
**Last Updated:** 2026-06-08

---

## 1. Migration (2 features)

### 1.1 One time migration
The One-Time Migration performs the initial transfer of all existing Google My Drive files and folders to OneDrive, including file content, folder structure, metadata, and supported permissions.

### 1.2 Delta migration
Delta Migration transfers only newly added or modified files and folders after the One-Time Migration. Only incremental file changes are included.

---

## 2. Files (4 features)

### 2.1 All File Types
All standard file types are migrated: documents (.docx, .pdf, .txt), spreadsheets (.xlsx, .csv), presentations (.pptx), images (.jpg, .png, .gif, .bmp), archives (.zip), and other binary formats.

### 2.2 Large Files
Files up to the OneDrive per-file size limit (250 GB) are supported for migration.

### 2.3 Special Characters in File Names
Files and folders with special characters in their names (e.g., `!`, `@`, `#`, `$`, `%`, `-`, `_`, `(`, `)`) are migrated with names preserved or sanitized to comply with OneDrive naming restrictions.

### 2.4 Long File Names
Files and folders with long names (up to 400 characters) are migrated. Names exceeding OneDrive limits are truncated with a unique suffix to avoid collisions.

---

## 3. Folder Structure (2 features)

### 3.1 Nested Folders
The complete folder hierarchy from Google Drive is recreated in OneDrive. All nested sub-folders are preserved at their correct depth.

### 3.2 Deep Nesting
Folder paths with many levels of nesting are migrated. Paths that exceed OneDrive path length limits (400 characters) are flattened or truncated as needed.

---

## 4. Google Workspace File Conversion (3 features)

### 4.1 Google Docs → Word (.docx)
Google Docs native files are exported and migrated as Microsoft Word (.docx) files in OneDrive. Formatting, headings, tables, and inline content are preserved to the extent supported by the conversion.

### 4.2 Google Sheets → Excel (.xlsx)
Google Sheets native files are exported and migrated as Microsoft Excel (.xlsx) files. Sheet tabs, cell values, and basic formulas are preserved.

### 4.3 Google Slides → PowerPoint (.pptx)
Google Slides native files are exported and migrated as Microsoft PowerPoint (.pptx) files. Slide layouts, text, and images are preserved.

---

## 5. File Versions (1 feature)

### 5.1 File Version History
Previous versions of files stored in Google Drive are migrated to OneDrive. The most recent version is the active file; prior versions are preserved in OneDrive version history.

---

## 6. Timestamps (1 feature)

### 6.1 Created and Modified Timestamps
The original file created date and last modified date from Google Drive are preserved and stamped on the migrated file in OneDrive.

---

## 7. Permissions (3 features)

### 7.1 Owner
The file owner identity is mapped to the corresponding destination user account in OneDrive/SharePoint.

### 7.2 Editor (Write)
Users with Editor access in Google Drive are granted Contribute/Edit permission on the migrated file in OneDrive.

### 7.3 Viewer (Read)
Users with Viewer access in Google Drive are granted Read permission on the migrated file in OneDrive.

---

## 8. Shared Drive (1 feature)

### 8.1 Shared Drives (Team Drives)
Files residing in Google Shared Drives (formerly Team Drives) are migrated to the corresponding SharePoint document library or OneDrive shared folder at the destination.

---

## 9. Root Files (1 feature)

### 9.1 Root Level Files
Files and folders placed directly at the root of Google My Drive (not inside any folder) are migrated to the root of the destination OneDrive.