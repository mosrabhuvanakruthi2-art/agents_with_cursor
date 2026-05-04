import { runAgents, getExecution } from './api';

/**
 * Factory: creates an isolated execution store backed by a runner function.
 * This keeps Run Agent and Message Agent state independent even though they
 * share identical polling / subscription semantics.
 */
export function createExecutionStore(runner) {
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

  function subscribe(listener) {
    store.listeners.add(listener);
    return () => store.listeners.delete(listener);
  }

  function getState() {
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

  async function runExecution(payload) {
    store.loading = true;
    store.error = null;
    store.execution = null;
    notify();
    try {
      const { data, status } = await runner(payload);
      store.loading = false;
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

  return { subscribe, getState, runExecution };
}

// Default (mail) execution store — unchanged public API for Run Agent callers.
const defaultStore = createExecutionStore(runAgents);

export const subscribe = defaultStore.subscribe;
export const getState = defaultStore.getState;
export const runExecution = defaultStore.runExecution;
