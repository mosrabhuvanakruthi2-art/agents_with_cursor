# Migration Feature Documentation

**Product Type:** Mail
**Combination:** Gmail to Outlook
**Scope:** Out of Scope
**Total Features:** 12
**Last Updated:** 2026-05-08

---

## 1. Default folder (3 features)

### 1.1 Scheduled
Scheduled emails in Gmail are system-managed pending messages, not actual folder-based emails. They are migrated only after they are sent or moved to a standard folder.

### 1.2 Snoozed
Snoozing means temporarily hiding an email; it will reappear in the inbox at a chosen date/time. Snoozed emails are not migrated because snooze is a temporary, time-based feature in Gmail and there is no equivalent feature in Outlook to map it.

### 1.3 Purchase
In Gmail the "Purchase" label will not be migrated as a separate folder, but the mails inside the purchase folder will be migrated to their original folders in Outlook. No separate folder is created in Outlook.

---

## 2. Migration (1 feature)

### 2.1 Multiple delta
Multiple deltas are not supported. If a second delta is performed, Calendar and Contacts will duplicate or go to conflict. Only incremental mails are supported for multiple deltas.

---

## 3. External user in groups (1 feature)

### 3.1 External user in groups
In Gmail Groups, external users cannot be added — only users from the same organization. Attempting to add an external user shows an error.

---

## 4. Group members (1 feature)

### 4.1 Group members
Group members are not added in the destination group.

---

## 5. Archive mailbox (1 feature)

### 5.1 Archive mailbox
An Archive Mailbox is a separate storage location used to keep older or less frequently accessed emails. During migration from Gmail to Outlook, an archive mailbox is not migrated because Gmail does not have a true, separate archive mailbox — its "archive" is only a label state (emails in All Mail without the Inbox label), so there is no distinct archive container to map or transfer.

---

## 6. Contact photos (1 feature)

### 6.1 Contact photos
Contact photos in Gmail are often profile-based or externally linked images (Google profile pictures) rather than being stored as standard contact photo attachments inside the contact record. During migration, only structured contact fields (name, email, phone, etc.) are transferred — not externally referenced images.

---

## 7. All Mail (1 feature)

### 7.1 All Mail
"All Mail" in Gmail is not a real folder — it is a collection view of all emails across labels (Inbox, Sent, Archive, etc.). Since migration tools work on actual folders/labels, there is no direct "All Mail" folder to migrate.

---

## 8. Past calendar events (1 feature)

### 8.1 Past calendar events
Past calendar events are calendar entries whose scheduled date and time have already passed. Past events are not migrated because APIs and tools prioritize future usability, past data adds complexity and risk, and migration setups often exclude it intentionally.

---

## 9. Encrypted mails (1 feature)

### 9.1 Encrypted mails
Gmail Confidential Mode emails are migrated as regular emails. Encryption, expiry, and access restrictions are not preserved.

---

## 10. Contact Directory (1 feature)

### 10.1 Contact Directory
Contact Directory is a centralized list of all users and shared contacts in the organization. The main goal is easy communication inside an organization. Contact Directory is not migrated.
