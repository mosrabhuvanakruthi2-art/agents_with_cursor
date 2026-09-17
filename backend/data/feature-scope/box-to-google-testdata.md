# Test data specification — Box to Google My Drive

**Cross-referenced against:** `box-to-google-inscope.md` (34 features) and `box-to-google-outscope.md`.

> Why this file exists. The scope document says *what* must be validated. This says what
> `BoxToGoogledriveTestDataAgent` actually seeds to exercise it, one numbered row per scenario, so the
> agent's own code comments can point back here (`_seed*` methods name the row they implement) the
> same way `DropboxTestDataAgent` cross-references `dropbox-to-google-testdata.md`.

---

## Test data the seeding creates

| # | Data | Scope | Method |
|---|---|---|---|
| 1 | Root folder with user (editor) + group (viewer) grants | 2.1 | `_seedPermissionLadder` |
| 2 | Sub-folders at two depths, each with its own grant | 2.2 | `_seedPermissionLadder` |
| 3 | Root files, both access levels, user + group | 2.3 | `_seedPermissionLadder` |
| 4 | Inner files inside the sub-folders, their own grants | 2.4 | `_seedPermissionLadder` |
| 5 | A folder and a file shared with an address outside the enterprise | 2.5 | `_seedPermissionLadder` |
| 6 | Every Box collaboration role (editor/viewer/previewer/co-owner/uploader) against a user and a group, on a folder and a file | 2.1-2.5 breadth | `_seedPermissionMatrix` |
| 7 | Team-wide vs restricted access, via `BOX_TEST_ACCESS_MODE` | — | `_applyAccessMode` |
| 8 | Two files, each re-uploaded through 4 versions | 3.1 / 3.2 | `_seedVersions` |
| 9 | Files with distinct `content_created_at` **and** `content_modified_at` | 4.1 | `_seedTimestampFiles` |
| 10 | A file with an `access: 'open'` shared link | 5.1 | `_seedSharedLinks` |
| 11 | A file with an `access: 'company'` shared link | 5.2 | `_seedSharedLinks` |
| 12 | A file with a Box comment | 6.1 | `_seedInlineComment` |
| 13 | A 30-level-deep folder chain, with checkpoint files at levels 10/20/25/30 | 7.1 | `_seedLongPath` |
| 14 | A name containing characters Box allows | 8.1 | `_seedSpecialCharacterNames` |
| 15 | A document with a link to an in-scope target and one to an out-of-scope target | 9.1 | `_seedEmbeddedLinks` |
| 16 | A real Box Note, created via `POST /2.0/notes/convert` (Markdown: formatting, lists, a table, a shared-link image, emojis, a GIF, Unicode, links) plus a comment on it | 10.1, 10.2 (partial), 10.4, 10.5, 10.7, 10.10, 10.11, 10.12, 10.14, 10.15, 10.16 | `_seedBoxNotes` |
| 17 | Every collaboration seeded with `notify:false` | 11.1 | every `_grant` call (default `suppressNotify = true`) |
| 18 | Root files in every pass-through format + one legacy-Office conversion target | 1.1 | `_seedRootFiles` |

### For delta (scope 1.3) `applyDeltaChanges` additionally

- **adds** a new file in a dedicated `15-Delta` folder
- **updates the content** of `03-File-Formats/document.txt` (a new Box version)
- **renames** `03-File-Formats/data.csv` → `data-renamed-in-delta.csv`
- **moves** `03-File-Formats/feed.xml` into `15-Delta`
- leaves `03-File-Formats/config.json` **unchanged**, as the control

---

## Box Notes (scope 10.1-10.16) — real content, seeded via the actual Notes API

Item 16 is a **real Box Note**, not a placeholder. `BoxToGoogledriveTestDataAgent._seedBoxNotes` calls
`boxClient.createNote`, which hits Box's `POST /2.0/notes/convert` (Box API version 2026.0+, released
May 2026) — the direct equivalent of Dropbox's `files/paper/create`. It converts real Markdown into a
genuine `.boxnote` file in one call; no new OAuth scope is required beyond ordinary upload permission
on the target folder.

