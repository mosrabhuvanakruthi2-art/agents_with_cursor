# Outlook → Gmail Migration — Test Case Document

**Product:** CloudFuze Migration Platform  
**Combination:** Microsoft Outlook (Exchange / M365) → Google Gmail / Workspace  
**Version:** 1.1 | **Date:** 2026-05-26  
**Author:** QA Engineering  

---

## Legend

| Symbol | Meaning |
|--------|---------|
| P1 | Critical — migration core, must pass |
| P2 | High — important feature, should pass |
| P3 | Medium — edge case or secondary feature |
| ✅ In Scope | CloudFuze supports this — verify it works correctly |
| ❌ Out of Scope | CloudFuze does NOT support this — verify graceful handling (no crash, correct behavior) |

---

## 1. SMOKE TEST CASES (SM)

> Bare-minimum pipeline check. Run before any deeper testing. Target: < 15 minutes.  
> If any Smoke test fails, do not proceed to Sanity or E2E.

---

### SM-001 — Source Account Connectivity

| Field | Details |
|-------|---------|
| **TC ID** | SM-001 |
| **Title** | Verify CloudFuze can connect to the Outlook source account |
| **Test Type** | Smoke |
| **Priority** | P1 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | CloudFuze provisioned; source Outlook account `granger@qatestagent.com` exists with valid OAuth/Graph token |
| **Test Steps** | 1. Log in to CloudFuze admin console. 2. Navigate to **Add Source Cloud → Microsoft Outlook**. 3. Enter credentials for source account. 4. Click **Authorize / Test Connection**. |
| **Expected Result** | Connection succeeds. Source account listed as connected. No authentication error. |

---

### SM-002 — Destination Account Connectivity

| Field | Details |
|-------|---------|
| **TC ID** | SM-002 |
| **Title** | Verify CloudFuze can connect to the Gmail destination account |
| **Test Type** | Smoke |
| **Priority** | P1 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Destination Gmail account `alex@migrationn.com` exists with valid OAuth token |
| **Test Steps** | 1. Navigate to **Add Destination Cloud → Gmail**. 2. Enter credentials for destination account. 3. Click **Authorize / Test Connection**. |
| **Expected Result** | Connection succeeds. Destination account listed as connected. |

---

### SM-003 — Single Plain Text Email Migration

| Field | Details |
|-------|---------|
| **TC ID** | SM-003 |
| **Title** | Verify a single plain text email migrates from Outlook Inbox to Gmail Inbox |
| **Test Type** | Smoke |
| **Priority** | P1 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook Inbox has at least 1 plain text email. Migration job configured for source → destination. |
| **Test Steps** | 1. Confirm 1 plain text email exists in source Outlook Inbox (e.g., Subject: "QA Smoke - Plain Text"). 2. Trigger migration. 3. Wait for job to complete. 4. Open destination Gmail Inbox. 5. Search for the subject. |
| **Expected Result** | Email appears in Gmail Inbox. Subject, sender (From), body text are intact. |

---

### SM-004 — Email Count Verification

| Field | Details |
|-------|---------|
| **TC ID** | SM-004 |
| **Title** | Verify source message count matches destination after migration |
| **Test Type** | Smoke |
| **Priority** | P1 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook has a known number of emails (e.g., 2). Migration completed. |
| **Test Steps** | 1. Count total messages in source Outlook (Inbox + Sent). 2. Run migration. 3. Count total messages in destination Gmail for same folders. 4. Compare counts. |
| **Expected Result** | Source count = Destination count. Zero messages lost. |

---

### SM-005 — Migration Job Status Completes Successfully

| Field | Details |
|-------|---------|
| **TC ID** | SM-005 |
| **Title** | Verify migration job reaches Completed status without errors |
| **Test Type** | Smoke |
| **Priority** | P1 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Migration job configured and started. |
| **Test Steps** | 1. Start migration. 2. Monitor job status on CloudFuze dashboard. 3. Wait for job to finish. 4. Check final status. |
| **Expected Result** | Job status shows **Completed**. No fatal errors. Processed count = Total count. |

---

### SM-006 — Email With Attachment Smoke Check

| Field | Details |
|-------|---------|
| **TC ID** | SM-006 |
| **Title** | Verify an email with one attachment migrates successfully |
| **Test Type** | Smoke |
| **Priority** | P1 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook Inbox has one email with a .txt or .pdf attachment. |
| **Test Steps** | 1. Confirm source email with attachment exists. 2. Run migration. 3. Find email in Gmail. 4. Check attachment presence and filename. |
| **Expected Result** | Email arrives in Gmail with attachment. Filename matches source. |

---

### SM-007 — Read State Preserved

| Field | Details |
|-------|---------|
| **TC ID** | SM-007 |
| **Title** | Verify read and unread state is preserved after migration |
| **Test Type** | Smoke |
| **Priority** | P1 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source has 1 read email and 1 unread email. |
| **Test Steps** | 1. Note which emails are read/unread in Outlook. 2. Run migration. 3. Open destination Gmail. 4. Check read/unread state for same emails. |
| **Expected Result** | Read email → read in Gmail. Unread email → unread (bold) in Gmail. |

---

## 2. SANITY TEST CASES (SN)

> Core feature validation. Covers all major in-scope features at one test per feature.  
> Target: 30–45 minutes.

---

### SN-001 — Inbox Email Migration

| Field | Details |
|-------|---------|
| **TC ID** | SN-001 |
| **Title** | Verify received emails in Outlook Inbox migrate to Gmail Inbox |
| **Test Type** | Sanity |
| **Priority** | P1 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook Inbox has 3 emails — plain text, HTML, email with attachment. |
| **Test Steps** | 1. Confirm 3 inbox emails in Outlook. 2. Run migration. 3. Open Gmail Inbox. 4. Verify all 3 appear. 5. Check subject, sender, body for each. |
| **Expected Result** | All 3 emails in Gmail Inbox with correct subject, From address, and body content. |

---

### SN-002 — Sent Items Migration

| Field | Details |
|-------|---------|
| **TC ID** | SN-002 |
| **Title** | Verify Outlook Sent Items migrate to Gmail Sent folder |
| **Test Type** | Sanity |
| **Priority** | P1 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook Sent Items has emails. |
| **Test Steps** | 1. Count emails in Outlook Sent Items. 2. Run migration. 3. Open Gmail → Sent. 4. Verify emails exist. 5. Check recipients (To field) are preserved. |
| **Expected Result** | Sent emails appear in Gmail Sent. To, From, Subject, timestamp all intact. |

---

### SN-003 — Drafts Migration

| Field | Details |
|-------|---------|
| **TC ID** | SN-003 |
| **Title** | Verify Outlook Drafts migrate to Gmail Drafts |
| **Test Type** | Sanity |
| **Priority** | P1 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook Drafts folder has at least 1 unsent email. |
| **Test Steps** | 1. Confirm draft exists in Outlook Drafts. 2. Run migration. 3. Open Gmail → Drafts. 4. Verify draft appears. 5. Confirm it is still a draft (not sent). |
| **Expected Result** | Draft appears in Gmail Drafts folder. Not delivered to any inbox. Subject and body preserved. |

---

### SN-004 — Junk Email → Gmail Spam

| Field | Details |
|-------|---------|
| **TC ID** | SN-004 |
| **Title** | Verify Outlook Junk Email folder migrates to Gmail Spam |
| **Test Type** | Sanity |
| **Priority** | P2 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook Junk Email has at least 1 email. |
| **Test Steps** | 1. Confirm email in Outlook Junk Email. 2. Run migration. 3. Open Gmail → Spam. 4. Check if email is present. |
| **Expected Result** | Email from Outlook Junk Email appears in Gmail Spam folder. |

---

### SN-005 — Deleted Items → Gmail Trash

| Field | Details |
|-------|---------|
| **TC ID** | SN-005 |
| **Title** | Verify Outlook Deleted Items migrate to Gmail Trash |
| **Test Type** | Sanity |
| **Priority** | P2 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook Deleted Items has at least 1 email. |
| **Test Steps** | 1. Confirm email in Outlook Deleted Items. 2. Run migration. 3. Open Gmail → Trash. 4. Verify email is present. |
| **Expected Result** | Email from Deleted Items appears in Gmail Trash folder. |

---

### SN-006 — Archive Folder Migration

| Field | Details |
|-------|---------|
| **TC ID** | SN-006 |
| **Title** | Verify Outlook Archive folder migrates to Gmail [Gmail]/Archive |
| **Test Type** | Sanity |
| **Priority** | P2 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook has an Archive folder with at least 1 email. |
| **Test Steps** | 1. Confirm email in Outlook Archive. 2. Run migration. 3. In Gmail, search for email or check **All Mail** / Archive label. 4. Verify email is archived (not in Inbox). |
| **Expected Result** | Email appears in Gmail under Archive / All Mail. Not visible in Inbox. |

---

### SN-007 — Flagged Email → Gmail Starred

| Field | Details |
|-------|---------|
| **TC ID** | SN-007 |
| **Title** | Verify Outlook flagged emails migrate as Starred/Important in Gmail |
| **Test Type** | Sanity |
| **Priority** | P2 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook Inbox has at least 1 email with flag set (flagStatus = flagged). |
| **Test Steps** | 1. Confirm flagged email in Outlook. 2. Run migration. 3. Open Gmail. 4. Check if email has Star or Important label. |
| **Expected Result** | Flagged Outlook email is Starred or marked Important in Gmail. |

---

### SN-008 — HTML Email Body Preserved

| Field | Details |
|-------|---------|
| **TC ID** | SN-008 |
| **Title** | Verify HTML formatted email body is preserved after migration |
| **Test Type** | Sanity |
| **Priority** | P1 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook has an HTML email with bold, italic, bullet list. |
| **Test Steps** | 1. Note HTML formatting in source email (bold text, list items). 2. Run migration. 3. Open same email in Gmail. 4. Inspect body formatting. |
| **Expected Result** | Bold, italic, underline, bullet lists preserved in Gmail. No raw HTML tags visible. |

---

### SN-009 — Email With Attachment Migration

| Field | Details |
|-------|---------|
| **TC ID** | SN-009 |
| **Title** | Verify email with PDF attachment migrates with attachment intact |
| **Test Type** | Sanity |
| **Priority** | P1 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook has an email with a PDF attachment (~100KB). |
| **Test Steps** | 1. Note attachment filename and size in Outlook. 2. Run migration. 3. Open email in Gmail. 4. Check attachment presence, filename, downloadability. |
| **Expected Result** | PDF attachment present in Gmail email. Filename matches. File downloads without corruption. |

---

