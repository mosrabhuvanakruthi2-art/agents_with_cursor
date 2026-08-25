# Contributing — working on migration combinations without conflicts

This project validates migrations across four combinations:

| Combination | source → destination |
|-------------|----------------------|
| Gmail → Outlook | `google` → `microsoft` |
| Outlook → Gmail | `microsoft` → `google` |
| Gmail → Gmail | `google` → `google` |
| Outlook → Outlook | `microsoft` → `microsoft` |

The code is structured so that **one combination = its own files**. If you work on
one combination and a teammate works on another, you edit different files and do
not get merge conflicts.

## Where each combination lives

```
backend/src/
  orchestrator/
    agentRegistry.js          # maps (domain, src, dst) → agent set; auto-loads combinations/
    combinations/             # ← which agents run, per combination (ONE FILE EACH)
      gmailToOutlook.js
      outlookToGmail.js
      gmailToGmail.js
      outlookToOutlook.js
    AgentOrchestrator.js      # generic pipeline — does NOT know combinations

  validation/
    index.js                  # dispatcher → routes to the per-combination validator
    combinations/             # ← deep mail validation logic, per combination (ONE FILE EACH)
      gmailToOutlook.js
      outlookToGmail.js
      gmailToGmail.js
      outlookToOutlook.js
    shared/deepMailCore.js    # helpers used by every combination (Tier A/B/C, pairing, links, …)
    deepMailValidator.js      # thin re-export shim (kept so existing imports still work)

  utils/
    mailTolerance/            # ← size tolerance bands, per combination (ONE FILE EACH)
      gmailToOutlook.js
      outlookToGmail.js
      gmailToGmail.js
      outlookToOutlook.js
      index.js                # auto-assembles the lookup
    mailMigrationComparator.js
```

## Rules (these keep the tree conflict-free)

1. **Edit only your combination's files.** To change Gmail→Outlook behavior, touch
   only `*/combinations/gmailToOutlook.js` (and `mailTolerance/gmailToOutlook.js`).
   Do not edit other combinations' files in your PR.
2. **`shared/` is a shared contract.** Changing a helper in
   `validation/shared/deepMailCore.js` affects every combination — keep those edits
   small and get a review, because that file *can* cause conflicts.
3. **Adding a new combination = add new files, edit no central list.** Drop a file in
   each `combinations/` folder (and `mailTolerance/`); the registries auto-load by
   scanning the folder. Nothing central needs editing.
4. **Branch per combination**, e.g. `feat/gmail-to-outlook-…`, and rebase before pushing.
5. **Line endings are LF** (enforced by `.gitattributes` + `.editorconfig`) so Windows
   and other machines don't produce whitespace-only conflicts.

## Before you push

```bash
cd backend
npm test          # unit tests (comparator + accounts picker)
npm run lint      # ESLint — no-undef catches a helper you forgot to import
```

`npm run lint` is clean — 0 errors, with `no-unused-vars` warnings only. If your change introduces an
error, it is yours to fix.

---

## Content combinations follow the same rules

The layout above describes mail. **Content** (files/folders) is organised identically, and is equally
load-bearing — the same one-combination-one-file rule applies:

```
backend/src/
  orchestrator/combinations/content/     # which agents run, per combination (ONE FILE EACH)
    boxToSharepoint.js
    googledriveToSharepoint.js
    googleshareddriveToSharepoint.js     # the run wizard sends 'googleshareddrive' separately
    …
  validation/combinations/content/       # the comparison logic, per combination (ONE FILE EACH)
    boxToSharepoint.js
    googledriveToSharepoint.js
  validation/shared/
    deepContentCore.js                   # shared: tree pairing, rename/path rules, the three tiers
    contentFunctionalityChecklist.js     # per-feature pass/fail/na rollup
  agents/sharepoint/
    SharePointValidationAgent.js         # DESTINATION-side agent, shared by every SharePoint combo
  utils/contentTolerance/                # size/timestamp/path bands, per combination (ONE FILE EACH)
    googledriveToSharepoint.js
    index.js                             # auto-assembles the lookup
```

Two extra rules specific to content:

1. **A combination validates deeply only if it opts in** with `static supportsDeepValidation = true`.
   Without it the orchestrator falls back to `ContentReportValidationAgent`, which compares **nothing** —
   it echoes CloudFuze's own report. A report-only result is a placeholder, never a pass.
2. **Read the feature scope before changing a validator.**
   `backend/data/feature-scope/<combination>-inscope.md` lists what must be validated;
   `-outscope.md` lists documented platform limitations that must be reported as INFO and **must never
   fail a run** (e.g. the Google API merges file revisions, so version counts cannot match).

Destination-side behaviour — how SharePoint is read, how a migrated folder is located through renames
and dedup counters — belongs in `agents/sharepoint/SharePointValidationAgent.js`, not copied into each
combination. Source-side behaviour (the cloud's roles, mime types, root resolution) stays in the
combination file.
