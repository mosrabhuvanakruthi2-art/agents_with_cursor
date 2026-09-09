/**
 * Per-combination content tolerance bands, auto-assembled from the files in this folder.
 * Adding a combination = drop a new file here exporting { combination, ... } — no edit to this index,
 * so teams working on different combinations never touch the same file.
 *
 * Exposes:
 *   bands[combination]        — the whole entry for a combination
 *   fileSize[combination]     — pass-through file size bands
 *   convertedFileSize[…]      — converted file size bands (Google native exports, legacy Office)
 *   forCombination(name)      — the entry, or null when the combination has no bands yet
 */
const fs = require('fs');
const path = require('path');

const bands = {};
const fileSize = {};
const convertedFileSize = {};

for (const file of fs.readdirSync(__dirname)) {
  if (file === 'index.js' || !file.endsWith('.js')) continue;
  const entry = require(path.join(__dirname, file));
  if (!entry || !entry.combination) continue;
  bands[entry.combination] = entry;
  if (entry.fileSize) fileSize[entry.combination] = entry.fileSize;
  if (entry.convertedFileSize) convertedFileSize[entry.combination] = entry.convertedFileSize;
}

/** @returns {object|null} the bands for a combination key, e.g. 'googledrive_to_sharepoint'. */
function forCombination(combination) {
  return bands[String(combination || '')] || null;
}

module.exports = { bands, fileSize, convertedFileSize, forCombination };
