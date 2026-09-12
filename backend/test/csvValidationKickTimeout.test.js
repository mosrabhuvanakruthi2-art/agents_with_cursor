/**
 * The request that STARTS CloudFuze's path-CSV validation must not be aborted by us.
 *
 * POST /mapping/download/csvcreator/{csvId}/asynchronous is "asynchronous" in name only: it returns
 * once CloudFuze has walked the source path, and its reply carries "Total Saved Count :N". It was
 * given a hard-coded 60s timeout, which SharePoint never hit (~8s) and Google My Drive always did.
 * When we abort it, CloudFuze saves nothing, every csvvalidationstatus poll afterwards reads
 * "Total Saved Count :0", the mapping row stays UNVALIDATED, and the job is refused with
 * "Migration not Allowed for wrong CSV paths" having moved nothing.
 *
 * These are behavioural: axios is stubbed, triggerMigration() is actually run, and the assertions
 * are made against the outbound request that was really issued.
 */
const assert = require('assert');
const path = require('path');
const Module = require('module');

const failures = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`PASS  ${name}`))
    .catch((err) => { failures.push(name); console.error(`FAIL  ${name}: ${err.message}`); });
}

const AXIOS_PATH = require.resolve('axios');
const CLIENT_PATH = require.resolve(path.join(__dirname, '..', 'src', 'clients', 'migrationClient.js'));

/**
 * Run triggerMigration() against a stubbed axios and return every request it issued.
 * `kickBehaviour` decides what the csvcreator call does: 'ok' | 'zeroSaved' | 'timeout'.
 */
async function runFlow(kickBehaviour, enumeration = 'ok') {
  for (const p of [AXIOS_PATH, CLIENT_PATH]) delete require.cache[p];

  const calls = [];
  const respond = (method, url, cfg) => {
    calls.push({ method, url, timeout: cfg?.timeout });

    if (/\/filefolder\//.test(url)) {
      // The pre-flight. 'blind' = CloudFuze can see nothing in the source cloud; 'unknown' = the
      // probe itself failed, which must never block a run.
      if (enumeration === 'blind') return { status: 200, data: [] };
      if (enumeration === 'unknown') throw new Error('socket hang up');
      return { status: 200, data: [{ name: '/a:FOLDER' }, { name: '/b:FOLDER' }] };
    }
    if (/\/login\b/.test(url)) {
      return { status: 200, data: { token: 'stub-token', userId: 'user-1' } };
    }
    if (/\/mapping\/user\/path\/csv\b/.test(url)) {
      return {
        status: 200,
        data: { cfMappingCachesList: [{ csvId: 4242, csvName: 'paths.csv' }] },
      };
    }
    if (/\/mapping\/download\/csvcreator\//.test(url)) {
      if (kickBehaviour === 'timeout') {
        const err = new Error('timeout of 600000ms exceeded');
        err.code = 'ECONNABORTED';
        throw err;
      }
      return {
        status: 200,
        data: kickBehaviour === 'zeroSaved'
          ? 'Your Request is under processing Total Saved Count :0'
          : 'Your Request is under processing Total Saved Count :1',
      };
    }
    if (/\/mapping\/user\/cache\/list/.test(url)) {
      return {
        status: 200,
        data: {
          cfMappingCachesList: [{
            csvId: 4242,
            mapped: false,
            sourceCloudDetails: { id: 'src-sub', emailId: 'erik@example.invalid', folderPath: '/mydrive-mydrive', pathRootFolderId: null },
            destCloudDetails: { id: 'dst-sub', emailId: 'mia@example.invalid', folderPath: '/QA-Automation-mydrivetomydrive', pathRootFolderId: null },
          }],
        },
      };
    }
    // Answer the first status poll so the loop exits at once; the 5s x 60 poll budget is not this
    // test's subject.
    if (/csvvalidationstatus/.test(url)) return { status: 200, data: 'CSV report is ready' };
    return { status: 200, data: {} };
  };

  const stub = {
    post: async (url, _body, cfg) => respond('post', url, cfg),
    get: async (url, cfg) => respond('get', url, cfg),
    put: async (url, _body, cfg) => respond('put', url, cfg),
    delete: async (url, cfg) => respond('delete', url, cfg),
  };
  stub.default = stub;

  const originalLoad = Module._load;
  Module._load = function patched(request, parent, isMain) {
    if (request === 'axios') return stub;
    return originalLoad.call(this, request, parent, isMain);
  };

  const logs = [];
  let thrown = null;
  let client;
  try {
    client = require(CLIENT_PATH);
    const logger = require('../src/utils/logger');
    const original = { info: logger.info, warn: logger.warn, error: logger.error };
    for (const level of ['info', 'warn', 'error']) {
      logger[level] = (msg, ...rest) => { logs.push({ level, msg: String(msg) }); return original[level].call(logger, msg, ...rest); };
    }
    client.setRuntimeConfig({
      baseUrl: 'https://qarelease.example.invalid',
      email: 'qa@example.invalid',
      password: 'pw',
      userId: 'user-1',
      basicAuth: 'Basic dGVzdA==',
    });
    try {
      await client.triggerMigration({
        sourceCloudId: 'src-cloud',
        sourceProvider: 'googledrive',
        destCloudId: 'dst-cloud',
        sourceCloudName: 'G_SUITE',
        destCloudName: 'G_SUITE',
        // triggerMigration builds its transfer units from userFolderMappings (migrationClient.js
        // ~1244), the same shape AgentOrchestrator hands it for a real content run.
        userFolderMappings: [{
          sourceEmail: 'erik@example.invalid',
          sourcePath: '/mydrive-mydrive',
          sourceRootId: 'src-folder-id',
          destinationEmail: 'mia@example.invalid',
          destinationPath: '/QA-Automation-mydrivetomydrive',
        }],
      });
    } catch (err) {
      thrown = err;
      // Expected: the stub answers later steps with empty bodies, so triggerMigration gives up
      // somewhere past the validation step. Everything this test asserts on has been recorded by
      // then — the kick request and the log lines around it.
    }
    for (const level of ['info', 'warn', 'error']) logger[level] = original[level];
  } finally {
    Module._load = originalLoad;
    try { client?.clearRuntimeConfig(); } catch { /* the stub may have left no state */ }
    for (const p of [AXIOS_PATH, CLIENT_PATH]) delete require.cache[p];
  }

  return { calls, logs, thrown };
}

