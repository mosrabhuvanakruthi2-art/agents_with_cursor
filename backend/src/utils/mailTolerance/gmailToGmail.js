// Size tolerance bands for Gmail → Gmail. Edit only this file to tune
// gmail_to_gmail tolerances.
module.exports = {
  combination: 'gmail_to_gmail',
  attachmentSize: {
    infoMin: 0.9, infoMax: 1.1,
    warnMin: 0.7, warnMax: 1.3,
    expectedNote: 'Same platform (Gmail→Gmail): attachment sizes should be near-identical.',
  },
  mailboxSize: {
    infoMin: 0.85, infoMax: 1.15, warnMin: 0.7, warnMax: 1.3,
    note: 'Same platform (Gmail→Gmail): mailbox sizes should be near-identical (±15%).',
  },
};
