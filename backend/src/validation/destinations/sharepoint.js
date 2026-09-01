/**
 * What SharePoint Online (and OneDrive) does to a name and a path.
 *
 * These rules used to sit inside `validation/shared/deepContentCore.js`, which meant every
 * combination — including ones migrating INTO Google, where none of them apply — went through
 * SharePoint's character set, reserved names and 400-character path limit. Two people adding two
 * destinations then had to edit the same 1100-line file that all five live combinations depend on.
 *
 * Moving them here makes a destination an ADDED FILE rather than an edit to shared code, the same way
 * `utils/contentTolerance/` and the combination registries already work.
 *
 * OneDrive is listed as an alias: it is the same storage engine and enforces the same rules.
 */

/**
 * Characters SharePoint Online actually rejects in a file or folder name:  " * : < > ? / \ |
 *
 * The set used to also include ~ # % & { }. Those have been permitted since the 2017
 * special-character update, and treating them as invalid made the validator predict a destination
 * name that never occurs. Observed on run 6a8d53d2: source "Special !@#$%^&*()-_+=[] Folder" arrived
 * as "Special !@#$%^&-()-_+=[] Folder" — # % & all preserved, only * replaced — while the validator
 * expected "Special !@_$_^__()-_+=[] Folder" and so reported the folder missing, its real name extra,
 * and every child misplaced. One wrong character class, four wrong findings.
 *
 * A FRESH regex each call, never a shared /g constant: a global regex carries `lastIndex` between
 * `.test()` calls, so a shared instance makes the result depend on call order.
 *
 * A leading ~ is handled by isReservedName(), not here, because only its position is a problem.
 */
function invalidChars() {
  return /["*:<>?/\\|]/g;
}

/** Names SharePoint refuses regardless of characters. */
const RESERVED_NAMES = new Set([
  '.lock', 'con', 'prn', 'aux', 'nul', 'desktop.ini', 'forms',
  ...Array.from({ length: 10 }, (_, i) => `com${i}`),
  ...Array.from({ length: 10 }, (_, i) => `lpt${i}`),
]);

/** True when the name is reserved by SharePoint and cannot be created as-is. */
function isReservedName(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return false;
  if (RESERVED_NAMES.has(n)) return true;
  if (n.startsWith('~$')) return true;
  if (n.includes('_vti_')) return true;
  // Leading "゛" / "ဧ" are rejected as the first character of a folder name.
  return /^[゛ဗ]/.test(n);
}

/**
 * The name SharePoint should end up with: unsupported characters replaced, surrounding spaces
 * trimmed. Case is preserved. `replacement` is '_' or '-' (feature 7.1 allows either).
 */
function sanitizeName(name, replacement = '_') {
  return String(name || '').replace(invalidChars(), replacement).trim();
}

/** True when the name carries characters or spacing SharePoint will not accept unchanged. */
function needsSanitizing(name) {
  const raw = String(name || '');
  return invalidChars().test(raw) || raw !== raw.trim();
}

module.exports = {
  destination: 'sharepoint',
  // OneDrive is the same engine with the same limits.
  aliases: ['onedrive'],
  label: 'SharePoint Online',

  invalidChars,
  // Exposed so deepContentCore can keep re-exporting it; nothing else reads it today.
  reservedNames: RESERVED_NAMES,
  isReservedName,
  sanitizeName,
  needsSanitizing,

  /** Full encoded path length beyond which the destination substitutes a placeholder link. */
  pathLengthLimit: 400,
  /** Longest single path segment SharePoint accepts. */
  segmentLengthLimit: 255,
  /** Shortest prefix that still counts as "this is the truncated form of that name". */
  truncationMatchMin: 60,
  /** Over-limit items arrive as a Folder/File Path Link URL rather than the content itself. */
  usesPlaceholderLinksOverPathLimit: true,
};