### SN-010 — CC and BCC Recipients Preserved

| Field | Details |
|-------|---------|
| **TC ID** | SN-010 |
| **Title** | Verify CC and BCC recipients are preserved in migrated emails |
| **Test Type** | Sanity |
| **Priority** | P1 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook has an email with To, CC, and BCC fields populated. |
| **Test Steps** | 1. Note To, CC, BCC addresses in source email. 2. Run migration. 3. Open email in Gmail. 4. Expand recipient fields and verify CC, BCC. |
| **Expected Result** | CC addresses visible and correct. BCC preserved. Recipient addresses match source. |

---

### SN-011 — Timestamp Preserved

| Field | Details |
|-------|---------|
| **TC ID** | SN-011 |
| **Title** | Verify original sent/received timestamp is preserved after migration |
| **Test Type** | Sanity |
| **Priority** | P1 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook has emails with known timestamps (e.g., sent on 2025-12-01 14:30 UTC). |
| **Test Steps** | 1. Note exact timestamp of email in Outlook. 2. Run migration. 3. Open email in Gmail. 4. Check email date/time stamp. |
| **Expected Result** | Email shows same date and time in Gmail as in Outlook. Not replaced with migration timestamp. |

---

### SN-012 — Custom Folder → Gmail Label

| Field | Details |
|-------|---------|
| **TC ID** | SN-012 |
| **Title** | Verify custom Outlook folder migrates as Gmail label |
| **Test Type** | Sanity |
| **Priority** | P1 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook has a custom folder "QA-Project-Alpha" with emails. |
| **Test Steps** | 1. Confirm folder "QA-Project-Alpha" exists in Outlook. 2. Run migration. 3. Open Gmail. 4. Check Labels section for "QA-Project-Alpha". 5. Verify emails under that label. |
| **Expected Result** | Gmail label "QA-Project-Alpha" created. All emails from that folder present under the label. |

---

### SN-013 — Nested Folder Hierarchy Preserved

| Field | Details |
|-------|---------|
| **TC ID** | SN-013 |
| **Title** | Verify nested Outlook folders migrate as nested Gmail labels |
| **Test Type** | Sanity |
| **Priority** | P2 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook has folder `Projects/Alpha/Q1` (2-level nesting). |
| **Test Steps** | 1. Confirm nested folder exists in Outlook. 2. Run migration. 3. Check Gmail Labels for `Projects/Alpha/Q1`. 4. Verify hierarchy and emails. |
| **Expected Result** | Gmail shows nested label `Projects > Alpha > Q1`. Emails from each folder appear under correct label. |

---

### SN-014 — Thread / Conversation Grouping

| Field | Details |
|-------|---------|
| **TC ID** | SN-014 |
| **Title** | Verify email conversation thread migrates as a grouped thread in Gmail |
| **Test Type** | Sanity |
| **Priority** | P2 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook has an email thread (3 messages in one conversation, same Subject with Re:). |
| **Test Steps** | 1. Identify thread in Outlook (root email + 2 replies with `Re:` prefix). 2. Run migration. 3. Open Gmail. 4. Search for thread subject. 5. Verify messages are grouped in one conversation. |
| **Expected Result** | Gmail shows 3 messages grouped as one conversation thread. Order preserved. |

---

### SN-015 — Read/Unread Status Migration

| Field | Details |
|-------|---------|
| **TC ID** | SN-015 |
| **Title** | Verify read and unread email status is preserved during migration |
| **Test Type** | Sanity |
| **Priority** | P1 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook Inbox has 2 read and 2 unread emails. |
| **Test Steps** | 1. Note which emails are read/unread in Outlook. 2. Run migration. 3. In Gmail Inbox, verify bold (unread) and normal (read) state for same emails. |
| **Expected Result** | Unread emails appear bold in Gmail. Read emails appear normal. Status matches source exactly. |

---

### SN-016 — Calendar Single Event Migration

| Field | Details |
|-------|---------|
| **TC ID** | SN-016 |
| **Title** | Verify a single-instance Outlook calendar event migrates to Google Calendar |
| **Test Type** | Sanity |
| **Priority** | P1 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook Primary Calendar has 1 future single-instance event. |
| **Test Steps** | 1. Note event title, date, time, location in Outlook. 2. Run migration (include Calendar). 3. Open Google Calendar. 4. Find event by title. 5. Verify all fields. |
| **Expected Result** | Event appears in Google Calendar. Title, date, time, location preserved. |

---

### SN-017 — Calendar Recurring Event Migration

| Field | Details |
|-------|---------|
| **TC ID** | SN-017 |
| **Title** | Verify recurring Outlook calendar event migrates to Google Calendar |
| **Test Type** | Sanity |
| **Priority** | P1 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook has a recurring weekly event (4 occurrences). |
| **Test Steps** | 1. Note recurrence pattern (e.g., every Monday, 4 occurrences). 2. Run migration. 3. Open Google Calendar. 4. Verify all 4 occurrences appear. 5. Check recurrence pattern. |
| **Expected Result** | All occurrences present. Recurrence pattern (weekly, every Monday) preserved. |

---

### SN-018 — Contacts Migration

| Field | Details |
|-------|---------|
| **TC ID** | SN-018 |
| **Title** | Verify Outlook contacts migrate to Google Contacts |
| **Test Type** | Sanity |
| **Priority** | P1 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook Contacts has 3 contacts with name, email, phone. |
| **Test Steps** | 1. Note contact details (name, email, phone) in Outlook. 2. Run migration (include Contacts). 3. Open Google Contacts. 4. Search for each contact. 5. Verify fields. |
| **Expected Result** | Contacts appear in Google Contacts. Name, email address, phone number migrated correctly. |

---

### SN-019 — Contact Photo NOT Migrated (Expected)

| Field | Details |
|-------|---------|
| **TC ID** | SN-019 |
| **Title** | Verify contact photo is NOT migrated (documented out-of-scope behavior) |
| **Test Type** | Sanity |
| **Priority** | P2 |
| **Scope** | ❌ Out of Scope |
| **Pre-condition** | Source Outlook has a contact with a profile photo. |
| **Test Steps** | 1. Confirm contact has a photo in Outlook. 2. Run migration. 3. Open Google Contacts. 4. Check if photo appears. |
| **Expected Result** | Contact migrated without photo. Placeholder/no image shown. No error. All other fields present. |

---

### SN-020 — Address Mapping (Cross-Domain Recipients)

| Field | Details |
|-------|---------|
| **TC ID** | SN-020 |
| **Title** | Verify recipient email addresses are mapped to destination domain after migration |
| **Test Type** | Sanity |
| **Priority** | P1 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Email in source sent To: `alex@qatestagent.com`. Mapping configured: `alex@qatestagent.com → alex@migrationn.com`. |
| **Test Steps** | 1. Confirm source email To: `alex@qatestagent.com`. 2. Run migration with address mapping configured. 3. Open migrated email in Gmail. 4. Check To: field. |
| **Expected Result** | To: field shows `alex@migrationn.com` (mapped destination address), not the original source domain address. |

---

### SN-021 — High Importance Email Preserved

| Field | Details |
|-------|---------|
| **TC ID** | SN-021 |
| **Title** | Verify high-importance Outlook email is preserved/flagged in Gmail |
| **Test Type** | Sanity |
| **Priority** | P2 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook has an email marked as High Importance (red exclamation). |
| **Test Steps** | 1. Confirm high importance flag on email. 2. Run migration. 3. Open email in Gmail. 4. Check if email is marked as Important. |
| **Expected Result** | Email appears with Important indicator in Gmail. |

---

### SN-022 — Delta Migration (New Emails Only)

| Field | Details |
|-------|---------|
| **TC ID** | SN-022 |
| **Title** | Verify Delta migration transfers only new emails added after initial migration |
| **Test Type** | Sanity |
| **Priority** | P1 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Initial (Full) migration already completed. 2 new emails added to source Outlook after initial migration. |
| **Test Steps** | 1. Complete initial full migration. 2. Add 2 new emails to source Outlook. 3. Run Delta migration. 4. Check destination Gmail. 5. Verify only the 2 new emails appear — no duplicates of old emails. |
| **Expected Result** | Only 2 new emails added to destination. Previously migrated emails not duplicated. |

---

### SN-023 — Secondary Calendar Migration

| Field | Details |
|-------|---------|
| **TC ID** | SN-023 |
| **Title** | Verify Outlook secondary calendar migrates to Google Calendar |
| **Test Type** | Sanity |
| **Priority** | P2 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook has a secondary calendar "QA Secondary Calendar" with 1 event. |
| **Test Steps** | 1. Confirm secondary calendar and event in Outlook. 2. Run migration. 3. Open Google Calendar. 4. Check for secondary calendar "QA Secondary Calendar". 5. Verify event. |
| **Expected Result** | Secondary calendar created in Google Calendar. Event preserved under it. |

---

### SN-024 — Email Rules NOT Migrated (Expected)

| Field | Details |
|-------|---------|
| **TC ID** | SN-024 |
| **Title** | Verify email inbox rules are NOT migrated (documented limitation) |
| **Test Type** | Sanity |
| **Priority** | P2 |
| **Scope** | ❌ Out of Scope |
| **Pre-condition** | Source Outlook has 2 inbox rules configured. Migration completed. |
| **Test Steps** | 1. Confirm rules in Outlook (Settings → Rules). 2. Run migration. 3. Open Gmail Settings → Filters. 4. Check if any rules were created. |
| **Expected Result** | No Gmail filters/rules created. Mail migration succeeds. No error about rules. User informed rules must be recreated manually. |

---

### SN-025 — Shared Mailbox Migration

| Field | Details |
|-------|---------|
| **TC ID** | SN-025 |
| **Title** | Verify shared Outlook mailbox migrates to Gmail with shared access |
| **Test Type** | Sanity |
| **Priority** | P2 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook has a shared mailbox `support@contoso.com` accessible to multiple users. |
| **Test Steps** | 1. Confirm shared mailbox access in Outlook. 2. Configure migration for shared mailbox. 3. Run migration. 4. Open Gmail as destination. 5. Verify shared access is preserved. |
| **Expected Result** | Shared mailbox emails migrated. Destination Gmail account accessible to same authorized users. |

---

## 3. END-TO-END TEST CASES (E2E)

> Full coverage — all in-scope features (positive + edge cases) + out-of-scope verification.

---

### 3.1 Mail — Default Folders

---

#### E2E-001 — Inbox: Plain Text Email

