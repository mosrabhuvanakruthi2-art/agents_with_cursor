# Migration Feature Documentation

**Product Type:** Mail
**Combination:** Outlook to Gmail
**Scope:** Out of Scope
**Total Features:** 5
**Last Updated:** 2026-05-08

---

## 1. Categories (1 feature)

### 1.1 Categories not Preserved
Emails are migrated, but category information is completely lost, and no corresponding labels are created in Gmail.

---

## 2. Labels (confidential, public, internal) (1 feature)

### 2.1 Sensitivity Labels / Information Protection Labels
The Sensitivity / classification value shown in Outlook is not returned by Microsoft Graph API for this message. Outlook may display this tag based on internal Exchange or Purview metadata that is not exposed through the API. Because the value is not available in the API response, it cannot be retrieved or migrated. This is a Microsoft Graph API limitation.

---

## 3. Folders with Emojis (1 feature)

### 3.1 Emoji Folder Name not Preserved
Gmail API has a length limitation for label names (approximately 225 characters). The source label contains a large number of Unicode emoji characters, which exceeds the maximum size allowed by Gmail. When this limit is exceeded, the Gmail API may return a backend error instead of creating the label. Because of this API limitation, very long label names containing emoji cannot be created in Gmail and must be shortened during migration.

---

## 4. Conversation History (1 feature)

### 4.1 Conversation History Folder not Preserved
This folder contains chat history and communication logs from applications such as Skype, Teams, or Lync, and does not store regular email messages. Since the migration process only supports standard email folders, the Conversation History folder is excluded from migration.

---

## 5. Notes (1 feature)

### 5.1 Notes Migration not Preserved
Notes are not migrated when Outlook is used as the source. This is because Notes in Outlook do not contain emails — they are personal notes created by the user and are not part of the mailbox data. The migration process only supports email and mailbox-related items, so Notes are not included in the migration.
