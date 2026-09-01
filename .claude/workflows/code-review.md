# Code Review Workflow — Migration QA Agent System

## When to Use This Workflow

Use when reviewing a PR or a set of changed files in this codebase. This workflow ensures the review covers migration-route correctness, agent pattern compliance, API safety, and test coverage.

---

## Step 1 — Get the Diff

```bash
# For a branch under review
git diff main...HEAD

# For a specific PR
gh pr diff <number>

# For staged changes not yet committed
git diff --cached
```

Identify which directories contain changes:

| Changed path | Review focus |
|---|---|
| `backend/src/agents/` | BaseAgent pattern, phase impact, context field correctness |
| `backend/src/validation/deepMailValidator.js` | Pairing logic, tier dispatch, env var defaults |
| `backend/src/utils/mailMigrationComparator.js` | Tier A/B/C logic, severity correctness, normalization |
| `backend/src/clients/` | Auth flow, retry behavior, throttle handling |
| `backend/src/orchestrator/` | Phase order, parallel vs. sequential, bulk error isolation |
| `backend/src/utils/pdfGenerator.js` | Report sections, executionId path safety |
| `backend/src/routes/`, `backend/src/controllers/` | 202 pattern, error format, execution polling |
| `frontend/src/` | API call shape, polling interval, error display |

---

## Step 2 — Read Files in Full

For each changed file, read the full file (not just the diff). Context around changed lines frequently reveals bugs that diff-only review misses.

Pay particular attention to:
- Changed functions that are called from multiple agents — a signature or behavior change may break callers not in the diff
- Modified env var defaults — a changed `|| false` to `|| true` changes behavior for all deployments
- Modified retry logic — changes to `retryWithBackoff` calls may affect all external API calls

---

## Step 3 — Apply Review Checklist

### For any agent file (`backend/src/agents/`)

```
[ ] Extends BaseAgent (not a plain class)
[ ] super('ClassName') string matches the class name exactly
[ ] execute(context) implemented — run() not overridden
[ ] Child logger: logger.child({ agent: this.name, executionId: context.executionId })
[ ] Returns plain object from execute() — not this, not a class instance
[ ] Cleanup paths catch-and-warn; critical paths re-throw
[ ] Correct calendar gating for this route:
    - Outlook validation: testType === 'E2E' only
    - Gmail/GtG validation: testType === 'E2E' || testType === 'DELTA'
[ ] Correct contacts gating: testType === 'E2E' || testType === 'DELTA'
[ ] Validation agent calls pdfGenerator.generatePdf() before returning
[ ] Validation agent calls agentBrain.analyzeFailure() when overallStatus === 'FAIL'
[ ] No hardcoded email addresses or credentials
[ ] createExecutionLogger cleanup called in finally block (if used)
```

### For comparison utilities (`mailMigrationComparator.js`, `deepMailValidator.js`)

```
[ ] Severity levels are intentional: 'error' (blocks PASS), 'warning' (degrades to WARN), 'info' (doesn't affect status)
[ ] knownLimitation field is only set by cloudfuzeDocsClient.classifyMismatches() — never hardcoded
[ ] Env var defaults match documented behavior in testing-standard.md
[ ] Body normalization (Tier C) handles both HTML and plain text input
[ ] Attachment size comparison accounts for base64 encoding overhead (~33-45% larger on destination)
[ ] Message pairing fallback (subject+time window) is guarded by DEEP_VALIDATION_SUBJECT_TIME_FALLBACK env var
[ ] System folders correctly excluded from scan (Drafts, Outbox, Conversation History, Sync Issues, etc.)
```

### For API clients (`backend/src/clients/`)

```
[ ] retryWithBackoff used for all external API calls — not a raw setTimeout loop
[ ] 429 Retry-After header is respected (retryWithBackoff handles this automatically)
[ ] Auth tokens are not logged (not passed to log.info/warn/error)
[ ] New env vars are in env.js and backend/.env.example
[ ] Error messages don't expose credential values in the thrown error.message
```

### For routes and controllers

```
[ ] New run endpoints use the 202 fire-and-forget pattern (setImmediate + res.status(202))
[ ] Error responses use format: { error: 'message string' } (no extra fields)
[ ] HTTP 400 for missing required fields, 404 for not-found, 500 for unhandled
[ ] executionService.create() and executionService.update() called correctly
[ ] No synchronous blocking work between res.status(202) and setImmediate
```

### For orchestrator changes

```
[ ] Bulk Phase 0 and Phase 3 remain parallel (Promise.all) — do NOT make sequential
[ ] Bulk Phase 1 (seeding) remains sequential (for..of) — do NOT make parallel (Gmail API rate-limit constraint)
[ ] Bulk Phase 2 remains sequential (for..of) — do NOT make parallel (CloudFuze API constraint)
[ ] Individual pair errors in bulk are caught inside the async callback — one failure must not abort others
[ ] Agent selection by provider combination is correct:
    - sourceProvider=google, destProvider=microsoft → OutlookValidationAgent
    - sourceProvider=microsoft, destProvider=google → GmailValidationAgent
    - sourceProvider=google, destProvider=google → GmailToGmailValidationAgent
```

---

## Step 4 — Security Scan

Run the security-reviewer checklist from `.claude/agents/security-reviewer.md`:
- Hardcoded credentials
- MongoDB query injection
- OAuth token in logs
- SSRF in migrationServerUrl
- Path traversal via executionId

---

## Step 5 — Output the Review

Group findings by severity. For each finding include:
- **File and line number**
- **What the issue is** — one sentence
- **Why it matters** — what breaks and when
- **Suggested fix** — one sentence

End with a summary: `N blocker(s), N warning(s), N suggestion(s)`. Label blockers as things that must be fixed before merge; warnings and suggestions are optional.

If no issues found: state explicitly that the checklist passed and nothing was found — do not omit the result.
