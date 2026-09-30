/**
 * Fill /QA-LoadTest-500k with small files in ONE flat folder, to exercise bulk enumeration.
 *
 * Run:
 *   cd backend && node scripts/dropbox-loadtest.js
 *   cd backend && LOADTEST_TARGET=25000 node scripts/dropbox-loadtest.js     (smaller target)
 *
 * On PowerShell, set the variable first — there is no inline `VAR=value cmd` form:
 *   $env:LOADTEST_TARGET="25000"
 *   node scripts\dropbox-loadtest.js
 *
 * UPLOAD SESSIONS, NOT COPIES — AND WHY IT CHANGED. The first version copied one seed file 500,000
 * times with `files/copy_batch_v2`, because that endpoint takes 1,000 entries per call while
 * `files/upload` takes one file per call. It worked, and it was wrong in two ways that only showed
 * up in the result:
 *
 *   1. A COPY INHERITS `client_modified`. That field is what Dropbox shows as "Modified", so all
 *      34,000 files displayed 13:37-13:38 UTC — the moment the 60 seeds were uploaded — however
 *      long the run actually took. `server_modified` held the real time but nothing surfaces it.
 *   2. EVERY COPY IS BYTE-IDENTICAL TO ITS SEED. Since 36 of the 60 seeds were plain text under a
 *      binary extension, 36/60ths of the set could not be opened at all.
 *
 * Both are fixed by uploading real bytes per file, which needs a per-file call — the thing copying
 * existed to avoid. The way out is `upload_session`, where the two halves of a write are separated:
 *
 *   - `upload_session/start` with `close:true` streams one file's bytes into a session. It does NOT
 *     take the folder's namespace lock, so these run in parallel without contending.
 *   - `upload_session/finish_batch_v2` commits up to 1,000 of those sessions in a single call, each
 *     with its own `client_modified`. The namespace lock is taken ONCE for the whole batch, exactly
 *     as `copy_batch_v2` did.
 *
 * So the batching that made copying viable is kept, and both defects go away.
 *
 * WHY PARALLELISM IS CAPPED, AND WHERE. Dropbox's performance guide is explicit:
 *
 *   "Write operations on a file within a namespace first acquire a lock on that namespace and
 *    release the lock when the operation has completed in order to ensure consistency. While this
 *    process is generally quick, enough parallel threads writing to the namespace may create lock
 *    contention, resulting in the 429 too_many_write_operations exception."
 *   - https://docs.dropboxapi.com/dropbox-api/docs/performance
 *
 * Measured here: 25 parallel `copy_batch_v2` jobs were rejected with 429 four seconds in, twice,
 * having created nothing. That limit applies to the COMMIT, which is why there is exactly one
 * commit in flight at a time. The session uploads are a different operation and are safe to run
 * concurrently; LOADTEST_SESSION_CONCURRENCY controls only those.
 *
 * RESUMABLE BY CONSTRUCTION. Progress is checkpointed to backend/data after every round, and the
 * commit uses `mode:'add'` with `autorename:false`, so a path that already exists comes back as a
 * conflict for that entry instead of being duplicated OR overwritten. Re-running is therefore safe
 * even with a stale or deleted checkpoint, and it never disturbs a file already in the folder.
 *
 * Logs go through the repo logger, so they appear in backend/logs/app.log with everything else.
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const dbx = require('../src/clients/dropboxClient');
const logger = require('../src/utils/logger');
const { buildAll } = require('./loadtest-formats');

const ROOT = process.env.LOADTEST_ROOT || '/QA-LoadTest-500k';
const EMAIL = process.env.LOADTEST_EMAIL || 'erik@filefuze.co';
const TARGET = Number(process.env.LOADTEST_TARGET || 500000);
/** Files per commit. Dropbox caps `finish_batch_v2` at 1,000 entries. */
const BATCH = Math.min(1000, Number(process.env.LOADTEST_BATCH || 1000));
/**
 * How many `upload_session/start` calls to run at once.
 *
 * These do not take the namespace lock, so unlike the commit they genuinely parallelise. 8 is a
 * deliberate middle: high enough to keep the pipe busy, low enough to stay well clear of the
 * account-wide request limits that a few hundred in flight would reach.
 */
const SESSIONS = Number(process.env.LOADTEST_SESSION_CONCURRENCY || 8);

