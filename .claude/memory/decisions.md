---
name: decisions
description: Architectural decisions observed in the codebase — why things are built the way they are
metadata:
  type: project
---

## Dual Storage for Executions (JSON file + in-memory Map)

**Decision:** `executionService` keeps all executions in an in-memory `Map` AND persists them to `backend/data/executions.json` on every write.

**Why:** The execution may run for 30–60 minutes (migration polling). If the server restarts mid-run, the JSON file preserves the execution record so the UI can show its last known state. On startup, any execution still marked `RUNNING` is flipped to `INTERRUPTED` so the user can click "Resume" instead of re-running from scratch. Pure in-memory would lose the record entirely on restart.

**How to apply:** Never remove the `saveExecutions()` call from `update()`. Don't replace the JSON store with MongoDB — MongoDB is optional in this system and executions need to work offline.

---

## Phase 1 (Seeding) and Phase 2 (Migration) Run Sequentially in Bulk Mode

**Decision:** In `runBulkFlow()`, Phases 2 (migration) and 1 (seeding) use `for..of` loops (sequential). Phases 0 (cleanup) and 3 (validation) use `Promise.all()` (parallel).

**Why:** Phase 2 is sequential to avoid CloudFuze API conflicts — multiple simultaneous migration jobs against the same server produce conflicts and partial failures. Phase 1 is sequential to avoid Gmail API rate-limit collisions and to guarantee all source data is fully seeded before any migration starts (comment in `AgentOrchestrator.js`: "creating test data for all pairs one by one (sequential)").

**How to apply:** Do NOT change Phase 1 or Phase 2 to parallel. If CloudFuze confirms multi-job concurrency support and Gmail API rates are no longer a concern, revisit both separately.

---

## Message-ID → Subject+Timestamp Fallback in Deep Validation

**Decision:** Deep validation first tries to pair source ↔ destination messages by `Message-ID` header. If that fails, it falls back to `subject + sentDateTime ±120 min window` (controlled by `DEEP_VALIDATION_SUBJECT_TIME_FALLBACK=true`).

**Why:** Gmail's `users.messages.insert` API generates a new `Message-ID` for each inserted message. After migration, the Outlook copy may carry this new ID (not the original). Strict Message-ID matching would mark every seeded message as "not found". The fallback enables pairing in the common case while the window tolerates timezone normalization differences between Gmail `internalDate` and Outlook `receivedDateTime`.

**How to apply:** When adding new seeding scenarios, ensure subjects are unique within a run (the `applyRunningSubjectNumbering()` function handles this automatically). Never seed two messages with identical subjects in the same run.

---

## Separate Validation Agents per Migration Direction

**Decision:** Three separate validation agents instead of one: `OutlookValidationAgent`, `GmailValidationAgent`, `GmailToGmailValidationAgent`.

**Why:** Each direction has fundamentally different folder/label mapping logic:
- G→O: Gmail system label IDs → Outlook display names (`INBOX→Inbox`, `SENT→Sent Items`, etc.)
- O→G: Outlook display names → Gmail label IDs (reverse map), plus `Archive → Archive[Gmail]`
- G→G: System labels map 1-to-1; overlap labels (STARRED, IMPORTANT, CATEGORY_*) are excluded from totals

Combining these into one agent would require deep conditional branching throughout, making the validation logic harder to understand and test independently.

**How to apply:** When a new migration direction is added (e.g. Exchange On-Prem → Gmail), add a new dedicated validation agent rather than adding more conditionals to an existing one.

---

## agentBrain.js Uses OpenAI (gpt-4o), Not Anthropic

**Decision:** `backend/src/ai/agentBrain.js` uses the `openai` npm package with `gpt-4o`, not `@anthropic-ai/sdk`.

**Why:** `agentBrain.js` was originally built with OpenAI. The Anthropic SDK (`@anthropic-ai/sdk ^0.89.0`) is present in `backend/package.json` but is **not imported or used anywhere in the current codebase** — it appears to be a dependency retained for potential future use.

**How to apply:** `agentBrain.js` requires `OPENAI_API_KEY`. If AI features are broken, check that env var first. If migrating to Claude, replace the `openai` import and `new OpenAI({ apiKey })` client, update the `chat()` function, and update the model constant from `'gpt-4o'` to the target Claude model ID.

---

## Cleanup is Non-Blocking

**Decision:** `CleanupAgent` errors are `log.warn()` only — they never cause the execution to fail.

**Why:** Cleanup is best-effort. If a previous run's test data was already deleted, or the mailbox is freshly provisioned, cleanup calls will return "nothing to delete" or transient errors. Failing the entire QA run because of cleanup would waste hours of seeding and migration time for a non-critical prep step. The migration still starts from a near-zero state even if cleanup partially fails.

**How to apply:** `CleanupAgent.execute()` returns a summary object (never throws). The orchestrator wraps it in its own try/catch and continues regardless.

---

## Pre-Migration Snapshot before Triggering

**Decision:** `MigrationAgent` takes a snapshot of the source mailbox's folder counts and the destination's baseline message count immediately before calling the initiate endpoint.

**Why:** The snapshot is stored in `context.preMigrationSnapshot` and `context.preMigrationDestSnapshot`. The PDF generator uses these to show "what was in source at T=0". For Outlook→Gmail, the destination baseline lets the validation agent exclude pre-existing messages from the migrated count.

**How to apply:** When adding a new migration direction, ensure MigrationAgent captures a pre-migration snapshot for both source and destination if the provider supports it.

---

## Neutara Bug Auto-Raise (fire-and-forget)

**Decision:** After `runFullFlow()` completes with `validationResult.overallStatus === 'FAIL'`, `neutaraClient.createBug()` is called with `.then()/.catch()` — it never blocks the flow result.

**Why:** Bug filing can fail for many reasons (Neutara API down, network, auth). Blocking the execution result on this would make the validation pipeline fragile. The bug ID is stored in the execution record via `executionService.update({ jiraIssue })` if it succeeds.

**How to apply:** Treat Neutara integration as best-effort. If bugs are not being raised, check `log.warn` lines for "Neutara bug creation failed" — this is expected when JIRA/Neutara credentials are not configured.
