# Testing Patterns Skill — Migration QA Agent System

## When This Skill Activates

When the user asks about test data seeding, how to add test cases, how validation works, how to reproduce a migration failure, or how to interpret validation results.

## Understanding the Test Pipeline

A single test run follows 4 phases. Each phase depends on the previous:

```
Phase 0: CleanupAgent     → wipe mailboxes (non-blocking)
Phase 1: [Data agent]     → seed test data into source mailbox
Phase 2: MigrationAgent   → trigger CloudFuze migration, poll to completion
Phase 3: [Validation agent] → compare source vs. destination, generate PDF
```

Never skip Phase 0 unless `context.skipCleanup = true` is explicitly set. Dirty mailboxes from a prior run cause false mismatches.

---

## Adding a New Test Case to GmailTestDataAgent

Test cases are loaded from `backend/data/gmail-test-cases.xlsx` (Mail + Drafts sheets). If the file is absent, `GmailTestDataAgent` uses its built-in definitions array (`emailDefinitions` constant).

Structure for each entry in the built-in definitions array:

```js
{
  subject: 'QA Subject Text',   // must start with 'QA ' — deepMailValidator filters by this prefix
  labels: ['INBOX', 'QA-TestLabel'],  // Gmail system labels + custom label names
  body: 'Plain text body.',     // used for Tier C body comparison
  htmlBody: '<p>HTML body.</p>', // optional; overrides body for HTML emails
  isRead: true,                 // false = UNREAD label added
  isFlagged: false,             // true = STARRED label added
  attachments: [                // optional
    {
      filename: 'test.txt',
      mimeType: 'text/plain',
      data: SAMPLE_ATTACHMENT_DATA  // base64 — use constants from GmailTestDataAgent.js
    }
  ]
}
```

**Subject prefix rule:** `deepMailValidator.js` only scans messages where the subject starts with `'QA '` (the `DEEP_VALIDATION_SUBJECT_PREFIX` env var, default `'QA '`) or matches `/^QA\b/i`. Any test email without this prefix is invisible to the deep validator.

---

## Available Attachment Constants (GmailTestDataAgent.js)

Use these base64 constants to keep MIME messages well-formed:

| Constant | Size | MIME type |
|----------|------|-----------|
| `SAMPLE_ATTACHMENT_DATA` | ~40 bytes | text/plain |
| `SAMPLE_1K_B64` | ~1 KB | application/octet-stream |
| `SAMPLE_100K_B64` | ~100 KB | application/octet-stream |
| `SAMPLE_LARGE_B64` | ~64 KB | application/octet-stream |
| `SAMPLE_512K_B64` | ~512 KB | application/octet-stream |
| `SAMPLE_2M_B64` | ~2 MB | application/octet-stream |
| `SAMPLE_JPEG_B64` | ~100 bytes | image/jpeg (1×1 px) |
| `SAMPLE_PNG_B64` | ~68 bytes | image/png (1×1 px) |
| `SAMPLE_MINIMAL_PDF_B64` | minimal | application/pdf |
| `SAMPLE_ZIP_B64` | minimal | application/zip |
| `SAMPLE_CSV_B64` | minimal | text/csv |
| `SAMPLE_ICS_B64` | minimal | text/calendar |
| `SAMPLE_DOCX_B64` | minimal | application/vnd.openxmlformats-officedocument.wordprocessingml.document |
| `SAMPLE_XLSX_B64` | minimal | application/vnd.openxmlformats-officedocument.spreadsheetml.sheet |

For Tier B hash testing, the source and destination attachment bytes must be identical. Always use the same constant on both seed and re-seed sides.

---

## Adding a New Test Case to OutlookTestDataAgent

Test cases are loaded from `backend/data/outlook-test-cases.xlsx`. The built-in fallback structure:

```js
{
  subject: 'QA Outlook Subject',
  folder: 'Inbox',                   // Outlook folder name (must exist or be created first)
  body: { contentType: 'HTML', content: '<p>Body</p>' },
  toRecipients: [{ emailAddress: { address: 'recipient@example.com' } }],
  importance: 'normal',
  isRead: true,
  hasAttachments: false
}
```

---

## How Message Pairing Works in deepMailValidator

Source and destination messages are paired in this order:

1. **By `internetMessageId`** — the RFC 2822 `Message-ID` header, preserved by CloudFuze across providers. Most reliable.
2. **Fallback: subject + sent-time** — `DEEP_VALIDATION_SUBJECT_TIME_FALLBACK=true` (default). Messages with matching subject are paired if their timestamps are within ±120 minutes.

If a source message has no pair on the destination, it appears as a "not found" mismatch (error severity, counted toward `notFoundCount`).

