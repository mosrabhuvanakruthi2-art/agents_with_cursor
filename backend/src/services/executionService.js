const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const dataDir = path.resolve(__dirname, '../../data');
const executionsFile = path.join(dataDir, 'executions.json');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

function saveExecutions(executions) {
  const arr = Array.from(executions.values());
  try {
    fs.writeFileSync(executionsFile, JSON.stringify(arr, null, 2), 'utf-8');
  } catch (err) {
    logger.error(`[executionService] saveExecutions failed: ${err.message}`);
  }
}

// On startup: clear all executions so the Reports & Logs page starts fresh.
// Any run that was in progress is dead (the server restarted), and stale data
// from previous sessions should not appear automatically in the UI.
const executions = new Map();
saveExecutions(executions);

// In-memory only — not persisted (if server restarts, running jobs are already dead)
const cancelledIds = new Set();

const executionService = {
  create(context) {
    const execution = {
      executionId: context.executionId,
      context: typeof context.toJSON === 'function' ? context.toJSON() : { ...context },
      status: 'PENDING',
      currentAgent: null,
      result: null,
      error: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
    };
    executions.set(context.executionId, execution);
    saveExecutions(executions);
    return execution;
  },

  update(executionId, updates) {
    const execution = executions.get(executionId);
    if (!execution) return null;
    Object.assign(execution, updates);
    saveExecutions(executions);
    return execution;
  },

  get(executionId) {
    return executions.get(executionId) || null;
  },

  getAll() {
    return Array.from(executions.values()).sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
    );
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
      saveExecutions(executions);
    }
  },

  isCancelled(executionId) {
    return cancelledIds.has(executionId);
  },

  getStats() {
    const all = this.getAll();
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