| Field | Details |
|-------|---------|
| **TC ID** | E2E-001 |
| **Title** | Inbox plain text email — all headers and body preserved |
| **Test Type** | E2E |
| **Priority** | P1 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook Inbox has plain text email from `sender@external.com` To: `user@contoso.com`, Subject: "QA E2E - Plain Text". |
| **Test Steps** | 1. Note From, To, Subject, body, timestamp. 2. Run migration. 3. Open Gmail Inbox. 4. Find email. 5. Verify From, To, Subject, body, timestamp. |
| **Expected Result** | All fields match. Body is plain text without any encoding artifacts. |

---

#### E2E-002 — Inbox: HTML Rich-Formatted Email

| Field | Details |
|-------|---------|
| **TC ID** | E2E-002 |
| **Title** | Inbox HTML email with full rich formatting preserved |
| **Test Type** | E2E |
| **Priority** | P1 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source email has bold, italic, underline, strikethrough, ordered list, unordered list, blockquote, colored text, hyperlink. |
| **Test Steps** | 1. Capture screenshot of source email formatting. 2. Run migration. 3. Open in Gmail. 4. Compare formatting element by element. |
| **Expected Result** | All HTML formatting elements render correctly in Gmail. No raw HTML tags visible. |

---

#### E2E-003 — Inbox: Unread Email Read-State Preserved

| Field | Details |
|-------|---------|
| **TC ID** | E2E-003 |
| **Title** | Verify unread email remains unread after migration |
| **Test Type** | E2E |
| **Priority** | P1 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source has 1 unread email in Inbox (never opened). |
| **Test Steps** | 1. Confirm email is unread in Outlook (bold subject line). 2. Run migration WITHOUT opening email in Outlook. 3. Check Gmail Inbox. |
| **Expected Result** | Email appears bold (unread) in Gmail. Unread count reflects it. |

---

#### E2E-004 — Sent Items: Timestamp and Recipients Preserved

| Field | Details |
|-------|---------|
| **TC ID** | E2E-004 |
| **Title** | Sent email — original sent timestamp and all recipients preserved |
| **Test Type** | E2E |
| **Priority** | P1 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Sent Items has email sent on `2025-03-15 09:30 UTC` To: `alice@domain.com`, CC: `bob@domain.com`. |
| **Test Steps** | 1. Note exact timestamp, To, CC. 2. Run migration. 3. Open same email in Gmail Sent. 4. Verify timestamp (not replaced by current time). 5. Verify To and CC. |
| **Expected Result** | Timestamp: `2025-03-15 09:30 UTC`. To: `alice@domain.com`. CC: `bob@domain.com`. All match source exactly. |

---

#### E2E-005 — Drafts: Unsent Draft Preserved Correctly

| Field | Details |
|-------|---------|
| **TC ID** | E2E-005 |
| **Title** | Draft email migrates to Gmail Drafts and remains unsent |
| **Test Type** | E2E |
| **Priority** | P1 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook Drafts has a draft email with Subject, partial body, To address but NOT sent. |
| **Test Steps** | 1. Note draft details in Outlook. 2. Run migration. 3. Open Gmail Drafts. 4. Verify draft exists. 5. Verify no email was actually sent to the To: recipient during migration. |
| **Expected Result** | Draft appears in Gmail Drafts. Email NOT delivered to recipient. Subject, body, To field preserved. |

---

#### E2E-006 — Drafts: Draft With DOCX Attachment

| Field | Details |
|-------|---------|
| **TC ID** | E2E-006 |
| **Title** | Draft with DOCX attachment migrates with attachment intact |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook has a draft with a Word document (.docx) attached. |
| **Test Steps** | 1. Confirm draft has DOCX attachment in Outlook. 2. Run migration. 3. Open draft in Gmail. 4. Verify DOCX attachment present. 5. Download and verify file is not corrupted. |
| **Expected Result** | DOCX attachment preserved in Gmail draft. File opens correctly. |

---

#### E2E-007 — Junk Email: Spam Label Applied in Gmail

| Field | Details |
|-------|---------|
| **TC ID** | E2E-007 |
| **Title** | Outlook Junk Email appears in Gmail Spam with correct label |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook Junk Email has 3 emails. |
| **Test Steps** | 1. Count emails in Outlook Junk. 2. Run migration. 3. Open Gmail Spam. 4. Verify count and content. |
| **Expected Result** | All 3 junk emails in Gmail Spam. Not in Inbox. Gmail spam label applied. |

---

#### E2E-008 — Deleted Items: Trash Folder Migration

| Field | Details |
|-------|---------|
| **TC ID** | E2E-008 |
| **Title** | Outlook Deleted Items migrate to Gmail Trash |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook Deleted Items has 2 emails. |
| **Test Steps** | 1. Confirm 2 emails in Deleted Items. 2. Run migration. 3. Open Gmail Trash. 4. Verify both emails present. |
| **Expected Result** | Both emails in Gmail Trash. Not in Inbox or other folder. |

---

#### E2E-009 — Archive: Migrates to Gmail All Mail / Archive

| Field | Details |
|-------|---------|
| **TC ID** | E2E-009 |
| **Title** | Outlook Archive folder maps to Gmail Archive label |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook has an Archive folder with 2 emails. |
| **Test Steps** | 1. Confirm emails in Outlook Archive. 2. Run migration. 3. Search Gmail for archived emails. 4. Verify they appear in All Mail / Archive, NOT in Inbox. |
| **Expected Result** | Emails accessible in Gmail under Archive/All Mail. Not in Inbox. `[Gmail]/Archive` label applied if applicable. |

---

#### E2E-010 — Flagged Email Mapping to Starred in Gmail

| Field | Details |
|-------|---------|
| **TC ID** | E2E-010 |
| **Title** | Outlook flagged email → Gmail Starred |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook has 1 email with Follow-up flag (flagStatus = flagged). |
| **Test Steps** | 1. Confirm flag on email in Outlook. 2. Run migration. 3. Open Gmail Starred. 4. Check if email appears. |
| **Expected Result** | Email has star (⭐) in Gmail. Appears in Gmail Starred folder. |

---

#### E2E-011 — Pinned Email Migrated but NOT Pinned in Gmail

| Field | Details |
|-------|---------|
| **TC ID** | E2E-011 |
| **Title** | Pinned Outlook email migrates but pin status not preserved (expected) |
| **Test Type** | E2E |
| **Priority** | P3 |
| **Scope** | ❌ Out of Scope |
| **Pre-condition** | Source Outlook has a pinned email in Inbox. |
| **Test Steps** | 1. Confirm email is pinned in Outlook. 2. Run migration. 3. Open Gmail Inbox. 4. Verify email exists. 5. Check if it is pinned. |
| **Expected Result** | Email present in Gmail Inbox but NOT pinned. Email content intact. No error. |

---

### 3.2 Mail — Email Content

---

#### E2E-012 — Signature Block Preserved

| Field | Details |
|-------|---------|
| **TC ID** | E2E-012 |
| **Title** | Email signature (HTML formatted) preserved in migrated email |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook email has a formatted HTML signature block (name, title, phone, logo image). |
| **Test Steps** | 1. Note signature content in source email. 2. Run migration. 3. Open email in Gmail. 4. Scroll to bottom. 5. Verify signature block. |
| **Expected Result** | Signature rendered correctly in Gmail. Formatting (bold name, italic title) preserved. |

---

#### E2E-013 — Email With Emoji in Subject and Body

| Field | Details |
|-------|---------|
| **TC ID** | E2E-013 |
| **Title** | Email with emoji characters in subject and body migrates correctly |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source email: Subject: "QA Test 📧 — Migration ✅", Body contains "🚀 🎉 ❤️ 😀". |
| **Test Steps** | 1. Confirm emoji in subject and body in Outlook. 2. Run migration. 3. Find email in Gmail. 4. Verify subject and body emojis render correctly. |
| **Expected Result** | Emoji characters preserved. Subject and body show correct emoji (not replacement characters or encoded strings). |

---

#### E2E-014 — Multi-Language Email Body (Unicode)

| Field | Details |
|-------|---------|
| **TC ID** | E2E-014 |
| **Title** | Email body with multiple language characters migrates without encoding corruption |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source email body contains: Arabic `مرحبا`, Chinese `你好`, Korean `안녕하세요`, Japanese `こんにちは`, Russian `Привет`. |
| **Test Steps** | 1. Confirm multi-language text in source. 2. Run migration. 3. Open email in Gmail. 4. Verify each language script renders. |
| **Expected Result** | All Unicode characters preserved and readable in Gmail. No question marks or garbled text. |

---

#### E2E-015 — Empty Subject Line Email

| Field | Details |
|-------|---------|
| **TC ID** | E2E-015 |
| **Title** | Email with empty subject line migrates correctly |
| **Test Type** | E2E |
| **Priority** | P3 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook has an email with no subject (empty string). |
| **Test Steps** | 1. Confirm email has blank subject in Outlook. 2. Run migration. 3. Find email in Gmail (search by sender). 4. Check subject field. |
| **Expected Result** | Email appears in Gmail. Subject shows "(no subject)" or empty. Body and other fields intact. No error. |

---

#### E2E-016 — Long Subject Line (200+ Characters)

| Field | Details |
|-------|---------|
| **TC ID** | E2E-016 |
| **Title** | Email with very long subject line (200+ characters) migrates without truncation |
| **Test Type** | E2E |
| **Priority** | P3 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source email has subject: "QA Test — This is a very long subject line designed to test migration of email subjects that exceed the typical display length limit and includes repeated text to reach 200+ characters for validation purposes." |
| **Test Steps** | 1. Confirm full subject in source. 2. Run migration. 3. Open email in Gmail. 4. Expand subject field and verify full length. |
| **Expected Result** | Full subject preserved. Not truncated. |

---

#### E2E-017 — Subject With Special Characters

| Field | Details |
|-------|---------|
| **TC ID** | E2E-017 |
| **Title** | Email subject with special characters (`<`, `>`, `&`, `|`, `"`) preserved |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source email subject: `QA Test <tag> | pipe & ampersand "quotes"`. |
| **Test Steps** | 1. Note exact subject. 2. Run migration. 3. Find in Gmail. 4. Compare subject exactly. |
| **Expected Result** | Subject preserved exactly including special characters. No HTML-encoding artifacts like `&lt;` visible to user. |

---

#### E2E-018 — Email With Inline Image

| Field | Details |
|-------|---------|
| **TC ID** | E2E-018 |
| **Title** | Email with inline embedded image migrates with image rendered inline |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook email has an image embedded inline in the body (not as attachment). |
| **Test Steps** | 1. Confirm image is embedded in body in Outlook (not attachment paperclip). 2. Run migration. 3. Open email in Gmail. 4. Verify image renders in body. |
| **Expected Result** | Inline image visible in email body in Gmail. Not shown as separate attachment. |

