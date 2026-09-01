/**
 * Per-pair role and link-scope maps, auto-assembled from the files in this folder.
 *
 * Adding a source→destination pair = drop a file here exporting `{ pair, combinations, ... }`. No edit
 * to this index and no edit to any shared module.
 *
 * Why this exists alongside `validation/contentRoleMap.js`: that file holds the Box→SharePoint and
 * Drive→SharePoint tables and is imported by every live combination, so each added pair grew the one
 * file two people would then have to merge. Existing combinations keep using it unchanged — nothing is
 * migrated out of it here — and NEW pairs live in this directory instead. Same arrangement as
 * `validation/destinations/` and `utils/contentTolerance/`.
 *
 * A map exposes the four functions `deepContentCore` calls — isComparableDriveRole,
 * nonComparableReason, compareDriveAccess, compareSharedLink — so a combination can pass it wherever
 * the SharePoint-oriented map would otherwise be used.
 *
 * Exposes:
 *   forCombination(name) — the map for a combination key, or null when no pair covers it
 *   forPair(name)        — the map by its own pair name
 *   pairs()              — every registered pair, for diagnostics
 */
const fs = require('fs');
const path = require('path');

const byPair = {};
const byCombination = {};

for (const file of fs.readdirSync(__dirname)) {
  if (file === 'index.js' || !file.endsWith('.js')) continue;
  const entry = require(path.join(__dirname, file));
  if (!entry || !entry.pair) continue;
  byPair[String(entry.pair).toLowerCase()] = entry;
  for (const combo of entry.combinations || []) {
    byCombination[String(combo).toLowerCase()] = entry;
  }
}

const key = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/**
 * @param {string} combination e.g. 'dropbox_to_googleshareddrive'
 * @returns {object|null} null when no pair covers it — the caller then keeps its own map rather than
 *   silently getting the wrong translation, which is why this does not fall back to anything.
 */
function forCombination(combination) {
  return byCombination[key(combination)] || null;
}

/** @returns {object|null} the map registered under this pair name. */
function forPair(pair) {
  return byPair[key(pair)] || null;
}

/** Every registered pair name. */
function pairs() {
  return Object.keys(byPair).sort();
}

module.exports = { forCombination, forPair, pairs };
