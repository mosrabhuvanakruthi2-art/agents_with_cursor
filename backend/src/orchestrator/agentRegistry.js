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
 * @param {string} domain            e.g. 'mail'
 * @param {string} sourceProvider    'google' | 'microsoft'
 * @param {string} destinationProvider
 * @param {{ TestDataAgent: Function, ValidationAgent: Function }} handlers  agent classes
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

const combosDir = path.join(__dirname, 'combinations');
for (const file of fs.readdirSync(combosDir)) {
  if (file.endsWith('.js')) require(path.join(combosDir, file));
}