const kickOf = (calls) => calls.find((c) => /\/mapping\/download\/csvcreator\//.test(c.url));

(async () => {
  await check('the validation kick is issued with a timeout far above the 60s that aborted every Google run', async () => {
    const { calls } = await runFlow('ok');
    const kick = kickOf(calls);
    assert.ok(kick, 'triggerMigration never called csvcreator/asynchronous');
    assert.notStrictEqual(kick.timeout, 60000, 'the 60s hard-coded timeout is back — it aborts Google My Drive validation');
    assert.ok(kick.timeout >= 300000,
      `kick timeout is ${kick.timeout}ms; CloudFuze needs minutes to walk a Drive tree`);
  });

  await check('the kick timeout is driven by CONTENT_CSV_VALIDATION_KICK_TIMEOUT_MS', async () => {
    const env = require('../src/config/env');
    const { calls } = await runFlow('ok');
    assert.strictEqual(kickOf(calls).timeout, env.CONTENT_CSV_VALIDATION_KICK_TIMEOUT_MS);
  });

  await check('the poll loop still runs after the kick, so a slow-but-successful start is not abandoned', async () => {
    const { calls } = await runFlow('ok');
    assert.ok(calls.some((c) => /csvvalidationstatus/.test(c.url)),
      'no csvvalidationstatus poll was issued');
  });

  await check('a kick that saves 0 rows is reported immediately, not after five minutes of polling', async () => {
    const { logs } = await runFlow('zeroSaved');
    const said = logs.some((l) => l.level === 'warn' && /saved 0 of \d+ path mapping row/i.test(l.msg));
    assert.ok(said, `no "saved 0 of N" warning was logged; got:\n${logs.map((l) => `${l.level}: ${l.msg}`).join('\n')}`);
  });

  await check('a kick timeout is logged as an error naming the consequence, not a shrug', async () => {
    const { logs } = await runFlow('timeout');
    const err = logs.find((l) => l.level === 'error' && /csvcreator\/asynchronous timed out/i.test(l.msg));
    assert.ok(err, 'a kick timeout was not logged at error level');
    assert.ok(/UNVALIDATED/.test(err.msg) && /wrong CSV paths/i.test(err.msg),
      'the timeout message does not say the mapping stays UNVALIDATED and the job will be refused');
    assert.ok(!logs.some((l) => /polling anyway/.test(l.msg)),
      'a timeout still claims "polling anyway" — polling after an aborted kick can never succeed');
  });

  await check('a saved count of 0 stops the run before a migration job is created', async () => {
    const { calls, thrown } = await runFlow('zeroSaved');
    assert.ok(!calls.some((c) => /newmultiuser\/create\/job/.test(c.url)),
      'a job was created from a CSV CloudFuze saved 0 rows from — it can only end CONFLICT, 0 items moved');
    assert.ok(thrown && /failed validation/i.test(thrown.message),
      `expected the run to stop with a validation failure; got: ${thrown && thrown.message}`);
    assert.ok(/saved 0 rows from the path CSV/i.test(thrown.message),
      "the failure does not name CloudFuze's 0 saved rows as the reason");
  });

  await check('a kick that never answers (502 / timeout) also stops the run before a job is created', async () => {
    // The gap the mia -> erik run exposed: a 502 at CloudFuze's own 300s gateway limit leaves the
    // saved count unknown, and "unknown" used to fall through to PASS and submit anyway.
    const { calls, thrown } = await runFlow('timeout');
    assert.ok(!calls.some((c) => /newmultiuser\/create\/job/.test(c.url)),
      'a job was created even though CloudFuze never answered the validation request');
    assert.ok(thrown && /never answered/i.test(thrown.message),
      `expected the failure to say CloudFuze never answered; got: ${thrown && thrown.message}`);
  });

  await check('a source cloud CloudFuze cannot enumerate stops the run before any mapping work', async () => {
    const { calls, thrown } = await runFlow('ok', 'blind');
    assert.ok(calls.some((c) => /\/filefolder\//.test(c.url)), 'the pre-flight was never issued');
    for (const later of [/mapping\/user\/path\/csv/, /csvcreator/, /csvvalidationstatus/, /newmultiuser\/create\/job/]) {
      assert.ok(!calls.some((c) => later.test(c.url)),
        `work continued past the pre-flight: ${later} was still called`);
    }
    assert.ok(thrown && /cannot list anything in the source cloud/i.test(thrown.message),
      `expected the pre-flight message; got: ${thrown && thrown.message}`);
  });

  await check('a pre-flight that cannot answer never blocks the run', async () => {
    // A slow or erroring probe is not evidence that the cloud is broken. Blocking on it would
    // break combinations whose enumeration is merely slow (SharePoint takes ~30s).
    const { calls } = await runFlow('ok', 'unknown');
    assert.ok(calls.some((c) => /mapping\/user\/path\/csv/.test(c.url)),
      'an inconclusive pre-flight stopped the run — it must only warn');
  });

  await check('no status polling when the kick saved nothing', async () => {
    const { calls, logs } = await runFlow('zeroSaved');
    assert.ok(!calls.some((c) => /csvvalidationstatus/.test(c.url)),
      'polled a status endpoint that can only echo the 0 the kick already reported — 5 wasted minutes');
    assert.ok(logs.some((l) => /not polling/i.test(l.msg)), 'the skip was not explained in the log');
  });

  await check('a saved count of 1 still creates the job, even with UNVALIDATED path reviews', async () => {
    // Guard for the combination that works: sharepoint -> googleshareddrive migrated 58/58 while
    // reporting Source/Destination Path Review: UNVALIDATED and mapped=false, exactly like the
    // refused google runs. Only the saved count told them apart, so only it may gate.
    const { calls } = await runFlow('ok');
    assert.ok(calls.some((c) => /newmultiuser\/create\/job/.test(c.url)),
      'the gate blocked a pair CloudFuze DID save — this would break sharepoint -> googleshareddrive');
  });

  console.log(`\n${failures.length === 0 ? 'all passed' : `${failures.length} failed`}`);
  process.exit(failures.length === 0 ? 0 : 1);
})();
