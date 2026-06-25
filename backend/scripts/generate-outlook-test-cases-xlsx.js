/**
 * Generates backend/data/outlook-test-cases.xlsx from custom-test-cases.json.
 * Separate sheets: SMOKE, SANITY, E2E-Mail, E2E-Calendar, E2E-Contacts, E2E-Groups, ColumnHelp.
 *
 *   node scripts/generate-outlook-test-cases-xlsx.js
 */
const fs   = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const DATA_FILE = path.join(__dirname, '../data/custom-test-cases.json');
const OUT_FILE  = path.join(__dirname, '../data/outlook-test-cases.xlsx');

// ── Load source JSON ──────────────────────────────────────────────────────────

const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));

// ── Helpers ───────────────────────────────────────────────────────────────────

function yn(v) { return v ? 'Y' : 'N'; }

function attachSizeLabel(c) {
  if (c.attachmentSize) return c.attachmentSize;
  if (!c.hasAttachment) return '';
  return 'yes';
}

// ── SMOKE sheet ───────────────────────────────────────────────────────────────

function buildSmokeRow(c, i) {
  return {
    '#':           i + 1,
    TestCaseId:    c.testCaseId || c.id || '',
    Combination:   c.combination || '',
    ProductType:   c.productType || 'Mail',
    Folder:        c.folder || '',
    Subject:       c.subject || '',
    Summary:       c.summary || '',
    Action:        c.action || '',
    TestData:      c.testData || '',
    TestSteps:     Array.isArray(c.testSteps) ? c.testSteps.map((s, n) => `${n + 1}. ${s}`).join('\n') : (c.testSteps || ''),
    ExpectedResult: c.expectedResult || '',
    HasAttachment: yn(c.hasAttachment),
    Enabled:       'Y',
  };
}

const smokeRows = (raw.smoke || []).map(buildSmokeRow);

// ── SANITY sheet ──────────────────────────────────────────────────────────────

const sanityRows = (raw.sanity || []).map(buildSmokeRow);

// ── E2E-Mail sheet ────────────────────────────────────────────────────────────

