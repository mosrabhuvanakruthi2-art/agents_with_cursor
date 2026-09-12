# Migration Feature Documentation

**Product Type:** Content  **Combination:** Shared Drive to Shared Drive  **Scope:** Out of Scope
**Total Features:** 7

Source of record: `Content_SharedDrivetoSharedDrive_(12-09-2026) (1).docx`.

Everything here is a **documented limitation**. The validator reports each as `INFO` on every run and
**must never fail a run for one**. Read together with
`google-shared-drive-to-shared-drive-inscope.md`.

| Id | Limitation | Documented behaviour | How this suite treats it |
|---|---|---|---|
| 1.1 | In Line comment | Inline file comments migrate to the destination and are preserved there | Native comments are **not** compared — reading them needs the Drive comments API, which the content flow does not request. Reported INFO. See the conflict note below. |
| 2.1 | Google Drawing | Migrates as a Google Doc **with empty data** | Its **presence** is checked; its contents are not. An empty body at the destination is the documented outcome, not a defect. |
| 3.1 | Google Vids | Goes to conflict — non-migratable | Excluded from "missing" in the structure comparison. |
| 4.1 | Google Forms | Goes to conflict — non-migratable | Excluded from "missing". |
| 5.1 | Google My Maps | Goes to conflict — non-migratable | Excluded from "missing". |
| 6.1 | Google Apps Script | Goes to conflict — non-migratable | Excluded from "missing". |
| 7.1 | Google Sites | Goes to conflict — non-migratable | Excluded from "missing". |

The five non-migratable types are excluded by `deepContentCore`'s `GOOGLE_NATIVE_NO_EXPORT` table, so
a seeded Form that is absent at the destination is the **documented outcome** rather than a defect.
They are still counted and listed, so a reader can see what did not travel.

## The In Line comment conflict

`11.1` of the **in-scope** document and `1.1` of this document describe the same feature and do not
agree:

- In scope: *"All the file comments will preserve in the **CSV formatted file** in the destination."*
- Out of scope: *"All the file comments will preserve **in the destination**."*

One says comments arrive as a generated CSV; the other says they arrive as comments. This suite takes
the in-scope reading — it looks for the comments CSV and treats the absence of natively re-created
comments as this limitation. The conflict is recorded here rather than resolved silently: if the
intended behaviour is native comments, feature 11.1 needs a different check, and this note is the
place that says so.