const RPC = 'https://api.dropboxapi.com/2';
const CONTENT = 'https://content.dropboxapi.com/2';
/**
 * One checkpoint file per root folder.
 *
 * A single shared path is how the first run lost its place: a trial with LOADTEST_TARGET=100000
 * wrote over the real 500,000 checkpoint, which reset `nextIndex` to 1. Keying the filename to the
 * folder keeps a trial in another root from touching the real run's progress. The default root
 * keeps the original filename so an existing checkpoint is still found.
 */
const STATE = path.join(__dirname, '..', 'data',
  ROOT === '/QA-LoadTest-500k'
    ? 'dropbox-loadtest-progress.json'
    : `dropbox-loadtest-progress${ROOT.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()}.json`);

const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
/** Seconds as `1h04m` / `47s` — a bare minute count stops being readable past an hour. */
const dur = (sec) => {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m${String(s % 60).padStart(2, '0')}s`;
};
const num = (n) => n.toLocaleString('en-US');
const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return null; } };
const writeState = (s) => fs.writeFileSync(STATE, JSON.stringify(s, null, 2));

/** ISO-8601 to the second, the only precision Dropbox stores for `client_modified`. */
const stamp = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Run `fn` over `items` with at most `limit` in flight, preserving result order. */
async function pooled(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

async function rpc(endpoint, body, memberId) {
  const token = await dbx.getAccessToken();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  if (memberId) headers['Dropbox-API-Select-User'] = memberId;
  return (await axios.post(`${RPC}/${endpoint}`, body, { headers, timeout: 240000 })).data;
}

/**
 * Stream one file's bytes into a new upload session and close it.
 *
 * Returns the cursor the commit needs plus `at`, the moment the bytes actually landed — that is
 * what becomes the file's `client_modified`, so the displayed time is the real creation time rather
 * than a value derived from anything else.
 */
async function openSession(buf, memberId) {
  const token = await dbx.getAccessToken();
  const res = await axios.post(`${CONTENT}/files/upload_session/start`, buf, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Dropbox-API-Select-User': memberId,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': dbx.apiArg({ close: true }),
    },
    timeout: 120000,
  });
  return { session_id: res.data.session_id, offset: buf.length, at: Date.now() };
}

/**
 * Commit a batch of closed sessions.
 *
 * `finish_batch_v2` answers inline for a batch this size but may still hand back an async job, so
 * both shapes are handled. The first check flips the tag from `async_job_id` to `in_progress`, so a
 * loop written as `while (tag === 'async_job_id')` would exit immediately and report zero
 * successes on a batch that is in fact still running — poll until the tag is neither.
 */
async function commitBatch(entries, memberId, onTick) {
  let r = await rpc('files/upload_session/finish_batch_v2', { entries }, memberId);
  if (r['.tag'] === 'async_job_id') {
    const started = Date.now();
    for (let i = 0; i < 1200; i += 1) {
      r = await rpc('files/upload_session/finish_batch/check', { async_job_id: r.async_job_id }, memberId);
      if (r['.tag'] !== 'in_progress') break;
      if (onTick && i % 15 === 14) onTick((Date.now() - started) / 1000);
      await sleep(1000);
    }
    if (r['.tag'] === 'in_progress') throw new Error('commit did not finish within 20 minutes');
  }
  return r;
}

(async () => {
  const formats = await buildAll();
  const memberId = await dbx.resolveTeamMemberId(EMAIL);
  await dbx.createFolder(ROOT, { asMemberId: memberId }).catch(() => {});

  /**
   * WHICH INDICES ARE ALREADY THERE — read from the folder, not from the checkpoint.
   *
   * Under the old copy-based version a file that already existed cost almost nothing: the whole
   * batch went in one `copy_batch_v2` call and Dropbox rejected the duplicate entries server-side,
   * so re-walking filled ground ran at ~10 files/sec. That is no longer true. Every file now has
   * its own upload session, so reaching a conflict means the bytes were sent first and then thrown
   * away — re-walking 34,000 existing files would cost as much as creating them.
   *
   * So the run skips them instead. One listing up front (~10s for 34,000 files) gives the exact
   * set, which also makes resume self-healing: a stale, wrong or missing checkpoint no longer
   * matters, and the scattered indices left by earlier aborted runs are stepped over rather than
   * re-uploaded.
   */
  process.stdout.write(`reading ${ROOT} to see what is already there ...`);
  const listing = await dbx.listFolder(ROOT, { asMemberId: memberId });
  const present = new Set();
  for (const e of listing) {
    const m = /^ld_(\d{7})\./.exec(e.name || '');
    if (m) present.add(Number(m[1]));
  }
  let alreadyInRange = 0;
  for (const i of present) if (i <= TARGET) alreadyInRange += 1;
  console.log(`\r${num(present.size)} load-test files in ${ROOT}, `
    + `${num(alreadyInRange)} of them inside the target range\n`);

  let state = readState();
  if (!state || state.root !== ROOT || state.target !== TARGET) {
    state = {
      root: ROOT, target: TARGET, created: 0, nextIndex: 1,
      conflicts: 0, failures: 0, startedAt: new Date().toISOString(),
    };
  }
  // The listing is the truth; the checkpoint only records where the walk had got to.
  state.created = alreadyInRange;
  if (!state.nextIndex || state.nextIndex < 1) state.nextIndex = 1;

  const tiers = formats.reduce((a, f) => { a[f.validity] = (a[f.validity] || 0) + 1; return a; }, {});
  logger.info(`[loadtest] START root=${ROOT} target=${TARGET} formats=${formats.length} `
    + `resuming at index ${state.nextIndex} (created so far ${state.created})`);
  console.log(`root ${ROOT} | target ${num(TARGET)} | batch ${num(BATCH)} per commit `
    + `| ${SESSIONS} parallel uploads`);
  console.log(`formats ${formats.length} (${tiers.real} real, ${tiers.container || 0} container, `
    + `${tiers.header || 0} header) | every file carries its own creation time`);
  console.log(`resuming at index ${num(state.nextIndex)} — ${num(state.created)} present, `
    + `${num(TARGET - state.created)} to go\n`);

  let roundNo = 0;
  const t0 = Date.now();
  const startCreated = state.created;
  let newSoFar = 0;

  while (state.created < TARGET) {
    // Plan the batch by stepping over indices that already exist, so no bytes are ever uploaded
    // for a file that is already in the folder.
    const from = state.nextIndex;
    const jobs = [];
    let cursor = from;
    let skipped = 0;
    while (jobs.length < BATCH && cursor <= TARGET) {
      if (present.has(cursor)) skipped += 1;
      else jobs.push({ idx: cursor, fmt: formats[cursor % formats.length] });
      cursor += 1;
    }
    if (jobs.length === 0) {
      state.nextIndex = cursor;
      writeState(state);
      break; // nothing left inside the target range
    }
    const n = jobs.length;

    const roundStart = Date.now();
    process.stdout.write(`  round ${roundNo + 1}: uploading ${num(n)} files from @${num(from)}`
      + `${skipped ? ` (skipped ${num(skipped)} already there)` : ''} ...`);

    // ── Phase 1: stream the bytes. Parallel, no namespace lock. ──────────────────────────
    let cursors;
    try {
      cursors = await pooled(jobs, SESSIONS, (job) => openSession(job.fmt.buf, memberId));
    } catch (err) {
      const msg = String(err.response ? JSON.stringify(err.response.data) : err.message).slice(0, 160);
      logger.warn(`[loadtest] upload phase at index ${from} failed: ${msg} — backing off 60s`);
      console.log(`\n  round ${roundNo + 1} UPLOAD FAILED (${msg.slice(0, 90)}) — retrying in 60s`);
      await sleep(60000);
      continue; // checkpoint untouched, so the same indices are retried
    }
    const uploadSecs = (Date.now() - roundStart) / 1000;
    process.stdout.write(` committing ...`);

    // ── Phase 2: one commit for the whole batch, each entry with its own timestamp. ──────
    const entries = jobs.map((job, k) => ({
      cursor: { session_id: cursors[k].session_id, offset: cursors[k].offset },
      commit: {
        path: `${ROOT}/ld_${String(job.idx).padStart(7, '0')}.${job.fmt.ext}`,
        // `add` never overwrites: a path already in the folder comes back as a conflict and is
        // left exactly as it is.
        mode: 'add',
        autorename: false,
        mute: true,
        client_modified: stamp(cursors[k].at),
      },
    }));

    let result;
    try {
      result = await commitBatch(entries, memberId,
        (secs) => process.stdout.write(`\r  round ${roundNo + 1}: committing ${num(n)} files ... ${dur(secs)}   `));
    } catch (err) {
      const msg = String(err.response ? JSON.stringify(err.response.data) : err.message).slice(0, 160);
      // Dropbox answers a malformed commit with a bare 500 "unexpected error occurred" and says
      // nothing about which entry it objected to, so the request has to be shown here or the
      // failure is undiagnosable from the logs alone.
      logger.warn(`[loadtest] commit at index ${from} failed: ${msg} — backing off 60s`);
      logger.warn(`[loadtest] commit had ${entries.length} entries; first = `
        + `${JSON.stringify(entries[0])}`);
      console.log(`\n  round ${roundNo + 1} COMMIT FAILED (${msg.slice(0, 90)}) — retrying in 60s`);
      console.log(`    entries=${entries.length} first=${JSON.stringify(entries[0]).slice(0, 220)}`);
      await sleep(60000);
      continue;
    }

    let ok = 0; let conflict = 0; let other = 0; let lastErr = '';
    for (const e of result.entries || []) {
      if (e['.tag'] === 'success') { ok += 1; continue; }
      const s = JSON.stringify(e);
      if (/conflict/.test(s)) conflict += 1;
      else { other += 1; if (!lastErr) lastErr = s.slice(0, 180); }
    }

    // ── Checkpoint, then report ─────────────────────────────────────────────────────────
    roundNo += 1;
    newSoFar += ok;
    // Record what landed, so a later round (or a retry after a failure) steps over it too.
    (result.entries || []).forEach((e, k) => {
      if (e['.tag'] === 'success' || /conflict/.test(JSON.stringify(e))) present.add(jobs[k].idx);
    });
    // NOT `+ skipped`. Files that were skipped were already counted by `alreadyInRange` when the
    // folder was listed; adding them again reported 920/900 on a 900-file run.
    state.created += ok + conflict;
    state.nextIndex = cursor;
    state.conflicts += conflict;
    state.failures += other;
    writeState(state);

    const roundSecs = (Date.now() - roundStart) / 1000;
    const totalSecs = (Date.now() - t0) / 1000;
    // Rate is measured over NEW files only. Conflicts re-walk ground that is already filled at
    // roughly 20x the speed, so mixing them in flatters the number and wrecks the estimate.
    const perFile = newSoFar > 0 ? totalSecs / newSoFar : 0;
    const left = TARGET - state.created;
    const pct = ((state.created / TARGET) * 100).toFixed(2);
    const eta = perFile > 0 ? dur(left * perFile) : 'unknown';

    const line = `[loadtest] round ${roundNo} | ${num(state.created)}/${num(TARGET)} (${pct}%) `
      + `| +${num(ok)} new`
      + `${skipped ? `, ${num(skipped)} skipped (already there)` : ''}`
      + `${conflict ? `, ${num(conflict)} conflicted` : ''}`
      + `${other ? `, ${num(other)} FAILED` : ''}`
      + ` | round ${dur(roundSecs)} (upload ${dur(uploadSecs)}, commit ${dur(roundSecs - uploadSecs)})`
      + ` | ${perFile > 0 ? `${perFile.toFixed(2)}s per new file` : 'rate pending'}`
      + ` | ${num(left)} left | ETA ${eta}`;
    process.stdout.write('\r');
    logger.info(line);
    console.log(line);

    if (other > 0 && lastErr) {
      logger.warn(`[loadtest] example failure: ${lastErr}`);
      console.log(`    example failure: ${lastErr}`);
    }
  }

  const totalSecs = (Date.now() - t0) / 1000;
  const line = `[loadtest] DONE ${num(state.created)}/${num(TARGET)} in ${dur(totalSecs)} `
    + `(+${num(state.created - startCreated)} this run, conflicts ${num(state.conflicts)}, `
    + `failures ${num(state.failures)})`;
  logger.info(line);
  console.log(`\n${line}`);
})().catch((e) => {
  const msg = e.response ? JSON.stringify(e.response.data).slice(0, 300) : e.message;
  logger.error(`[loadtest] FAILED ${msg}`);
  console.error('FAILED', msg);
  process.exit(1);
});
