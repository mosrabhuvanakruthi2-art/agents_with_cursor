# Agent Reference — Email Migration QA System

All agents live in `backend/src/agents/` and extend `BaseAgent` (`agents/core/BaseAgent.js`).
The orchestrator (`orchestrator/AgentOrchestrator.js`) is a singleton (`module.exports = new AgentOrchestrator()`).

---

## BaseAgent Pattern

```js
// backend/src/agents/core/BaseAgent.js
class BaseAgent {
  constructor(name)          // sets this.name, this.status = 'PENDING'
  getName()                  // returns this.name
  setStatus(status)          // sets timestamps (startedAt / completedAt)
  async execute(context)     // OVERRIDE — receives MigrationContext, returns result
  async run(context)         // wraps execute(): sets RUNNING → SUCCESS/FAILED, logs both
  toJSON()                   // { name, status, startedAt, completedAt, result, error }
}
```

`run()` is called by the orchestrator. Subclasses only implement `execute()`.

---

## MigrationContext (shared across all phases)

Fields populated at construction time:

| Field | Type | Source |
|-------|------|--------|
| `executionId` | string (UUID) | auto-generated or passed in |
| `sourceEmail` | string | run form |
| `destinationEmail` | string | run form |
| `sourceProvider` | `'google'` \| `'microsoft'` | run form |
| `destinationProvider` | `'google'` \| `'microsoft'` | run form |
| `migrationType` | `'FULL'` \| `'DELTA'` | run form |
| `testType` | `'SMOKE'` \| `'SANITY'` \| `'E2E'` | run form |
| `includeMail` | boolean | run form |
| `includeCalendar` | boolean | run form / auto (true for DELTA) |
| `includeContacts` | boolean | run form / auto (true for DELTA) |
| `userEmailMappings` | `[{sourceEmail, destinationEmail}]` | run form |
| `migrateOrphanedLabels` | boolean | run form |
| `sourceAdminEmail` | string | run form |
| `destAdminEmail` | string | run form |
| `migrationServerUrl` | string | run form override |
| `migrationServerEmail` | string | run form override |
| `migrationServerPassword` | string | run form override |
| `mode` | string | `'bulk'` when launched via `runBulkFlow()`; absent for single pair |
| `bulkId` | string | shared UUID across all pairs in a bulk run; absent for single pair |

Fields written by agents during the run:

| Field | Written by | Content |
|-------|-----------|---------|
| `sourceCloudId` | MigrationAgent | CloudFuze cloud ID for source |
| `destCloudId` | MigrationAgent | CloudFuze cloud ID for destination |
| `sourceCloudName` | MigrationAgent | `'GMAIL'` or `'OUTLOOK'` |
| `destCloudName` | MigrationAgent | `'GMAIL'` or `'OUTLOOK'` |
| `csvPairsUploaded` | MigrationAgent | count of pairs in uploaded CSV |
| `preMigrationSnapshot` | MigrationAgent | folder/message counts at T=0 |
| `preMigrationDestSnapshot` | MigrationAgent | Gmail destination baseline (O→G only) |
| `migrationJobDetails` | MigrationAgent or ValidationAgent | `{ workspaceId, cfStatus, totalCount, processedCount }` |
| `skipCleanup` | Orchestrator (resume flow) | skip CleanupAgent on resume |
| `skipTestData` | Orchestrator (resume flow) | skip seed agent on resume |
| `skipMigration` | Orchestrator (resume flow) | skip MigrationAgent on resume |

---

## Agent Details

### CleanupAgent
**File:** `agents/cleanup/CleanupAgent.js`  
**Constructor:** `new CleanupAgent()` — no params  
**Role:** Full-wipes both source and destination mailboxes before a run so every migration starts from a zero state.  
**Inputs:** `context.sourceEmail`, `context.destinationEmail`, `context.sourceProvider`, `context.destinationProvider`, `context.skipCleanup`  
**External APIs:**
- `outlookClient.cleanMailbox(email)` — deletes all messages, custom folders, calendar events, recoverable items
- `outlookClient.deleteAllInboxRules(email)`, `deleteAllConditionalFormattingRules(email)`, `deleteAllSearchFolders(email)`, `deleteQAGroups(email)`
- `gmailClient.cleanGmailMailbox(email)` — deletes all messages, drafts, labels, calendar events, Gmail filters

**Returns:** `{ sourceOutlook: { messagesDeleted, foldersDeleted, eventsDeleted, errors }, destGmail: { … } }` or `{ skipped: true }`  
**Non-blocking:** cleanup errors are `log.warn` only — never throw from CleanupAgent.

---

