const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const mongoStore = require('./executionMongoStore');

const dataDir = path.resolve(__dirname, '../../data');
const executionsFile = path.join(dataDir, 'executions.json');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// ── Persistence model ────────────────────────────────────────────────────────
// MongoDB (when configured) is the durable, deploy-safe store — one document per
// execution. The flat file (data/executions.json) lives INSIDE the app directory
// and is wiped on every server redeploy, so it is now only a fallback used when
// Mongo is unavailable (e.g. local dev with no MONGODB_URI, or a Mongo outage).
// The in-memory Map remains the synchronous source of truth for reads.

function saveExecutionsFile(execMap) {
  const arr = Array.from(execMap.values());
  try {
    fs.writeFileSync(executionsFile, JSON.stringify(arr, null, 2), 'utf-8');
  } catch (err) {
    logger.error(`[executionService] saveExecutionsFile failed: ${err.message}`);
  }
}

function loadExecutionsFile() {
  try {
    if (fs.existsSync(executionsFile)) {
      const arr = JSON.parse(fs.readFileSync(executionsFile, 'utf-8'));
      if (Array.isArray(arr)) return new Map(arr.map((e) => [e.executionId, e]));
    }
  } catch (err) {
    logger.warn(`[executionService] loadExecutionsFile failed (${err.message}) — starting empty`);
  }
  return new Map();
}

// Load whatever the local file has so Reports & Logs works before Mongo connects
// (and as the sole store when Mongo isn't configured). On a fresh server deploy
// this file is absent, so the Map starts empty and is filled by hydrateFromMongo().
const executions = loadExecutionsFile();

/**
 * Persist a single execution: upsert to Mongo (durable) when connected, otherwise
 * mirror the whole Map to the file. When Mongo is the store we deliberately skip the
 * file write to avoid rewriting the entire history on every progress update — a
 * failed upsert self-heals on the next update() (which re-sends the full state).
 */
function persist(execution) {
  if (mongoStore.isReady()) {
    mongoStore.upsertExecution(execution).catch((err) =>
      logger.error(`[executionService] Mongo upsert failed for ${execution?.executionId}: ${err.message}`)
    );
  } else {
    saveExecutionsFile(executions);
  }
}

/**
 * Mark a RUNNING/PENDING execution as INTERRUPTED — it was orphaned when its
 * process died. Mutates in place and returns whether it changed.
 */
function markInterrupted(exec) {
  if (exec.status === 'RUNNING' || exec.status === 'PENDING') {
    Object.assign(exec, {
      status: 'INTERRUPTED',
      error: 'Server restarted while execution was in progress',
      progress: 'Interrupted — server was restarted. Click Resume to continue.',
      completedAt: exec.completedAt || new Date().toISOString(),
    });
    return true;
  }
  return false;
}

// Any file-loaded execution still RUNNING/PENDING was orphaned by the restart.
// (On a fresh server deploy the file is empty, so this is a no-op there; Mongo-
// loaded orphans are handled in hydrateFromMongo once Mongo connects.)
let _orphansFixed = false;
for (const exec of executions.values()) {
  if (markInterrupted(exec)) _orphansFixed = true;
}
if (_orphansFixed) saveExecutionsFile(executions);

// In-memory only — not persisted (if server restarts, running jobs are already dead)
const cancelledIds = new Set();

const executionService = {
  /**
   * Merge MongoDB's persisted executions into the in-memory Map. Called once from
   * server.js after MongoDB connects (Mongo is connected in the background, after
   * the HTTP server is already listening). Also performs a one-time back-fill so
   * any executions still living only in the legacy file are migrated into Mongo.
   * @returns {Promise<{hydrated:number, backfilled:number, interrupted:number}>}
   */
  async hydrateFromMongo() {
    const empty = { hydrated: 0, backfilled: 0, interrupted: 0 };
    if (!mongoStore.isReady()) return empty;

    let docs;
    try {
      docs = await mongoStore.loadAllExecutions();
    } catch (err) {
      logger.warn(`[executionService] hydrateFromMongo load failed: ${err.message}`);
      return empty;
    }

    const mongoIds = new Set(docs.map((d) => d.executionId));
    let hydrated = 0;
    let interrupted = 0;

    for (const doc of docs) {
      // Never overwrite an execution already in memory — the in-process/file copy
      // is at least as fresh and may be actively RUNNING in THIS process.
      if (executions.has(doc.executionId)) continue;
      // A RUNNING/PENDING doc loaded from Mongo belongs to a previous, now-dead
      // process → mark it INTERRUPTED so the UI offers Resume instead of a stuck run.
      if (markInterrupted(doc)) {
        interrupted++;
        mongoStore.upsertExecution(doc).catch((err) =>
          logger.error(`[executionService] orphan persist failed for ${doc.executionId}: ${err.message}`)
        );
      }
      executions.set(doc.executionId, doc);
      hydrated++;
    }

    // One-time migration: push any executions that live only in the legacy file
    // (missing from Mongo) up to Mongo so they survive future deploys.
    let backfilled = 0;
    for (const exec of executions.values()) {
      if (mongoIds.has(exec.executionId)) continue;
      try {
        const ok = await mongoStore.upsertExecution(exec);
        if (ok) backfilled++;
      } catch (err) {
        logger.warn(`[executionService] backfill failed for ${exec.executionId}: ${err.message}`);
      }
    }

    return { hydrated, backfilled, interrupted };
  },

  create(context) {
    const execution = {
      executionId: context.executionId,
      // Owner (signed-in user) — used to scope Reports & Logs / Dashboard per user.
      userEmail: context.userEmail ? String(context.userEmail).toLowerCase() : null,
      context: typeof context.toJSON === 'function' ? context.toJSON() : { ...context },
      status: 'PENDING',
      currentAgent: null,
      result: null,
      error: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
    };
    executions.set(context.executionId, execution);
    persist(execution);
    return execution;
  },

  update(executionId, updates) {
    const execution = executions.get(executionId);
    if (!execution) return null;
    Object.assign(execution, updates);
    persist(execution);
    return execution;
  },

  get(executionId) {
    return executions.get(executionId) || null;
  },

  /**
   * All executions, newest first. When filterEmail is given, scope to that user's runs
   * (plus legacy runs that predate per-user scoping, which have no owner). Passing no
   * filter returns everything — used by internal callers.
   */
  getAll(filterEmail) {
    const all = Array.from(executions.values()).sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
    );
    if (!filterEmail) return all;
    const f = String(filterEmail).toLowerCase();
    return all.filter((e) => !e.userEmail || String(e.userEmail).toLowerCase() === f);
  },

  cancel(executionId) {
    cancelledIds.add(executionId);
    const execution = executions.get(executionId);
    if (execution && execution.status === 'RUNNING') {
      Object.assign(execution, {
        status: 'CANCELLED',
        progress: 'Cancelled by user',
        completedAt: new Date().toISOString(),
      });
      persist(execution);
    }
  },

  isCancelled(executionId) {
    return cancelledIds.has(executionId);
  },

  getStats(filterEmail) {
    const all = this.getAll(filterEmail);
    const completed = all.filter((e) => e.status === 'COMPLETED').length;
    const failed = all.filter((e) => e.status === 'FAILED').length;
    const running = all.filter((e) => e.status === 'RUNNING').length;
    return {
      total: all.length,
      completed,
      failed,
      running,
      successRate: all.length > 0 ? Math.round((completed / all.length) * 100) : 0,
      lastRun: all.length > 0 ? all[0] : null,
    };
  },
};

module.exports = executionService;
