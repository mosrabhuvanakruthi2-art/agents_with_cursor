# QA Run Workflow

## Triggering a Single Run (API)

```http
POST http://localhost:5000/api/agents/run
Content-Type: application/json

{
  "sourceEmail":        "source@yourdomain.com",
  "destinationEmail":   "dest@yourdomain.com",
  "sourceProvider":     "google",          // "google" | "microsoft"
  "destinationProvider": "microsoft",      // "google" | "microsoft"
  "migrationType":      "FULL",            // "FULL" | "DELTA"
  "testType":           "E2E",             // "SMOKE" | "SANITY" | "E2E"
  "includeMail":        true,
  "includeCalendar":    false,
  "includeContacts":    false,
  "userEmailMappings":  [
    { "sourceEmail": "source@yourdomain.com", "destinationEmail": "dest@yourdomain.com" }
  ],
  "sourceAdminEmail":   "",
  "destAdminEmail":     ""
}
```

**Response (202):**
```json
{
  "executionId": "<uuid>",
  "status": "RUNNING",
  "message": "Execution started. Poll GET /api/agents/executions/:id or open Execution Logs to watch progress.",
  "context": { ... }
}
```

The run executes in the background via `setImmediate(() => orchestrator.runFullFlow(context))`.

## Triggering a Bulk Run (API)

```http
POST http://localhost:5000/api/agents/run
Content-Type: application/json

{
  "mappedPairs": [
    { "sourceEmail": "alice@src.com", "destinationEmail": "alice@dst.com", "sourceProvider": "google", "destinationProvider": "microsoft" },
    { "sourceEmail": "bob@src.com",   "destinationEmail": "bob@dst.com",   "sourceProvider": "google", "destinationProvider": "microsoft" }
  ],
  "migrationType": "FULL",
  "testType": "E2E",
  "includeMail": true
}
```

Bulk runs are **fire-and-forget** — they return 202 immediately with `{ bulk: true, executionId, totalPairs, executionIds, status: 'RUNNING', message }`. Poll each individual `executionId` via `GET /api/agents/executions/:id`.

## Polling for Status

```http
GET http://localhost:5000/api/agents/executions/<executionId>
```

Poll until `status` is one of: `COMPLETED`, `FAILED`, `CANCELLED`, `INTERRUPTED`.

Key fields in the response:
- `status` — current state
- `currentAgent` — e.g. `"MigrationAgent"`
- `progress` — human-readable step description, updated throughout
- `result.validationSummary.overallStatus` — `"PASS"` or `"FAIL"` (after completion)
- `result.validationSummary.mismatches` — array of mismatch objects (top-level field on ValidationResult)

Frontend polling interval: **3 seconds** (`executionStore.js`)

## Checking Logs

```http
GET http://localhost:5000/api/agents/executions/<executionId>/logs
→ { "executionId": "...", "logs": [ { "level": "info", "message": "...", "timestamp": "...", "agent": "...", "executionId": "..." } ] }
```

Log file on disk: `backend/logs/<executionId>.log`

## Downloading the PDF Report

```http
GET http://localhost:5000/api/agents/executions/<executionId>/pdf
→ PDF blob (Content-Disposition: attachment; filename="validation-report-<id>.pdf")
```

## Cancelling a Running Execution

```http
POST http://localhost:5000/api/agents/executions/<executionId>/cancel
```

Cancellation is cooperative — agents check `executionService.isCancelled(executionId)` at safe polling points.

## Resuming an INTERRUPTED Execution

```http
POST http://localhost:5000/api/agents/executions/<executionId>/resume
```

`resumeFlow()` reads the stored `agentResults` to determine which phases completed, injects `skipCleanup/skipTestData/skipMigration` flags, then re-calls `runFullFlow()`.

## Orchestrator Method Signatures

```js
// backend/src/orchestrator/AgentOrchestrator.js  (singleton)
const orchestrator = require('./src/orchestrator/AgentOrchestrator');

// Single pair (fire-and-forget from controller)
const result = await orchestrator.runFullFlow(contextOrContextData);
// Success path → { executionId, status: 'COMPLETED', duration, agentResults, sourceData, migrationResult, validationSummary }
// Failure path → { executionId, status: 'FAILED'|'CANCELLED', duration, error, agentResults }
// NOTE: sourceData, migrationResult, and validationSummary are absent on the failure path.
// Always guard: result.validationSummary?.overallStatus before reading validation fields.

// Multiple pairs (fire-and-forget — returns 202, run phases in parallel/sequential per AGENTS.md strategy)
const results = await orchestrator.runBulkFlow(pairsDataArray);
// → Array<{ executionId, sourceEmail, destinationEmail, status, error, duration, sourceData, migrationResult, validationSummary }>

// Resume an INTERRUPTED execution
const result = await orchestrator.resumeFlow(executionId);
```

## MigrationContext at Each Phase

| After Phase | New fields added to context |
|------------|---------------------------|
| Pre-construction | `executionId`, `sourceEmail`, `destinationEmail`, `sourceProvider`, `destinationProvider`, `migrationType`, `testType`, `includeMail`, `includeCalendar`, `includeContacts`, `userEmailMappings` |
| Cleanup | (nothing written to context) |
| Seed | (nothing written to context — result returned, not stored in context) |
| MigrationAgent | `sourceCloudId`, `destCloudId`, `sourceCloudName`, `destCloudName`, `csvPairsUploaded`, `preMigrationSnapshot`, `preMigrationDestSnapshot`, `migrationJobDetails`, `userEmailMappings` (updated) |
| ValidationAgent | `migrationJobDetails` (if not already populated by MigrationAgent) |