function buildMailRow(c, i) {
  const flagStatus = c.flag?.flagStatus;
  const isFlagged  = flagStatus === 'flagged' || flagStatus === 'followUp';
  const hasHtml    = !!(c.htmlBody && (c.htmlBody === true || (typeof c.htmlBody === 'string' && c.htmlBody.trim())));
  const hasZoom    = !!(c.zoomLink ||
    (c.textBody && /zoom\.us\/j\//i.test(c.textBody)) ||
    (c.htmlBody && /zoom\.us\/j\//i.test(c.htmlBody)));

  return {
    '#':            i + 1,
    TestCaseId:     c.testCaseId || c.id || '',
    Source:         c.source || '',
    Combination:    c.combination || '',
    Folder:         c.folder || '',
    Subject:        c.subject || '',
    Summary:        c.summary || '',
    IsRead:         c.isRead === false ? 'N' : 'Y',
    HasAttachment:  yn(c.hasAttachment),
    AttachmentSize: attachSizeLabel(c),
    Flagged:        yn(isFlagged),
    Importance:     c.importance || 'normal',
    Categories:     Array.isArray(c.categories) ? c.categories.join(', ') : (c.categories || ''),
    HasHtmlBody:    yn(hasHtml),
    HasZoomLink:    yn(hasZoom),
    ExpectedResult: c.expectedResult || '',
    Enabled:        'Y',
  };
}

const e2eMailRows = (raw.e2e || [])
  .filter(c => !c.productType || c.productType === 'Mail')
  .map(buildMailRow);

// ── E2E-Calendar sheet ────────────────────────────────────────────────────────

const calendarRows = [
  { '#': 1,  TestCaseId: 'E2E-CAL-01', MigrationType: 'DELTA', Subject: 'QA E2E - Past Calendar Event',        BodyText: 'Past calendar event for migration QA.',                                       IsAllDay: 'N', IsPast: 'Y', IsFuture: 'N', IsRecurring: 'N', RecurrenceType: '',      RecurrenceCount: '', HasAttendees: 'N', HasAttachment: 'N', IsSharedCalendar: 'N', CalendarName: '', ExpectedResult: 'Event appears in Gmail Calendar with correct title, date, and time' },
  { '#': 2,  TestCaseId: 'E2E-CAL-02', MigrationType: 'DELTA', Subject: 'QA E2E - Present All-Day Event',       BodyText: 'All-day event (today) for migration QA.',                                     IsAllDay: 'Y', IsPast: 'N', IsFuture: 'N', IsRecurring: 'N', RecurrenceType: '',      RecurrenceCount: '', HasAttendees: 'N', HasAttachment: 'N', IsSharedCalendar: 'N', CalendarName: '', ExpectedResult: 'All-day event migrates without time component' },
  { '#': 3,  TestCaseId: 'E2E-CAL-03', MigrationType: 'DELTA', Subject: 'QA E2E - Future Calendar Event',       BodyText: 'Future calendar event for migration QA.',                                     IsAllDay: 'N', IsPast: 'N', IsFuture: 'Y', IsRecurring: 'N', RecurrenceType: '',      RecurrenceCount: '', HasAttendees: 'N', HasAttachment: 'N', IsSharedCalendar: 'N', CalendarName: '', ExpectedResult: 'Future event appears in Gmail Calendar' },
  { '#': 4,  TestCaseId: 'E2E-CAL-04', MigrationType: 'DELTA', Subject: 'QA E2E - Weekly Recurring Event',      BodyText: 'Recurring weekly event for migration QA.',                                    IsAllDay: 'N', IsPast: 'N', IsFuture: 'Y', IsRecurring: 'Y', RecurrenceType: 'weekly', RecurrenceCount: '4', HasAttendees: 'N', HasAttachment: 'N', IsSharedCalendar: 'N', CalendarName: '', ExpectedResult: 'All 4 weekly occurrences migrated correctly' },
  { '#': 5,  TestCaseId: 'E2E-CAL-05', MigrationType: 'DELTA', Subject: 'QA E2E - Multi-Day Calendar Event',    BodyText: 'Multi-day event spanning 2 days.',                                            IsAllDay: 'Y', IsPast: 'N', IsFuture: 'Y', IsRecurring: 'N', RecurrenceType: '',      RecurrenceCount: '', HasAttendees: 'N', HasAttachment: 'N', IsSharedCalendar: 'N', CalendarName: '', ExpectedResult: 'Multi-day event spans correct date range in Gmail Calendar' },
  { '#': 6,  TestCaseId: 'E2E-CAL-06', MigrationType: 'DELTA', Subject: 'QA E2E - Meeting With Attendees',      BodyText: 'Meeting event with external attendees.',                                      IsAllDay: 'N', IsPast: 'N', IsFuture: 'Y', IsRecurring: 'N', RecurrenceType: '',      RecurrenceCount: '', HasAttendees: 'Y', HasAttachment: 'N', IsSharedCalendar: 'N', CalendarName: '', ExpectedResult: 'Attendees list preserved after migration' },
  { '#': 7,  TestCaseId: 'E2E-CAL-07', MigrationType: 'DELTA', Subject: 'QA E2E - Event With Long Description', BodyText: 'Meeting Agenda: Introduction, Status update, Action items, Q&A.',            IsAllDay: 'N', IsPast: 'N', IsFuture: 'Y', IsRecurring: 'N', RecurrenceType: '',      RecurrenceCount: '', HasAttendees: 'N', HasAttachment: 'N', IsSharedCalendar: 'N', CalendarName: '', ExpectedResult: 'Full description preserved in Gmail event' },
  { '#': 8,  TestCaseId: 'E2E-CAL-08', MigrationType: 'DELTA', Subject: 'QA E2E - Shared Calendar Event',       BodyText: 'Event in shared calendar for migration QA.',                                  IsAllDay: 'N', IsPast: 'N', IsFuture: 'Y', IsRecurring: 'N', RecurrenceType: '',      RecurrenceCount: '', HasAttendees: 'N', HasAttachment: 'N', IsSharedCalendar: 'Y', CalendarName: 'QA Shared Calendar', ExpectedResult: 'Event appears in shared calendar equivalent in Gmail' },
  { '#': 9,  TestCaseId: 'E2E-CAL-09', MigrationType: 'DELTA', Subject: 'QA E2E - Event With Attachment',       BodyText: 'Calendar event with text file attachment.',                                   IsAllDay: 'N', IsPast: 'N', IsFuture: 'Y', IsRecurring: 'N', RecurrenceType: '',      RecurrenceCount: '', HasAttendees: 'N', HasAttachment: 'Y', IsSharedCalendar: 'N', CalendarName: '', ExpectedResult: 'Calendar event attachment count matches source; attachment content validated' },
  { '#': 10, TestCaseId: 'E2E-CAL-10', MigrationType: 'DELTA', Subject: 'QA Delta - New Future Event',          BodyText: 'New calendar event added in delta run.',                                      IsAllDay: 'N', IsPast: 'N', IsFuture: 'Y', IsRecurring: 'N', RecurrenceType: '',      RecurrenceCount: '', HasAttendees: 'N', HasAttachment: 'N', IsSharedCalendar: 'N', CalendarName: '', ExpectedResult: 'Delta event appears in Gmail Calendar after incremental migration' },
  { '#': 11, TestCaseId: 'E2E-CAL-11', MigrationType: 'DELTA', Subject: 'QA Delta - New Daily Recurring Event', BodyText: 'New daily recurring event added in delta run.',                               IsAllDay: 'N', IsPast: 'N', IsFuture: 'Y', IsRecurring: 'Y', RecurrenceType: 'daily',  RecurrenceCount: '3', HasAttendees: 'N', HasAttachment: 'N', IsSharedCalendar: 'N', CalendarName: '', ExpectedResult: 'All 3 daily occurrences appear in Gmail Calendar' },
];

// ── E2E-Contacts sheet ────────────────────────────────────────────────────────

const contactRows = [
  { '#': 1, TestCaseId: 'E2E-CON-01', MigrationType: 'DELTA', DisplayName: 'QA Contact Alpha',       GivenName: 'QA', Surname: 'Alpha',   Email: 'qa.alpha@external-test.com',                               Phone: '+1-555-0001', Company: 'QA Test Corp',         JobTitle: '',                HasPhoto: 'Y', HasAddress: 'N', HasBirthday: 'N', MultiEmail: 'N', Notes: '',                                                               ExpectedResult: 'Contact migrated with correct name, email, phone, and photo' },
  { '#': 2, TestCaseId: 'E2E-CON-02', MigrationType: 'DELTA', DisplayName: 'QA Contact Beta',        GivenName: 'QA', Surname: 'Beta',    Email: 'qa.beta@external-test.com',                                Phone: '+1-555-0002', Company: 'QA Test Corp',         JobTitle: '',                HasPhoto: 'N', HasAddress: 'N', HasBirthday: 'N', MultiEmail: 'N', Notes: '',                                                               ExpectedResult: 'Contact migrated with correct name and email' },
  { '#': 3, TestCaseId: 'E2E-CON-03', MigrationType: 'DELTA', DisplayName: 'QA Contact Gamma',       GivenName: 'QA', Surname: 'Gamma',   Email: 'qa.gamma@external-test.com',                               Phone: '+1-555-0003', Company: 'QA Test Corp',         JobTitle: '',                HasPhoto: 'N', HasAddress: 'N', HasBirthday: 'N', MultiEmail: 'N', Notes: '',                                                               ExpectedResult: 'Contact migrated with correct name and email' },
  { '#': 4, TestCaseId: 'E2E-CON-04', MigrationType: 'DELTA', DisplayName: 'QA Contact Delta',       GivenName: 'QA', Surname: 'Delta',   Email: 'qa.delta@external-test.com',                               Phone: '+1-555-0004', Company: 'QA Test Corp',         JobTitle: 'QA Engineer',     HasPhoto: 'N', HasAddress: 'N', HasBirthday: 'Y', MultiEmail: 'N', Notes: '',                                                               ExpectedResult: 'Contact migrated with job title and birthday preserved' },
  { '#': 5, TestCaseId: 'E2E-CON-05', MigrationType: 'DELTA', DisplayName: 'QA Contact Epsilon',     GivenName: 'QA', Surname: 'Epsilon', Email: 'qa.epsilon@external-test.com',                             Phone: '',            Company: 'QA External Corp',     JobTitle: '',                HasPhoto: 'N', HasAddress: 'Y', HasBirthday: 'N', MultiEmail: 'N', Notes: 'QA contact with home address — migration test.',                 ExpectedResult: 'Contact home address preserved after migration' },
  { '#': 6, TestCaseId: 'E2E-CON-06', MigrationType: 'DELTA', DisplayName: 'QA Contact Zeta',        GivenName: 'QA', Surname: 'Zeta',    Email: 'qa.zeta.work@external-test.com,qa.zeta.home@personal.com', Phone: '+44-20-1234-5678', Company: 'QA International Ltd', JobTitle: 'Senior QA Manager', HasPhoto: 'N', HasAddress: 'N', HasBirthday: 'N', MultiEmail: 'Y', Notes: 'Contact with multiple email addresses and international phone.', ExpectedResult: 'Both email addresses and international phone preserved' },
  { '#': 7, TestCaseId: 'E2E-CON-07', MigrationType: 'DELTA', DisplayName: 'QA Delta Contact Eta',   GivenName: 'QA', Surname: 'Eta',     Email: 'qa.eta@external-test.com',                                 Phone: '+1-555-0007', Company: 'QA Delta Corp',         JobTitle: '',                HasPhoto: 'N', HasAddress: 'N', HasBirthday: 'N', MultiEmail: 'N', Notes: '',                                                               ExpectedResult: 'Delta contact appears in Gmail Contacts after incremental migration' },
  { '#': 8, TestCaseId: 'E2E-CON-08', MigrationType: 'DELTA', DisplayName: 'QA Delta Contact Theta', GivenName: 'QA', Surname: 'Theta',   Email: 'qa.theta@external-test.com',                               Phone: '+1-555-0008', Company: 'QA Delta Corp',         JobTitle: 'Delta QA Tester', HasPhoto: 'N', HasAddress: 'N', HasBirthday: 'N', MultiEmail: 'N', Notes: '',                                                               ExpectedResult: 'Contact job title preserved after delta migration' },
  { '#': 9, TestCaseId: 'E2E-CON-09', MigrationType: 'DELTA', DisplayName: 'QA Delta Contact Iota',  GivenName: 'QA', Surname: 'Iota',    Email: 'qa.iota@external-test.com',                                Phone: '',            Company: 'QA Delta Corp',         JobTitle: '',                HasPhoto: 'N', HasAddress: 'N', HasBirthday: 'N', MultiEmail: 'N', Notes: 'Contact added during delta migration run.',                       ExpectedResult: 'Contact notes preserved; appears in Gmail Contacts' },
];

// ── E2E-Groups sheet ──────────────────────────────────────────────────────────

const groupRows = [
  { '#': 1, TestCaseId: 'E2E-GRP-01', MigrationType: 'BOTH', DisplayName: 'QA Public Group',  MailNickname: 'qa-pub-(ts)',  Description: 'Public M365 group for migration QA',  IsPrivate: 'N', ExpectedResult: 'Public group and its emails migrated; membership preserved' },
  { '#': 2, TestCaseId: 'E2E-GRP-02', MigrationType: 'BOTH', DisplayName: 'QA Private Group', MailNickname: 'qa-prv-(ts)', Description: 'Private M365 group for migration QA', IsPrivate: 'Y', ExpectedResult: 'Private group emails migrated; access restrictions noted in report' },
];

// ── ColumnHelp sheet ──────────────────────────────────────────────────────────

const columnHelpRows = [
  // General
  { Sheet: 'All',          Column: 'TestCaseId',       Description: 'Unique identifier for the test case (e.g. E2E-OTG-B01, Testsmoke1)' },
  { Sheet: 'All',          Column: 'Combination',      Description: 'Migration path: "Outlook → Gmail", "Gmail → Outlook", etc.' },
  { Sheet: 'All',          Column: 'Enabled',          Description: 'Y = active test case. N = disabled (kept for reference but skipped in runs)' },
  { Sheet: 'All',          Column: 'ExpectedResult',   Description: 'What the validation agent should confirm after migration' },
  // SMOKE / SANITY
  { Sheet: 'SMOKE/SANITY', Column: 'ProductType',      Description: 'Mail | Calendar | Contacts | Groups' },
  { Sheet: 'SMOKE/SANITY', Column: 'Action',           Description: 'High-level description of the migration action under test' },
  { Sheet: 'SMOKE/SANITY', Column: 'TestData',         Description: 'What data is pre-seeded for this test' },
  { Sheet: 'SMOKE/SANITY', Column: 'TestSteps',        Description: 'Step-by-step execution steps (numbered, newline-separated)' },
  { Sheet: 'SMOKE/SANITY', Column: 'HasAttachment',    Description: 'Y if the test email has an attachment' },
  // E2E-Mail
  { Sheet: 'E2E-Mail',     Column: 'Source',           Description: '"json" = created by the base loop in OutlookTestDataAgent. "extended" = created by _createExtendedTestData with richer attributes (flags, attachments, HTML, etc.)' },
  { Sheet: 'E2E-Mail',     Column: 'Folder',           Description: 'Inbox | Sent Items | Drafts | Junk Email | Deleted Items | Archive | QA-Migration-Folder | QA-Work-Projects | QA-Client-Emails | custom folder name' },
  { Sheet: 'E2E-Mail',     Column: 'IsRead',           Description: 'Y = migrated as read. N = migrated as unread (UNREAD label must be present in Gmail)' },
  { Sheet: 'E2E-Mail',     Column: 'HasAttachment',    Description: 'Y = email has at least one file attachment' },
  { Sheet: 'E2E-Mail',     Column: 'AttachmentSize',   Description: 'small (~1KB), medium (~512KB), large (~2MB) — or blank if no attachment' },
  { Sheet: 'E2E-Mail',     Column: 'Flagged',          Description: 'Y = Outlook flag:flagged. Should map to Gmail STARRED label after migration' },
  { Sheet: 'E2E-Mail',     Column: 'Importance',       Description: 'normal | high | low. "high" maps to Gmail IMPORTANT label' },
  { Sheet: 'E2E-Mail',     Column: 'Categories',       Description: 'Comma-separated Outlook category names (e.g. "Red Category,Blue Category"). Migrated as Gmail labels or ignored (advisory)' },
  { Sheet: 'E2E-Mail',     Column: 'HasHtmlBody',      Description: 'Y = email body is HTML. Validation checks HTML content preserved with Tier C body comparison' },
  { Sheet: 'E2E-Mail',     Column: 'HasZoomLink',      Description: 'Y = email body contains a Zoom meeting link. Validation checks link accessibility in destination.' },
  // E2E-Calendar
  { Sheet: 'E2E-Calendar', Column: 'MigrationType',   Description: 'DELTA = created as incremental test data (present at delta sweep). BOTH = created upfront and also present at delta.' },
  { Sheet: 'E2E-Calendar', Column: 'IsAllDay',         Description: 'Y = all-day event (no specific time)' },
  { Sheet: 'E2E-Calendar', Column: 'IsPast',           Description: 'Y = event start is 7 days in the past (tests past-event migration)' },
  { Sheet: 'E2E-Calendar', Column: 'IsFuture',         Description: 'Y = event start is 7 days in the future' },
  { Sheet: 'E2E-Calendar', Column: 'IsRecurring',      Description: 'Y = event has a recurrence pattern' },
  { Sheet: 'E2E-Calendar', Column: 'RecurrenceType',   Description: 'daily | weekly | monthly (used when IsRecurring=Y)' },
  { Sheet: 'E2E-Calendar', Column: 'RecurrenceCount',  Description: 'Number of occurrences for the recurrence series' },
  { Sheet: 'E2E-Calendar', Column: 'HasAttendees',     Description: 'Y = event has external attendees; validation checks attendee list' },
  { Sheet: 'E2E-Calendar', Column: 'HasAttachment',    Description: 'Y = calendar event has a file attachment; validation checks attachment count match' },
  { Sheet: 'E2E-Calendar', Column: 'IsSharedCalendar', Description: 'Y = event belongs to a named shared/additional calendar' },
  { Sheet: 'E2E-Calendar', Column: 'CalendarName',     Description: 'Name of shared calendar (used when IsSharedCalendar=Y)' },
  // E2E-Contacts
  { Sheet: 'E2E-Contacts', Column: 'HasPhoto',         Description: 'Y = contact has a profile photo set (1×1 PNG for QA Contact Alpha). Validation flags photoMismatches if missing in Gmail.' },
  { Sheet: 'E2E-Contacts', Column: 'HasAddress',       Description: 'Y = contact has homeAddress populated' },
  { Sheet: 'E2E-Contacts', Column: 'HasBirthday',      Description: 'Y = contact has birthday set' },
  { Sheet: 'E2E-Contacts', Column: 'MultiEmail',       Description: 'Y = contact has multiple email addresses (comma-separated in Email column)' },
  // E2E-Groups
  { Sheet: 'E2E-Groups',   Column: 'MailNickname',     Description: '(ts) is replaced with a 6-digit timestamp at runtime to avoid alias conflicts' },
  { Sheet: 'E2E-Groups',   Column: 'IsPrivate',        Description: 'Y = private/members-only M365 group; N = public group' },
];

// ── Write workbook ────────────────────────────────────────────────────────────

const wb = XLSX.utils.book_new();

XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(smokeRows),      'SMOKE');
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sanityRows),     'SANITY');
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(e2eMailRows),    'E2E-Mail');
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(calendarRows),   'E2E-Calendar');
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(contactRows),    'E2E-Contacts');
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(groupRows),      'E2E-Groups');
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(columnHelpRows), 'ColumnHelp');

XLSX.writeFile(wb, OUT_FILE);

console.log('Wrote', OUT_FILE);
console.log(`  SMOKE rows:        ${smokeRows.length}`);
console.log(`  SANITY rows:       ${sanityRows.length}`);
console.log(`  E2E-Mail rows:     ${e2eMailRows.length}`);
console.log(`  E2E-Calendar rows: ${calendarRows.length}`);
console.log(`  E2E-Contacts rows: ${contactRows.length}`);
console.log(`  E2E-Groups rows:   ${groupRows.length}`);
