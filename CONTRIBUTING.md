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

`npm run lint` currently reports 2 pre-existing errors in
`agents/gmail/GmailTestDataAgent.js:1230` (`inboundSenders` / `toEmail` undefined) —
these are unrelated to the combination structure and predate this layout.
