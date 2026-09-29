# Test data specification — My Drive to My Drive

**Derived from:** the QA team's own cases in the Xray Test Repository, folder `/Mydrive to Mydrive/*`
— **14 cases analysed** (`/Cloud Adding` 5, `/Root Folder Permissions` 9).

**Cross-referenced against:** `my-drive-to-my-drive-inscope.md` (17 features) and
`my-drive-to-my-drive-outscope.md` (7 limitations).

> Why this file exists. The scope document says *what* must be validated. It does not say what data
> has to exist for a run to exercise it. The QA cases do — and here they also expose how little of the
> scope is currently covered at all.
>
> **Read the coverage warning first.** Unlike the Dropbox pair (5,905 cases across every feature),
> this folder holds 14 cases touching **one** of the 17 in-scope features. The seeding cannot be
> derived from the QA cases alone, because for 16 features there are none. Most of this specification
> is therefore driven by the scope documents, and each row says which source it came from.

---

## What the QA cases actually vary

Counted from case summaries — 14 cases, so these are exact, not weightings.

### The 9 permission cases are a complete 3 × 3 matrix

| | view | comment | edit |
|---|---|---|---|
| **internal** collaborator | TEST-34399 | TEST-34400 | TEST-34398 |
| **external** collaborator | TEST-34403 | TEST-34401 | TEST-34402 |
| **group** collaboration | TEST-34404 | TEST-34406 | TEST-34405 |

Three subjects × three access levels, no gaps and no duplicates. The completeness is deliberate.

Two things follow immediately:

- **Commenter is a first-class case (3 of 9), but the scope document never mentions it.** No figure in
  the in-scope PDF shows a Commenter grant. Google→Google means commenter exists on both sides and
  should map to itself, but that is an inference, not a documented rule. See the open question below.
- **External is a subject at the root folder**, which means in-scope feature 2.5 is exercised *through*
  2.1 rather than separately. There is no standalone external-shares case.

### Every permission case is Root → Root, via CSV

All nine end with the identical clause: **"For Root to Root CSV mapping."**

| dimension | value | cases |
|---|---|---|
| path pair | Root → Root only | 9 / 9 |
| user mapping | CSV | 9 / 9 |
| item position | root folder | 9 / 9 |

Compare the Dropbox pair, which varies all nine source→destination path pairs across 5,905 cases.
Here there is exactly one. **The CSV is not optional** — it is the mechanism by which a
`@filefuze.co` grantee becomes a `@cloudfuze.com` grantee, which is the whole point of a cross-tenant
run (in-scope 2.x).

### The 5 Cloud Adding cases are account setup, not migration data

| case | what it needs |
|---|---|
| TEST-31989 | a My Drive account added with **Super admin** credentials |
| TEST-31990 | a My Drive account added with **user** credentials |
| TEST-32018 | the **CloudFuze application installed from the Google Marketplace** |
| TEST-34374 | added accounts visible in the **managed clouds** section |
| TEST-34377 | the **total number of users** added for My Drive |

These are preconditions for a run rather than content to migrate, and they are **not covered by any
of the 17 in-scope features**. They belong to the connect/authorise flow. Worth noting because a
seeding agent that only creates Drive content will not satisfy them — two distinct credential types
and a Marketplace install are environment setup.

### What the QA cases do NOT vary

Nothing in this folder covers: delta, root files, sub-folders, inner files, shared links, metadata,
special characters, long paths, embedded links, versions, or any of the 7 out-of-scope native types.

---

## Test data the seeding must create

Each row states which scope feature it exercises and where the requirement came from.

### A. Permissions — the one area the QA cases actually specify

| # | Data | Scope | Source |
|---|---|---|---|
| 1 | A **root folder** granted to an **internal** user at **view**, **comment** and **edit** | 2.1 | TEST-34398/34399/34400 |
| 2 | The same root folder granted to an **external** address (outside the org) at view, comment and edit | 2.1 / 2.5 | TEST-34401/34402/34403 |
| 3 | The same root folder granted to a **group** at view, comment and edit | 2.1 | TEST-34404/34405/34406 |
| 4 | A **user-mapping CSV** covering every grantee above, source tenant → destination tenant | 2.x | all 9 cases |

Item 4 carries a requirement the other rows do not: the CSV must map **both users and groups**.
Figure 2.3.1 of the in-scope document shows `harry-group-@filefuze.co` arriving as
`harry_group_@cloudfuze.com`, so group principals are remapped too — but the same figure shows
`kalyan_test_group_2@filefuze.co` **unchanged on both sides**. Seed both shapes: a group that is
remapped and one that is not, so the validator has to distinguish them rather than assume.

