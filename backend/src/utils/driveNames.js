/**
 * Shared Drive / folder name normalisation.
 *
 * Lives here rather than in driveClient because migrationClient needs it too, and requiring
 * driveClient there would pull googleapis into a module that only builds HTTP payloads.
 */

/**
 * Trim whitespace, then strip leading AND trailing slashes.
 *
 * Names reach the code as path-style strings — a CSV column ("/QA_Team1/"), a form field, or
 * GOOGLE_SHARED_DRIVE_NAME. Only LEADING slashes were ever stripped
 * (AgentOrchestrator's `.replace(/^\/+/, '')`), so "/QA_Team1/" became "QA_Team1/", never matched
 * the drive named "QA_Team1", and seeding silently fell back to My Drive.
 */
function normalizeDriveName(name) {
  return String(name || '').trim().replace(/^\/+|\/+$/g, '').trim();
}

/** Case-insensitive compare of two drive/folder names after normalisation. */
function driveNamesMatch(a, b) {
  const na = normalizeDriveName(a).toLowerCase();
  return na !== '' && na === normalizeDriveName(b).toLowerCase();
}

module.exports = { normalizeDriveName, driveNamesMatch };
