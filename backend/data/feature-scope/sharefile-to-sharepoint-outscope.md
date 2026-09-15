# Migration Feature Documentation

**Product Type:** Content
**Combination:** ShareFile to SharePoint
**Scope:** Out of Scope
**Total Features:** 7
**Last Updated:** 2026-09-14
**Source:** https://doc.cftools.live — Migration Docs → Content → "ShareFile to SharePoint" →
**Outscope** tab. Read directly from the tool on 2026-09-14; the page itself reports
*Updated on 07 Aug 2026*. The .docx set does **not** contain this list — see "Why the .docx set is
not the source" below.

The companion in-scope tab (*Updated on 27 Apr 2026*) carries the same 11 features recorded in
`sharefile-to-sharepoint-inscope.md`, verified name by name on the same visit.

> Companion file: `sharefile-to-sharepoint-inscope.md` — the 11 features that must be validated.

---

## The 7 out-of-scope features

These are **not migrated**. Content exercising them must therefore NOT appear at the destination,
and a run in which it does is a defect — the mirror image of the in-scope checks.

| # | Feature | Family | Description (verbatim) |
|---|---|---|---|
| 1 | Delta | Migration | Migration of incremental changes made in source during the onetime migration. |
| 2 | Root File Permissions | Permissions | CloudFuze preserves all Root file permissions along with access levels. |
| 3 | Inner File Permissions | Permissions | CloudFuze preserves all inner file permissions along with access levels. |
| 4 | In Line comment | In Line comment | Inline file comments will be migrated to the destination cloud. All the file comments will preserve in the CSV formatted file in the destination. |
| 5 | Shared Links | Shared Links | CloudFuze migrates all shared links from source to destination and maintains the type of links. |
| 6 | Selective Versions | Selective Versions | Migration of selective versions of files from source to destination. If we opt for five, the last five versions will get migrates to the destination. |
| 7 | Embedded Links | Embedded Links | The system retains the addresses of links present within a file, which point to other files in the cloud. These links' addresses will be transformed into appropriate destination formats during Migration. |

**Read the descriptions carefully.** They are written as though the feature works — they are the
generic feature blurbs, reused. What makes them out of scope is the list they appear on, not their
wording. Do not read "CloudFuze migrates all shared links" here as a promise; on this combination it
is the description of a feature that is *not* delivered.

## The two that change how permissions are judged

Features 2 and 3 draw a line the in-scope document does not: **folder** permissions are in scope
(in-scope 2.1 root folder, 2.2 sub-folder), **file** permissions are not.

So on this combination:

- a grant on a FOLDER must migrate    → in-scope 2.1 / 2.2
- a grant on a FILE must NOT migrate  → out-of-scope 2 / 3

That distinction is invisible in the in-scope document, which says only "root folder permissions"
and "sub-folder permissions" without ever mentioning files. Validating file permissions as though
they were in scope would fail a run for behaving exactly as specified.

## What can be seeded as a negative control, and what cannot

| Feature | Seedable? | How it is exercised |
|---|---|---|
| Root File Permissions | **no** | ShareFile answers `HTTP 403 Authorization failed: ItemUser` to a grant on a FILE from this account — measured on the live tenant 2026-09-14 |
| Inner File Permissions | **no** | the same 403; file-level grants cannot be created at all |
| Shared Links | **yes** | create a ShareFile share link on a file |
| Embedded Links | **yes**, not yet built | a document containing a hyperlink to another file in the same account — seedable in principle, not planted by this agent yet, so it reports not exercised |
| In Line comment | no | ShareFile exposes no per-file comment stream to seed |
| Selective Versions | no | a JOB SETTING, not data — exercised by requesting N versions, not by planting any |
| Delta | no | a second migration pass over changed content, not data |

A feature that cannot be seeded must be reported as **not exercised**, never as passing. A negative
control that was never planted proves nothing, and a green tick against it is the vacuous kind —
green because nothing was looked for.

---

## Why the .docx set is not the source

The 02-09-2026 content documentation set ships two files for this combination:

```
Content_ShareFiletoSharePoint_(02-09-2026).docx        header says "Scope: In Scope",      11 features
Content_ShareFiletoSharePoint_(02-09-2026) (1).docx    header says "Scope: Out of Scope",  11 features
```

Their bodies are identical apart from that one header word. The `(1)` file is the in-scope list saved
a second time with the label flipped — it is not an out-of-scope document, and the real one is not in
the set. ShareFile → SharePoint is one of 20 of 26 pairs with this defect, and 4 further pairs have
their labels swapped outright.

This file previously recorded `Total Features: 0` on the strength of that, with a test pinning it at
zero so nobody could borrow a neighbouring combination's limitations. That was the right call while
the .docx set was the only thing anyone had looked at, and it was **wrong**: the out-of-scope list
does exist, in the feature repository rather than the document set, and recording zero meant the
agent seeded no negative controls and validated nothing against them. The list above replaces it.

The lesson is worth keeping: the absence of a document is not evidence that a feature list does not
exist — only that nobody had found it yet.
