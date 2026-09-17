# Migration Feature Documentation

**Product Type:** Content
**Combination:** Box to Google (My Drive & Shared Drive)
**Scope:** Out of Scope
**Last Updated:** 2026-09-12
**Source:** `Content_BoxtoGoogle(MyDrive&SharedDrive)_(12-09-2026).pdf`

> Companion file: `box-to-google-inscope.md` — the 34 features that must be validated.
>
> **Validation rule:** everything in this file is documented, expected platform behaviour. A
> difference described here is reported as INFO with its explanation and **must never fail a run**.
> Failing it would report a defect against behaviour the source document has written down as expected.
>
> Unlike `dropbox-to-google-outscope.md` (whose Paper-limitations section was left an open question
> because the Dropbox source document and its own out-of-scope file disagreed), **this PDF is explicit
> and unambiguous** about which Box Notes sub-features do not migrate. So they are listed here
> directly, as confirmed limitations — not flagged for a combination-owner ruling.

---

## 1. In-line comment (1 item)

### 1.1 In-line comment — "CSV is the evidence, not the item"
Box file comments (scope 6.1) and Box Notes comments (scope 10.14) both migrate as a **CSV file** at
the destination, never as native comments on the destination item. A migrated item carrying no
comments of its own is the **correct**, expected outcome — not a loss. The CSV is the evidence the
feature worked; its absence is a defect, the destination item's silence is not.

---

## 2. Box Notes — confirmed content-fidelity limitations (9 items)

The source document is explicit that each of these does **not** survive the Box Note → Google Doc
conversion. Each is reported at INFO with this wording; none may fail a run.

### 2.1 Text Formatting (partial) — scope 10.2
Bold, italic and underline are preserved. **Strikethrough, text alignment and inline code are not** —
they render as plain text at the destination.

### 2.2 Font Size and Text Color — scope 10.3
Not preserved. The destination renders uniform font size and default text color regardless of what
the source Note used.

### 2.3 Checklist, Numbered list, Bulleted list — scope 10.4
Not preserved. All three convert to plain text at the destination, losing both structure and
interactive functionality (a checklist item is no longer checkable).

### 2.4 Tables — scope 10.5
Not migrated correctly. Structure, column alignment and formatting are broken; the destination layout
is distorted and unreadable.

### 2.5 Insert Image (upload from computer) — scope 10.6
Not preserved. An image inserted by uploading directly from a computer is lost in the conversion.

### 2.6 Insert Image (Insert Link Preview) — scope 10.8
Not preserved. A link-preview-style image insert is lost, the same as an uploaded image — only a Box
Shared Link image insert (scope 10.7) survives.

### 2.7 Clipboard Images — scope 10.9
Not preserved. An image pasted from the clipboard is lost.

### 2.8 GIFs — scope 10.11
Not preserved. A GIF renders incorrectly, or as an unsupported element, at the destination.

### 2.9 Mentions — scope 10.13
Not migrated. An `@mention` is missing completely at the destination — a loss of reference
information, not merely a formatting change.

---

**Everything in this file is documented, expected platform behaviour — a difference described here is
reported as INFO and must never fail a run.**