### GmailTestDataAgent
**File:** `agents/gmail/GmailTestDataAgent.js`  
**Constructor:** `new GmailTestDataAgent()`  
**Role:** Seeds the Gmail source mailbox with a structured set of test emails, drafts, labels, calendar events, and contacts.  
**Inputs:** `context.sourceEmail`, `context.testType` (SMOKE/SANITY/E2E), `context.includeMail`, `context.includeCalendar`, `context.includeContacts`, `context.executionId`  
**External APIs:**
- `gmailClient.createLabel()`, `listLabels()`, `modifyMessageLabels()` (Gmail API)
- `gmailClient.insertMessage()` — builds raw MIME via `users.messages.insert`
- `calendarClient` — creates secondary calendar + events (E2E only)
- `gmailClient.listDomainUsers()` — Admin SDK for tenant 3 (DWD)
- `gmailClient.seedGmailFilters()` — E2E filter/rules seeding

**Test data loaded from:** `backend/data/gmail-test-cases.xlsx` (Mail + Drafts sheets) with fallback to built-in definitions  
**Returns:** `{ testType, emailsCreated, labelsCreated, draftsCreated, eventsCreated, contactsCreated, correspondentEmail }`  
**Writes to context:** nothing directly (context reads are for test params only)

---

### OutlookTestDataAgent
**File:** `agents/outlook/OutlookTestDataAgent.js`  
**Constructor:** `new OutlookTestDataAgent()`  
**Role:** Seeds the Outlook/Exchange source mailbox with test emails, custom folders, calendar events, and contacts via Microsoft Graph (and EWS as fallback).  
**Inputs:** `context.sourceEmail`, `context.testType`, `context.includeMail`, `context.includeCalendar`, `context.includeContacts`  
**External APIs:** Microsoft Graph via `outlookClient` — folder creation, message insertion, calendar events, contacts

**Returns:** `{ testType, emailsCreated, foldersCreated, draftsCreated, eventsCreated, contactsCreated }`

---

### MigrationAgent
**File:** `agents/migration/MigrationAgent.js`  
**Constructor:** `new MigrationAgent()` — also sets `this.jobId = null`, `this.retries = 0`  
**Role:** Authenticates with the CloudFuze migration server, resolves cloud IDs, uploads user mapping CSV, triggers a migration job, and polls until completion.

**Inputs:** full `MigrationContext` including `migrationServerUrl`, `migrationServerEmail`, `migrationServerPassword`, `userEmailMappings`, `sourceProvider`, `destinationProvider`

**6-step internal flow:**
1. Auth — `migrationClient.register()` → Bearer JWT (falls back to `login()`); devemail: `devemailClient.authenticate()` → App JWT → Mail JWT
2. Resolve cloud IDs — from env vars (`CLOUDFUZE_GMAIL_CLOUD_ID` / `CLOUDFUZE_OUTLOOK_CLOUD_ID`) or `GET /mail/clouds`
3. Load destination domains — `GET /email/move/domains/:destCloudId` (informational)
4. Upload user CSV — `POST /email/user/csv/:srcId/:dstId` with mapped pairs
5. Trigger migration — `POST /mail/move/initiate` (new server) or `/mail/initiate` (devemail)
6. Poll — `GET /email/user/jobs` or `/mail/reports` every 30 s, max 30 min; fallback to direct Gmail/Outlook API message count stabilization

**Returns:**
```js
{
  jobId,           // CloudFuze job ID from initiate response
  finalStatus,     // 'COMPLETED' | 'CANCELLED' | 'TIMEOUT' | CloudFuze status string
  retriesUsed,
  rawResponse,     // raw initiate response
  ownerValidation, // { userName, id, role }
  migrationJobDetails: { serverUrl, workspaceId, totalCount, processedCount, cfStatus },
  cloudIds: { sourceCloudId, destCloudId, sourceCloudName, destCloudName },
}
```
**Writes to context:** `sourceCloudId`, `destCloudId`, `sourceCloudName`, `destCloudName`, `csvPairsUploaded`, `preMigrationSnapshot`, `preMigrationDestSnapshot`, `migrationJobDetails`, `userEmailMappings` (updated from server permission mapping)

---

### OutlookValidationAgent
**File:** `agents/outlook/OutlookValidationAgent.js`  
**Constructor:** `new OutlookValidationAgent()`  
**Route:** Gmail→Outlook and Outlook→Outlook  
**Role:** Fetches source (Gmail or Outlook) and destination (Outlook) data; compares folder counts, deep-validates individual messages (Tiers A/B/C), validates drafts, calendar events, filters, contacts, mailbox settings. Calendar validation only runs when `testType === 'E2E'` — silently skipped for SMOKE/SANITY even if `includeCalendar: true`.

