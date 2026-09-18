# Migration Feature Documentation

**Product Type:** Content
**Combination:** Box to Google (My Drive & Shared Drive)
**Scope:** Out of Scope
**Total Features:** 9
**Last Updated:** 2026-09-14
**Source:** `Content_BoxtoGoogle(MyDrive&SharedDrive)_(14-09-2026) (1).pdf`

> Companion file: `box-to-google-inscope.md` — the 34 features that must be validated.
>
> **Validation rule:** everything in this file is documented, expected platform behaviour. A
> difference described here is reported as INFO with its explanation and **must never fail a run**.
> Failing it would report a defect against behaviour the company has written down as out of scope.
>
> **Read the conflict section at the bottom before wiring any of this into a validator.** Seven of
> these nine features are also listed in the in-scope document, and two carry the wrong destination
> cloud. Those are not transcription slips on this side — they are in the source PDF.

---

## 1. Metadata & Additional Elements : Tags (1 feature)

### 1.1 Metadata & Additional Elements : Tags
Tags associated with Box Notes will not migrate.

---

## 2. Shared Links (for Box Notes files) (1 feature)

### 2.1 Shared Links (for Box Notes files)
Shared links created for Box Notes will not migrate to the destination.

**Scope boundary.** This is narrower than it first reads: it covers shared links created **on Box
Notes files only**. Shared links on ordinary files and folders are in scope — in-scope features 5.1
and 5.2 — and must still be validated. A validator that reads this as "shared links are out of
scope" would silently drop two in-scope features.

---

## 3. Box note Annotation /Mention (1 feature)

### 3.1 Box note Annotation /Mention
Box note annotation or mention is migrated as normal text instead of mention tag.

---

## 4. Media & Images : Uploaded Media Files (1 feature)

### 4.1 Media & Images : Uploaded Media Files
Uploaded Media Files Files uploaded directly through the media upload option will not migrate.

---

## 5. Media & Images : Insert Link Preview (1 feature)

### 5.1 Media & Images : Insert Link Preview
Insert Link Preview Files uploaded from " insert link preview" media upload option will not migrate.

---

## 6. Font Size and Text Color (1 feature)

### 6.1 Font Size and Text Color
font size variations and text colors from the source are not fully preserved. Most of the text
appears in a uniform size and default color in the destination, leading to loss of original
formatting differences.

---

## 7. Checklist, Numbered list, Bulleted list: (1 feature)

### 7.1 Checklist, Numbered list, Bulleted list:
Validated checklist, numbered list, and bulleted list migration for Box Notes for Box to Microsoft.
Content was migrated; however, these list formats were not preserved as expected. All items are
converted numbers list only in the destination, resulting in loss of original list structure and
functionality.

> ⚠️ Transcribed verbatim. The text says **"Box to Microsoft"** and **"converted numbers list
> only"**, in a Box-to-**Google** document whose in-scope counterpart (10.4) says the same feature
> converts to **plain text**. See the conflict section.

---

## 8. Strikethrough Text in box note (1 feature)

### 8.1 Strikethrough Text in box note
Strikethrough Text Text formatted with strikethrough will migrate as normal plain text (strikethrough
formatting is not preserved).

---

## 9. Tables in box notes (1 feature)

### 9.1 Tables in box notes
The table content migration from Box Notes to Microsoft Docs. Table content is not migrated as
expected; structure, alignment, and formatting are broken in the destination, resulting in distorted
and unreadable table layout.

> ⚠️ Transcribed verbatim. The text says **"to Microsoft Docs"**, in a Box-to-Google document. The
> in-scope counterpart (10.5) describes the identical outcome for **Google Docs**. See below.

---

## Conflicts with the in-scope document — NOT resolved here

Both PDFs are dated 14-09-2026 and describe the same combination. Seven of the nine features above
also appear in `box-to-google-inscope.md`. That matters because the two documents carry opposite
validation treatments: in scope means *must be validated and can fail*; out of scope means *report
at INFO and never fail*. A feature in both has no defined verdict.

| Out-of-scope | In-scope | Do the two agree? |
|---|---|---|
| 3.1 Annotation/Mention → "migrated as normal text" | 10.13 Mentions → "not migrated, missing completely" | **No.** Text-instead-of-tag and total absence are different outcomes with different evidence. |
| 4.1 Uploaded Media Files | 10.6 Upload images from your computer | Yes — both say not preserved. |
| 5.1 Insert Link Preview | 10.8 Insert Link Preview | Yes — both say not preserved. |
| 6.1 Font Size and Text Color | 10.3 Font Size and Text Color | Yes — wording is near-identical. |
| 7.1 Checklist/Numbered/Bulleted | 10.4 Checklist/Numbered/Bulleted | **No.** "converted numbers list only" vs "converted into plain text". |
| 8.1 Strikethrough | 10.2 Text Formatting (lists strikethrough among the differences) | Yes on the outcome; 10.2 bundles it with alignment and inline code. |
| 9.1 Tables in box notes | 10.5 Tables | Yes on the outcome — but 9.1 names Microsoft Docs and 10.5 names Google Docs. |

Only **1.1 Tags** and **2.1 Shared Links for Box Notes** are unique to this file.

**These are deliberately left unresolved.** Picking a winner per row would either convert real
defects into accepted behaviour or fail a run against documented behaviour — on a validator author's
judgement, which is not a call this file gets to make. This follows the precedent set in
`dropbox-to-google-outscope.md`, which refuses the same kind of call and says why.

**What a validator should do until the combination owner rules:**

- For the five rows that agree (4.1, 5.1, 6.1, 8.1, 9.1-outcome): treat as out of scope — INFO, never
  a FAIL. Both documents describe the same outcome, so there is no ambiguity about what happened,
  only about which file owns it.
- For the two that disagree (3.1/10.13 and 7.1/10.4): report at INFO carrying **both** documents'
  wording and flag the contradiction in the run output. Do not fail, and do not pick one.
- For 1.1 and 2.1: out of scope, INFO, never a FAIL.

**Questions for the combination owner** — these need answers before the contradictions can be closed:

1. Do mentions in Box Notes arrive as plain text (3.1) or not at all (10.13)? The two describe
   different destination states.
2. Do lists arrive as a numbered list (7.1) or as plain text (10.4)?
3. Are the "Microsoft" references in 7.1 and 9.1 copy-paste from the Box-to-Microsoft document, or
   was that combination genuinely the one tested? If the former, the Google behaviour in those two
   rows is **undocumented**, not merely mis-labelled — and 9.1's table finding would not yet have
   been verified against Google Docs at all.
4. Should the seven overlapping features be removed from the in-scope document's count of 34, or
   from this document's count of 9? As written, the two documents claim 43 features between them
   while describing 36 distinct ones.
