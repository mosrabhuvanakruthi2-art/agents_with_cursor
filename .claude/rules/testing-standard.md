# Testing Standard — Migration QA Agent System

## Test Data Per Migration Route

All test data agents live in `backend/src/agents/`. The route determines which agent seeds and which validates.

### Gmail → Outlook
- **Seed:** `GmailTestDataAgent` — Gmail API `users.messages.insert` (never sends mail)
- **Validate:** `OutlookValidationAgent`
- **Source labels used:** SENT, INBOX, SPAM, TRASH, STARRED, IMPORTANT, custom (e.g. `QA-TestLabel`)

### Outlook → Gmail
- **Seed:** `OutlookTestDataAgent` — Microsoft Graph `POST /users/{id}/messages` + `/sendMail`
- **Validate:** `GmailValidationAgent`
- **Source folders used:** Inbox, Sent Items, Drafts, Deleted Items, Junk Email, custom folders

### Gmail → Gmail
- **Seed:** `GmailTestDataAgent` (same agent, same source account)
- **Validate:** `GmailToGmailValidationAgent`
- **Source labels used:** same Gmail labels; overlap labels STARRED, IMPORTANT, UNREAD, CHAT, CATEGORY_* are skipped from count totals

---

## Scope by `testType`

| testType | Mail | Labels/Folders | Drafts | Calendar | Contacts | Filters |
|----------|------|----------------|--------|----------|----------|---------|
| SMOKE    | 1 plain email only | none | no | no | no | no |
| SANITY   | plain + HTML + attachment | SANITY_LABEL_NAMES (2 labels) | yes | no | no | no |
| E2E      | full coverage (~80+ messages) | E2E_LABEL_NAMES (30+ labels) | yes | yes (if `includeCalendar`) | yes (if `includeContacts`) | yes |

`SANITY_LABEL_NAMES = ['QA-TestLabel', 'QA-Important']`  
`E2E_LABEL_NAMES` = 30+ labels including nested (`QA-TestLabel/Nested-Child/Deep-Level`), deep chain to L15, filter labels, and custom folder mirrors.

---

## Tier A — Header and Envelope Fields

**File:** `backend/src/utils/mailMigrationComparator.js` — `compareTierA(source, dest, opts)`

Checks on every paired message. Severity: `error` for all fields.

| Field | Check | Notes |
|-------|-------|-------|
| `subject` | exact normalized match | MIME encoded-words decoded, whitespace collapsed |
| `from` | exact email set match | Raw address, NOT mapped — sender stays the same after migration |
| `to` | email set match (after user-mapping) | Applies `userEmailMappings` to expected recipients |
| `cc` | email set match (after user-mapping) | Same mapping rules as `to` |
| `bcc` | email set match (after user-mapping) | `opts.bccAsError=true` makes this an error (default) |
| `replyTo` | email set match | Warning severity when source sets a non-default replyTo |
| `attachments` | sorted filename list match | Size comparison is separate (Tier A uses names only) |

To seed a message that exercises Tier A attachment check: attach a file with a known unique filename. The validator checks that the same filename appears on the destination. Use `SAMPLE_ATTACHMENT_DATA` pattern from `GmailTestDataAgent.js`.

---

## Tier B — Attachment SHA-256 Hash

**File:** `backend/src/validation/shared/deepMailCore.js` — `tierBHashesGmail()` / `tierBHashesOutlookToOutlook()` / `tierBHashesOutlookToGmail()`  
(`deepMailValidator.js` is a thin re-export shim — the actual implementation is in `deepMailCore.js`)

Disabled by default. Enable with environment variables:
- `MAIL_DEEP_VALIDATE_ATTACHMENT_HASH=true` — enables for all routes
- `MAIL_DEEP_VALIDATE_ATTACHMENT_HASH_OG=true` — enables for Outlook→Gmail only (enabled by default for O→G when the general flag is false)

**Cap:** `MAIL_DEEP_HASH_MAX_BYTES=10485760` (10 MB) — attachments larger than this are skipped.

How it works:
1. Downloads source attachment bytes via Gmail API (`getAttachmentData`) or Graph (`$value` endpoint)
2. Computes `sha256Hex(buffer)` for each attachment by filename
3. `compareTierBHashes(srcHashes, dstHashes)` reports mismatches as `{ field: 'attachmentHash:<filename>', severity: 'error' }`
4. When all hashes match, any size-discrepancy warnings from Tier A are downgraded to `info`

