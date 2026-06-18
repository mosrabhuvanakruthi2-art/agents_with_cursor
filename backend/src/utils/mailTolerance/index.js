/**
 * Per-combination size tolerance bands, auto-assembled from the files in this
 * folder. Adding a combination = drop a new file here exporting
 * { combination, attachmentSize, mailboxSize } — no edit to this index.
 *
 * Exposes:
 *   attachmentSize[combination] — bands used by compareAttachmentSizesWithTolerance
 *   mailboxSize[combination]    — bands used by buildMailboxSizeValidation
 */
const fs = require('fs');
const path = require('path');

const attachmentSize = {};
const mailboxSize = {};

for (const file of fs.readdirSync(__dirname)) {
  if (file === 'index.js' || !file.endsWith('.js')) continue;
  const entry = require(path.join(__dirname, file));
  if (!entry || !entry.combination) continue;
  if (entry.attachmentSize) attachmentSize[entry.combination] = entry.attachmentSize;
  if (entry.mailboxSize) mailboxSize[entry.combination] = entry.mailboxSize;
}

module.exports = { attachmentSize, mailboxSize };
