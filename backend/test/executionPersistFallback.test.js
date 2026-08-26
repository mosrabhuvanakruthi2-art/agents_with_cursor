/**
 * Run: npm test  (from backend/)
 *
 * A finished execution must survive a restart even when MongoDB accepts a connection but rejects
 * every write.
 *
 * `mongoStore.isReady()` is `!!getDb()` — it proves a CLIENT OBJECT exists, not that writes work.
 * When Atlas dropped TLS mid-session the client stayed non-null, so `persist()` kept taking the
 * Mongo branch, every upsert rejected, and the file fallback was never reached. Eight executions
 * lived only in the process's memory, including a 51-minute validation run.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Point the store at a scratch data directory so the real backend/data/executions.json is never
// touched by a test run.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-persist-'));
const dataDir = path.join(scratch, 'data');
fs.mkdirSync(dataDir, { recursive: true });

// Stub the Mongo store BEFORE executionService is loaded: connected, but every write fails.
const storePath = require.resolve('../src/services/executionMongoStore');
require(storePath);
let upsertCalls = 0;
let failWrites = true;
require.cache[storePath].exports = {
  isReady: () => true,
  upsertExecution: async () => {
    upsertCalls++;
    if (failWrites) throw new Error('tlsv1 alert internal error');
    return true;
  },
  loadAllExecutions: async () => [],
  deleteExecution: async () => true,
  COLLECTION: 'executions',
};

// executionService resolves its data directory relative to its own file, so redirect writes by
// intercepting them rather than by moving the module.
const realWrite = fs.writeFileSync;
const writes = [];
fs.writeFileSync = function (file, data, enc) {
  if (String(file).endsWith('executions.json')) {
    writes.push(String(data));
    return realWrite.call(fs, path.join(dataDir, 'executions.json'), data, enc);
  }
  return realWrite.apply(fs, arguments);
};

const executionService = require('../src/services/executionService');

let failures = 0;
function check(name, fn) {
  try {
    fn();
  } catch (err) {
    failures++;
    console.error('  FAIL ' + name + '\n        ' + err.message);
  }
}

function ctx(id) {
  return {
    executionId: id,
    userEmail: 'qa@example.com',
    toJSON: () => ({ executionId: id, sourceEmail: 'a@b.c', destinationEmail: 'd@e.f' }),
  };
}

// ── Mongo connected but every write failing ─────────────────────────────────
writes.length = 0;
executionService.create(ctx('exec-tls-broken'));

check('a failed Mongo upsert is attempted', function () {
  assert.ok(upsertCalls > 0, 'the Mongo branch should still be tried first');
});

// The rejection is handled asynchronously, so let the microtask queue drain.
setTimeout(function () {
  check('a failed upsert falls back to the local file', function () {
    assert.ok(
      writes.length > 0,
      'nothing was written to disk — the execution would be lost on restart'
    );
  });
  check('the fallback file contains the execution', function () {
    const last = JSON.parse(writes[writes.length - 1]);
    assert.ok(
      last.some(function (e) { return e.executionId === 'exec-tls-broken'; }),
      'the execution is missing from the persisted file'
    );
  });

  // ── Mongo healthy: the file is NOT rewritten on every progress tick ───────
  failWrites = false;
  writes.length = 0;
  const before = upsertCalls;
  executionService.update('exec-tls-broken', { progress: 'step 1' });
  executionService.update('exec-tls-broken', { progress: 'step 2' });

  setTimeout(function () {
    check('a healthy Mongo still absorbs the writes', function () {
      assert.ok(upsertCalls > before, 'upsert was not called');
    });
    check('NEGATIVE a healthy Mongo does not rewrite the whole file per update', function () {
      assert.strictEqual(
        writes.length, 0,
        'the file was rewritten while Mongo was healthy — that is the churn the Mongo branch exists to avoid'
      );
    });

    fs.writeFileSync = realWrite;
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* scratch dir */ }

    if (failures > 0) {
      console.error('executionPersistFallback.test.js: ' + failures + ' check(s) failed');
      process.exit(1);
    }
    console.log('executionPersistFallback.test.js: ok');
  }, 30);
}, 30);
