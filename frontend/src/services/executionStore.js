import { runAgents, getExecution } from './api';

// Module-level singleton — persists across React component mounts/unmounts (tab switches)
const store = {
  execution: null,
  loading: false,
  error: null,
  pollingInterval: null,
  listeners: new Set(),
};

function notify() {
  store.listeners.forEach((fn) => {
    try { fn(); } catch { /* ignore */ }
  });
}

export function subscribe(listener) {
  store.listeners.add(listener);
  return () => store.listeners.delete(listener);
}

export function getState() {
  return {
    execution: store.execution,
    loading: store.loading,
    error: store.error,
  };
}

function stopPolling() {
  if (store.pollingInterval) {
    clearInterval(store.pollingInterval);
    store.pollingInterval = null;
  }
}

function startPolling(executionId) {
  stopPolling();
  const tick = async () => {
    try {
      const { data } = await getExecution(executionId);
      store.execution = data;
      notify();
      if (data.status === 'COMPLETED' || data.status === 'FAILED' || data.status === 'INTERRUPTED' || data.status === 'CANCELLED') {
        stopPolling();
      }
    } catch {
      stopPolling();
    }
  };
  tick();
  store.pollingInterval = setInterval(tick, 3000);
}

export async function runExecution(payload) {
  store.loading = true;
  store.error = null;
  store.execution = null;
  notify();
  try {
    const { data, status } = await runAgents(payload);
    store.loading = false;
    // Bulk runs still return 200 with full results inline (synchronous on server).
    if (data.bulk) {
      store.execution = data;
      notify();
      return data;
    }
    if (data.executionId && (status === 202 || data.status === 'RUNNING')) {
      store.execution = data;
      notify();
      startPolling(data.executionId);
      return data;
    }
    store.execution = data;
    notify();
    return data;
  } catch (err) {
    const msg = err.response?.data?.error || err.message;
    store.error = msg;
    store.loading = false;
    notify();
    throw err;
  }
}

/**
 * Factory for an independent execution store backed by a custom runner.
 * Used by the message product (messageExecutionStore) to keep its run/seed/migrate
 * flows separate from the mail/content singleton above. Same polling behaviour.
 */
export function createExecutionStore(runner) {
  const s = { execution: null, loading: false, error: null, pollingInterval: null, listeners: new Set() };
  const fire = () => s.listeners.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
  const stop = () => { if (s.pollingInterval) { clearInterval(s.pollingInterval); s.pollingInterval = null; } };
  const poll = (executionId) => {
    stop();
    const tick = async () => {
      try {
        const { data } = await getExecution(executionId);
        s.execution = data; fire();
        if (['COMPLETED', 'FAILED', 'INTERRUPTED', 'CANCELLED'].includes(data.status)) stop();
      } catch { stop(); }
    };
    tick();
    s.pollingInterval = setInterval(tick, 3000);
  };
  return {
    subscribe(listener) { s.listeners.add(listener); return () => s.listeners.delete(listener); },
    getState() { return { execution: s.execution, loading: s.loading, error: s.error }; },
    async runExecution(payload) {
      s.loading = true; s.error = null; s.execution = null; fire();
      try {
        const { data, status } = await runner(payload);
        s.loading = false;
        if (data.bulk) { s.execution = data; fire(); return data; }
        if (data.executionId && (status === 202 || data.status === 'RUNNING')) { s.execution = data; fire(); poll(data.executionId); return data; }
        s.execution = data; fire(); return data;
      } catch (err) {
        s.error = err.response?.data?.error || err.message;
        s.loading = false; fire(); throw err;
      }
    },
  };
}
