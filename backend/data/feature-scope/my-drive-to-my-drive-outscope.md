# Migration Feature Documentation

**Product Type:** Content
**Combination:** My Drive to My Drive
**Scope:** Out of Scope
**Total Features:** 7
**Last Updated:** 2026-09-14
**Source:** `Content_MyDrivetoMyDrive_(14-09-2026) (1).pdf`

> Companion files: `my-drive-to-my-drive-inscope.md` (17 features that must be validated) and
> `my-drive-to-my-drive-testdata.md`.
>
> **Validation rule:** everything in this file is documented, expected platform behaviour. A
> difference described here is reported as INFO with its explanation and **must never fail a run**.
> Failing it would report a defect against behaviour the company has written down as out of scope.
>
> Unlike the Box and Dropbox out-of-scope documents, **none of these 7 features also appears in the
> in-scope document.** There is no overlap to resolve. Six of the seven are Google-native editor file
> types that do not survive the transfer.

---

## 1. In Line comment (1 feature)

### 1.1 In Line comment
Inline file comments will be migrated to the destination cloud. All the file comments will preserve in
the destination.

**Read this carefully — it is phrased as a success, in the out-of-scope document.** The same oddity
appears in `dropbox-to-google-outscope.md` 1.1, where the resolution is that the evidence is a **CSV
report**, not native comments on the item.

Here the wording is different: it says comments "preserve in **the destination**", with no mention of
a CSV. On a Google → Google pair native comments genuinely could survive, so the two readings are not
interchangeable:

- If it means *native comments survive*, the feature works and its presence here is a filing error.
- If it means *a CSV is produced* (as on the Dropbox and Box pairs), the destination item will carry
  no comments and that absence is correct.

**Until this is settled, report at INFO either way and never fail.** Absence of comments on a migrated
item is not evidence of a defect while this ambiguity stands. Flagged as a question below.

---

## 2. google drawing (1 feature)

### 2.1 google drawing
google drawing will be migrated as google doc, with empty data.

**This is data loss with a surviving container**, and it is the only one of the six native types that
produces an object at all. Figure 2.1.1 shows source `new drawing` (a Drawing) and destination
`Diagram`/`new drawing` present in the listing — so an item-count comparison **passes** while the
content is gone. A validator that checks counts alone will not see this.

---

## 3. google vids (1 feature)

### 3.1 google vids
google vids will go into conflict and is non migratable.

---

## 4. google forms (1 feature)

### 4.1 google forms
google forms will go into conflicts and is non migratable.

---

## 5. google my maps (1 feature)

### 5.1 google my maps
google my maps will go into conflicts and is non migratable.

---

## 6. google app script (1 feature)

### 6.1 google app script
google app script will go into conflicts and is non migratable.

---

## 7. google sites (1 feature)

### 7.1 google sites
google sites will go into conflicts and is non migratable.

---

## The five conflict types, read together

Features 3.1 and 4.1–7.1 all say the same thing about five native types:

| Type | MIME type | Outcome |
|---|---|---|
| Google Vids | `application/vnd.google-apps.vid` | conflict — non migratable |
| Google Forms | `application/vnd.google-apps.form` | conflict — non migratable |
| Google My Maps | `application/vnd.google-apps.map` | conflict — non migratable |
| Google Apps Script | `application/vnd.google-apps.script` | conflict — non migratable |
| Google Sites | `application/vnd.google-apps.site` | conflict — non migratable |

*MIME types are supplied here for implementation convenience; the document names the types in prose
only. Verify each against the Drive API response before relying on it in a filter.*

**"Goes into conflict" is a specific, checkable outcome, not a synonym for "missing."** The figures
bear this out: in every one (3.1.1, 4.1.1, 5.1.1, 6.1.1, 7.1.1) the source pane lists `video`, `map`,
`site`, `project`, `Bakery Order Request Form` and the destination pane lists **none of them** — the
destination consistently shows 7 items against the source's 13.

Two consequences for validation:

1. **The run should report these as CONFLICT, not as missing data.** If a run reports them as absent
   without a conflict status, that is itself worth flagging — the documented behaviour is that
   CloudFuze recognises and rejects them, not that it silently drops them.
2. **A raw item-count comparison will always show a shortfall** on any account containing these
   types. The six items in the figures account for the entire 13 → 7 gap. Any count-based check must
   exclude the five conflict types and treat Drawings (2.1) separately, or every run against a real
   Drive fails on documented behaviour.

---

## Questions for the combination owner

1. **1.1 In Line comment** — do comments arrive as native Google comments on the destination item, or
   as a CSV report as on the Box and Dropbox pairs? The document says "preserve in the destination"
   and mentions no CSV, which contradicts how every other combination describes the same feature.
   Until answered, a validator cannot tell a working migration from a silent loss.
2. **Why is 1.1 in this document at all?** It describes a feature working. If it belongs in scope, it
   should move to the in-scope document and raise the count from 17 to 18.
3. **2.1 google drawing** — is an empty Google Doc the accepted end state, or is the expectation that
   Drawings should also go to conflict like the other five native types? Converting to an empty
   container is strictly worse than a conflict for a customer, because it looks like success.
4. Are there other native types not listed — Google Jamboard, Looker Studio, Colab notebooks — that
   behave the same way? The document covers six; the family is larger, and an unlisted type has no
   documented treatment at all.
