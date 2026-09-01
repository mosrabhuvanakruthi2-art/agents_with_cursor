# Migration QA Agents — Quick Reference

All agents in `backend/src/agents/`. All extend `BaseAgent` (`agents/core/BaseAgent.js`).  
Call `new AgentName()`, then `await agent.run(context)`.

---

## CleanupAgent

**File:** `agents/cleanup/CleanupAgent.js`  
**Constructor:** `new CleanupAgent()` — no parameters  
**Main method:** `async execute(context) → { sourceOutlook, destGmail }` or `{ skipped: true }`  
**External APIs:**
- `outlookClient.cleanMailbox(email)`, `deleteAllInboxRules(email)`, `deleteAllConditionalFormattingRules(email)`, `deleteAllSearchFolders(email)`, `deleteQAGroups(email)`
- `gmailClient.cleanGmailMailbox(email)`

**Reads from context:** `sourceEmail`, `destinationEmail`, `sourceProvider`, `destinationProvider`, `skipCleanup`  
**Writes to context:** nothing  
**Error behavior:** all errors are `log.warn` + continue — never throws

---

## GmailTestDataAgent

**File:** `agents/gmail/GmailTestDataAgent.js`  
**Constructor:** `new GmailTestDataAgent()`  
**Main method:** `async execute(context) → { testType, emailsCreated, labelsCreated, draftsCreated, eventsCreated, contactsCreated, correspondentEmail, ccEmail, bccEmail, inboundSenders }`  
**External APIs:**
- Gmail API (`gmailClient`): `createLabel`, `listLabels`, `insertMessage`, `modifyMessageLabels`, `createDraft`, `seedGmailFilters`
- Admin SDK (`gmailClient.listDomainUsers`) — DWD tenants only
- `calendarClient` — create QA Secondary Calendar + events (E2E only when `context.includeCalendar`)

**Reads from context:** `sourceEmail`, `testType`, `includeMail`, `includeCalendar`, `includeContacts`, `executionId`  
**Writes to context:** nothing  
**Test data source:** `backend/data/gmail-test-cases.xlsx` (Mail + Drafts sheets), fallback to ~100+ built-in definitions

---

## OutlookTestDataAgent

**File:** `agents/outlook/OutlookTestDataAgent.js`  
**Constructor:** `new OutlookTestDataAgent()`  
**Main method:** `async execute(context) → { testType, emailsCreated, foldersCreated, draftsCreated, eventsCreated, contactsCreated }`  
**External APIs:**
- Microsoft Graph via `outlookClient`: `createMailFolder`, `createMessage`, `createDraft`, `createCalendarEvent`, `createContact`
- EWS via `ewsClient` as fallback for message insertion

**Reads from context:** `sourceEmail`, `testType`, `includeMail`, `includeCalendar`, `includeContacts`  
**Writes to context:** nothing  
**Test data source:** `backend/data/outlook-test-cases.xlsx`, fallback to built-in definitions (30+ scenarios)

---

## MigrationAgent

**File:** `agents/migration/MigrationAgent.js`  
**Constructor:** `new MigrationAgent()` — sets `this.jobId = null`, `this.retries = 0`  
**Main method:** `async execute(context) → { jobId, finalStatus, retriesUsed, rawResponse, ownerValidation, migrationJobDetails, cloudIds }`  
**External APIs:**
- `migrationClient` (new server): `register/login`, `getClouds`, `getDomains`, `uploadUserCSV`, `cacheUserMapping`, `getPermissionMapping`, `triggerPreScan`, `triggerMigration`, `pollReports`, `getLastJobDetails`
- `devemailClient` (devemail flavor): parallel auth/trigger/poll methods
- `outlookClient.getMailFolders` / `gmailClient.getGmailMailboxStats` — pre-migration snapshots
- `outlookClient.getTotalMessageCount` / `gmailClient.getGmailMailboxStats` — fallback polling

**Reads from context:** `sourceEmail`, `destinationEmail`, `sourceProvider`, `destinationProvider`, `migrationType`, `userEmailMappings`, `migrationServerUrl`, `migrationServerEmail`, `migrationServerPassword`, `sourceAdminEmail`, `destAdminEmail`, `executionId`  
**Writes to context:** `sourceCloudId`, `destCloudId`, `sourceCloudName`, `destCloudName`, `csvPairsUploaded`, `preMigrationSnapshot`, `preMigrationDestSnapshot`, `migrationJobDetails`, `userEmailMappings` (updated from server)  
**`toJSON()` extra fields:** `jobId`, `retries`

---

## OutlookValidationAgent

**File:** `agents/outlook/OutlookValidationAgent.js`  
**Constructor:** `new OutlookValidationAgent()`  
**Route:** Gmail→Outlook, Outlook→Outlook  
**Main method:** `async execute(context) → ValidationResult.toJSON()`  
**External APIs:**
- `gmailClient` — fetch source Gmail messages per label (G→O)
- `outlookClient` — fetch source Outlook folders (O→O), fetch destination Outlook messages
- `calendarClient` — validate calendar events (`testType === 'E2E'` only; silently skipped for SMOKE/SANITY)
- `agentBrain.analyzeMigrationLogs()` — OpenAI gpt-4o failure analysis on FAIL
- `cloudfuzeDocsClient.classifyMismatches()` — marks mismatches as known limitations

**Note:** PDF generation is NOT called from within the agent — it is handled by `agentController.js` via `GET /executions/:id/pdf`.

**Reads from context:** `sourceEmail`, `destinationEmail`, `sourceProvider`, `testType`, `includeMail`, `includeCalendar`, `includeContacts`, `userEmailMappings`, `migrationJobDetails`, `preMigrationSnapshot`, `executionId`  
**Writes to context:** `migrationJobDetails` (if not already set)

---

## GmailValidationAgent

**File:** `agents/gmail/GmailValidationAgent.js`  
**Constructor:** `new GmailValidationAgent()`  
**Route:** Outlook→Gmail  
**Main method:** `async execute(context) → ValidationResult.toJSON()`  
**Folder mapping used:**
```
Inbox → INBOX | Sent Items → SENT | Drafts → DRAFT
Deleted Items → TRASH | Junk Email → SPAM | Archive → Archive[Gmail]
<Custom folder> → same-name Gmail label
```
**External APIs:** `outlookClient` (source), `gmailClient` (destination), `calendarClient` (`testType === 'E2E'` or `'DELTA'` only; skipped for SMOKE/SANITY), `agentBrain.analyzeMigrationLogs()`, `cloudfuzeDocsClient`

**Note:** PDF generation is NOT called from within the agent — handled by `agentController.js`.

**Reads from context:** same as OutlookValidationAgent  
**Writes to context:** `migrationJobDetails` (if not already set)

---

## GmailToGmailValidationAgent

**File:** `agents/gmail/GmailToGmailValidationAgent.js`  
**Constructor:** `new GmailToGmailValidationAgent()`  
**Route:** Gmail→Gmail  
**Main method:** `async execute(context) → ValidationResult.toJSON()`  
**Label handling:** System labels map 1-to-1 (INBOX, SENT, DRAFT, TRASH, SPAM). Overlap labels `STARRED`, `IMPORTANT`, `UNREAD`, `CHAT`, `CATEGORY_*` are skipped from count totals.  
**External APIs:** `gmailClient` (both source and destination), `calendarClient` (`testType === 'E2E'` or `'DELTA'` only; skipped for SMOKE/SANITY), `agentBrain.analyzeMigrationLogs()`, `cloudfuzeDocsClient`

**Reads from context:** same as OutlookValidationAgent  
**Writes to context:** `migrationJobDetails` (if not already set)
