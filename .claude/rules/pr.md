# PR Standards — Migration QA Agent System

## Files That Must Never Appear in a PR

The pre-commit hook (`validate-code.sh`) and `block-sensitive-writes.sh` enforce these. Verify manually before opening a PR.

| File | Reason |
|------|--------|
| `.env` | Contains credentials — gitignored; use `.env.example` for templates |
| `backend/data/oauth-tokens.json` | Live OAuth tokens — managed by `oauthTokenStore.js` |
| `backend/data/executions.json` | Runtime execution state — managed by `executionService.js` |
| `backend/data/*.json` (any) | Runtime state in `backend/data/` is never committed |
| `CLAUDE.local.md` | Machine-specific overrides — gitignored |
| `.claude/settings.local.json` | Local override settings — gitignored |

Run `git status` and inspect any `backend/data/` or token-related files before staging.

---

## Required Checks Before Opening a PR

1. **No staged secrets:** `git diff --cached --name-only` must not show `.env` or any token file.

2. **ESLint:** Backend has ESLint configured (`eslint ^9.39.4` is in `package.json` devDependencies). Run `npx eslint backend/src/ --quiet` and confirm zero errors.

3. **Agent files extend BaseAgent:** Any new file in `backend/src/agents/` must `require('../core/BaseAgent')` and call `super('ClassName')`. The `validate-code.sh` PostToolUse hook warns when this check fails.

4. **No hardcoded credentials:** Search the diff for string literals that look like API keys, tokens, or passwords (`grep -E "(password|secret|token|api_key)\s*[:=]\s*['\"][^'\"]{8,}" -- *.js`).

5. **Manual smoke test:** Run `npm start` in `backend/`, confirm `Server running on port 5000` and `MongoDB: connected` appear (or `MongoDB: MONGODB_URI not set — skipping` if no local DB).

---

## Describing Changes by File Type

### Agent changes (`backend/src/agents/`)
Include in PR description:
- Which agent changed (`CleanupAgent`, `MigrationAgent`, etc.)
- Which execution phase is affected (Phase 0/1/2/3)
- Which migration route(s) are affected (`G→O`, `O→G`, `G→G`, `O→O`)
- Whether context fields read or written by the agent changed
- Whether the `ValidationResult` shape changed (affects PDF generator and Neutara/Jira tickets)

### Client changes (`backend/src/clients/`)
Include in PR description:
- Which external API the client wraps (Gmail, Graph, CloudFuze migration server, Neutara, Jira, Xray)
- Which endpoints are added, changed, or removed
- Whether retry behavior or auth flow is affected
- Any new environment variables required

### Route / controller changes (`backend/src/routes/`, `backend/src/controllers/`)
Include in PR description:
- What endpoints are added, changed, or removed
- Request/response shape changes
- Whether frontend polling (`GET /executions/:id`) is affected
- Whether the 202 fire-and-forget pattern is preserved for new run endpoints

### Utility changes (`backend/src/utils/`)
- `mailMigrationComparator.js`: note which Tier (A/B/C) is affected and whether severity levels changed
- `pdfGenerator.js`: note which report sections are affected
- `logger.js`: note if `maskEmail()` or `createExecutionLogger()` behavior changes

---

## Branch Naming Convention

Based on observed commit history:
```
feat/<short-description>       — new feature or capability
fix/<short-description>        — bug fix
refactor/<short-description>   — refactoring without behavior change
docs/<short-description>       — documentation only
test/<short-description>       — test data or validation logic changes
```

Examples from git log:
- `feat/gmail-to-gmail-validation`
- `feat/outlook-to-outlook-migration`
- `fix/devemail-legacy-server`
- `feat/docs-sync-controller`