---

#### E2E-019 — Very Large Body (~50KB Plain Text)

| Field | Details |
|-------|---------|
| **TC ID** | E2E-019 |
| **Title** | Email with very large plain-text body (~50KB) migrates without truncation |
| **Test Type** | E2E |
| **Priority** | P3 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source email body contains ~50,000 characters of text (repeated paragraphs). |
| **Test Steps** | 1. Confirm body character count in source. 2. Run migration. 3. Open email in Gmail. 4. Scroll to end of body. 5. Check last line matches source. |
| **Expected Result** | Full body preserved. No truncation at any character limit. |

---

#### E2E-020 — Forwarded Email Chain (FW: FW:)

| Field | Details |
|-------|---------|
| **TC ID** | E2E-020 |
| **Title** | Forwarded email chain with multiple FW: prefixes migrates with full chain history |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source has email with Subject: "FW: FW: FW: Original Message" containing 3 levels of forwarded content. |
| **Test Steps** | 1. Note all forwarded content levels in source. 2. Run migration. 3. Open in Gmail. 4. Verify each level of forwarded content is intact. |
| **Expected Result** | All forwarded content visible. Subject prefix (FW: FW: FW:) preserved. Each quoted section readable. |

---

#### E2E-093 — Reply Chain (Re: Re: Re:)

| Field | Details |
|-------|---------|
| **TC ID** | E2E-093 |
| **Title** | Reply email chain with multiple Re: prefixes migrates with full reply history intact |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook has a thread with Subject: "Re: Re: Re: Project Update" containing 3 replies with quoted original text at each level. |
| **Test Steps** | 1. Note subject prefix count and all quoted body levels in source. 2. Run migration. 3. Open email in Gmail. 4. Verify Re: Re: Re: subject prefix preserved. 5. Expand each quoted reply section and confirm content. |
| **Expected Result** | Subject shows `Re: Re: Re: Project Update` exactly. All quoted text levels present and readable. No truncation of quoted content. |

---

#### E2E-094 — Outlook RTF Body Email Converts Correctly

| Field | Details |
|-------|---------|
| **TC ID** | E2E-094 |
| **Title** | Email with Outlook-native RTF body converts to readable HTML/plain text in Gmail |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook has an email composed in RTF format (not HTML): bold text, bullet list, colored text — stored as `application/rtf` MIME part in the Exchange message. |
| **Test Steps** | 1. Compose/identify email in Outlook as RTF-formatted (not HTML — check via EWS bodyType = RTF). 2. Run migration. 3. Open email in Gmail. 4. Check body renders readable text (not raw RTF codes). 5. Verify formatting (bold, bullets) render correctly or degrade gracefully to plain text. |
| **Expected Result** | Email body is readable in Gmail. RTF format converted to HTML or plain text. No raw RTF escape sequences (`\rtf1`, `\pard`, etc.) visible in body. |

---

#### E2E-095 — Email With Empty Body (Subject Only)

| Field | Details |
|-------|---------|
| **TC ID** | E2E-095 |
| **Title** | Email with no body content (subject only) migrates without error |
| **Test Type** | E2E |
| **Priority** | P3 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook has an email where the body is completely empty (zero characters) and only the subject and headers are set. |
| **Test Steps** | 1. Confirm body is blank in Outlook. 2. Run migration. 3. Find email in Gmail by subject. 4. Open email. 5. Check body area. |
| **Expected Result** | Email appears in Gmail. Body area is blank — no error, no placeholder text injected. Subject, sender, and timestamp intact. |

---

### 3.3 Mail — Attachments

---

#### E2E-021 — PDF Attachment Migration

| Field | Details |
|-------|---------|
| **TC ID** | E2E-021 |
| **Title** | Email with PDF attachment migrates — filename and content intact |
| **Test Type** | E2E |
| **Priority** | P1 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source email has `qa-report.pdf` (~100KB). |
| **Test Steps** | 1. Note filename and size. 2. Run migration. 3. Download attachment from Gmail. 4. Verify filename = `qa-report.pdf`. 5. Open file — verify it is a valid PDF. |
| **Expected Result** | PDF attached. Filename exact match. File opens without corruption. |

---

#### E2E-022 — DOCX Attachment Migration

| Field | Details |
|-------|---------|
| **TC ID** | E2E-022 |
| **Title** | Email with Word document (.docx) attachment migrates correctly |
| **Test Type** | E2E |
| **Priority** | P1 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source email has `qa-document.docx` attached. |
| **Test Steps** | 1. Run migration. 2. Download DOCX from Gmail email. 3. Verify filename. 4. Open in Word — verify content. |
| **Expected Result** | `qa-document.docx` present. Content intact. MIME type preserved as `application/vnd.openxmlformats-officedocument.wordprocessingml.document`. |

---

#### E2E-023 — XLSX Attachment Migration

| Field | Details |
|-------|---------|
| **TC ID** | E2E-023 |
| **Title** | Email with Excel spreadsheet (.xlsx) attachment migrates correctly |
| **Test Type** | E2E |
| **Priority** | P1 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source email has `qa-spreadsheet.xlsx` attached. |
| **Test Steps** | 1. Run migration. 2. Find email in Gmail. 3. Download XLSX. 4. Open in Excel — verify content. |
| **Expected Result** | XLSX attachment present. Filename matches. File valid and opens correctly. |

---

#### E2E-024 — PNG / JPEG Image Attachment

| Field | Details |
|-------|---------|
| **TC ID** | E2E-024 |
| **Title** | Email with PNG and JPEG image attachments — both migrated correctly |
| **Test Type** | E2E |
| **Priority** | P1 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source email has `screenshot.png` and `photo.jpg` as attachments. |
| **Test Steps** | 1. Run migration. 2. Open email in Gmail. 3. Verify both image attachments appear. 4. Open each image — verify not corrupted. |
| **Expected Result** | Both `screenshot.png` and `photo.jpg` present. Images render correctly. |

---

#### E2E-025 — ZIP Archive Attachment

| Field | Details |
|-------|---------|
| **TC ID** | E2E-025 |
| **Title** | Email with ZIP archive attachment migrates correctly |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source email has `qa-archive.zip` attached. |
| **Test Steps** | 1. Run migration. 2. Download ZIP from Gmail email. 3. Extract ZIP. 4. Verify files inside are not corrupted. |
| **Expected Result** | ZIP attachment present. File extracts without errors. Content intact. |

---

#### E2E-026 — Multiple Attachments in One Email (5+ files)

| Field | Details |
|-------|---------|
| **TC ID** | E2E-026 |
| **Title** | Email with 5+ different file type attachments — all migrated |
| **Test Type** | E2E |
| **Priority** | P1 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source email has: `report.pdf`, `data.xlsx`, `notes.docx`, `photo.png`, `log.csv`, `readme.txt` (6 attachments). |
| **Test Steps** | 1. Note all 6 filenames and sizes. 2. Run migration. 3. Open email in Gmail. 4. Count and name all attachments. 5. Download each and verify. |
| **Expected Result** | All 6 attachments present. Filenames and types match. None missing. |

---

#### E2E-027 — Large Attachment (~20MB)

| Field | Details |
|-------|---------|
| **TC ID** | E2E-027 |
| **Title** | Email with ~20MB attachment migrates without size corruption |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source email has a ~20MB binary file attachment. |
| **Test Steps** | 1. Note attachment size in source (e.g., 20,480 KB). 2. Run migration. 3. Download from Gmail. 4. Check file size. |
| **Expected Result** | Attachment present in Gmail. File size within acceptable tolerance of source (±5%). File not truncated. |

---

#### E2E-028 — Attachment With Spaces in Filename

| Field | Details |
|-------|---------|
| **TC ID** | E2E-028 |
| **Title** | Attachment filename with spaces is preserved exactly |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source email has attachment named `Q1 2025 Report Final.xlsx`. |
| **Test Steps** | 1. Note exact filename (spaces included). 2. Run migration. 3. Check attachment in Gmail email. 4. Verify filename exactly. |
| **Expected Result** | Filename preserved as `Q1 2025 Report Final.xlsx`. Spaces not replaced with underscores or encoded. |

---

#### E2E-029 — Attachment With Special Characters in Filename

| Field | Details |
|-------|---------|
| **TC ID** | E2E-029 |
| **Title** | Attachment filename with special characters preserved |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source email has attachment `résumé (2024) — Final.docx`. |
| **Test Steps** | 1. Note exact filename. 2. Run migration. 3. Check attachment name in Gmail. |
| **Expected Result** | Filename `résumé (2024) — Final.docx` preserved. Accented characters and special characters not mangled. |

---

#### E2E-030 — ICS (Calendar Invite) as Email Attachment

| Field | Details |
|-------|---------|
| **TC ID** | E2E-030 |
| **Title** | Email with ICS file attached migrates with ICS attachment preserved |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook email has a `.ics` file attached (calendar invite from external system). |
| **Test Steps** | 1. Confirm ICS file attached in source. 2. Run migration. 3. Open email in Gmail. 4. Verify ICS attachment present. 5. Download and verify it is a valid iCal file. |
| **Expected Result** | ICS file attached in Gmail email. File is valid iCal format. |

---

#### E2E-031 — EML Attachment (Email as Attachment)

| Field | Details |
|-------|---------|
| **TC ID** | E2E-031 |
| **Title** | Email with another email saved as .eml attachment migrates correctly |
| **Test Type** | E2E |
| **Priority** | P3 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook email has an `.eml` file (forwarded message saved as file) as attachment. |
| **Test Steps** | 1. Confirm EML attachment in source. 2. Run migration. 3. Download EML from Gmail. 4. Open EML — verify it is a valid email message. |
| **Expected Result** | EML attachment present in Gmail. File is valid RFC 822 email format. |

---

### 3.4 Mail — Headers & Recipients

---

#### E2E-032 — Multiple TO Recipients

| Field | Details |
|-------|---------|
| **TC ID** | E2E-032 |
| **Title** | Email sent to multiple TO recipients — all preserved |
| **Test Type** | E2E |
| **Priority** | P1 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source email To: `alice@domain.com; bob@domain.com; carol@domain.com`. |
| **Test Steps** | 1. Note all To: addresses. 2. Run migration. 3. Open email in Gmail. 4. Check all To: recipients. |
| **Expected Result** | All 3 To: recipients preserved in order. |

---

#### E2E-033 — BCC Recipients Preserved

