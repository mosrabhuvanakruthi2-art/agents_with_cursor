// Size tolerance bands for Outlook → Gmail. Edit only this file to tune
// outlook_to_gmail tolerances.
module.exports = {
  combination: 'outlook_to_gmail',
  attachmentSize: {
    infoMin: 0.55, infoMax: 1.05,
    warnMin: 0.4, warnMax: 1.2,
    expectedNote:
      'Graph API reports base64-encoded + MIME size; Gmail API reports decoded (raw) bytes (~25–32% smaller). ' +
      'This size difference is expected during Outlook→Gmail migration.',
  },
  mailboxSize: {
    infoMin: 0.7, infoMax: 1.3, warnMin: 0.5, warnMax: 1.6,
    note: 'Outlook MIME sizes vs Gmail sizeEstimate — a ±30% difference is normal due to header additions and encoding conversions during migration.',
  },
};
