# Migration Feature Documentation

**Product Type:** Content
**Combination:** Dropbox to Microsoft (OneDrive & SharePoint)
**Scope:** Out of Scope
**Total Features:** 1
**Last Updated:** 2026-09-09
**Source:** `Content_DropboxtoMicrosoft(OneDrive&SharePoint)_(09-09-2026) (1).docx`

> Companion file: `dropbox-to-sharepoint-inscope.md` — the 36 features that must be validated.
>
> **Validation rule:** everything in this file is documented, expected platform behaviour. A
> difference described here is reported as INFO with its explanation and **must never fail a run**.
> Failing it would report a defect against behaviour the company has written down as out of scope.

---

## 1. In-line comment (1 feature)

### 1.1 In-line comment
Migrates inline file comments to the destination cloud. All file comments are preserved in a **CSV
formatted file at the destination**.

**Validation treatment.** In-line comments are NOT expected to appear as comments on the destination
item. They are expected to arrive as a CSV report alongside the migrated content. So:

- A migrated file with no comments on it is **correct**, not a loss.
- The evidence that the feature worked is the **CSV report**, not the item.
- Absence of comments on the destination item is reported at INFO and never contributes to a FAIL.

This is the same shape as the Shared Links and Long Path and Embedded Links CSVs described in the
in-scope document (features 5.1, 5.2, 8.1 and 9.1): CloudFuze writes a report into the destination
rather than reproducing the data natively. Those reports are ordinary files in the destination and
can be read directly — there is no special API for the CSV, a point worth stating because two
features on the Google Shared Drive combination were marked "not automated — no API for the CSV" for
months while the files were sitting in the destination the whole time.

---

## Note on the eight Dropbox Paper deviations

The in-scope document records eight Paper elements that did not migrate as a user would expect —
highlight colours (11.2), GIFs (11.6), TO-DO lists (11.11), section breaks (11.14), code block
formatting (11.15), mentions (11.17), comments (11.18) and Paper version history (11.19).

**They are deliberately NOT listed in this file**, because the official out-of-scope document does
not list them. Adding them here would silently convert eight potential defects into accepted
behaviour on a validator author's judgement, which is not a call this file gets to make.

Until the combination owner rules on them, the validator reports each at INFO carrying the
document's own wording — neither hiding a defect nor inventing one. If the owner confirms they are
accepted limitations, get them added to the official out-of-scope document first, then move them
here with the reasoning. If the owner confirms they are defects, they belong in the report as
failures.

*Precedent:* `dropbox-to-google-outscope.md` carries the identical open question for six Paper
features, and the Google Shared Drive out-of-scope file carries a section marked "validator
assumption — NOT confirmed" for exactly this reason, explicitly inert so that no run can excuse a
real absence against a rule the company has not written.

---

## Note on the Word table column limit

In-scope feature 11.9 records that Paper tables retain up to **63 columns** with minimal cell content
and up to **62** with richer content, and that columns beyond the limit are **merged into the last
supported column**.

That merge is **documented, expected behaviour** of the Word format, not a migration defect — but it
is described in the in-scope document rather than here, so it is reported with the document's own
wording at INFO. A table at or below the limit arriving merged *would* be a defect.
