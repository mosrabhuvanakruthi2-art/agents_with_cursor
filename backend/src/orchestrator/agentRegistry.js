/**
 * Agent registry — maps (domain, sourceProvider, destinationProvider) to the
 * set of agents that run for that combination.
 *
 * Combinations self-register from ./combinations/*. Adding a new combination is
 * a NEW FILE in ./combinations — no edit to this file or the orchestrator, so
 * developers working on different combinations never touch the same file.
 */
const fs = require('fs');
const path = require('path');

const registry = new Map();
const key = (domain, src, dst) => `${domain}:${src}:${dst}`;

/**
 * @param {string} domain            'mail' | 'content' | 'message' (future)
 * @param {string} sourceProvider    e.g. 'google' | 'microsoft' | 'box' | 'googledrive'
 * @param {string} destinationProvider
 * @param {{ TestDataAgent?: Function, ValidationAgent: Function }} handlers  agent classes.
 *        TestDataAgent is optional — content migrations create source data via a separate
 *        flow and skip test-data seeding, so those combinations register without one.
 */
function register(domain, sourceProvider, destinationProvider, handlers) {
  registry.set(key(domain, sourceProvider, destinationProvider), handlers);
}

/** Returns the registered agent set, or undefined if the combination is unknown. */
function resolve(domain, sourceProvider, destinationProvider) {
  return registry.get(key(domain, sourceProvider, destinationProvider));
}

// Exports are assigned BEFORE auto-loading so that combination files can safely
// `require('../agentRegistry')` while this module is still initializing.
module.exports = { register, resolve };

// Combinations live in per-domain subfolders: combinations/<domain>/<combo>.js
// (e.g. combinations/mail/gmailToOutlook.js, combinations/content/boxToSharepoint.js).
// Recurse so a new domain or combination is just a NEW FILE — no edit here.
function loadCombinations(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) loadCombinations(full);
    else if (entry.name.endsWith('.js')) require(full);
  }
}
loadCombinations(path.join(__dirname, 'combinations'));
