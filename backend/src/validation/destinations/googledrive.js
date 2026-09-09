/**
 * What Google Drive does to a name and a path — which is very little.
 *
 * Added for the Dropbox → Google combinations. Google is the first DESTINATION that is not Microsoft,
 * and almost none of SharePoint's rules apply:
 *
 *   - no forbidden characters. A name may contain " * : < > ? \ | and even "/" is accepted through
 *     the API (the UI displays it, it is not rewritten).
 *   - no reserved names. CON, PRN, AUX, desktop.ini are ordinary names here.
 *   - no total-path limit, so nothing is relocated and no placeholder link is ever created. A
 *     validator that expected placeholders would report every deep item as wrongly handled.
 *   - a single name may be up to 32,767 characters, so the 255 truncation does not occur either.
 *
 * Stated explicitly rather than left to a default: "Google has no limit" is a claim about the
 * destination, and if it turns out a limit exists it belongs here, in one file, not spread through
 * shared code.
 *
 * NOT YET EXERCISED — no Dropbox → Google run has been validated against these values. They come from
 * Google's documented behaviour, not from an observed migration. Confirm against the combination's
 * scope document before trusting a pass produced with them.
 */

/** Nothing is rejected, so the "invalid characters" set is empty. */
function invalidChars() {
  // A regex that can never match. Kept as a function for the same reason SharePoint's is: a shared
  // /g instance would carry lastIndex between .test() calls.
  return /(?!)/g;
}

/** Google reserves no names. */
function isReservedName() {
  return false;
}

/**
 * Google stores the name as given. Only surrounding whitespace is trimmed, matching what the Drive
 * API does on create — the `replacement` argument is accepted for signature compatibility and is
 * deliberately unused, because no character is ever replaced.
 */
function sanitizeName(name) {
  return String(name || '').trim();
}

/** Only leading or trailing whitespace ever changes. */
function needsSanitizing(name) {
  const raw = String(name || '');
  return raw !== raw.trim();
}

module.exports = {
  destination: 'googledrive',
  // A Shared Drive is the same storage with a different ownership model; the name rules are identical.
  aliases: ['googleshareddrive'],
  label: 'Google Drive',

  invalidChars,
  isReservedName,
  sanitizeName,
  needsSanitizing,

  // No total-path limit. Infinity rather than a large number so a comparison can never accidentally
  // trip it, and so the intent reads as "there is no limit" rather than "the limit is big".
  pathLengthLimit: Infinity,
  segmentLengthLimit: 32767,
  truncationMatchMin: 60,
  // Nothing is relocated, so a placeholder link is never the expected outcome.
  usesPlaceholderLinksOverPathLimit: false,
};
