# Migration Feature Documentation

**Product Type:** Mail
**Combination:** Gmail to Outlook
**Scope:** In Scope
**Total Features:** 30
**Last Updated:** 2026-05-08

---

## 1. Migration (2 features)

### 1.1 One time migration
The One-Time Migration performs the initial transfer of all existing Gmail data to Outlook, including emails, folders (labels), threads, and metadata.

### 1.2 Delta migration
Delta Migration transfers only newly added or modified data along with contacts and calendars after the One-Time Migration.

---

## 2. Custom labels (7 features)

### 2.1 Inbox
The Inbox contains all received emails from internal and external users.
- **Read / Unread:** Email read and unread status is preserved
- **Files:** Attachments are migrated with the email
- **Text Formatting:** Bold, italic, underline, bullet list, ordered list, and inline formatting are preserved
- **Headers:** To, From, CC, BCC, Subject fields are retained
- **External Emails:** Sending and receiving emails to/from external users is supported
- **Mentions:** User mentions are retained where supported
- **Pin / Flag / Mark as Unread:** Message flags and unread indicators are preserved

### 2.2 Sent
The Sent Items folder stores all emails successfully sent by the user. Sent emails are migrated with recipients, timestamps, and content intact.

### 2.3 Drafts
Emails composed but not sent are migrated and stored in the Drafts folder for further editing.

### 2.4 Spam
Unwanted or spam emails are stored in the spam folder in Gmail, and those spam mails from Gmail are migrated to the Junk folder in Outlook.

### 2.5 Trash
Emails deleted by users are stored in the trash folder in Gmail and those are migrated from Gmail to Outlook in the Deleted folder.

### 2.6 Important
A folder that contains emails marked as important either by Gmail automatically or by the user, representing high-priority messages. Emails which are moved to the Important folder in Gmail are migrated to their original folder with an exclamation mark in Outlook.

### 2.7 Custom Folders (Labels)
A custom label in Gmail is a way to group similar emails into categories. Custom labels are migrated as custom folders in Outlook in a hierarchical structure:
- **Root label (Main label):** Top-level label
- **Nested label (Sub-label):** A label created inside a root label
- **Child label (Sub-sub label):** A label inside a nested label, more specific level of organization

---

## 3. Threads (1 feature)

### 3.1 Threads
Email conversations with multiple replies are migrated as threaded conversations to maintain continuity.

---

## 4. Timestamp (1 feature)

### 4.1 Timestamp
A record of the exact date and time when an event happened, such as when an email was sent or received. Original sent and received timestamps are preserved for all migrated emails.

---

## 5. All Mail (Gmail Only) (1 feature)

### 5.1 All Mail (Gmail Only)
All Mail in Gmail is a folder that contains every email in your account except spam and trash, including inbox, sent, archived, and even labeled emails. Labels do not remove emails from All Mail but only categorize them for easy viewing.

---

## 6. Calendars (1 feature)

### 6.1 Calendars
Calendars and events are migrated incrementally.
- **Recurring Events:** Location, attachments, guests, and recurrence patterns are preserved
- **Non-Recurring Events:** Single-instance events are migrated
- **Past / Present / Future Events:** All event timelines are supported

---

## 7. Contacts (1 feature)

### 7.1 Contacts
Contacts are migrated with detailed attributes.
- **Contact Details:** Name, phone numbers, email addresses, and notes are migrated
- **Contact Photos:** Photos are not migrated; all other details are preserved

---

## 8. Shared Mailbox (1 feature)

### 8.1 Shared Mailbox
A shared mailbox is a mailbox that multiple users can access and use together, instead of belonging to just one person. It is migrated as a normal migration.

---

## 9. Group Mail Migration (1 feature)

### 9.1 Group Mail Migration
Emails sent to Google Groups are migrated and delivered to all group members in Outlook. Group will be created at the destination with the destination domain name.

---

## 10. Group Calendars (1 feature)

### 10.1 Sharing calendar with group of people
Group calendars are migrated with sharing permissions, allowing users to add events and manage access.

---

## 11. Read / Unread Functionality (1 feature)

### 11.1 Read / Unread Functionality
Read and Unread status of emails is fully preserved during migration. Emails marked as read in Gmail will appear as read in Outlook, and unread emails remain unread. This status is also maintained during Delta Migration.

---

## 12. Shared Calendars (1 feature)

### 12.1 Shared Calendars
Shared calendars are migrated with permissions, allowing users to add events and manage access.

---

## 13. Migrate Archives (1 feature)

### 13.1 Migrate Archives
When Migrate Archives is enabled, the Gmail All Mail folder is created at the destination.

---

## 14. Orphaned Labels (1 feature)

### 14.1 Migrate Orphaned Labels
A "no label" email is created by removing it from Inbox and all labels, making it exist only in All Mail. Emails that exist only under custom labels or in All Mail without any labels — not part of default folders like Inbox or Sent — are migrated into corresponding folders in Outlook only when Migrate Orphaned Labels is enabled.

---

## 15. Default folder (1 feature)

### 15.1 Starred
A symbol used to mark an email for easy access later, acting like a bookmark or reminder. Mails which are marked as starred in Gmail are migrated to Outlook as flags by creating a folder named "Yellow Star" and also moved to their original folder marked with flags.

---

## 16. Primary calendar (1 feature)

### 16.1 Primary calendar
The primary calendar is the default calendar tied to your mailbox/account. When someone sends a meeting, it lands in the primary calendar. Free/busy availability is taken from the primary calendar. Events can be created in the primary calendar.

---

## 17. Secondary calendar (1 feature)

### 17.1 Secondary calendar
A secondary calendar is a calendar created manually or added from another source, separate from the primary calendar. Used for organization, categorization, or sharing. Events in secondary calendars are also migrated.

---

## 18. Calendar rooms (1 feature)

### 18.1 Calendar meeting rooms
A calendar room is a bookable resource calendar that represents a physical location. Calendar meeting rooms are migrated.

---

## 19. Calendar notes (1 feature)

### 19.1 Calendar notes
Calendar notes are the description field in a calendar event. They contain extra details like agenda, instructions, links, etc., inside the event.

---

## 20. Contact labels (1 feature)

### 20.1 Contact labels
Contact labels are used to categorize and organize contacts into specific groups based on their type or purpose. Gmail contact labels are migrated as categories in Outlook, where each label becomes a category tag assigned to the respective contacts.

---

## 21. Categories (1 feature)

### 21.1 Categories
Categories in Gmail are used to automatically organize emails into grouped sections. When migrating to Outlook, these categories are converted into folders because Outlook handles organization differently.

---

## 22. Filters/rules (1 feature)

### 22.1 Filters/rules
If filters are configured for particular From or To addresses, incoming emails that match those conditions are automatically moved to a designated label or folder. During migration, the emails themselves are migrated to the destination mailbox. If those emails appear under the correct folder or label after migration, they are considered successfully migrated. The filter only controls organization and does not affect the migration status of the emails.

---

## 23. Signature (1 feature)

### 23.1 Signature
Email signatures are supported for Gmail to Outlook migration.
