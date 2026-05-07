/**
 * Build permission-mapping rows for To/Cc/Bcc QA: pair source directory users with
 * destination users using the same first-name heuristic as Auto-Map, then fill gaps by
 * matching the local-part of the email (before @).
 */

/** @param {string} email */
export function localPart(email) {
  const i = String(email || '').indexOf('@');
  if (i <= 0) return '';
  return String(email).slice(0, i).toLowerCase().replace(/\./g, '');
}

/**
 * @param {{ sourceEmail?: string, destinationEmail?: string }[]} confirmedPairs Rows from Auto-Map (includes manual overrides)
 * @param {unknown[]} sourceUsers Raw source users from directory fetch
 * @param {unknown[]} destUsers Raw destination users from directory fetch
 * @returns {{ sourceEmail: string, destinationEmail: string }[]}
 */
export function mergePermissionMappings(confirmedPairs, sourceUsers, destUsers) {
  const src = Array.isArray(sourceUsers) ? sourceUsers : [];
  const dst = Array.isArray(destUsers) ? destUsers : [];

  const mappedSrc = new Set();
  const usedDestKeys = new Set();

  /** @type {Map<string, { sourceEmail: string, destinationEmail: string }>} */
  const byKey = new Map();

  function destKey(u) {
    if (u && u.id != null && u.id !== '') return `id:${u.id}`;
    const em = String(u?.email || '').toLowerCase();
    return em ? `em:${em}` : '';
  }

  function commit(sourceEmail, destinationEmail) {
    const s = String(sourceEmail || '').trim();
    const d = String(destinationEmail || '').trim();
    if (!s || !d) return;
    const key = s.toLowerCase();
    if (mappedSrc.has(key)) return;
    mappedSrc.add(key);
    byKey.set(key, { sourceEmail: s, destinationEmail: d });
    const du = dst.find((u) => u.email && String(u.email).toLowerCase() === d.toLowerCase());
    const dk = destKey(du || { email: d });
    if (dk) usedDestKeys.add(dk);
  }

  for (const p of confirmedPairs || []) commit(p.sourceEmail, p.destinationEmail);

  function firstNameNorm(u) {
    return String(u.firstName || '')
      .toLowerCase()
      .trim();
  }

  function destAvailable(d) {
    const dk = destKey(d);
    return dk && !usedDestKeys.has(dk);
  }

  // Same first-name pairing as UserMapping.autoMap — for users not covered by confirmed pairs.
  for (const s of src) {
    const sk = String(s.email || '').toLowerCase();
    if (mappedSrc.has(sk)) continue;
    const fn = firstNameNorm(s);
    if (!fn) continue;
    const match = dst.find((d) => destAvailable(d) && firstNameNorm(d) === fn);
    if (match) commit(s.email, match.email);
  }

  // Local-part match (common CloudFuze-style convention: alice@cloudfuze.us ↔ alice@gajha.com).
  for (const s of src) {
    const sk = String(s.email || '').toLowerCase();
    if (mappedSrc.has(sk)) continue;
    const lp = localPart(s.email);
    if (!lp) continue;
    const match = dst.find((d) => destAvailable(d) && localPart(d.email) === lp);
    if (match) commit(s.email, match.email);
  }

  return [...byKey.values()].sort((a, b) => a.sourceEmail.localeCompare(b.sourceEmail));
}
