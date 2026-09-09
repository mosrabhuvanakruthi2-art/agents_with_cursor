# Code Review Skill — Migration QA Agent System

## When This Skill Activates

When the user asks to review an agent file, a client, a controller, or any file in `backend/src/`.

## Step 1 — Read the Target File

Read the full file being reviewed. If it is in `backend/src/agents/`, also read `backend/src/agents/core/BaseAgent.js` as the authoritative reference.

## Step 2 — Apply Agent Pattern Checks (agents/ only)

These are hard requirements from `CLAUDE.md` and `code-style.md`:

**Constructor:**
```js
// CORRECT
constructor() {
  super('ExactClassName'); // string MUST match the class name
}
```
- `super()` string mismatch causes `toJSON()` to report the wrong agent name and the log `agent:` field to be wrong; the agent still runs but results are misattributed

**Override `execute()`, not `run()`:**
```js
// CORRECT
async execute(context) { ... }

// WRONG — never override run()
async run(context) { ... }
```

**Child logger:**
```js
// CORRECT
const log = logger.child({ agent: this.name, executionId: context.executionId });

// WRONG — root logger misses structured fields
logger.info('started');
```

**Return value:**
```js
// CORRECT — plain object
return { emailsCreated: 5, labelsCreated: 2 };

// WRONG — never return this or a class instance
return this;
```

**Error handling:**
```js
// Cleanup/non-critical: catch and warn, never throw
try { await outlookClient.deleteFolder(id); }
catch (err) { log.warn('Could not delete folder', { err: err.message }); }

// Agent core logic: let BaseAgent.run() catch it — do NOT swallow
const result = await gmailClient.insertMessage(raw); // let this throw
```

**Exports:**
```js
// Validation agents, data agents — export class (orchestrator instantiates)
module.exports = GmailValidationAgent;

// Clients, orchestrator — export singleton instance
module.exports = new AgentOrchestrator();
```

## Step 3 — Apply Context Field Checks

Validate the agent reads the right context fields for its role:

| Agent | Required context reads |
|-------|----------------------|
| CleanupAgent | `sourceEmail`, `destinationEmail`, `sourceProvider`, `destinationProvider`, `skipCleanup` |
| GmailTestDataAgent | `sourceEmail`, `testType`, `includeMail`, `includeCalendar`, `includeContacts`, `executionId` |
| MigrationAgent | `sourceEmail`, `destinationEmail`, `sourceProvider`, `destinationProvider`, `migrationType`, `userEmailMappings`, `migrationServerUrl`, `migrationServerEmail`, `migrationServerPassword` |
| Validation agents | `sourceEmail`, `destinationEmail`, `sourceProvider`, `testType`, `includeMail`, `includeCalendar`, `includeContacts`, `userEmailMappings`, `executionId` |

## Step 4 — Apply Validation-Agent–Specific Checks

For any file in `agents/*/Validation*.js`:

**Calendar gating:**
```js
// Outlook validation: E2E only
if (context.includeCalendar && testType === 'E2E') { ... }

// Gmail / GtG validation: E2E or DELTA
if (context.includeCalendar && (testType === 'E2E' || testType === 'DELTA')) { ... }
```

**Contacts/groups gating (GmailValidationAgent._validateGroups):**
```js
if (context.includeContacts && (testType === 'E2E' || testType === 'FULL')) { ... }
```

**Required calls before returning:**
1. `await runDeepMailValidation(context, result, log)` — deep per-message Tier A/B/C
2. `agentBrain.analyzeMigrationLogs()` when `result.mismatches.length > 0` — NOT `analyzeFailure()`
3. PDF is NOT generated inside agents — `pdfGenerator.generateValidationPdf(execution, stream)` is called by `agentController.js` on `GET /executions/:id/pdf`
4. Neutara bug: only in the orchestrator (`neutaraClient.createBug`), never inside the agent

## Step 5 — Check Logging Conventions

- No `maskEmail()` calls — the root logger applies it automatically via Winston format
- Log level discipline: `info` for normal progress, `warn` for recoverable issues, `error` for thrown errors
- `createExecutionLogger(executionId)` cleanup must be in a `finally` block

## Step 6 — Check for New Env Vars

If the file reads from `env.*` or `process.env.*`:
- Verify the var is listed in `backend/.env.example`
- Verify `backend/src/config/env.js` exports it
- Verify it's documented in the PR if this is a PR review

## Output Format

Report findings as a checklist:
```
File: backend/src/agents/gmail/NewAgent.js

[ PASS ] Extends BaseAgent
[ PASS ] super('NewAgent') matches class name
[ WARN ] execute() not implemented — returns undefined
[ FAIL ] run() is overridden — must use execute() instead
[ PASS ] Child logger created correctly
[ PASS ] No hardcoded credentials
[ PASS ] Calendar gating correct for Gmail route (E2E|DELTA)
[ FAIL ] pdfGenerator.generatePdf not called before return

2 failures, 1 warning. Fix FAIL items before merging.
```
