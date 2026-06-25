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
  const { sendUpdates = 'none', conferenceDataVersion } = options;
  const calendar = getCalendar(sourceEmail);
  const params = { calendarId, requestBody: event, sendUpdates };
  if (conferenceDataVersion !== undefined) params.conferenceDataVersion = conferenceDataVersion;
  return retryWithBackoff(
    () => calendar.events.insert(params),
    { label: `Calendar createEvent for ${sourceEmail}` }
  );
}

async function patchEvent(sourceEmail, calendarId, eventId, patch) {
  const calendar = getCalendar(sourceEmail);
  return retryWithBackoff(
    () =>
      calendar.events.patch({
        calendarId,
        eventId,
        requestBody: patch,
      }),
    { label: `Calendar patchEvent ${eventId} for ${sourceEmail}` }
  );
}

async function listInstances(sourceEmail, calendarId, eventId, maxResults = 10) {
  const calendar = getCalendar(sourceEmail);
  const now = new Date();
  const timeMin = new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString();
  const timeMax = new Date(now.getTime() + 90 * 24 * 3600 * 1000).toISOString();
  const res = await retryWithBackoff(
    () =>
      calendar.events.instances({
        calendarId,
        eventId,
        maxResults,
        timeMin,
        timeMax,
      }),
    { label: `Calendar listInstances ${eventId} for ${sourceEmail}` }
  );
  return res.data.items || [];
}

async function listEvents(sourceEmail, calendarId, maxResults = 250) {
  const calendar = getCalendar(sourceEmail);
  const res = await retryWithBackoff(
    () =>
      calendar.events.list({
        calendarId,
        maxResults,
        singleEvents: false,
        supportsAttachments: true,
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

async function getEvent(sourceEmail, calendarId, eventId) {
  const calendar = getCalendar(sourceEmail);
  const res = await retryWithBackoff(
    () => calendar.events.get({ calendarId, eventId, supportsAttachments: true }),
    { label: `Calendar getEvent ${eventId} for ${sourceEmail}` }
  );
  return res.data;
}

module.exports = {
  createCalendar,
  createEvent,
  patchEvent,
  listInstances,
  listEvents,
  listCalendars,
  getEvent,
};
