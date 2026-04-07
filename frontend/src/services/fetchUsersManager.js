import { getSourceUsers, getDestinationUsers } from './api';

const state = {
  loading: false,
  error: null,
  sourceUsers: [],
  destUsers: [],
  fetched: false,
  lastSourceAdmin: '',
  lastDestAdmin: '',
  listeners: new Set(),
};

function notify() {
  state.listeners.forEach(function(fn) { try { fn({ ...state }); } catch { /* ignore */ } });
}

export function subscribe(listener) {
  state.listeners.add(listener);
  listener({ ...state });
  return function() { state.listeners.delete(listener); };
}

export function getState() {
  return { ...state };
}

export async function fetchAndAutoMap(sourceAdmin, destAdmin) {
  if (state.loading) return;
  state.loading = true;
  state.error = null;
  state.fetched = false;
  state.sourceUsers = [];
  state.destUsers = [];
  state.lastSourceAdmin = sourceAdmin;
  state.lastDestAdmin = destAdmin;
  notify();

  try {
    var results = await Promise.all([
      getSourceUsers(sourceAdmin),
      getDestinationUsers(destAdmin),
    ]);
    state.sourceUsers = results[0].data.users || [];
    state.destUsers = results[1].data.users || [];
    state.fetched = true;
  } catch(err) {
    state.error = err.response?.data?.error || err.message;
  } finally {
    state.loading = false;
    notify();
  }
}
