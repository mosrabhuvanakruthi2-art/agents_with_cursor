/**
 * Pick another mailbox from GOOGLE_ACCOUNTS for realistic To: / calendar attendee fields.
 * Prefers any configured email other than the migration source; if only one account exists, returns source.
 *
 * @param {Map<string, string>} accounts email (lowercase) -> refresh token
 * @param {string} sourceEmail migration source user
 * @returns {string} email to use in To: or as attendee
 */
function norm(s) {
  return String(s || '').toLowerCase().trim();
}

function pickCorrespondentEmail(accounts, sourceEmail) {
  if (!accounts || accounts.size === 0) {
    return String(sourceEmail || '').toLowerCase().trim();
  }
  const n = norm(sourceEmail);
  const keys = Array.from(accounts.keys());
  const alternate = keys.find((e) => e !== n);
  return alternate || n;
}

/**
 * Cc: a GOOGLE_ACCOUNTS address different from the To line when possible.
 * With only two accounts and To = correspondent, Cc resolves to the source mailbox (valid for QA).
 */
function pickCcEmail(accounts, sourceEmail, toEmail) {
  if (!accounts?.size) return norm(sourceEmail);
  const nt = norm(toEmail);
  const ns = norm(sourceEmail);
  for (const e of accounts.keys()) {
    if (norm(e) !== nt) return e;
  }
  for (const e of accounts.keys()) {
    if (norm(e) !== ns) return e;
  }
  return Array.from(accounts.keys())[0];
}

module.exports = { pickCorrespondentEmail, pickCcEmail, norm };
