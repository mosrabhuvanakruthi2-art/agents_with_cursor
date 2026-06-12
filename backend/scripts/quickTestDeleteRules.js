'use strict';

/**
 * quickTestDeleteRules.js
 * Tests the deleteAllInboxRules fix (app-token auth).
 * Usage:  cd backend && node scripts/quickTestDeleteRules.js
 */

require('../src/config/env');
const outlookClient = require('../src/clients/outlookClient');

const TARGET = 'alex@qatestagent.com';

async function main() {
  console.log(`\n=== deleteAllInboxRules quick test (${TARGET}) ===\n`);

  // 1. List rules before
  const before = await outlookClient.getInboxRules(TARGET);
  if (!before.available) {
    console.error('FAIL: getInboxRules returned available=false —', before.note);
    process.exit(1);
  }
  console.log(`Before: ${before.rules.length} rule(s) found`);
  before.rules.forEach((r, i) =>
    console.log(`  [${i + 1}] "${r.displayName}" — enabled: ${r.isEnabled}`)
  );

  if (before.rules.length === 0) {
    console.log('\nNothing to delete — rules already clean.');
    process.exit(0);
  }

  // 2. Delete all
  console.log('\nDeleting...');
  const deleted = await outlookClient.deleteAllInboxRules(TARGET);
  console.log(`deleteAllInboxRules returned: ${deleted}`);

  // 3. List rules after
  const after = await outlookClient.getInboxRules(TARGET);
  console.log(`\nAfter: ${after.rules.length} rule(s) remaining`);

  if (after.rules.length === 0) {
    console.log('\n✓ PASS — all inbox rules deleted successfully');
  } else {
    console.error('\n✗ FAIL — rules still present after deletion:');
    after.rules.forEach((r) => console.error(`  - "${r.displayName}"`));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err.message);
  process.exit(1);
});