**This corrects an earlier, wrong assumption in this repo.** The original seeding code believed Box had
no public Notes-authoring API at all, and uploaded a hand-built JSON file with a `.boxnote` extension
through the generic file-upload endpoint instead. Confirmed live (2026-09-15) that Box does **not**
recognise a file created that way as an actual Note — it carries only the generic
`extracted_text`/`embedded_metadata` representations any ordinary file gets. The real endpoint was
found, tested live (schema corrected twice against the API's own error messages: `parent` must be
`{id, type: "folder"}`, not `parent_id`), and confirmed to produce a proper Note — a comment added to
it afterward via `boxClient.addComment` round-tripped through `GET /2.0/files/{id}/comments` correctly.

**What Markdown genuinely still cannot express** (5 items, not 15): a font size or colour choice, text
alignment, an `@mention` that resolves to a real user, a pasted clipboard image, and the specific
*method* used to insert an image — "uploaded from computer" (10.6) and "Insert Link Preview" (10.8) are
indistinguishable from an ordinary embedded image reference in Markdown. Only 10.7 ("Insert Image via
Box Shared Link") is represented faithfully, using a real `app.box.com/s/…` link to a file already
seeded earlier in the same run (`03-File-Formats/photo.jpg`). These five remain manual — `_seedBoxNotes`
still prints authoring steps for them, now much shorter.

**10.14 (Box Notes Comments)** is seeded too, but separately from the Markdown import: a comment is its
own Box object (`POST /2.0/comments`), not part of a file's content, so it's added via `addComment`
right after the Note is created — the same call `_seedInlineComment` already uses for scope 6.1.

**Still open:** Box has no public *export* endpoint for a Note's content (only the new *import*
direction exists), so the validator still cannot do a structural "N tables in, N tables out" comparison
the way `dropboxToGoogledrive.js`'s `paperMarkdownStructure`/`googleDocStructure` pair does for Paper.
10.1 (does the Note arrive at all) is asserted automatically; 10.2, 10.4, 10.5, 10.10, 10.11, 10.12,
10.15, 10.16 now have real seeded content to check by hand against the migrated file, which is a much
smaller ask than authoring a Note from scratch.

---

## Coverage check against the scope document

| Scope feature | Data specified |
|---|---|
| 1.1 Data Migration | ✅ items 1-18 (whole tree) |
| 1.2 One Time | ✅ (no job-setting data needed) |
| 1.3 Delta | ✅ `applyDeltaChanges` |
| 2.1-2.5 Permissions | ✅ items 1-6 |
| 3.1-3.2 Versions | ✅ item 8 |
| 4.1 Meta Data | ✅ item 9 |
| 5.1-5.2 Shared Links | ✅ items 10-11 |
| 6.1 In-Line Comment | ✅ item 12 |
| 7.1 Long Path | ✅ item 13 |
| 8.1 Special Characters | ✅ item 14 |
| 9.1 Embedded Links | ✅ item 15 |
| 10.1 Box Notes Migration | ✅ item 16 — real Box Note, asserted automatically |
| 10.2, 10.4, 10.5, 10.7, 10.10-10.12, 10.14-10.16 | ✅ item 16 — real content seeded, checked by hand (no export API to automate the comparison) |
| 10.3, 10.6, 10.8, 10.9, 10.13 | ❌ cannot be seeded by API (no Markdown syntax for these) — manual steps only |
| 11.1 Suppress Notifications | ✅ item 17 (source half only — destination half needs Gmail scope, see `GoogleDriveValidationAgent.findSharingNotifications`) |

Every in-scope feature has seeding data specified except five Box Note elements Markdown cannot
express (10.3, 10.6, 10.8, 10.9, 10.13), which are a documented platform/format limitation rather than
an effort gap.