### B. Permissions — required by scope, no QA case exists

| # | Data | Scope | Source |
|---|---|---|---|
| 5 | A **root file** with grants at all three levels | 2.2 | scope only — no case |
| 6 | **Sub-folders** with their own grants, at two depths | 2.3 | scope only — no case |
| 7 | **Inner files** inside those sub-folders with their own grants | 2.4 | scope only — no case |

Features 2.2–2.4 have **zero QA cases** in this folder. They are in scope and must still be seeded;
the absence of cases is a gap in the test repository, not permission to skip the data.

### C. Everything else in scope

| # | Data | Scope | Notes |
|---|---|---|---|
| 8 | Files and folders in a **nested structure** | 1.1 | the baseline for every other row |
| 9 | Data sufficient for a **one-time** run | 1.2 | |
| 10 | Changes made *after* the one-time run — see the delta list below | 1.3 | no QA case; capability is new for this pair |
| 11 | A link with audience **Anyone with the link**, at viewer and at editor | 3.1 | expect identity — same audience, same role |
| 12 | A link with audience **restricted to the organisation**, at viewer and editor | 3.2 | **expect the destination org's name, not `Sync Orbit`** — see inscope 3.2 |
| 13 | Files with **distinct created and modified timestamps**, including a same-day time | 4.1 | figure 4.1.1 matches to the minute, not the day |
| 14 | Names containing **punctuation Google accepts** | 5.1 | expect **no replacement** — source and destination are the same platform |
| 15 | A **deeply nested path** (the figure uses `TEST01…TEST09`) | 7.1 | expect **no adjustment** — see inscope 7.1 |
| 16 | A document containing a **link to another file in the same migration set** | 8.1 | plus at least one link to a file **outside** the set, so a non-rewrite is distinguishable |
| 17 | A file with **many versions — more than five** | 9.1 / 9.2 | see the version note below |
| 18 | A job configured with **selective versions = 5** | 9.2 | the setting, not just the data |
| 19 | A collaboration that would normally **trigger an email notification** | 6.1 | plus mailbox access to prove the absence |

### D. Out-of-scope data — must be seeded, must not fail

The out-of-scope document describes six Google-native types. **Seeding must create them**, because
their documented behaviour is only observable if they exist:

| # | Data | Scope | Expected |
|---|---|---|---|
| 20 | A **Google Drawing** with visible content | out 2.1 | arrives as a Google **Doc with empty data** — container present, content gone |
| 21 | A **Google Vid** | out 3.1 | CONFLICT — non migratable |
| 22 | A **Google Form** | out 4.1 | CONFLICT — non migratable |
| 23 | A **Google My Map** | out 5.1 | CONFLICT — non migratable |
| 24 | A **Google Apps Script** | out 6.1 | CONFLICT — non migratable |
| 25 | A **Google Site** | out 7.1 | CONFLICT — non migratable |
| 26 | A file carrying **inline comments** | out 1.1 | ambiguous — see out-of-scope question 1 |

Item 20 is the one that needs care: the Drawing **survives as an object**, so an item-count check
passes while the content is lost. It has to be opened, not counted.

Items 21–25 are why a count-based check cannot be used naively on this pair at all. In the
out-of-scope figures the source lists 13 items and the destination 7 — a shortfall of six that is
entirely documented behaviour. Seed them deliberately so the validator is forced to handle it.

### For delta (item 10) the run must additionally be able to

- **rename** an item that already migrated
- **update the content** of an item that already migrated
- **add** a new item
- **move** an item between folders
- leave an item **unchanged**, and confirm it is not re-migrated

No QA case in this folder exercises delta. This list is carried from
`dropbox-to-google-testdata.md`, where 3,627 delta cases established the five change types. It is
reasonable to expect the same five apply, but **it is an inference from another combination**, not a
requirement this pair's cases or documents state.

---

## The version-count problem

In-scope 9.1 claims migration of **all** file versions. 9.2 says selecting five migrates the last
five. Both figures (9.1.1 and 9.2.1) show **the same file with only two versions** — `Current
version` plus `Version 1`.

A two-version file cannot demonstrate either claim: "all" is indistinguishable from "the last two",
and a selective count of five is indistinguishable from no selection at all. **Seed a file with at
least seven versions** so that:

