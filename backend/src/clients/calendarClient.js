const { google } = require('googleapis');
const { getCalendarAuthForEmail } = require('./gmailClient');
const { retryWithBackoff } = require('../utils/retry');

function getCalendar(sourceEmail) {
  return google.calendar({ version: 'v3', auth: getCalendarAuthForEmail(sourceEmail) });
}

async function createCalendar(sourceEmail, summary) {
  const calendar = getCalendar(sourceEmail);
  return retryWithBackoff(
    () =>
      calendar.calendars.insert({
        requestBody: { summary },
      }),
    { label: `Calendar createCalendar(${summary}) for ${sourceEmail}` }
  );
}

async function createEvent(sourceEmail, calendarId, event, options = {}) {
  const { sendUpdates = 'none' } = options;
  const calendar = getCalendar(sourceEmail);
  return retryWithBackoff(
    () =>
      calendar.events.insert({
        calendarId,
        requestBody: event,
        sendUpdates,
      }),
    { label: `Calendar createEvent for ${sourceEmail}` }
  );
}

async function listEvents(sourceEmail, calendarId, maxResults = 250) {
  const calendar = getCalendar(sourceEmail);
  const res = await retryWithBackoff(
    () =>
      calendar.events.list({
        calendarId,
        maxResults,
        singleEvents: false,
      }),
    { label: `Calendar listEvents for ${sourceEmail}` }
  );
  return res.data.items || [];
}

async function listCalendars(sourceEmail) {
  const calendar = getCalendar(sourceEmail);
  const res = await retryWithBackoff(
    () => calendar.calendarList.list(),
    { label: `Calendar listCalendars for ${sourceEmail}` }
  );
  return res.data.items || [];
}

module.exports = {
  createCalendar,
  createEvent,
  listEvents,
  listCalendars,
};
