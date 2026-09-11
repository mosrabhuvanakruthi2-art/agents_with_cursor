# Migration Feature Documentation

**Product Type:** Content  **Combination:** SharePoint to Shared Drive  **Scope:** Out of Scope
**Total Features:** 13

Source of record: `Content_SharePointtoSharedDrive_(09-09-2026) (1).docx`.

**Every item here is reported as INFO and must never fail a run.** The validator emits one INFO row
per entry (`OUT_OF_SCOPE_NOTES` in
`validation/combinations/content/sharepointToGoogleshareddrive.js`) so a reader holding this
document can see each one acknowledged, and so a run that starts failing one of them is recognisable
as a scope change rather than a new defect.

| # | Limitation | Effect on validation |
|---|---|---|
| 1 | Selective Versions | 10.1 judges history PRESENCE; no exact count is asserted |
| 2 | In-line comments | not compared |
| 3 | Lists and page libraries | never expected at the destination |
| 4 | Coloured folders | colour not compared; structure and contents are |
| 5 | Site-level permissions | only item-level grants compared (3.1–6.1) |
| 6 | Modified By / Created By | identity recorded, never compared; timestamps ARE (9.1) |
| 7 | Document expiration dates | not compared |
| 8 | Forms | an empty folder at the destination is the documented outcome |
| 9 | Shortcuts | not expected at the destination |
| 10 | Legal Hold data | not compared |
| 11 | Single standard group type | a group's *type* is not compared, only its access |
| 12 | Group external members | external members of a migrated group are not expected |
| 13 | Share notifications | Google notifies admins by default — see in-scope 13.1 |

---

## 1. Selective Versions

Selective version migration is not supported for the Microsoft → Google combination. Files migrate
successfully, but the option to migrate only selected versions is not available; Google handles
versioning differently from SharePoint Online, so either the latest supported version migrates or
version-history behaviour is limited by the destination platform.

## 2. In Line Comment

Inline/threaded comments are not preserved during migration due to platform differences. An Excel
file migrates successfully to Google Sheets, but comments arrive as imported static/threaded
reference text rather than native Google Sheets comments; comment metadata, reply functionality and
collaboration behaviour are not retained.

## 3. Lists and page libraries

SharePoint Lists and page libraries are not supported for migration in CloudFuze.

## 4. Coloured Folders

Folder colour metadata is not migrated. Folder structure and the data inside the folders migrate
successfully.

## 5. SharePoint site-level permissions

SharePoint site-level permissions are not migrated. File-level and folder-level permissions are
preserved.

This is why the validator excludes SharePoint's built-in site groups — `<Site> Owners / Members /
Visitors` and the `@*.onmicrosoft.com` principal behind the M365 group — from the permission
comparison. They sit on effectively every item and are not migrated grants; counting them would
demand Google permissions that should not exist.

## 6. Modified Date and Created By details

Preservation of "Modified By" and "Created By" metadata is not supported for this combination, due
to platform limitations on the Google side.

Timestamps are a different question and ARE in scope — see in-scope 9.1.

## 7. SharePoint Online document expiration dates

Document expiration-date metadata is not supported for migration, due to differences in platform
capabilities between Microsoft and Google.

## 8. Forms

Microsoft Forms are not supported for migration. Only an empty folder is migrated; no form is
migrated.

## 9. Shortcuts

Shortcuts are not supported for migration, due to platform and feature differences between Microsoft
and Google.

## 10. Legal Hold Data

Legal Hold data and compliance retention information are not supported for migration, due to
platform and compliance feature differences between Microsoft and Google.

## 11. Single standard group type

Google does not support multiple group types such as Distribution Lists, M365 groups or Security
Groups. The tool creates a single standard Google Group at the destination regardless of the source
group type.

The validator therefore compares a group's ACCESS LEVEL, never its type.

## 12. Group Migration with External Email Members Behavior

Groups containing external email members are only partially supported:

- Groups migrate successfully to the destination.
- External email members within the groups are not added or preserved.
- Only internal users of the source organisation migrate as group members.
- A group holding both internal and external users keeps only the internal ones.

## 13. Share notifications suppressed

Google sends notifications to admin accounts when a document is shared — its default behaviour. A
document is shared in a way that suppresses those notifications where possible.

This is the destination-side counterpart of in-scope feature 13.1, which the suite reports as NOT
VERIFIED rather than as a pass.
