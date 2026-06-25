import { cleanSource, getSourceMailboxStats, deleteSourceCalendarEvents } from './api';

const state = {
  processing: null,
  queue: [],
  results: {},
  listeners: new Set(),
};

function notify() {
  state.listeners.forEach((fn) => {
    try { fn({ ...state }); } catch { /* ignore */ }
  });
}

export function subscribe(listener) {
  state.listeners.add(listener);
  return () => state.listeners.delete(listener);
}

export function getActiveCleans() {
  const active = new Set(state.queue);
  if (state.processing) active.add(state.processing);
  return active;
}

export function getAllResults() {
  return { ...state.results };
}

async function processQueue() {
  if (state.processing) return;

  while (state.queue.length > 0) {
    const email = state.queue.shift();
    state.processing = email;
    notify();

    try {
      const { data } = await cleanSource(email);
      // Also delete primary + secondary Google Calendar events via bulk API (best-effort)
      let calendarDeleteResult = null;
      try {
        const { data: cd } = await deleteSourceCalendarEvents(email);
        calendarDeleteResult = cd;
      } catch { /* ignore — bulk API may not be running */ }
      // Wait for Google APIs to catch up before refreshing stats
      await new Promise((resolve) => setTimeout(resolve, 6000));
      let stats = null;
      try {
        const { data: s } = await getSourceMailboxStats(email);
        stats = s;
      } catch { /* ignore */ }
      state.results[email] = { ...data, calendarDeleteResult, refreshedStats: stats };
    } catch (err) {
      const msg = err.response?.data?.error || err.message || 'Connection lost â€” server may have restarted';
      state.results[email] = { error: msg };
    }

    state.processing = null;
    notify();
  }
}

export function startClean(email) {
  if (state.processing === email || state.queue.includes(email)) return;
  state.queue.push(email);
  notify();
  processQueue();
}

export function startCleanAll(emails) {
  for (const email of emails) {
    if (state.processing !== email && !state.queue.includes(email)) {
      state.queue.push(email);
    }
  }
  notify();
  processQueue();
}

export function clearResults() {
  Object.keys(state.results).forEach((k) => delete state.results[k]);
  notify();
}

