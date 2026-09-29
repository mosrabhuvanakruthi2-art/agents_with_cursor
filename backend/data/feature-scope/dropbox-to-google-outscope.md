# Migration Feature Documentation

**Product Type:** Content
**Combination:** Dropbox to Google (My Drive & Shared Drive)
**Scope:** Out of Scope
**Total Features:** 1
**Last Updated:** 2026-09-16
**Source:** `Content_DropboxtoGoogle(MyDrive&SharedDrive)_(16-09-2026).pdf` (re-confirmed from the
`01-09-2026` version — content unchanged: still exactly one out-of-scope feature, in-line comments)

> Companion file: `dropbox-to-google-inscope.md` — the 36 features that must be validated.
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

This is the same shape as the Shared Links and Embedded Links CSVs described in the in-scope
document (features 3.1, 3.2 and 8.1): CloudFuze writes a report into the destination rather than
reproducing the data natively. Those reports are ordinary files in the destination and can be read
directly — there is no special API for them, a point worth stating because two features on the
Google Shared Drive combination were marked "not automated — no API for the CSV" for months when the
files were sitting in the destination the whole time.

---

## Note on Dropbox Paper limitations

The in-scope document records six Paper elements that did not migrate — highlight colours (10.2),
GIFs (10.6), section breaks (10.14), code block formatting (10.15), mentions (10.17) and comments
(10.18).

**They are deliberately NOT listed in this file**, because the official out-of-scope document does not
list them — confirmed again in the `16-09-2026` re-issue, fifteen days after the original: still
exactly one out-of-scope feature (in-line comments), Paper's six limitations still absent. Two
independent document versions omitting them is stronger evidence this is not an oversight, not weaker
grounds to add them ourselves. Adding them here would silently convert six potential defects into
accepted behaviour on a validator author's judgement, which is not a call this file gets to make.

The same reissue is also silent on Dropbox Papers Migration itself (in-scope feature 10.1) — it is not
named anywhere in either out-of-scope version. Total non-migration of a Paper document (as opposed to
a documented partial-fidelity loss) has no textual basis for treatment as accepted behaviour and must
keep failing when it happens.

Until the combination owner rules on them, the validator reports each at INFO carrying the
document's own wording — neither hiding a defect nor inventing one. If the owner confirms they are
accepted limitations, get them added to the official out-of-scope document first, then move them
here with the reasoning. If the owner confirms they are defects, they belong in the report as
failures.

*Precedent:* the Google Shared Drive out-of-scope file carries a section marked "validator
assumption — NOT confirmed" for exactly this reason, and it is explicitly inert so that no run can
excuse a real absence against a rule the company has not written.