| Field | Details |
|-------|---------|
| **TC ID** | E2E-033 |
| **Title** | BCC recipient address preserved in migrated sent email |
| **Test Type** | E2E |
| **Priority** | P1 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Sent Items has email with TO: `alice@domain.com` and BCC: `secret@domain.com`. |
| **Test Steps** | 1. Confirm BCC in source email. 2. Run migration. 3. Open in Gmail Sent. 4. Expand recipient header. 5. Check BCC field. |
| **Expected Result** | BCC: `secret@domain.com` preserved in migrated email. |

---

#### E2E-096 — BCC-Only Sent Email (No TO Recipient)

| Field | Details |
|-------|---------|
| **TC ID** | E2E-096 |
| **Title** | Sent email with empty TO field and only BCC recipient migrates correctly |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook Sent Items has an email where the TO field is empty and only the BCC field is populated (`bcc@domain.com`). |
| **Test Steps** | 1. Confirm source email: TO = empty, BCC = `bcc@domain.com`. 2. Run migration. 3. Find email in Gmail Sent (search by subject). 4. Open email. 5. Check TO field (should be empty or "(undisclosed recipients)"). 6. Check BCC field. |
| **Expected Result** | Email migrated successfully. TO field is empty or shows "(undisclosed recipients)". BCC address `bcc@domain.com` preserved. No migration error for missing TO recipient. |

---

#### E2E-034 — Reply-To Different From Sender

| Field | Details |
|-------|---------|
| **TC ID** | E2E-034 |
| **Title** | Email with Reply-To different from From preserved |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source email: From: `noreply@service.com`, Reply-To: `support@service.com`. |
| **Test Steps** | 1. Note From and Reply-To in source. 2. Run migration. 3. Click Reply in Gmail on migrated email. 4. Check To: field of reply (should be Reply-To address). |
| **Expected Result** | Reply-To: `support@service.com` preserved. Clicking Reply in Gmail pre-fills to `support@service.com`, not `noreply@service.com`. |

---

#### E2E-035 — External Sender Email Preserved

| Field | Details |
|-------|---------|
| **TC ID** | E2E-035 |
| **Title** | Email from external domain sender — From address preserved |
| **Test Type** | E2E |
| **Priority** | P1 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Inbox has email from `vendor@external-company.com`. |
| **Test Steps** | 1. Note From address. 2. Run migration. 3. Open email in Gmail. 4. Check From field. |
| **Expected Result** | From: `vendor@external-company.com` preserved exactly. Display name also preserved. |

---

#### E2E-036 — Distribution List as Recipient

| Field | Details |
|-------|---------|
| **TC ID** | E2E-036 |
| **Title** | Email sent to a distribution list — email migrated, members not recreated |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ✅ In Scope (emails migrated) / ❌ Out of Scope (members not at destination) |
| **Pre-condition** | Source Sent Items has email To: `all-staff@company.com` (distribution list). |
| **Test Steps** | 1. Confirm email To: distribution list address. 2. Run migration. 3. Open in Gmail Sent. 4. Check To: field. 5. Verify no new Google Group members were created. |
| **Expected Result** | Email migrated. To: shows `all-staff@company.com`. No individual member accounts created in destination Google Workspace. |

---

#### E2E-037 — Cross-Domain Address Mapping

| Field | Details |
|-------|---------|
| **TC ID** | E2E-037 |
| **Title** | Internal user email addresses rewritten to destination domain |
| **Test Type** | E2E |
| **Priority** | P1 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Mapping: `alex@qatestagent.com → alex@migrationn.com`. Source email To: `alex@qatestagent.com`, CC: `dan@qatestagent.com`. |
| **Test Steps** | 1. Note source addresses. 2. Configure migration with address mapping. 3. Run migration. 4. Open email in Gmail. 5. Verify To: and CC: fields. |
| **Expected Result** | To: `alex@migrationn.com`. CC: `dan@migrationn.com`. Source domain `qatestagent.com` replaced with `migrationn.com`. |

---

#### E2E-038 — Sender Display Name With Special Characters

| Field | Details |
|-------|---------|
| **TC ID** | E2E-038 |
| **Title** | Sender display name with accented/encoded characters preserved |
| **Test Type** | E2E |
| **Priority** | P3 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source email From: `"Søren Müller" <s.muller@corp.com>`. |
| **Test Steps** | 1. Note display name. 2. Run migration. 3. Check From display name in Gmail. |
| **Expected Result** | Display name shows `Søren Müller` correctly. Accented characters not corrupted. |

---

### 3.5 Mail — Email Properties

---

#### E2E-039 — High Importance Preserved

| Field | Details |
|-------|---------|
| **TC ID** | E2E-039 |
| **Title** | Outlook high-importance email importance indicator preserved in Gmail |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook email has Importance = High (red `!` indicator). |
| **Test Steps** | 1. Confirm importance in source. 2. Run migration. 3. Open email in Gmail. 4. Check Important label or indicator. |
| **Expected Result** | Email marked as Important in Gmail. |

---

#### E2E-040 — Low Importance Email

| Field | Details |
|-------|---------|
| **TC ID** | E2E-040 |
| **Title** | Outlook low-importance email migrates without importance elevation |
| **Test Type** | E2E |
| **Priority** | P3 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source email has Importance = Low (blue ↓ indicator). |
| **Test Steps** | 1. Confirm low importance in source. 2. Run migration. 3. Open in Gmail. 4. Verify no Important label. |
| **Expected Result** | Email in Gmail has no Important label. Appears as normal (non-important) email. |

---

#### E2E-041 — Categories NOT Migrated (Expected)

| Field | Details |
|-------|---------|
| **TC ID** | E2E-041 |
| **Title** | Outlook email categories are NOT migrated to Gmail (documented limitation) |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ❌ Out of Scope |
| **Pre-condition** | Source Outlook email has categories: "Red Category", "Blue Category". |
| **Test Steps** | 1. Confirm categories on email in Outlook. 2. Run migration. 3. Open email in Gmail. 4. Check for any labels that match category names. |
| **Expected Result** | Email migrated. **No Gmail labels created for categories.** No error thrown. Email content fully intact. |

---

#### E2E-042 — Sensitivity Label NOT Migrated (Expected)

| Field | Details |
|-------|---------|
| **TC ID** | E2E-042 |
| **Title** | Outlook sensitivity label (Confidential/Internal) not migrated — Graph API limitation |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ❌ Out of Scope |
| **Pre-condition** | Source Outlook email has a Microsoft Purview sensitivity label "Confidential — Internal". |
| **Test Steps** | 1. Confirm sensitivity label visible in Outlook. 2. Run migration. 3. Open email in Gmail. 4. Check if any classification label was applied. |
| **Expected Result** | Email migrated. **No sensitivity label in Gmail** (Graph API does not expose this). No error. Email body intact. |

---

#### E2E-043 — Encrypted Email Tag NOT Preserved (Expected)

| Field | Details |
|-------|---------|
| **TC ID** | E2E-043 |
| **Title** | Encrypted/non-encrypted mail tag not preserved — platform limitation |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ❌ Out of Scope |
| **Pre-condition** | Source Outlook has an email tagged as encrypted (IRM protected or S/MIME). |
| **Test Steps** | 1. Confirm encryption tag in Outlook. 2. Run migration. 3. Open in Gmail. 4. Check for encryption indicator. |
| **Expected Result** | Email migrated (if accessible). **Encryption tag not preserved.** No crash. |

---

#### E2E-044 — Completed Flag (Follow-Up Done)

| Field | Details |
|-------|---------|
| **TC ID** | E2E-044 |
| **Title** | Outlook email with Completed flag status migrates correctly |
| **Test Type** | E2E |
| **Priority** | P3 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source email has flag status = Completed (green check in Outlook). |
| **Test Steps** | 1. Confirm completed flag. 2. Run migration. 3. Check email state in Gmail. |
| **Expected Result** | Email migrated. Flag/star state handled gracefully (may appear as Starred or normal — document actual behavior). |

---

#### E2E-097 — Voting Buttons NOT Migrated (Expected)

| Field | Details |
|-------|---------|
| **TC ID** | E2E-097 |
| **Title** | Outlook voting button requests are NOT migrated — Outlook-specific feature |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ❌ Out of Scope |
| **Pre-condition** | Source Outlook has an email with voting buttons added ("Yes / No / Maybe"). |
| **Test Steps** | 1. Confirm voting buttons visible in Outlook (Action bar shows Yes/No/Maybe). 2. Run migration. 3. Open migrated email in Gmail. 4. Check if any voting widget or button appears. |
| **Expected Result** | Email migrated with full body content. **Voting buttons not rendered in Gmail** (no equivalent Gmail feature). Body text intact. No error. |

---

#### E2E-098 — Out-of-Office Auto-Reply Email Migrates as Regular Email

