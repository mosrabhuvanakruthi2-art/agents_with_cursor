/**
 * Destination name and path rules, auto-assembled from the files in this folder.
 *
 * Adding a destination = drop a new file here exporting `{ destination, ... }`. No edit to this index,
 * and no edit to `validation/shared/deepContentCore.js` — which is the point. Those rules used to live
 * inside deepContentCore, so supporting a new destination meant changing an 1100-line file that every
 * live combination depends on, and two people adding two destinations collided on it.
 *
 * Same pattern as `utils/contentTolerance/` and the two combination registries, which nobody has ever
 * had to merge by hand.
 *
 * Exposes:
 *   forDestination(name)  — the rules for a destination or alias, or null when none is registered
 *   rulesFor(name)        — the same, falling back to SharePoint (today's behaviour for every caller
 *                           that does not name a destination)
 *   DEFAULT               — the SharePoint rules
 *   names()               — every registered destination and alias
 */
const fs = require('fs');
const path = require('path');

const byName = {};

for (const file of fs.readdirSync(__dirname)) {
  if (file === 'index.js' || !file.endsWith('.js')) continue;
  const entry = require(path.join(__dirname, file));
  if (!entry || !entry.destination) continue;
  byName[String(entry.destination).toLowerCase()] = entry;
  for (const alias of entry.aliases || []) {
    byName[String(alias).toLowerCase()] = entry;
  }
}

const DEFAULT = byName.sharepoint || null;

/** Normalise a provider string: "SHAREPOINT_ONLINE_BUSINESS", "sharepoint", "Google Shared Drive". */
function normalize(name) {
  const n = String(name || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!n) return '';
  if (byName[n]) return n;
  // Longest registered name that the provider string contains, so a CloudFuze cloud name such as
  // "GOOGLE_SHARED_DRIVES" resolves to googleshareddrive rather than to googledrive.
  const hit = Object.keys(byName)
    .filter((k) => n.includes(k))
    .sort((a, b) => b.length - a.length)[0];
  return hit || '';
}

/** @returns {object|null} rules for a destination, or null when it is not registered. */
function forDestination(name) {
  const key = normalize(name);
  return key ? byName[key] : null;
}

/**
 * Rules for a destination, falling back to SharePoint.
 *
 * The fallback is deliberate and is what keeps this change behaviour-neutral: every existing caller
 * passes no destination and so keeps exactly the rules it had. A combination migrating somewhere else
 * has to name its destination to get different treatment.
 */
function rulesFor(name) {
  return forDestination(name) || DEFAULT;
}

/** Every registered destination and alias, for diagnostics. */
function names() {
  return Object.keys(byName).sort();
}

module.exports = { forDestination, rulesFor, DEFAULT, names };
