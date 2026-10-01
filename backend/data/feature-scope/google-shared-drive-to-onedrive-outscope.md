# Migration Feature Documentation

**Product Type:** Content
**Combination:** Google Shared Drive → OneDrive for Business
**Scope:** Out of Scope
**Total Features:** 4
**Last Updated:** 2026-09-17
**Source:** `Content_ShareddrivetoOnedrive_(17-09-2026).pdf`

> Companion file: `google-shared-drive-to-onedrive-inscope.md` — the eight features this
> combination IS judged on.
>
> **What "out of scope" means here.** These four are not unsupported and not broken. The document
> simply does not make a promise about them for this combination, so a validation run must not fail
> on them. Observing them is useful and reporting what was observed is welcome; turning that
> observation into a defect is not.
>
> This matters because the same four ARE in scope for neighbouring combinations — versions and
> shared links are judged for `google-shared-drive-to-sharepoint`, timestamps and external shares
> for `dropbox-to-google`. Carrying a rule across from one of those would report a defect against a
> promise nobody made, which is the single most common way this project has produced a wrong
> verdict.

---

## 1. External shares (1 feature)

### 1.1 External shares
CloudFuze can migrate external permissions (Files/Folders shared with people of outside
organizations) of files/folders to the destination along with access levels.

**Out of scope for this combination.** A grant to an address outside the organisation is neither
required to arrive nor required to be absent. If the seeding creates one, report what happened to
it and move on.

---

## 2. Timestamps (1 feature)

### 2.1 Timestamps
Maintaining the original timestamps, including creation and modification dates and times, when
transferring data to the destination cloud.

**Out of scope for this combination.** Created and modified dates at the destination are not
compared, and drift is not a defect here. Note that a migration job still carries its own timestamp
options — a destination date that differs is the expected outcome when preservation was never
requested, and neither case is judged under this document.

---

## 3. SharedLinks (1 feature)

### 3.1 SharedLinks
CloudFuze migrates all shared links from source to destination and maintains the type of links.

**Out of scope for this combination.** Anonymous ("Anyone with the link") and organisation-scoped
links on the source are not required to appear at the destination. Report the observation; do not
fail it.

---

## 4. Versions (1 feature)

### 4.1 Versions
Migration of all file versions from source to destination.

**Out of scope for this combination.** Version counts are not compared. A destination file holding
one version where the source held nine is not a defect under this document.

This is worth flagging to the combination owner rather than assuming: version history IS judged for
`google-shared-drive-to-sharepoint`, and OneDrive runs on the same SharePoint Online storage, so the
capability plainly exists. If the intent was to judge versions here too, the in-scope document is
what needs changing — not the validator.