| Field | Details |
|-------|---------|
| **TC ID** | E2E-098 |
| **Title** | Auto-reply (Out-of-Office) email received in Outlook Inbox migrates as a standard email |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook Inbox has an auto-reply response email (from sender's Out-of-Office rule, `X-Auto-Response-Suppress` headers present, subject: "Out of Office: Project Update"). |
| **Test Steps** | 1. Confirm auto-reply email in Outlook Inbox. 2. Note subject, sender, body, and received timestamp. 3. Run migration. 4. Open email in Gmail Inbox. 5. Verify subject, body, timestamp. |
| **Expected Result** | Email migrated to Gmail as a regular inbox email. Subject, sender, body all preserved. Auto-reply header metadata may be stripped — this is expected. Email is readable and not missing. |

---

### 3.6 Mail — Custom Folders & Labels

---

#### E2E-045 — Top-Level Custom Folder

| Field | Details |
|-------|---------|
| **TC ID** | E2E-045 |
| **Title** | Top-level Outlook custom folder migrates as Gmail label |
| **Test Type** | E2E |
| **Priority** | P1 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook has folder `QA-ProjectX` at root level with 3 emails. |
| **Test Steps** | 1. Confirm folder and 3 emails. 2. Run migration. 3. Open Gmail Labels. 4. Find `QA-ProjectX`. 5. Count emails. |
| **Expected Result** | Gmail label `QA-ProjectX` created. All 3 emails under it. |

---

#### E2E-046 — Two-Level Nested Folder Hierarchy

| Field | Details |
|-------|---------|
| **TC ID** | E2E-046 |
| **Title** | Two-level nested Outlook folder migrates as nested Gmail label |
| **Test Type** | E2E |
| **Priority** | P1 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source: `Projects/Alpha` (parent/child). Emails in child folder. |
| **Test Steps** | 1. Confirm nested structure. 2. Run migration. 3. Check Gmail label `Projects/Alpha`. 4. Verify hierarchy in Gmail label tree. |
| **Expected Result** | `Projects` parent label and `Alpha` child label created. Hierarchy: `Projects > Alpha`. |

---

#### E2E-047 — Deep Nested Folder (5+ Levels)

| Field | Details |
|-------|---------|
| **TC ID** | E2E-047 |
| **Title** | Deeply nested Outlook folder structure migrates with hierarchy intact |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source folder: `L1/L2/L3/L4/L5` with emails at each level. |
| **Test Steps** | 1. Confirm 5-level hierarchy. 2. Run migration. 3. Check Gmail labels for each level. 4. Verify emails at each level. |
| **Expected Result** | All 5 label levels created in Gmail. Each email under correct label. |

---

#### E2E-048 — Empty Custom Folder Migration

| Field | Details |
|-------|---------|
| **TC ID** | E2E-048 |
| **Title** | Empty Outlook custom folder migrates as Gmail label (even with no emails) |
| **Test Type** | E2E |
| **Priority** | P3 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook has custom folder `QA-EmptyFolder` with zero emails. |
| **Test Steps** | 1. Confirm folder is empty in Outlook. 2. Run migration. 3. Check Gmail Labels list. |
| **Expected Result** | Label `QA-EmptyFolder` exists in Gmail (even if empty). OR label not created — document actual behavior. No error. |

---

#### E2E-049 — Folder With Emoji in Name (Long — Expected Truncation)

| Field | Details |
|-------|---------|
| **TC ID** | E2E-049 |
| **Title** | Outlook folder with very long emoji name — Gmail API limit handled gracefully |
| **Test Type** | E2E |
| **Priority** | P3 |
| **Scope** | ❌ Out of Scope (known limitation) |
| **Pre-condition** | Source Outlook has folder with name containing 50+ emoji characters (exceeds Gmail 225-char label limit). |
| **Test Steps** | 1. Create folder with very long emoji name. 2. Run migration. 3. Check Gmail labels. 4. Check migration logs for any errors. |
| **Expected Result** | Label name truncated OR migration gracefully skips/renames. **No crash or fatal error.** Other emails unaffected. |

---

#### E2E-050 — Conversation History Folder NOT Migrated

| Field | Details |
|-------|---------|
| **TC ID** | E2E-050 |
| **Title** | Outlook Conversation History folder (Teams/Skype chat) not migrated |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ❌ Out of Scope |
| **Pre-condition** | Source Outlook has a Conversation History folder with Skype/Teams chat logs. |
| **Test Steps** | 1. Confirm Conversation History folder in Outlook. 2. Run migration. 3. Check Gmail for any label named "Conversation History". |
| **Expected Result** | Conversation History folder NOT migrated to Gmail. No corresponding label. Email migration completes normally. |

---

### 3.7 Calendar

---

#### E2E-051 — Single-Instance Event: All Fields Preserved

| Field | Details |
|-------|---------|
| **TC ID** | E2E-051 |
| **Title** | Single calendar event — title, date, time, location, description, attendees all preserved |
| **Test Type** | E2E |
| **Priority** | P1 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook has event: Title: "QA Meeting", Date: 2026-06-01 10:00 AM UTC, Location: "Conference Room A", Attendees: `alice@domain.com`, Description: "Quarterly review." |
| **Test Steps** | 1. Note all event fields. 2. Run migration. 3. Open Google Calendar. 4. Find event. 5. Check each field. |
| **Expected Result** | All fields match: Title, Date/Time, Location, Attendees, Description. |

---

#### E2E-052 — Single-Instance Event: Teams Link Converted to Google Meet

| Field | Details |
|-------|---------|
| **TC ID** | E2E-052 |
| **Title** | Outlook event with Teams meeting link — link converted to Google Meet after migration |
| **Test Type** | E2E |
| **Priority** | P1 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook event has a Microsoft Teams meeting link in the body/conference field. |
| **Test Steps** | 1. Confirm Teams link in source event. 2. Run migration. 3. Open event in Google Calendar. 4. Check conference/meeting link. |
| **Expected Result** | Teams link replaced with (or supplemented by) a Google Meet link. Event fully accessible. |

---

#### E2E-053 — Attendee RSVP Status Preserved

| Field | Details |
|-------|---------|
| **TC ID** | E2E-053 |
| **Title** | Calendar event attendee response status (accepted/declined/tentative) preserved |
| **Test Type** | E2E |
| **Priority** | P1 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook event has: Organizer = accepted, Attendee 1 = accepted, Attendee 2 = declined, Attendee 3 = tentative. |
| **Test Steps** | 1. Note each attendee's response status. 2. Run migration. 3. Open event in Google Calendar. 4. Check attendee response states. |
| **Expected Result** | Accepted = accepted, Declined = declined, Tentative = tentative. Status preserved for all attendees. |

---

#### E2E-054 — Past Calendar Event Migration

| Field | Details |
|-------|---------|
| **TC ID** | E2E-054 |
| **Title** | Past calendar event (historical record) migrates to Google Calendar |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook has a past event from `2025-01-15` (already occurred). |
| **Test Steps** | 1. Confirm past event in Outlook. 2. Run migration. 3. Navigate to January 2025 in Google Calendar. 4. Verify event exists. |
| **Expected Result** | Past event appears in Google Calendar on correct historical date. Creator/organizer's calendar shows it. |

---

#### E2E-055 — Past Event: Attendees NOT Re-Notified

| Field | Details |
|-------|---------|
| **TC ID** | E2E-055 |
| **Title** | Past non-recurring event attendees do not receive notification after migration |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ❌ Out of Scope (expected behavior) |
| **Pre-condition** | Source has past single-instance event with 2 attendees. Migration completed. |
| **Test Steps** | 1. Run migration. 2. Monitor attendee inboxes for post-migration notifications. |
| **Expected Result** | Attendees receive **no** calendar invite or notification. Event migrated only to organizer's calendar as historical record. |

---

#### E2E-056 — All-Day Event Migration

| Field | Details |
|-------|---------|
| **TC ID** | E2E-056 |
| **Title** | All-day Outlook event migrates correctly as all-day event in Google Calendar |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook has an all-day event on `2026-07-04`. |
| **Test Steps** | 1. Confirm all-day event in Outlook. 2. Run migration. 3. Check Google Calendar July 4, 2026. |
| **Expected Result** | Event appears as all-day event (no specific time) on correct date. |

---

#### E2E-057 — Multi-Day Event

| Field | Details |
|-------|---------|
| **TC ID** | E2E-057 |
| **Title** | Multi-day Outlook event spans correct days in Google Calendar |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook event spans `2026-07-10 to 2026-07-12` (3 days). |
| **Test Steps** | 1. Note start and end dates. 2. Run migration. 3. Check Google Calendar. 4. Verify event spans all 3 days. |
| **Expected Result** | Event visible across July 10, 11, and 12 in Google Calendar. |

---

#### E2E-058 — Weekly Recurring Event (4 Occurrences)

| Field | Details |
|-------|---------|
| **TC ID** | E2E-058 |
| **Title** | Weekly recurring event — all 4 occurrences migrate with correct recurrence pattern |
| **Test Type** | E2E |
| **Priority** | P1 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source has weekly recurring event, FREQ=WEEKLY, COUNT=4, starting 2026-06-02. |
| **Test Steps** | 1. Note recurrence rule. 2. Run migration. 3. Check Google Calendar for June 2, 9, 16, 23. 4. Verify all 4 occurrences. |
| **Expected Result** | 4 occurrences on correct dates. Google Calendar shows it as a recurring series. |

---

#### E2E-059 — Monthly Recurring Event

| Field | Details |
|-------|---------|
| **TC ID** | E2E-059 |
| **Title** | Monthly recurring Outlook event migrates with correct monthly pattern |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source has event recurring on the 1st of every month for 3 months. |
| **Test Steps** | 1. Note recurrence: FREQ=MONTHLY, COUNT=3. 2. Run migration. 3. Check Google Calendar. 4. Verify 3 monthly occurrences. |
| **Expected Result** | Event appears on 1st of 3 consecutive months. Monthly recurrence pattern preserved. |

---

#### E2E-060 — Recurring Event With Modified Occurrence (Known Limitation)

| Field | Details |
|-------|---------|
| **TC ID** | E2E-060 |
| **Title** | Recurring event with one modified occurrence — migration behavior documented |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ❌ Out of Scope (platform limitation) |
| **Pre-condition** | Source Outlook has weekly recurring event where 2nd occurrence was modified (different title) and 3rd occurrence was deleted. |
| **Test Steps** | 1. Confirm modifications in Outlook. 2. Run migration. 3. Open Google Calendar. 4. Check all occurrences. 5. Note any differences from source. |
| **Expected Result** | Migration completes. Occurrences may NOT reflect individual modifications (Outlook exceptions don't map to Google Calendar). **Modification lost and deleted occurrence reappears** — this is documented known behavior, not a bug. |

---

#### E2E-061 — Calendar Event With Attachment

| Field | Details |
|-------|---------|
| **TC ID** | E2E-061 |
| **Title** | Calendar event with file attachment migrates with attachment preserved |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook event has a PDF file attached to it. |
| **Test Steps** | 1. Confirm event attachment in Outlook. 2. Run migration. 3. Open event in Google Calendar. 4. Check for attachment. 5. Download and verify. |
| **Expected Result** | Attachment present in Google Calendar event. File accessible and not corrupted. |

---

#### E2E-062 — Past Calendar Event With Attachment

| Field | Details |
|-------|---------|
| **TC ID** | E2E-062 |
| **Title** | Past calendar event attachment migrates successfully |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source has a historical calendar event (past date) with a document attached. |
| **Test Steps** | 1. Confirm past event with attachment. 2. Run migration. 3. Find event in Google Calendar past dates. 4. Check attachment. |
| **Expected Result** | Attachment present in migrated past event in Google Calendar. |

---

#### E2E-063 — Non-UTC Timezone Event

| Field | Details |
|-------|---------|
| **TC ID** | E2E-063 |
| **Title** | Calendar event with non-UTC timezone (Eastern Time) preserves correct time |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source event start: `2026-06-10 09:00 AM Eastern Standard Time (UTC-5)` — which is `14:00 UTC`. |
| **Test Steps** | 1. Note event time and timezone in Outlook. 2. Run migration. 3. Open event in Google Calendar (set calendar to Eastern Time). 4. Verify time. |
| **Expected Result** | Event shows `09:00 AM EST` (or equivalent UTC-5 offset) in Google Calendar. Time not shifted incorrectly. |

---

#### E2E-064 — Private Calendar Event

| Field | Details |
|-------|---------|
| **TC ID** | E2E-064 |
| **Title** | Private Outlook calendar event migrates and remains private in Google Calendar |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook event has Privacy = Private. |
| **Test Steps** | 1. Confirm private flag on event in Outlook. 2. Run migration. 3. Check event in Google Calendar. 4. Verify visibility setting. |
| **Expected Result** | Event migrated. Visibility preserved as private. Non-owner attendees see "Private" placeholder. |

---

#### E2E-065 — Primary Calendar Event

| Field | Details |
|-------|---------|
| **TC ID** | E2E-065 |
| **Title** | Events from Outlook primary calendar appear in Google primary calendar |
| **Test Type** | E2E |
| **Priority** | P1 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook default/primary calendar has 3 events. |
| **Test Steps** | 1. Confirm events in primary Outlook calendar. 2. Run migration. 3. Open Google Calendar primary. 4. Count and verify events. |
| **Expected Result** | All 3 events in Google primary calendar. Not in secondary or other calendar. |

---

#### E2E-066 — Secondary Calendar Migration

| Field | Details |
|-------|---------|
| **TC ID** | E2E-066 |
| **Title** | Outlook secondary/personal calendar migrates as separate Google Calendar |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook has secondary calendar "QA Personal Calendar" with 2 events. |
| **Test Steps** | 1. Confirm secondary calendar. 2. Run migration. 3. Check Google Calendar sidebar for "QA Personal Calendar". 4. Verify 2 events under it. |
| **Expected Result** | "QA Personal Calendar" created in Google Calendar. Both events present. Separate from primary calendar. |

---

#### E2E-067 — Shared Calendar Migration

| Field | Details |
|-------|---------|
| **TC ID** | E2E-067 |
| **Title** | Outlook shared calendar migrates with sharing permissions to Google Calendar |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook user has shared their calendar with `colleague@domain.com`. |
| **Test Steps** | 1. Confirm calendar sharing in Outlook. 2. Run migration. 3. Check Google Calendar. 4. Verify `colleague@domain.com` can see the migrated calendar. |
| **Expected Result** | Shared calendar migrated. `colleague@domain.com` has access ("Make changes and manage sharing" permission). |

---

#### E2E-068 — Calendar Permissions / Delegate Access

| Field | Details |
|-------|---------|
| **TC ID** | E2E-068 |
| **Title** | Outlook calendar delegate access migrated to Google Calendar |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source user `john@domain.com` has delegated calendar access to `assistant@domain.com`. |
| **Test Steps** | 1. Confirm delegate in Outlook. 2. Run migration. 3. Check Google Calendar permissions for `assistant@domain.com`. |
| **Expected Result** | Delegate can access migrated Google Calendar with "Make changes and manage sharing" permission. |

---

#### E2E-069 — External Organizer Invite (Expected Notification)

| Field | Details |
|-------|---------|
| **TC ID** | E2E-069 |
| **Title** | Calendar event with external organizer — system sends organizer notification (expected) |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ❌ Out of Scope (expected side effect, not a bug) |
| **Pre-condition** | Source Outlook has event created by `external-organizer@vendor.com`. |
| **Test Steps** | 1. Run migration. 2. Monitor `external-organizer@vendor.com` inbox. |
| **Expected Result** | External organizer may receive a notification email about event modification. This is expected RFC 5545 behavior — not a bug. Migration team should suppress outbound notifications during migration window if possible. |

---

#### E2E-070 — Group Calendar Migration

| Field | Details |
|-------|---------|
| **TC ID** | E2E-070 |
| **Title** | Outlook group calendar migrates with sharing and event access |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook has a group calendar shared with a team. |
| **Test Steps** | 1. Confirm group calendar and access list. 2. Run migration. 3. Check Google Calendar for group calendar. 4. Verify team members can view events. |
| **Expected Result** | Group calendar migrated. Team members retain access. Events visible. |

---

#### E2E-099 — Calendar Event Free/Busy Status Preserved

| Field | Details |
|-------|---------|
| **TC ID** | E2E-099 |
| **Title** | Outlook calendar event show-as status (Busy / Free / Tentative / OOF) preserved in Google Calendar |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook has 4 events with different show-as values: (1) Busy, (2) Free, (3) Tentative, (4) Out of Office. |
| **Test Steps** | 1. Note the show-as status for each of the 4 events in Outlook. 2. Run migration. 3. Open each event in Google Calendar. 4. Check the "Show as" / status field under event details. |
| **Expected Result** | Busy → Busy. Free → Free. Tentative → Tentative. Out of Office → Out of Office (or nearest Google Calendar equivalent). Status not defaulted to Busy for all events. |

---

### 3.8 Contacts

---

#### E2E-071 — Basic Contact: Name, Email, Phone

| Field | Details |
|-------|---------|
| **TC ID** | E2E-071 |
| **Title** | Outlook contact with name, email, and phone migrates to Google Contacts |
| **Test Type** | E2E |
| **Priority** | P1 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source contact: Name: "Jane Smith", Email: `jane@domain.com`, Phone: `+1-555-0001`. |
| **Test Steps** | 1. Note contact fields. 2. Run migration. 3. Search Google Contacts for "Jane Smith". 4. Verify all fields. |
| **Expected Result** | Contact found. Name, email, phone all match source exactly. |

---

#### E2E-072 — Contact With Notes / Personal Notes

| Field | Details |
|-------|---------|
| **TC ID** | E2E-072 |
| **Title** | Contact with notes field migrates with notes intact |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook contact has Notes: "Key supplier for Q3. Prefers email contact.". |
| **Test Steps** | 1. Confirm notes in Outlook contact. 2. Run migration. 3. Open Google Contact. 4. Check Notes field. |
| **Expected Result** | Notes text preserved exactly in Google Contacts. |

---

#### E2E-073 — Contact With Address

| Field | Details |
|-------|---------|
| **TC ID** | E2E-073 |
| **Title** | Contact with home/business address migrates with address intact |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source contact has address: `123 Main Street, San Francisco, CA 94107, US`. |
| **Test Steps** | 1. Note address. 2. Run migration. 3. Check Google Contact address. |
| **Expected Result** | Address (street, city, state, zip, country) preserved. |

---

#### E2E-074 — Contact With Birthday

| Field | Details |
|-------|---------|
| **TC ID** | E2E-074 |
| **Title** | Outlook contact birthday date migrates to Google Contacts |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source contact has birthday: `1990-06-15`. |
| **Test Steps** | 1. Confirm birthday in Outlook contact. 2. Run migration. 3. Open Google Contact. 4. Check Birthday field. |
| **Expected Result** | Birthday `June 15, 1990` preserved in Google Contacts. |

---

#### E2E-075 — Contact Photo NOT Migrated (Expected)

| Field | Details |
|-------|---------|
| **TC ID** | E2E-075 |
| **Title** | Contact profile photo is NOT migrated — documented behavior |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ❌ Out of Scope |
| **Pre-condition** | Source Outlook contact has a profile photo. |
| **Test Steps** | 1. Confirm photo on contact. 2. Run migration. 3. Open Google Contact. 4. Check for photo. |
| **Expected Result** | Contact migrated without photo. All other fields intact. No error. |

---

#### E2E-076 — Contact Categories NOT Migrated (Expected)

| Field | Details |
|-------|---------|
| **TC ID** | E2E-076 |
| **Title** | Outlook contact categories (tags) not migrated — API limitation |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ❌ Out of Scope |
| **Pre-condition** | Source Outlook contact is tagged with category "VIP Client". |
| **Test Steps** | 1. Confirm category on contact. 2. Run migration. 3. Check Google Contact for any tag/label. |
| **Expected Result** | Contact migrated. Category/tag not present in Google Contacts. No error. |

---

#### E2E-077 — Contact Lists / Groups NOT Migrated (Expected)

| Field | Details |
|-------|---------|
| **TC ID** | E2E-077 |
| **Title** | Outlook contact group (distribution list) not migrated — Google Contacts limitation |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ❌ Out of Scope |
| **Pre-condition** | Source Outlook has a contact group "Executive Team" with 5 members. |
| **Test Steps** | 1. Confirm contact group in Outlook. 2. Run migration. 3. Check Google Contacts for any group. |
| **Expected Result** | Contact group NOT migrated. Individual contacts may be migrated but group structure not preserved. No crash. |

---

#### E2E-078 — Multiple Email Addresses per Contact

| Field | Details |
|-------|---------|
| **TC ID** | E2E-078 |
| **Title** | Contact with multiple email addresses (work + personal) — all preserved |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source contact has Work: `john@corp.com`, Personal: `john.personal@gmail.com`, Other: `john@home.net`. |
| **Test Steps** | 1. Note all 3 email addresses. 2. Run migration. 3. Open Google Contact. 4. Check email addresses. |
| **Expected Result** | All 3 email addresses preserved in Google Contacts with correct labels (Work, Personal, Other). |

---

#### E2E-100 — Contact With Job Title, Company, and Website URL

| Field | Details |
|-------|---------|
| **TC ID** | E2E-100 |
| **Title** | Outlook contact with job title, company name, department, and website URL migrated correctly |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook contact: Name: "David Chen", Job Title: "Senior Engineer", Company: "Acme Corp", Department: "Engineering", Website: `https://acme.com`. |
| **Test Steps** | 1. Note all 5 fields in Outlook contact. 2. Run migration. 3. Open Google Contact "David Chen". 4. Check each field: Job Title, Company, Department, Website. |
| **Expected Result** | All fields preserved: Job Title = "Senior Engineer", Company = "Acme Corp", Department = "Engineering", Website = `https://acme.com`. None defaulted to blank. |

---

### 3.9 Migration Types

---

#### E2E-079 — One-Time (Full) Migration Completeness

| Field | Details |
|-------|---------|
| **TC ID** | E2E-079 |
| **Title** | Full one-time migration migrates all mail, calendar, and contacts |
| **Test Type** | E2E |
| **Priority** | P1 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook has mail in all folders, calendar events, and contacts. Migration configured for Full. |
| **Test Steps** | 1. Count source: total emails, events, contacts. 2. Run full migration. 3. Count destination: total emails, events, contacts. 4. Compare. |
| **Expected Result** | Destination counts match source (within expected out-of-scope exclusions). No data loss. |

---

#### E2E-080 — Delta Migration — No Duplicates

| Field | Details |
|-------|---------|
| **TC ID** | E2E-080 |
| **Title** | Delta migration after full migration — no email duplication |
| **Test Type** | E2E |
| **Priority** | P1 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Full migration completed. 3 new emails added to source after migration. |
| **Test Steps** | 1. Run delta migration. 2. Count total emails in destination after delta. 3. Compare: should be (original count) + 3. 4. Search for specific old emails to confirm no duplicates. |
| **Expected Result** | Exactly 3 new emails added. Previously migrated emails NOT duplicated. |

---

#### E2E-081 — Delta Migration — Read Status of New Emails

| Field | Details |
|-------|---------|
| **TC ID** | E2E-081 |
| **Title** | Delta migration preserves read/unread state of newly added emails |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | After full migration, 1 new unread and 1 new read email added to source Outlook. |
| **Test Steps** | 1. Add unread and read email to source. 2. Run delta migration. 3. Check both emails in Gmail. |
| **Expected Result** | Unread email arrives unread in Gmail. Read email arrives read. State preserved in delta. |

---

### 3.10 Out-of-Scope Verification

---

#### E2E-082 — Notes NOT Migrated

| Field | Details |
|-------|---------|
| **TC ID** | E2E-082 |
| **Title** | Outlook Notes (sticky notes) not migrated — no equivalent in Gmail |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ❌ Out of Scope |
| **Pre-condition** | Source Outlook has 3 sticky Notes items. |
| **Test Steps** | 1. Confirm Notes in Outlook. 2. Run migration. 3. Check Gmail for any Notes. |
| **Expected Result** | Notes NOT migrated. No Gmail equivalent created. Mail migration completes without error. |

---

#### E2E-083 — To-Do / Tasks NOT Migrated

| Field | Details |
|-------|---------|
| **TC ID** | E2E-083 |
| **Title** | Outlook To-Do / Tasks items not migrated — no equivalent in Gmail |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ❌ Out of Scope |
| **Pre-condition** | Source Outlook has 2 tasks in To-Do list. |
| **Test Steps** | 1. Confirm tasks in Outlook. 2. Run migration. 3. Check Gmail and Google Tasks. |
| **Expected Result** | Tasks NOT migrated. No Google Tasks created. No error. |

---

#### E2E-084 — Inbox Rules NOT Migrated

| Field | Details |
|-------|---------|
| **TC ID** | E2E-084 |
| **Title** | Outlook inbox rules not migrated — API limitation and platform incompatibility |
| **Test Type** | E2E |
| **Priority** | P1 |
| **Scope** | ❌ Out of Scope |
| **Pre-condition** | Source Outlook has 3 inbox rules (From-based routing, subject filtering, forwarding). |
| **Test Steps** | 1. Document all rules in Outlook. 2. Run migration. 3. Open Gmail Settings → Filters and Blocked Addresses. 4. Check for any created filters. |
| **Expected Result** | No Gmail filters created. Mail migrated correctly. User receives no notification about rules. |

---

#### E2E-085 — Rooms/Resources NOT Migrated

| Field | Details |
|-------|---------|
| **TC ID** | E2E-085 |
| **Title** | Outlook Room / Resource mailboxes not migrated |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ❌ Out of Scope |
| **Pre-condition** | Outlook has a Room resource `Conference-Room-A@company.com`. |
| **Test Steps** | 1. Confirm room resource exists in Outlook. 2. Run migration. 3. Check Google Workspace admin for any resource. |
| **Expected Result** | Room resource NOT migrated. Other mailboxes in scope unaffected. |

---

#### E2E-086 — Legal Hold Emails — Migration Behavior

| Field | Details |
|-------|---------|
| **TC ID** | E2E-086 |
| **Title** | Emails under Legal Hold migrate (content) but metadata may be incomplete |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ❌ Out of Scope (full metadata not accessible) |
| **Pre-condition** | Source Outlook mailbox has emails under Legal Hold. |
| **Test Steps** | 1. Confirm Legal Hold emails. 2. Run migration. 3. Check if emails appear in Gmail. 4. Check if metadata (timestamps, headers) are complete. |
| **Expected Result** | Migration completes without crash. Legal Hold emails may migrate with incomplete metadata or be skipped. Behavior documented. |

---

#### E2E-087 — Admin Settings NOT Migrated

| Field | Details |
|-------|---------|
| **TC ID** | E2E-087 |
| **Title** | Outlook admin/user mailbox settings not migrated |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ❌ Out of Scope |
| **Pre-condition** | Source Outlook has custom mailbox policies, retention policies, permissions. |
| **Test Steps** | 1. Document Outlook settings. 2. Run migration. 3. Check Gmail admin console for equivalent settings. |
| **Expected Result** | Settings NOT migrated. Email migration completes. User must reconfigure policies manually in Gmail. |

---

#### E2E-088 — Mailbox Policy Blocks Migration (Expected)

| Field | Details |
|-------|---------|
| **TC ID** | E2E-088 |
| **Title** | If mailbox policy applied — emails blocked from migration (expected) |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ❌ Out of Scope |
| **Pre-condition** | Source Outlook mailbox has a DLP/retention policy that blocks data export. |
| **Test Steps** | 1. Apply policy to mailbox. 2. Run migration. 3. Check migration logs and email count. |
| **Expected Result** | Affected emails skipped/not migrated. Migration tool logs the blocked emails clearly. Migration does not crash. Other mailboxes unaffected. |

---

#### E2E-089 — In-Place Archive NOT Migrated as Regular Mail

| Field | Details |
|-------|---------|
| **TC ID** | E2E-089 |
| **Title** | Outlook In-Place Archive (secondary mailbox) behavior during migration |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ❌ Out of Scope |
| **Pre-condition** | Source Outlook user has an In-Place Archive mailbox with old emails. |
| **Test Steps** | 1. Confirm In-Place Archive exists. 2. Run standard migration. 3. Check if archive emails appear in Gmail. |
| **Expected Result** | In-Place Archive emails are NOT migrated in standard flow. Tool does not crash. Behavior clearly documented. |

---

#### E2E-101 — Outlook Search Folders NOT Migrated

| Field | Details |
|-------|---------|
| **TC ID** | E2E-101 |
| **Title** | Outlook Search Folders (virtual folders) not migrated — no Gmail equivalent |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ❌ Out of Scope |
| **Pre-condition** | Source Outlook has one or more Search Folders (virtual, query-based folders such as "Unread Mail", "Large Mail", custom saved searches). |
| **Test Steps** | 1. Confirm Search Folders exist in Outlook (they appear under the Search Folders node in the folder tree). 2. Run migration. 3. Open Gmail Labels. 4. Check if any label was created matching the search folder names. |
| **Expected Result** | Search Folders NOT migrated as Gmail labels or filters. Emails that appeared in those search results are migrated via their actual folder (Inbox, Sent, etc.). No error thrown. Migration log does not treat missing search folder as data loss. |

---

#### E2E-090 — Thread Grouping Preserved Across Folders

| Field | Details |
|-------|---------|
| **TC ID** | E2E-090 |
| **Title** | Email thread where messages are split across Inbox and Sent Items groups correctly in Gmail |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source thread: initial email in Inbox, reply in Sent Items, second reply in Inbox. Same conversation. |
| **Test Steps** | 1. Note conversation ID / Subject. 2. Run migration. 3. Search Gmail for thread subject. 4. Verify all 3 messages group as one thread. |
| **Expected Result** | All 3 messages appear as one conversation thread in Gmail regardless of folder origin. |

---

#### E2E-091 — Signature Migration Verification

| Field | Details |
|-------|---------|
| **TC ID** | E2E-091 |
| **Title** | Outlook email signature content migrated in email body |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook sent emails have a formatted HTML signature (Name, Title, Company, Phone, Logo). |
| **Test Steps** | 1. Confirm signature in source email body. 2. Run migration. 3. Open email in Gmail. 4. Verify signature content and formatting at bottom of email. |
| **Expected Result** | Signature block preserved in Gmail email body. Logo image rendered if inline. Formatting intact. |

---

#### E2E-092 — Shared Mailbox Migration Verification

| Field | Details |
|-------|---------|
| **TC ID** | E2E-092 |
| **Title** | Shared Outlook mailbox migrated with all emails and shared access |
| **Test Type** | E2E |
| **Priority** | P2 |
| **Scope** | ✅ In Scope |
| **Pre-condition** | Source Outlook has shared mailbox `help@company.com` accessible to 3 users. |
| **Test Steps** | 1. Confirm shared access for 3 users. 2. Run migration for shared mailbox. 3. Verify emails in destination Gmail. 4. Verify all 3 users can access destination shared mailbox. |
| **Expected Result** | All emails migrated. Shared access preserved for all 3 authorized users. |

---

## 4. Test Execution Summary

| Test Type | Total Cases | In-Scope Cases | Out-of-Scope Verification |
|-----------|-------------|----------------|---------------------------|
| **Smoke** | 7 | 7 | 0 |
| **Sanity** | 25 | 23 | 2 |
| **E2E** | 101 | 79 | 22 |
| **Total** | **133** | **109** | **24** |

**New in v1.1:** Added E2E-093 (Reply chain), E2E-094 (RTF email), E2E-095 (Empty body), E2E-096 (BCC-only sent), E2E-097 (Voting buttons OOS), E2E-098 (OOF auto-reply), E2E-099 (Calendar free/busy), E2E-100 (Contact job title/company), E2E-101 (Search Folders OOS).

---

## 5. Entry and Exit Criteria

### Entry Criteria
- CloudFuze tenant provisioned with Outlook source and Gmail destination clouds added
- At least 1 source Outlook account with test data created
- Migration API connectivity verified
- Test data agent run (OutlookTestDataAgent) completed successfully

### Exit Criteria — Smoke
- All 7 Smoke tests pass
- Zero P1 failures

### Exit Criteria — Sanity
- All 25 Sanity tests pass (23 in-scope pass, 2 OOS confirm expected behavior)
- No P1 or P2 failures on in-scope cases

### Exit Criteria — E2E
- ≥ 95% of in-scope E2E tests pass (≥ 75 of 79)
- All P1 tests pass
- All 22 out-of-scope tests confirm graceful handling (no crash, correct documented behavior)
- Migration report generated with zero unexplained data loss

---

## 6. Key Risk Areas

| Risk | Likelihood | Impact |
|------|-----------|--------|
| Recurring event exceptions lost (Outlook→Google platform mismatch) | High | Medium |
| Large attachment (>25MB) truncated or fails | Medium | High |
| Cross-domain address mapping misconfigured | Medium | Critical |
| Timezone offset shift for non-UTC events | Medium | High |
| Sensitivity/category labels cause confusion (expected to be missing) | Low | Medium |
| Emoji/Unicode in folder names causing Gmail API label limit | Low | Low |

---

*Document generated by QA Engineering | CloudFuze Migration Platform | v1.1 | 2026-05-26*  
*133 test cases: 7 Smoke · 25 Sanity · 101 E2E | 109 In-Scope · 24 Out-of-Scope*
