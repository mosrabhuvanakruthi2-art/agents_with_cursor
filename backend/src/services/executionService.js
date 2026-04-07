const fs = require('fs');
const path = require('path');

const dataDir = path.resolve(__dirname, '../../data');
const executionsFile = path.join(dataDir, 'executions.json');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

function loadExecutions() {
  try {
    if (fs.existsSync(executionsFile)) {
      const raw = fs.readFileSync(executionsFile, 'utf-8');
      const arr = JSON.parse(raw);
      return new Map(arr.map((e) => [e.executionId, e]));
    }
  } catch {
    // Corrupted file — start fresh
  }
  return new Map();
}

function saveExecutions(executions) {
  const arr = Array.from(executions.values());
  fs.writeFileSync(executionsFile, JSON.stringify(arr, null, 2), 'utf-8');
}

const executions = loadExecutions();

const executionService = {
  create(context) {
    const execution = {
      executionId: context.executionId,
      context: context.toJSON(),
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
