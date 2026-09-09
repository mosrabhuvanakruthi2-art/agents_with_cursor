---
name: project-context
description: Factual context for the Email Migration QA Agent System — routes, phases, validation tiers, storage, OAuth
metadata:
  type: project
---

## Migration Routes

| Route | sourceProvider | destinationProvider | Validation Agent |
|-------|---------------|--------------------|--------------------|
| Gmail → Outlook | `'google'` | `'microsoft'` | `OutlookValidationAgent` |
| Outlook → Gmail | `'microsoft'` | `'google'` | `GmailValidationAgent` |
| Gmail → Gmail | `'google'` | `'google'` | `GmailToGmailValidationAgent` |

## CloudFuze API Endpoints Used by MigrationAgent

| Step | Method | Path |
|------|--------|------|
| Auth (new server) | POST | `/mail/login` or `/mail/register` |
| Auth (devemail) | POST | `/auth/user` → App JWT; POST `/mail/register` → Mail JWT |
| Resolve clouds | GET | `/mail/clouds` (skipped if cloud IDs set in .env) |
| Destination domains | GET | `/email/move/domains/:destCloudId` |
| Upload user CSV | POST | `/email/user/csv/:srcId/:dstId` |
| Cache mapping | POST/PUT | `/email/user/cache/:srcId/:dstId` |
| Read permission mapping | GET | `/email/user/cache/:srcId/:dstId` |
| Pre-scan (new server only) | POST | `/email/mail/move/initiate/preScan` |
| Trigger migration | POST | `/mail/move/initiate` (new server) or `/mail/initiate` (devemail) |
| Poll completion | GET | `/email/user/jobs` (new server) or `/mail/reports` (devemail) |

Two server flavors detected via `migrationClient.isNewServer()`:
- **newtestemail5.cloudfuze.com** — "new server", uses App Bearer JWT
- **devemail.cloudfuze.com/proxyservices/v1** — "devemail", uses `devemailClient` (different auth flow)

## 4-Phase Execution Flow

```
Phase 0 – Cleanup:   CleanupAgent           backend/src/agents/cleanup/CleanupAgent.js
Phase 1 – Seed:      GmailTestDataAgent     backend/src/agents/gmail/GmailTestDataAgent.js
                  or OutlookTestDataAgent   backend/src/agents/outlook/OutlookTestDataAgent.js
Phase 2 – Migrate:   MigrationAgent         backend/src/agents/migration/MigrationAgent.js
Phase 3 – Validate:  OutlookValidationAgent backend/src/agents/outlook/OutlookValidationAgent.js
                  or GmailValidationAgent   backend/src/agents/gmail/GmailValidationAgent.js
                  or GmailToGmailValidation backend/src/agents/gmail/GmailToGmailValidationAgent.js
```

Orchestrated by `backend/src/orchestrator/AgentOrchestrator.js` (singleton).

## Deep Validation Tiers

**Tier A** — Header/metadata fields compared per message:
- `subject` (normalized — `normalizeSubject()` strips Re:/Fwd: prefixes)
- `from` (raw address — NOT mapped; `userEmailMappings` is NOT applied to `from`)
- `to`, `cc`, `bcc` (after rewriting)
- `replyTo`
- `attachments` presence (count + filename)
- `sentDateTime` (within tolerance)
- `readState` (isRead / UNREAD)
- `importance` (high/low → flag mapping)
- `starred` / flag status
- folder placement / Gmail label assignment

**Tier B** — SHA-256 hash of each attachment's binary content (controlled by `MAIL_DEEP_VALIDATE_ATTACHMENT_HASH=true`; max bytes: `MAIL_DEEP_HASH_MAX_BYTES=10485760` — 10 MB)

**Tier C** — Normalized plain-text body comparison (`normalizeMailBodyPlain()` strips whitespace noise; `htmlToPlainLoose()` for HTML→text)

Pairing strategy: match source ↔ destination message by `Message-ID` header first. Fallback (when `DEEP_VALIDATION_SUBJECT_TIME_FALLBACK=true`): match by subject + timestamp within `DEEP_VALIDATION_SUBJECT_TIME_WINDOW_MINUTES=120` minutes.

## Bulk Execution Parallelism

```
Phase 0: Promise.all(cleanup per pair)        — parallel
Phase 1: for..of loop (seed per pair)          — sequential (Gmail API rate-limit constraint)
Phase 2: for..of loop (migrate per pair)      — SEQUENTIAL (CloudFuze API conflict constraint)
Phase 3: Promise.all(validate per pair)       — parallel
```

## OAuth Token Management

Primary storage: `backend/data/oauth-tokens.json`
```json
{
  "google":    { "accounts": { "email": { "refreshToken": "...", "connectedAt": "..." } } },
  "microsoft": { "accounts": { "email": { "accessToken": "...", "refreshToken": "...", "expiresAt": 0, "connectedAt": "..." } } }
}
```

Secondary storage: MongoDB `connected_accounts` collection (fire-and-forget sync).  
On server startup: `loadFromMongo()` syncs MongoDB → JSON file.  
Every write: `syncToMongo(provider, email, data)` fires async, never blocks.

## MongoDB Usage

Database: `migration_qa` (configurable via `MONGODB_DB_NAME`)

| Collection | Contents |
|-----------|---------|
| `connected_accounts` | OAuth tokens (Google + Microsoft) |
| `test_repository` | Imported Xray/Jira test cases (tree structure) |
| `test_expanded_details` | Full test step data per Jira issue |
| `test_cases` | Custom QA test cases |

Execution records are NOT stored in MongoDB — they live in `backend/data/executions.json` + in-memory Map.

## Known Complexity Areas

**Email address rewriting:** CloudFuze rewrites From/To/Cc/Bcc during migration (e.g. `alex@qatestagent.com → alex@migrationn.com`). The comparator applies `userEmailMappings` before checking recipient fields. When the mapping is incomplete (old run without CSV upload), field-level mismatches appear even when migration succeeded.

**Message-ID fallback matching:** Gmail's `users.messages.insert` generates a new Message-ID; the migrated Outlook/Gmail item may not carry the original ID. When `DEEP_VALIDATION_SUBJECT_TIME_FALLBACK=true`, the validator pairs by `subject + sentDateTime ±window`. Window default: 120 min.

**Attachment hash validation (Tier B):** disabled by default (`MAIL_DEEP_VALIDATE_ATTACHMENT_HASH=false`). When enabled, it downloads each attachment from both sides — slow and rate-limit prone on large runs.

**Why:** Understanding these constraints is essential when triaging validation mismatches that claim field X differs when it actually migrated correctly.
**How to apply:** When a mismatch says "From mismatch" or "Message-ID not found", check `userEmailMappings` and `DEEP_VALIDATION_SUBJECT_TIME_FALLBACK` before concluding a migration bug.
