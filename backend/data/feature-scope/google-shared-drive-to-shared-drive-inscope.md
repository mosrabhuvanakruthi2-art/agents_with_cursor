# Migration Feature Documentation

**Product Type:** Content  **Combination:** Shared Drive to Shared Drive  **Scope:** In Scope
**Total Features:** 19

Source of record: `Content_SharedDrivetoSharedDrive_(12-09-2026).docx`. Transcribed here so the
validator and the reviewer read the same numbering — the checklist in
`validation/combinations/content/googleshareddriveToGoogleshareddrive.js` uses these ids verbatim.

Read together with `google-shared-drive-to-shared-drive-outscope.md`. An out-of-scope behaviour is
reported as INFO and **must never fail a run**.

| Id | Feature | How this suite answers it |
|---|---|---|
| 1.1 | Onetime | the structure comparison, under a FULL run |
| 1.2 | Delta | the structure comparison, under a DELTA run |
| 2.1 | Preserving File/Folder structure | Tier A tree comparison |
| 3.1 | Root Folder Permissions | Tier C, grants on a folder at the source root |
| 3.2 | Root File Permissions | Tier C, grants on a file at the source root |
| 3.3 | Sub-folder permissions | Tier C, grants on a folder below the root |
| 3.4 | Inner File Permissions | Tier C, grants on a file below the root |
| 3.5 | External Shares | Tier C, by principal — an address outside the source domain |
| 3.6 | Group Permissions | Tier C, by principal — grants whose type is `group` |
| 4.1 | Metadata | created/modified timestamps within the drift band |
| 5.1 | Version History | history PRESENT at the destination |
| 5.2 | Selective Versions | only assessable when the job requests a version count |
| 6.1 | Special Characters Replacement | negative test — Google replaces nothing |
| 7.1 | Long-File/folder path | negative test — Google imposes no path limit |
| 8.1 | Suppress email notifications | NOT VERIFIED from the Google side (see below) |
| 9.1 | Embedded Links | link targets inside the migrated file, plus the generated CSV |
| 10.1 | Shared Links | link scope **and** type compared, per item |
| 11.1 | In Line comment | the comments CSV CloudFuze writes into the destination |
| 12.1 | Folder Display | the run's own mapping — source and destination folders resolved by name |

## What makes this pair different

Both clouds are the **same platform**, and both roots are **Shared Drives**.

- **Nothing converts, nothing is renamed, nothing is relocated.** Features 6.1 and 7.1 are therefore
  *negative* tests: they pass when the destination did **nothing**. A destination that replaced a
  character or truncated a path is the failure, not the pass.
- **Roles translate one-to-one** (`validation/roleMaps/google_to_google.js`), so a role difference is
  a real difference and never a vocabulary gap. Shared Drives add `organizer` and `fileOrganizer`
  (Manager / Content manager), which My Drive has no equivalent for.
- **Every item inherits the drive's own grant.** So "does this item have zero grants" is never true
  at a Shared Drive destination, and the permission check asks whether a **direct** grant exists
  instead. Accepting the inherited drive grant as a match would pass every permission check
  automatically.
- **Both sides are read through the same code** — the inherited `GoogleDriveValidationAgent`
  readers serve the source and the destination, so the two cannot drift apart in what they believe
  a permission, a revision or a link is.

## Features that cannot be fully answered here

**8.1 Suppress email notifications** — the feature says the destination must not send collaboration
mail. Nothing on the Google side records whether a notification was suppressed; only the recipient's
mailbox would show it. The run sets `notifyInternalUsers=false` / `notifyExternalUsers=false` on the
job and reports the feature as **NOT VERIFIED**, never as a pass.

**5.2 Selective Versions** — only meaningful when the job asks for a specific number of versions.
When it does not, the feature reports *not exercised* rather than passing on a full history.

**11.1 In Line comment** — the in-scope document says comments are preserved "in the CSV formatted
file in the destination", while the out-of-scope document says comments are migrated and preserved
*in the destination*. These two statements conflict. This suite takes the in-scope reading: it looks
for the comments **CSV** CloudFuze writes into the destination, and reports the absence of native
re-created comments as the documented out-of-scope limitation. If the intended behaviour is native
comments, this check needs revisiting — flag it rather than changing the verdict quietly.

**12.1 Folder Display** — this is a CloudFuze web-app affordance (picking folders visually to build
the mapping). A headless run cannot exercise the picker; what it *can* confirm is the outcome the
picker exists to produce — that the named source and destination folders resolved and the pair
migrated. Reported on that basis, with the limitation stated.

## Open question — Manager (`organizer`) grants are not compared

`validation/roleMaps/google_to_google.js` excludes `organizer` from comparison alongside `owner`,
because the migrating account owns its own copy of every item and its own grant cannot be asserted.
That reasoning was written for **My Drive**, where `organizer` really is ownership.

On a **Shared Drive** it is weaker: `organizer` is *Manager*, a real role that several members can
hold and that CloudFuze migrates. Excluding it means a Manager grant is reported under
"not comparable" — visible, with its reason, but not asserted either way.

This is left as the current behaviour deliberately rather than changed on reasoning alone, because
the change would also affect the My Drive pair that shares the map, and because the drive creator's
own grant would then be compared and could fail on a principal that legitimately has no counterpart.
**Settle it on the first live run**: if the report shows Manager grants under "not comparable" that
should have been checked, add a dedicated role map for this pair (a new file in
`validation/roleMaps/`) rather than editing the shared one. `backend/test/
googleshareddriveToGoogleshareddrive.test.js` pins the current behaviour, so the change cannot be
made silently.
