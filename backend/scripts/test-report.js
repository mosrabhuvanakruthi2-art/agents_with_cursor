/**
 * Backend test report — runs every test file in the npm test chain and prints a success rate.
 *
 * Run: npm run test:report   (from backend/)
 *
 * The plain `npm test` chain stops at the first failure, which is right for a gate but useless for
 * "where do we stand". This runs every file regardless, then reports per-file results, scenario counts
 * where a file exposes them, and an overall rate. Read-only: it starts no server and touches no cloud.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const TEST_DIR = path.resolve(__dirname, '../test');
const pkg = require('../package.json');

/** Test files in the order the npm test chain runs them, so this mirrors the gate. */
function filesFromChain() {
  const chain = String(pkg.scripts?.test || '');
  const ordered = [...chain.matchAll(/node\s+test\/([\w.-]+\.test\.js)/g)].map((m) => m[1]);
  const onDisk = fs.readdirSync(TEST_DIR).filter((f) => f.endsWith('.test.js'));
  // Anything on disk but absent from the chain never runs in CI — worth surfacing.
  const unwired = onDisk.filter((f) => !ordered.includes(f));
  return { ordered, unwired };
}

function run(file) {
  const started = Date.now();
  const res = spawnSync(process.execPath, [path.join(TEST_DIR, file)], {
    encoding: 'utf8',
    env: { ...process.env, LOG_LEVEL: process.env.LOG_LEVEL || 'error' },
  });
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  // A file may report its own scenario tally, e.g. "18/18 scenarios passed (100.0%)".
  const tally = out.match(/(\d+)\/(\d+)\s+scenarios passed/);
  return {
    file,
    ok: res.status === 0,
    ms: Date.now() - started,
    scenarios: tally ? { passed: Number(tally[1]), total: Number(tally[2]) } : null,
    output: out.trim(),
  };
}

const { ordered, unwired } = filesFromChain();
const results = ordered.map(run);

const filesPassed = results.filter((r) => r.ok).length;
const scenarioTotals = results.reduce((acc, r) => {
  if (r.scenarios) {
    acc.passed += r.scenarios.passed;
    acc.total += r.scenarios.total;
  }
  return acc;
}, { passed: 0, total: 0 });

const pct = (a, b) => (b === 0 ? '0.0' : ((a / b) * 100).toFixed(1));

console.log('\nBackend test report');
console.log('═'.repeat(72));
for (const r of results) {
  const status = r.ok ? 'PASS' : 'FAIL';
  const detail = r.scenarios ? `${r.scenarios.passed}/${r.scenarios.total} scenarios` : '';
  console.log(`  ${status}  ${r.file.padEnd(40)} ${String(r.ms + 'ms').padStart(7)}  ${detail}`);
  if (!r.ok) {
    for (const line of r.output.split('\n').slice(-12)) console.log(`        ${line}`);
  }
}
console.log('═'.repeat(72));
console.log(`  Files     : ${filesPassed}/${results.length} passed (${pct(filesPassed, results.length)}%)`);
if (scenarioTotals.total > 0) {
  console.log(`  Scenarios : ${scenarioTotals.passed}/${scenarioTotals.total} passed `
    + `(${pct(scenarioTotals.passed, scenarioTotals.total)}%)`);
}
if (unwired.length > 0) {
  console.log(`\n  NOT WIRED into the npm test chain (they never run): ${unwired.join(', ')}`);
}
console.log('');

process.exit(filesPassed === results.length ? 0 : 1);
