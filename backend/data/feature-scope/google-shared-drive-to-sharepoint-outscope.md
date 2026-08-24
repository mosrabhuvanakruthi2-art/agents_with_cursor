# Migration Feature Documentation

**Product Type:** Content
**Combination:** Google Shared Drive to SharePoint
**Scope:** Out of Scope
**Total Features:** 1 (+1 validator assumption, unconfirmed)
**Last Updated:** 2026-08-20
**Source:** `Content_SharedDrivetoSharePoint_(20-08-2026) (1).docx`

> Companion file: `google-shared-drive-to-sharepoint-inscope.md` — the 38 features that must be validated.
>
> **Validation rule:** everything in this file is documented, expected platform behavior. A difference
> described here is reported as INFO with its explanation and **must never fail a run**. Failing it would
> report a defect against Google's own API behavior.

---

## 1. Migration of Google Files – Version and Timestamp Limitations (1 feature)

### 1.1 Migration of Google Files – Version and Timestamp Limitations
**Applies to:** Google My Drive and Shared Drives

**Issue — version counts do not match.** The number of versions on a source document does not match the
number of versions in the destination.

*Root cause:* the Google API merges smaller versions into a single version when retrieving a file's
versions, so the API returns a lower version count than the Drive UI displays. This is the behavior of the
Google API, not a migration defect. If a customer reports seeing fewer versions on the destination than on
the source, they should be informed that during migration the Google API merges smaller versions and
consolidates the total count, so fewer versions are migrated.

Google's own documentation corroborates this: `revisions.list` "might be incomplete for files with a large
revision history, including frequently edited Google Docs, Sheets, and Slides", editor file revisions "may
be merged together", and `keepForever` applies only to files with binary content and to a maximum of 200
revisions.

**Issue — version timestamps are not retained.** File version timestamps are not preserved when migrating.

*Root cause:* for Google file versions, timestamps cannot be updated. The system automatically assigns the
upload time and no API exists to modify or override that timestamp.

**Related in-scope note.** In-scope feature 8.1 records two further distortions that compound this: a
single source version may appear as **two** versions in SharePoint (the second reflecting the migration
timestamp update), and Google may expose only the earliest and the current/latest version of a file. These
are platform-dependent and do not indicate data loss.

**Validation treatment.** Version-count differences and version-timestamp differences are recorded as
informational rows carrying the explanation above. They do not contribute to a FAIL verdict. What *is*
still validated: that version history exists on the destination when the source had multiple versions and
destination versioning is enabled, and that the latest version's content matches.

---

## 2. Google-only file types (validator assumption — NOT yet confirmed for this combination)

> **This section is an assumption made by the validator, not a statement from the source document.**
> The Shared Drive → SharePoint scope document says nothing about these types. The companion
> `google-my-drive-to-one-drive-outscope.md` lists Google Forms, Sites, Drawings and My Maps as out of
> scope for that combination, and none of them appear in this combination's in-scope format list
> (feature 12.1). **Confirm with the QA team**, and move this section into the in-scope document if any
> of these types are in fact expected to migrate.

### 2.1 Types with no Microsoft 365 equivalent
The following Google-only types have no destination format to convert into, so they do not arrive at the
destination at all:

| Type | Reason |
|---|---|
| Google Form | No Microsoft 365 equivalent; must be rebuilt in Microsoft Forms |
| Google Site | No direct conversion to a SharePoint page |
| Google My Map | No Microsoft 365 equivalent |
| Jamboard file | No Microsoft 365 equivalent |
| Apps Script project | Not migrated as content |
| Google Drawing | Exportable only as a static image, on a best-effort basis |
| Drive shortcut | A pointer, not content — its target migrates on its own |

**Validation treatment.** An item of one of these types that is absent from the destination is reported in
a dedicated "Google-only types not migrated" row with its reason, and is **not** counted as missing.
Counting them as missing would fail every run containing a single Form or shortcut anywhere in the tree.
Google editor files that *do* have an export path — Docs, Sheets, Slides — are **not** in this list: they
migrate as `.docx` / `.xlsx` / `.pptx` and are validated normally (their bytes are not hash-compared,
since a converter produces them).
