# Bug Fix Workflow — Migration QA Agent System

## When to Use This Workflow

Use when a migration run reports `FAIL` in the validation result, or when an agent throws an unexpected error. This workflow guides you through diagnosis to fix without re-running the full pipeline unnecessarily.

---

## Step 1 — Locate the Execution

Find the failing execution:

```bash
# List recent executions (newest first)
curl http://localhost:5000/api/agents/executions | jq '.[0:5] | .[] | {id: .executionId, status: .status, currentAgent: .currentAgent}'

# Get full details of a specific execution
curl http://localhost:5000/api/agents/executions/<executionId> | jq .
```

Or check the log file directly:
```bash
ls backend/logs/<executionId>.log
cat backend/logs/<executionId>.log | grep -E '"level":"error"'
```

---

## Step 2 — Identify Which Phase Failed

Check `result.agentResults` to find the failing agent:

```json
{
  "agentResults": [
    { "name": "GmailTestDataAgent", "status": "SUCCESS" },
    { "name": "MigrationAgent",     "status": "SUCCESS" },
    { "name": "OutlookValidationAgent", "status": "FAILED", "error": "..." }
  ]
}
```

| Failed agent | Phase | Common causes |
|---|---|---|
| `CleanupAgent` | Phase 0 | OAuth token expired, mailbox permission error. Non-blocking — check `errors[]` in result, not the agent status |
| `GmailTestDataAgent` | Phase 1 | Gmail API quota, invalid label name, refresh token expired |
| `OutlookTestDataAgent` | Phase 1 | Graph API throttle (429), EWS fallback failed, folder creation limit |
| `MigrationAgent` | Phase 2 | CloudFuze auth failed, job stuck at `IN_PROGRESS`, `PROCESSED_WITH_CONFLICTS` (see note) |
| `*ValidationAgent` | Phase 3 | Source/destination count mismatch, deep-validation Tier A/B/C failure |

**`PROCESSED_WITH_CONFLICTS` note:** MigrationAgent.js:489 has a TODO — auto-retry delta is disabled. When the job status is `PROCESSED_WITH_CONFLICTS`, the migration partially completed. You must manually decide: re-run from Phase 2 (`skipCleanup: true, skipTestData: true`) or investigate which messages were not migrated via the CloudFuze dashboard.

---

## Step 3 — Classify the Failure Type

### Type A: Infra / auth failure
Signs: `401 Unauthorized`, `403 Forbidden`, `Token expired`, `invalid_grant`  
Fix: Re-authenticate. For Gmail: rotate the refresh token in `backend/data/oauth-tokens.json` via `POST /api/auth/gmail/connect`. For Outlook: verify `GRAPH_CLIENT_SECRET` in `.env` has not expired (Azure App Registration).

### Type B: Migration did not complete
Signs: `finalStatus: 'TIMEOUT'` or `finalStatus: 'CANCELLED'` in MigrationAgent result  
Fix: Check CloudFuze dashboard for the job ID. If the job is still running on the server, wait and resume via `POST /api/agents/executions/:id/resume`. If cancelled by CloudFuze, re-run Phase 2 only with `skipCleanup: true, skipTestData: true`.

### Type C: Validation mismatch — messages not found
Signs: `deepMailValidation.unmatchedSourceIds` is non-empty; or `deepMailValidation.pairedCount` is less than `deepMailValidation.scannedSourceMessages`
Fix path:
1. Check that `DEEP_VALIDATION_SUBJECT_PREFIX` matches the test email subjects (default `'QA '`)
2. Check `deepMailValidation.pairedCount` — if 0, pairing is completely failing. The `internetMessageId` header may not be preserved across the migration.
3. Check if the migration job reports `processedCount < totalCount` — partial migration

### Type D: Validation mismatch — field mismatch
Signs: `deepMailValidation.messageResults` contains entries where `pass: false`; inspect each entry's `diffs[]` array for failing fields
Fix path:
1. Identify which `field` is failing in `diffs[].field`: `subject`, `from`, `to`, `body`, `attachmentHash:<filename>`
2. Check `bugStatus: 'known_limitation'` on the `messageResults` entry — set by `cloudfuzeDocsClient.classifyMismatches()` for documented CloudFuze behavior
3. Check `aiAnalysis.rootCause` for the OpenAI gpt-4o classification
4. For Tier C body mismatches: compare `expected` vs `actual` in the failing diff object

---

## Step 4 — Fix Strategy

### Fix for Type A (auth)
1. Read `backend/src/config/env.js` to confirm the env var name
2. Verify the current value: `node -e "require('./backend/src/config/env'); console.log(process.env.GOOGLE_CLIENT_ID)"` (from project root)
3. Rotate credentials in `.env` and restart the server

### Fix for Type C/D (validation logic bug)
1. Locate the relevant comparison function in `backend/src/utils/mailMigrationComparator.js`
2. The Tier → function mapping:
   - Tier A: `compareTierA()` — lines around subject/from/to normalization
   - Tier B: `compareTierBHashes()` — SHA-256 comparison
   - Tier C: `compareTierC()` — `htmlToPlainLoose()` + `normalizeMailBodyPlain()`
3. Add a `log.info('DIAG', { sourceValue, destValue })` trace before the comparison, re-run, check logs
4. Fix the normalization function and remove the trace

### Fix for a new mapping gap
If a label or folder is not being mapped correctly:
- Gmail→Outlook: `GMAIL_SYSTEM_LABEL_TO_OUTLOOK_FOLDER` in `mailMigrationComparator.js`
- Outlook→Gmail: `OUTLOOK_FOLDER_TO_GMAIL_LABEL` in `backend/src/validation/shared/deepMailCore.js`

---

## Step 5 — Verify the Fix

After the fix, re-run only Phase 3 (validation) without re-migrating:

```bash
curl -X POST http://localhost:5000/api/agents/run \
  -H 'Content-Type: application/json' \
  -d '{
    "sourceEmail": "source@example.com",
    "destinationEmail": "dest@example.com",
    "sourceProvider": "google",
    "destinationProvider": "microsoft",
    "migrationType": "FULL",
    "testType": "SANITY",
    "skipCleanup": true,
    "skipTestData": true,
    "skipMigration": true
  }'
```

Poll the new execution until `status: 'COMPLETED'`, then confirm `validationSummary.overallStatus === 'PASS'`.
