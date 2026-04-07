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
      if (data.status === 'COMPLETED' || data.status === 'FAILED') {
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