**Scenario: message not paired despite subject match**  
- Subject encoding differs (MIME encoded-words vs. UTF-8 literal) → `normalizeSubject()` handles most cases
- Timestamp difference > 120 minutes → increase `DEEP_VALIDATION_SUBJECT_TIME_WINDOW_MINS`
- `internetMessageId` was rewritten by the mail server → the fallback should catch this

---

## Reading a Validation Result

The `ValidationResult.toJSON()` shape returned by all validation agents (from `backend/src/models/ValidationResult.js`):

```js
{
  overallStatus: 'PASS' | 'FAIL',   // only these two — 'WARN' is never set
  mailValidation: {
    sourceCount: N,
    destinationCount: N,
    countMatch: boolean,
    folderMapping: [],              // folder-level comparison items
    attachmentChecks: [],
    subjectChecks: [],
    // NOTE: no matchedCount, notFoundCount, or folderMismatches fields
  },
  deepMailValidation: {
    enabled: boolean,
    scannedSourceMessages: N,
    pairedCount: N,                 // NOT totalPaired
    skippedCount: N,
    unmatchedSourceIds: [],
    messageResults: [               // per-message deep validation results
      {
        internetMessageId: '...',   // RFC 2822 Message-ID from source
        sourceMessageId: '...',
        pass: true | false,
        diffs: [                    // field-level check results (Tier A/B/C combined)
          {
            field: 'subject' | 'from' | 'to' | 'cc' | 'bcc' | 'body' | 'attachments' | 'attachmentHash:<filename>' | ...,
            ok: true | false,
            expected: '...',
            actual: '...',
            severity: 'error' | 'warning' | 'info',
          }
        ],
        note: '...',                // optional error / status message
      }
    ],
    summary: '...',
  },
  mismatches: [                     // flattened list built by computeOverallStatus()
    {
      category: 'comparison' | 'deepMail' | 'mail' | 'calendar' | 'settings',
      kind: 'comparison' | 'mailbox' | 'calendar' | 'settings' | 'infrastructure' | 'attachment' | 'headers' | 'subject' | 'folder' | 'other',
      kindLabel: '...',             // human-readable label for the kind
      field: '...',                 // field name or internetMessageId for deepMail items
      expected: '...',
      actual: '...',
      summaryLine: '...',
      structuredDiffs: [...],       // present on deepMail items; [{fieldKey, fieldLabel, sourceExpected, destinationActual, severity}]
      messageSubject: '...',        // present on deepMail items
    }
  ],
  calendarValidation: { sourceEventCount, destinationEventCount, countMatch, ... },
  contactsValidation: { sourceCount, destinationCount, countMatch, available, ... },
  comparison: { issues: [], defaultLabelsMatch, customLabelsMatch },
  aiAnalysis: null | { rootCause, tier, faultSource, confidence, suggestions }
}
```

**Interpreting `overallStatus`:**
- `FAIL` — `mismatches[]` is non-empty after `computeOverallStatus()` runs
- `PASS` — `mismatches[]` is empty

Messages excluded from `mismatches` via `cloudfuzeDocsClient.classifyMismatches()` have `bugStatus: 'known_limitation'` on their `messageResults` entry — they are filtered out by `computeOverallStatus()` before the status is set.

---

## Triggering Only Specific Phases

To run only Phase 3 (re-validate without re-migrating):
- POST `{ ..., skipCleanup: true, skipTestData: true, skipMigration: true }` to `POST /api/agents/run`
- OR use `POST /api/agents/executions/:id/resume` on an execution that completed Phase 2

To skip cleanup and re-seed:
- POST `{ ..., skipCleanup: true }`

---

## Known Env Vars for Tuning Validation

| Env var | Default | Effect |
|---------|---------|--------|
| `DEEP_VALIDATION_MAX_MESSAGES` | 500 | Cap on messages validated per run |
| `DEEP_VALIDATION_SUBJECT_PREFIX` | `QA ` | Only validate messages with this subject prefix |
| `DEEP_VALIDATION_SUBJECT_TIME_FALLBACK` | `true` | Allow fallback pairing by subject+time |
| `DEEP_VALIDATION_SUBJECT_TIME_WINDOW_MINS` | `120` | Pairing time window in minutes |
| `MAIL_DEEP_VALIDATE_BODY` | `true` | Enable Tier C body comparison |
| `MAIL_DEEP_BODY_MAX_CHARS` | `500000` | Cap on body length for Tier C |
| `MAIL_DEEP_VALIDATE_ATTACHMENT_HASH` | `false` | Enable Tier B hash comparison (all routes) |
| `MAIL_DEEP_VALIDATE_ATTACHMENT_HASH_OG` | `true` | Enable Tier B for Outlook→Gmail only |
| `MAIL_DEEP_HASH_MAX_BYTES` | `10485760` | Skip attachments larger than this for hash |
