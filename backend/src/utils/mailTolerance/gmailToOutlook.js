// Size tolerance bands for Gmail → Outlook. Edit only this file to tune
// gmail_to_outlook tolerances.
module.exports = {
  combination: 'gmail_to_outlook',
  attachmentSize: {
    infoMin: 1.0, infoMax: 1.6,
    warnMin: 0.85, warnMax: 2.0,
    expectedNote:
      'Gmail API reports decoded (raw) bytes; Graph API includes base64 encoding + MIME envelope overhead (~33–45% larger). ' +
      'This size difference is expected during Gmail→Outlook migration.',
  },
  mailboxSize: {
    infoMin: 0.7, infoMax: 1.3, warnMin: 0.5, warnMax: 1.6,
    note: 'Gmail sizeEstimate vs Outlook MIME sizes — a ±30% difference is normal due to header additions and encoding conversions during migration.',
  },
};
