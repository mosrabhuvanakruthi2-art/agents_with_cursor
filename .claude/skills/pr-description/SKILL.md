# PR Description Skill — Migration QA Agent System

## When This Skill Activates

When the user says "generate a PR description", "write the PR body", or "create a pull request description" for staged or committed changes.

## Step 1 — Read the Diff

```bash
git diff main...HEAD        # all commits on this branch vs main
git diff --cached           # staged-only (if not yet committed)
```

If a PR number is given: `gh pr diff <number>`

## Step 2 — Classify the Change

Identify which files changed and their categories:

| Changed path | Category |
|---|---|
| `backend/src/agents/` | Agent change |
| `backend/src/clients/` | Client / external API change |
| `backend/src/validation/` | Validation logic change |
| `backend/src/utils/mailMigrationComparator.js` | Tier A/B/C comparison change |
| `backend/src/utils/pdfGenerator.js` | PDF report change |
| `backend/src/utils/logger.js` | Logging change |
| `backend/src/routes/` or `backend/src/controllers/` | API endpoint change |
| `backend/src/orchestrator/` | Orchestration / flow change |
| `backend/data/*.xlsx` | Test data change |
| `frontend/src/` | Frontend change |
| `.claude/` | Claude configuration change |

## Step 3 — Write the PR Description

Use this template, filling only the sections that apply to the actual diff:

---

```markdown
## Summary

- [One-line description of what changed and why]
- [Second bullet if the change has multiple independent parts]
- [Third bullet only if needed — keep it short]

## Migration Route(s) Affected

<!-- Delete rows that don't apply -->
| Route | Affected |
|-------|---------|
| Gmail → Outlook | [yes / no / modified behavior] |
| Outlook → Gmail | [yes / no / modified behavior] |
| Gmail → Gmail | [yes / no / modified behavior] |
| Outlook → Outlook | [yes / no / modified behavior] |

## Phase(s) Affected

<!-- Delete rows that don't apply -->
| Phase | Agent | Impact |
|-------|-------|--------|
| Phase 0 — Cleanup | CleanupAgent | [unchanged / modified / new behavior] |
| Phase 1 — Seed | GmailTestDataAgent / OutlookTestDataAgent | [unchanged / ...] |
| Phase 2 — Migrate | MigrationAgent | [unchanged / ...] |
| Phase 3 — Validate | OutlookValidationAgent / GmailValidationAgent / GtGValidationAgent | [unchanged / ...] |

## Validation Tier Changes

<!-- Include only if mailMigrationComparator.js or deepMailValidator.js changed -->
- Tier A (headers/envelope): [unchanged / new check added / severity changed]
- Tier B (attachment hashes): [unchanged / ...]
- Tier C (body text): [unchanged / ...]

## New Environment Variables

<!-- Include only if new env vars are required -->
| Variable | Default | Required |
|----------|---------|----------|
| `NEW_VAR_NAME` | `default_value` | No |

## Test Plan

- [ ] Run SMOKE test on [route] — confirm Phase 0–3 complete without error
- [ ] Run SANITY test on [route] — confirm PDF generated, no unexpected mismatches
- [ ] Run E2E test on [route] — confirm calendar/contacts included if applicable
- [ ] Confirm `GET /api/health` returns 200 after server restart
- [ ] [Any route-specific or tier-specific check relevant to this change]

## Sensitive Files Check

- [ ] `.env` not staged
- [ ] `backend/data/oauth-tokens.json` not staged
- [ ] `backend/data/executions.json` not staged
```

---

## Commit Message Convention

Single-line, lowercase, no period:
```
feat: add Tier B hash validation for Outlook→Gmail route
fix: restore SMTP folder mapping for custom labels
refactor: extract deepMailValidator pairing logic into shared util
docs: update AGENTS.md with GmailValidationAgent groups section
```

Observed types from git log: `feat`, `fix`, `merge`, `refactor`, `docs`, `test`
