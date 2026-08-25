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

> **NOT company policy — checked and confirmed absent from the official document.**
>
> The Outscope tab of `doc.cftools.live` → Content → *Shared Drive to SharePoint* (updated
> 20 Apr 2026) lists exactly **one** out-of-scope item: the version and timestamp limitation in
> section 1 above. Google Forms, Sites, Drawings and My Maps do **not** appear there.
>
> This section therefore records a validator assumption, carried over from
> `google-my-drive-to-one-drive-outscope.md`, which covers a different combination. It is currently
> **inert**: `DriveTestDataAgent` seeds only Docs, Sheets and Slides as Google-native types, and all
> three have an export path and are validated normally. No seeded item reaches this rule.
>
> Do not extend it or rely on it. If a Form, Site, Drawing or My Map is ever seeded, get the
> exclusion added to the official document first — otherwise the run would excuse a real absence
> against a rule the company has not written.

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

---

## 3. Conditions the combination document states as prerequisites, not defects

**Source:** `doc.cftools.live` -> Content -> *Shared Drive to SharePoint* (updated 27 Apr 2026). Quoted
from the official document, which is authoritative over any judgement made here.

### 3.1 Permissions for principals with no destination mapping
Document #5 (Permissions): permissions are preserved *"provided users are properly mapped and **available
in the destination tenant**"*.

A source principal - user **or group** - with no mapped destination counterpart therefore falls outside
the feature. CloudFuze has nobody to re-grant the access to.

**Validation treatment.** Reported as `8b. Permissions not migratable - N unmapped principal(s)` at INFO,
naming each principal and stating that mapping it under Map Users brings it into scope. It does **not**
contribute to a FAIL.

*Why this matters:* every grant to one unmapped group (`everyone_at_exinent@filefuze.co`, which holds
`fileOrganizer` on the whole drive) was compared against that same `filefuze.co` address inside the
`gajha.com` tenant, where it cannot exist. That produced 88 identical failures and buried the grants that
had migrated correctly. With the rule applied the same run reports *88 shared item(s) verified - roles
mapped correctly*.

### 3.2 Anonymous shared links when the destination restricts sharing
Document #13 (External Shares): *"Migration of external shares depends on proper user mapping and
Microsoft 365 external sharing policies. **If external sharing is restricted or disabled in SharePoint,
those permissions may not be applied in the destination.**"*

**Validation treatment.** Reported as `9b. Anonymous links not applicable - N item(s)` at INFO, citing the
document. Organization-scope links ("People in <org> with the link", features 5.6-5.9 and 5.13-5.15) are
**still validated normally** - the exemption covers only the anonymous scope.

**Declared, never inferred.** Set `CONTENT_DEST_ANONYMOUS_SHARING=blocked` only after confirming the
destination refuses anonymous sharing; Graph `createLink` with `scope=anonymous` answers
`notAllowed: sharing has been disabled on this site` when it does. Left unset, missing anonymous links are
reported as failures.

*Why the declaration matters:* an earlier version inferred the policy from "no anonymous link matched
anywhere". One genuinely failed link produces that identical shape, so a real defect would have been
excused as expected behaviour. `contentCombinationSuite.test.js` caught it - 25/26 - and the check was
changed to require the explicit setting.

### 3.3 Over-length paths
Document #37 (Long Folder/File path): the 400-character limit is a Microsoft platform constraint, and
*"when the path length limit is reached, a Folder/File Path Link URL is created... This link acts as a
placeholder in the destination."*

**Validation treatment.** Items over the limit are paired to their relocated destination copy and reported
as placeholder links, not as missing/extra/misplaced. Previously one deliberately over-length test path
produced five separate findings (3 missing + 2 extra) for behaviour the document describes as intended.

---

## 4. Confirmed IN scope by the same document - these must fail when broken

Recorded only to mark the boundary; the detail lives in the in-scope file.

- **File conversion** (document #38) explicitly lists `.doc -> .docx`, `.xls -> .xlsx`, `.ppt -> .pptx`.
  Files arriving with their original extension are a **defect**, not a platform limitation.
- **Destination availability.** The document assumes migrated content is usable at the destination. Files
  left checked out are invisible to every user other than the check-out holder, so
  `1b. Destination files available to the user` fails when any are found - presence is not availability.