**External APIs:**
- `gmailClient` (list messages, labels) — for Gmail source
- `outlookClient` (list folders, messages, contacts, rules) — for Outlook destination
- `calendarClient` (list events)
- `agentBrain.analyzeMigrationLogs()` — OpenAI gpt-4o analysis when `result.mismatches.length > 0`
- `classifyMismatches()` from `cloudfuzeDocsClient` — marks mismatches as known limitations
- PDF is NOT generated inside the agent — `pdfGenerator.generateValidationPdf(execution, stream)` is called by `agentController.js` on `GET /executions/:id/pdf`

**Returns:** `ValidationResult.toJSON()` — includes `{ overallStatus, mailValidation, calendarValidation, contactsValidation, mismatches, deepMailValidation, … }`

---

### GmailValidationAgent
**File:** `agents/gmail/GmailValidationAgent.js`  
**Constructor:** `new GmailValidationAgent()`  
**Route:** Outlook→Gmail  
**Role:** Validates Gmail destination after an Outlook migration. Fetches source Outlook folder counts and destination Gmail label counts; compares per folder/label with deep per-message validation. Calendar validation runs only when `testType === 'E2E'` or `'DELTA'` — silently skipped for SMOKE/SANITY even if `includeCalendar: true`.

**Folder mapping:**
```
Inbox → INBOX, Sent Items → SENT, Drafts → DRAFT,
Deleted Items → TRASH, Junk Email → SPAM,
Archive → Archive[Gmail], <Custom> → same-name Gmail label
```

**External APIs:** `outlookClient` (source), `gmailClient` (destination), `calendarClient`, `agentBrain`

**Returns:** same `ValidationResult.toJSON()` shape as `OutlookValidationAgent`

---

### GmailToGmailValidationAgent
**File:** `agents/gmail/GmailToGmailValidationAgent.js`  
**Constructor:** `new GmailToGmailValidationAgent()`  
**Route:** Gmail→Gmail  
**Role:** Validates a destination Gmail mailbox after a Gmail→Gmail migration. System labels map 1-to-1; custom labels match by name. Calendar validation runs only when `testType === 'E2E'` or `'DELTA'` — silently skipped for SMOKE/SANITY even if `includeCalendar: true`.

**Label mapping:** INBOX→INBOX, SENT→SENT, DRAFT→DRAFT, TRASH→TRASH, SPAM→SPAM, custom→same-name on destination. Labels STARRED, IMPORTANT, UNREAD, CHAT, and CATEGORY_* are skipped in totals (they overlap counts).

**External APIs:** `gmailClient` (both source and destination), `calendarClient`, `agentBrain`

**Returns:** same `ValidationResult.toJSON()` shape

---

## Full Execution Flow

### Single pair — `runFullFlow(contextData)`
```
Step 0: CleanupAgent.run(context)          → summary (non-blocking on error)
Step 1: GmailTestDataAgent | OutlookTestDataAgent .run(context)  → sourceData
Step 2: MigrationAgent.run(context)        → migrationResult
Step 3: OutlookValidationAgent | GmailValidationAgent | GmailToGmailValidationAgent .run(context)  → validationResult
```
Returns:
```js
{
  executionId, status, duration,
  agentResults: [ dataAgent.toJSON(), migrationAgent.toJSON(), outlookAgent.toJSON() ],
  sourceData, migrationResult, validationSummary
}
```

On FAIL: `neutaraClient.createBug(execRecord)` is called fire-and-forget (never blocks the result).  
On resume: `resumeFlow(executionId)` reads `exec.result.agentResults`, injects `skipCleanup`/`skipTestData`/`skipMigration` into context, and calls `runFullFlow()` again.

### Bulk pairs — `runBulkFlow(pairsData)`
```
Phase 0: Promise.all( CleanupAgent.run(context) per pair )      — parallel
Phase 1: for..of loop ( dataAgent.run(context) per pair )        — sequential (Gmail API rate-limit constraint)
Phase 2: for..of loop ( migrationAgent.run(context) per pair )   — sequential (CloudFuze API constraint)
Phase 3: Promise.all( validationAgent.run(context) per pair )    — parallel
```
Each pair carries its own `context` and independent `executionId`.

---

## AI Analysis (agentBrain.js)

**File:** `backend/src/ai/agentBrain.js`  
**Model:** OpenAI gpt-4o (requires `OPENAI_API_KEY`)  
**Methods:**
- `analyzeFailure(validationResult, context)` — classifies root cause, tier (A/B/C/placement/thread), fault source (test_data_creation/migration/unknown), confidence
- `analyzeMigrationLogs(validationResult, context, executionId, startTime, endTime)` — reads `backend/logs/<executionId>.log` + Grafana CloudFuze server logs, then does evidence-backed analysis
- `generateTestCases(context)` — generates 5-10 targeted test case objects
- `suggestFix(mismatch)` — returns `{ suggestion, steps, confidence, severity, isAutoFixable, fixTarget }`
