// Size tolerance bands for Outlook → Outlook. Edit only this file to tune
// outlook_to_outlook tolerances.
module.exports = {
  combination: 'outlook_to_outlook',
  attachmentSize: {
    infoMin: 0.9, infoMax: 1.1,
    warnMin: 0.7, warnMax: 1.3,
    expectedNote: 'Same platform (Outlook→Outlook): attachment sizes should be near-identical.',
  },
  mailboxSize: {
    infoMin: 0.85, infoMax: 1.15, warnMin: 0.7, warnMax: 1.3,
    note: 'Same platform (Outlook→Outlook): mailbox sizes should be near-identical (±15%).',
  },
};
