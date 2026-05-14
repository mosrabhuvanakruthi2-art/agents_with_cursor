/**
 * Pick another mailbox from GOOGLE_ACCOUNTS for realistic To: / calendar attendee fields.
 *
 * Seeds mail as From: migration source → To: correspondent — so we avoid always picking the
 * first alternate (often the same address when .env ordering is stable). Uses a deterministic
 * hash of the source mailbox so different sources tend to route to different correspondents
 * when GOOGLE_ACCOUNTS lists three or more users.
 *
 * @param {Map<string, string>} accounts email (lowercase) -> refresh token
 * @param {string} sourceEmail migration source user
 * @returns {string} email to use in To: or as attendee
 */
function norm(s) {
  return String(s || '').toLowerCase().trim();
}

/** Stable index in [0, modulus) from a seed string — same inputs always yield same pick. */
function stablePickIndex(seedStr, modulus) {
  let h = 2166136261;
  const s = String(seedStr ?? '');
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  }
  return modulus <= 1 ? 0 : Math.abs(h >>> 0) % modulus;
}

function pickCorrespondentEmail(accounts, sourceEmail) {
  if (!accounts || accounts.size === 0) {
    return norm(sourceEmail);
  }
  const n = norm(sourceEmail);
  const alternates = Array.from(accounts.keys())
    .filter((e) => norm(e) !== n)
    .sort((a, b) => norm(a).localeCompare(norm(b)));
  if (alternates.length === 0) return n;
  const idx = stablePickIndex(`to:${n}`, alternates.length);
  return alternates[idx];
}

/**
 * Cc: distinct GOOGLE_ACCOUNTS addresses when possible (different from To:).
 * With two accounts only, Cc often equals the mailbox not on the To line.
 */
function pickCcEmail(accounts, sourceEmail, toEmail) {
  if (!accounts?.size) return norm(sourceEmail);
  const nt = norm(toEmail);
  const ns = norm(sourceEmail);

  let candidates = Array.from(accounts.keys())
    .filter((e) => norm(e) !== nt && norm(e) !== ns)
    .sort((a, b) => norm(a).localeCompare(norm(b)));
  if (candidates.length >= 1) {
    const idx = stablePickIndex(`cc:${ns}|${nt}`, candidates.length);
    return candidates[idx];
  }

  candidates = Array.from(accounts.keys())
    .filter((e) => norm(e) !== nt)
    .sort((a, b) => norm(a).localeCompare(norm(b)));
  if (candidates.length >= 1) {
    const idx = stablePickIndex(`ccf:${ns}|${nt}`, candidates.length);
    return candidates[idx];
  }

  return Array.from(accounts.keys())[0];
}

/**
 * Bcc: distinct GOOGLE_ACCOUNTS address — never the source (sender), To, or Cc.
 *
 * The source Gmail view was previously showing "Bcc: peter@cloudfuze.us" on QA seeds because
 * we used sourceEmail as a "self-bcc". Pick a fourth user from GOOGLE_ACCOUNTS so mail/test-data
 * reflects realistic multi-recipient scenarios (From/To/Cc/Bcc all distinct).
 *
 * @param {Map<string, string>} accounts email (lowercase) -> refresh token
 * @param {string} sourceEmail sender mailbox
 * @param {string} toEmail primary recipient
 * @param {string} ccEmail Cc recipient (excluded)
 * @returns {string} address to use as Bcc (falls back to sourceEmail only if no other account)
 */
function pickBccEmail(accounts, sourceEmail, toEmail, ccEmail) {
  if (!accounts?.size) return norm(sourceEmail);
  const ns = norm(sourceEmail);
  const nt = norm(toEmail);
  const nc = norm(ccEmail);

  const strict = Array.from(accounts.keys())
    .filter((e) => {
      const n = norm(e);
      return n !== ns && n !== nt && n !== nc;
    })
    .sort((a, b) => norm(a).localeCompare(norm(b)));
  if (strict.length > 0) {
    const idx = stablePickIndex(`bcc:${ns}|${nt}|${nc}`, strict.length);
    return strict[idx];
  }

  const relaxed = Array.from(accounts.keys())
    .filter((e) => {
      const n = norm(e);
      return n !== ns && n !== nt;
    })
    .sort((a, b) => norm(a).localeCompare(norm(b)));
  if (relaxed.length > 0) {
    const idx = stablePickIndex(`bccf:${ns}|${nt}|${nc}`, relaxed.length);
    return relaxed[idx];
  }

  const any = Array.from(accounts.keys())
    .filter((e) => norm(e) !== ns)
    .sort((a, b) => norm(a).localeCompare(norm(b)));
  return any[0] || ns;
}

/**
 * Sorted list of distinct tenant addresses to rotate as inbound-mail senders.
 *
 * Used by the GmailTestDataAgent / OutlookTestDataAgent to seed mail INTO the source user's
 * Inbox that appears to come from several different tenant users. This is insert-only —
 * Gmail: users.messages.insert; Outlook: POST /mailFolders/inbox/messages. Nothing is ever
 * actually sent, and no data is written to any correspondent's mailbox.
 *
 * @param {Map<string, unknown> | Iterable<string>} accounts Map<email, refreshToken> or list of emails.
 * @param {string} sourceEmail migration source user (excluded from the rotation).
 * @returns {string[]} sorted, distinct addresses; empty when none are available.
 */
function buildInboundSenderRotation(accounts, sourceEmail) {
  if (!accounts) return [];
  const ns = norm(sourceEmail);
  /**
   * Map → iterate email keys; Array / other iterables → iterate values directly.
   * (We avoid `accounts.keys()` on Arrays because that returns indices, not strings.)
   */
  const keys = accounts instanceof Map
    ? Array.from(accounts.keys())
    : Array.from(accounts);
  const alternates = keys
    .map((e) => String(e || '').trim())
    .filter(Boolean)
    .filter((e) => norm(e) !== ns)
    .sort((a, b) => norm(a).localeCompare(norm(b)));
  return Array.from(new Set(alternates));
}

/**
 * Deterministic sender-for-index picker that cycles through `rotation` using a stable hash
 * of source+index, so two runs with the same source mail ordering produce the same senders.
 */
function pickRotatedSender(rotation, sourceEmail, index) {
  if (!Array.isArray(rotation) || rotation.length === 0) return norm(sourceEmail);
  if (rotation.length === 1) return rotation[0];
  const seeded = stablePickIndex(`inbound:${norm(sourceEmail)}:${index}`, rotation.length);
  const offset = (seeded + index) % rotation.length;
  return rotation[offset];
}

module.exports = {
  pickCorrespondentEmail,
  pickCcEmail,
  pickBccEmail,
  buildInboundSenderRotation,
  pickRotatedSender,
  norm,
  stablePickIndex,
};
