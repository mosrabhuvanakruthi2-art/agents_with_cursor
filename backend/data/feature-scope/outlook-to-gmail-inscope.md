# Migration Feature Documentation

**Product Type:** Mail
**Combination:** Outlook to Gmail
**Scope:** In Scope
**Total Features:** 19
**Last Updated:** 2026-05-08

---

## 1. Migration (2 features)

### 1.1 One time migration
The One-Time Migration performs the initial transfer of all existing Outlook data to Gmail, including emails, folders, threads, and metadata.

### 1.2 Delta migration
Delta Migration transfers only newly added or modified data after the One-Time Migration.

---

## 2. Default Folders (1 feature)

### 2.1 Inbox
The Inbox contains all received emails from internal and external users.
- **Read / Unread:** Email read and unread status is preserved
- **Files:** Attachments are migrated with the email
- **Text Formatting:** Bold, italic, underline, bullet list, ordered list, and inline formatting are preserved
- **Headers:** To, From, CC, BCC, Subject fields are retained
- **External Emails:** Sending and receiving emails to/from external users is supported
- **Mentions:** User mentions are retained where supported
- **Flag / Mark as Unread:** Message flags and unread indicators are preserved

---

## 3. Default Folder (5 features)

### 3.1 Sent
The Sent Items folder stores all emails successfully sent by the user. Sent emails are migrated with recipients, timestamps, and content intact.

### 3.2 Drafts
Emails composed but not sent are migrated and stored in the Drafts folder for further editing.

### 3.3 Junk / Spam
Unwanted or spam emails are migrated into the Spam folder in Gmail.

### 3.4 Deleted / Trash
Emails deleted by users are migrated into the Trash folder in Gmail.

### 3.5 Flagged / Important
Emails marked as Flagged in Outlook are migrated as Important or Starred in Gmail.

---

## 4. Custom Folders (1 feature)

### 4.1 Custom Folders (Labels)
User-created folders are migrated as Gmail labels with hierarchy preserved.
- **Root Folder:** Top-level folders are migrated
- **Child / Nested Folder:** Subfolders maintain their structure
- **Rules:** Outlook rules are applied and emails are placed into corresponding labels

---

## 5. Threads (1 feature)

### 5.1 Threads
Email conversations are migrated and maintained as threaded conversations in Gmail.

---

## 6. Timestamp (1 feature)

### 6.1 Timestamp
Original sent and received timestamps are preserved for all migrated emails.

---

## 7. Archive (1 feature)

### 7.1 Archive
The mails which are archived in Outlook will migrate to Archive [Gmail] — the migration tool creates this folder at the destination in Gmail.

---

## 8. Distribution Lists / Groups (1 feature)

### 8.1 Distribution Lists / Groups
Emails sent to Outlook distribution lists are migrated and delivered to corresponding Gmail groups, but members are not migrated at destination.

---

## 9. Calendars (1 feature)

### 9.1 Calendars
Calendars and events are migrated with full detail.
- **Recurring Events:** Location, attachments, guests, and recurrence patterns are preserved
- **Non-Recurring Events:** Single-instance events are migrated
- **Past / Present / Future Events:** All event timelines are supported

---

## 10. Contacts (1 feature)

### 10.1 Contacts
Contacts are migrated with detailed attributes.
- **Contact Details:** Name, phone numbers, email addresses, and notes are migrated
- **Contact Photos:** Photos are not migrated; all other details are preserved

---

## 11. Shared Mailbox (1 feature)

### 11.1 Shared Mailbox
Shared mailboxes accessible by multiple users are migrated while preserving shared access.

---

## 12. Shared Calendars (1 feature)

### 12.1 Shared Calendars
Shared calendars are migrated with permissions, allowing users to add events and manage access.

---

## 13. Group Calendars (1 feature)

### 13.1 Group Calendars
Group calendars are migrated with sharing permissions, allowing users to add events and manage access.

---

## 14. Read / Unread Functionality (1 feature)

### 14.1 Read / Unread Functionality
Read and Unread status of emails is fully preserved during migration. Emails marked as read in Outlook will appear as read in Gmail, and unread emails remain unread. This status is also maintained during Delta Migration.