To seed attachments that exercise Tier B: use the binary attachment constants in `GmailTestDataAgent.js`:
- `SAMPLE_ATTACHMENT_DATA` (~40 bytes, text/plain)
- `SAMPLE_1K_B64` (~1 KB), `SAMPLE_LARGE_B64` (~64 KB), `SAMPLE_512K_B64` (~512 KB)
- `SAMPLE_JPEG_B64` (minimal 1×1 JPEG), `SAMPLE_PNG_B64` (minimal 1×1 PNG)

---

## Tier C — Full Body Comparison

**File:** `backend/src/utils/mailMigrationComparator.js` — `compareTierC(sourcePlain, destHtmlOrPlain, opts)`

Enabled by default. Disable with `MAIL_DEEP_VALIDATE_BODY=false`.

**Cap:** `MAIL_DEEP_BODY_MAX_CHARS=500000`

How it works:
1. Source: extract HTML body via `gmailClient.extractHtmlBodyFromPayload(payload)` → `htmlToPlainLoose()`. Falls back to plain text part when no HTML.
2. Destination: `destFull.body?.content` normalized via `normalizeMailBodyPlain(htmlToPlainLoose(content))`
3. Both sides normalized: `\r\n` → `\n`, collapse multiple spaces/blank lines, trim
4. Severity: `warning` by default (`bodyMismatchSeverity: 'warning'`)

To seed emails that will exercise Tier C: use `htmlBody` in the email definition. The `compareTierC` function strips HTML tags and collapses whitespace — both sides must contain the same meaningful text.

---

## Folder Placement Validation

**File:** `backend/src/utils/mailMigrationComparator.js` — `validateGmailToOutlookPlacement()`

Gmail→Outlook mapping (from `GMAIL_SYSTEM_LABEL_TO_OUTLOOK_FOLDER`):
```
INBOX        → Inbox
SENT         → Sent Items
DRAFT/DRAFTS → Drafts
TRASH        → Deleted Items
SPAM         → Junk Email
STARRED      → red flag (flag.flagStatus = 'flagged') in the original folder
IMPORTANT    → importance = 'high' (exclamation mark) in the original folder
CATEGORY_*   → same-name category folder
<custom>     → same-name Outlook folder
```

Outlook→Gmail mapping (from `OUTLOOK_FOLDER_TO_GMAIL_LABEL` in `backend/src/validation/shared/deepMailCore.js`):
```
Inbox        → INBOX
Sent Items   → SENT
Drafts       → DRAFT
Deleted Items → TRASH
Junk Email   → SPAM
Archive      → Archive[Gmail]
<custom>     → same-name Gmail label (leaf folder name match)
```

---

## CleanupAgent Pre-Seed Verification

Before seeding, `CleanupAgent` runs a full wipe. Verify cleanup succeeded by checking the return value:

```js
// Expect from CleanupAgent.run(context):
{
  sourceOutlook: { messagesDeleted: N, foldersDeleted: N, eventsDeleted: N, errors: [] },
  destGmail:     { messagesDeleted: N, foldersDeleted: N, eventsDeleted: N, errors: [] }
}
// or { skipped: true } when context.skipCleanup = true
```

A non-empty `errors[]` array is non-fatal (CleanupAgent never throws). Check that `messagesDeleted > 0` when you expect a dirty account. If cleanup returns `messagesDeleted: 0` on a known-dirty account, check the provider is correct in `context.sourceProvider` / `context.destinationProvider`.

For Outlook source: wipe runs in order — settings (inbox rules → CF rules → search folders) THEN messages. QA Groups with `displayName` starting `"QA "` are also deleted.

For Gmail source/destination: `cleanGmailMailbox()` wipes messages, drafts, labels, calendar events, and Gmail filters.

---

## Writing a New Validation Agent

Follow `GmailValidationAgent.js` and `GmailToGmailValidationAgent.js` as templates:

1. `class MyValidationAgent extends BaseAgent`; `super('MyValidationAgent')` — name must match class name
2. `execute(context)` returns `ValidationResult.toJSON()`
3. Create `const result = new ValidationResult()` at the start
4. Use `logger.child({ agent: this.name, executionId: context.executionId })` for all logging
5. Gate calendar validation: `if (context.includeCalendar && (testType === 'E2E' || testType === 'DELTA'))`
6. Gate contacts/groups: `if (context.includeContacts && (testType === 'E2E' || testType === 'FULL'))`
7. Call `await runDeepMailValidation(context, result, log)` after folder-count comparison
8. Call `agentBrain.analyzeMigrationLogs()` when `result.mismatches.length > 0` (NOT `analyzeFailure()`)
   - Do NOT call `pdfGenerator.generatePdf()` — PDF is generated on-demand by `agentController.js` via `GET /executions/:id/pdf`