- 9.1 can show all seven arriving, and
- 9.2 with `selectiveVersions = 5` can show exactly the last five, proving two were deliberately
  dropped rather than never created.

Google's own version retention (30 days / 100 versions unless *Keep forever* is set, per the Manage
versions dialog in both figures) means the seeded versions must be **pinned**, or the test data will
decay on its own.

---

## Open questions to resolve before writing the seeding

### 1. Is Commenter in scope?

Three of the nine QA cases grant **commenter** — internal, external and group. The in-scope document
never mentions the role and no figure shows it.

Google→Google means commenter exists identically on both sides, so identity mapping is the obvious
answer. But "obvious" is how a validator ends up asserting an undocumented rule. Either the scope
document should name the role, or the three commenter cases should be retired. Until then a validator
should report commenter results at INFO rather than failing them.

*Contrast:* on `box-to-google` and `dropbox-to-google` the question does not arise — neither source
platform has a commenter role at all.

### 2. Which principals get remapped?

Figure 2.3.1 shows one group remapped across tenants and another left on the source domain, in the
same screenshot. Both cannot be right as a general rule. Before seeding, establish whether:

- every principal in the CSV is remapped and `kalyan_test_group_2@filefuze.co` is a mapping gap; or
- principals absent from the CSV are deliberately granted as-is, cross-tenant.

The answer decides whether item 4 above seeds one group shape or two, and whether an unremapped
grantee is a pass or a defect.

### 3. Does 3.2 preserve the source org name or take the destination's?

The in-scope prose says `Sync Orbit` → `Sync Orbit`; figure 3.2.1 shows `Sync Orbit` → `cloudfuze.com`.
Seeding is unaffected either way — item 12 is the same data — but the **expected result** is not. Settle
it before the assertion is written, or the check will be written against a string that only holds in
the tenant the screenshots came from.

### 4. Are the Cloud Adding cases in scope for the agent at all?

The five `/Cloud Adding` cases test the connect-and-authorise flow: two credential types plus a Google
Marketplace install. None of the 17 in-scope features covers them, and they are not content. Decide
whether they are validated by this agent or belong to a separate connect-flow suite — otherwise they
sit in the repository permanently untested by anything.

---

## Coverage check against the scope documents

| Scope feature | QA cases | Data specified |
|---|---|---|
| 1.1 Data Migration | — | ✅ 8 |
| 1.2 One Time Migration | — | ✅ 9 |
| 1.3 Delta Migration | **0** | ⚠️ 10 — change types inferred from the Dropbox pair |
| 2.1 Root folder permissions | **9** | ✅ 1, 2, 3, 4 |
| 2.2 Root file permissions | **0** | ✅ 5 — scope-driven, no case exists |
| 2.3 Sub-folder permissions | **0** | ✅ 6 — scope-driven, no case exists |
| 2.4 Inner file permissions | **0** | ✅ 7 — scope-driven, no case exists |
| 2.5 External shares | 6 (via 2.1) | ✅ 2 — no standalone case |
| 3.1 Anyone with the link | **0** | ✅ 11 |
| 3.2 Org-restricted link | **0** | ⚠️ 12 — blocked on question 3 |
| 4.1 Metadata | **0** | ✅ 13 |
| 5.1 Special characters | **0** | ✅ 14 (expect no replacement) |
| 6.1 Suppress notifications | **0** | ⚠️ 19 — needs mailbox access, not Drive |
| 7.1 Long path | **0** | ✅ 15 (expect no adjustment) |
| 8.1 Embedded links | **0** | ✅ 16 |
| 9.1 Version history | **0** | ⚠️ 17 — needs > 5 versions, pinned |
| 9.2 Selective versions | **0** | ⚠️ 17, 18 |
| out 1.1 In-line comment | **0** | ⚠️ 26 — blocked on out-of-scope question 1 |
| out 2.1 Google Drawing | **0** | ✅ 20 — must be opened, not counted |
| out 3.1–7.1 five native types | **0** | ✅ 21–25 — expect CONFLICT |

**16 of 17 in-scope features have no QA case in this folder.** Every one still has data specified
here, driven by the scope document rather than by a case. That gap is the headline finding of this
analysis: the combination is documented far more thoroughly than it is tested.

No validator exists for this pair yet — `validation/combinations/content/` has no
`googledriveToGgoogledrive.js` and `validation/roleMaps/` has no Google→Google map.
