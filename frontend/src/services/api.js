import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
  headers: { 'Content-Type': 'application/json' },
});

export function runAgents(payload) {
  return api.post('/agents/run', payload);
}

export function getExecutions() {
  return api.get('/agents/executions');
}

export function getExecution(id) {
  return api.get(`/agents/executions/${id}`);
}

export function getExecutionLogs(id) {
  return api.get(`/agents/executions/${id}/logs`);
}

export function getSourceUsers(adminEmail, provider) {
  const params = new URLSearchParams({ adminEmail });
  if (provider) params.set('provider', provider);
  return api.get(`/agents/users/source?${params}`);
}

export function getDestinationUsers(adminEmail, provider) {
  const params = new URLSearchParams();
  if (adminEmail) params.set('adminEmail', adminEmail);
  if (provider) params.set('provider', provider);
  return api.get(`/agents/users/destination?${params}`);
}

export function downloadValidationPdf(executionId) {
  return api.get(`/agents/executions/${executionId}/pdf`, { responseType: 'blob' });
}

export function getMailboxStats(email, includeCalendar = false) {
  return api.get(`/agents/mailbox-stats?email=${encodeURIComponent(email)}&includeCalendar=${includeCalendar}`, { timeout: 60000 });
}

export function cleanDestination(email) {
  return api.post('/agents/clean-destination', { email }, { timeout: 0 });
}

export function getCalendarEventCount(email) {
  return api.get(`/agents/calendar-event-count?email=${encodeURIComponent(email)}`, { timeout: 30000 });
}

export function deleteCalendarEvents(email) {
  return api.post('/agents/delete-calendar-events', { email }, { timeout: 0 });
}


export function getSourceMailboxStats(email) {
  return api.get('/agents/source-mailbox-stats?email=' + encodeURIComponent(email), { timeout: 60000 });
}

export function getSourceCalendarStats(email) {
  return api.get(`/agents/source-calendar-stats?email=${encodeURIComponent(email)}`, { timeout: 30000 });
}

export function deleteSourceCalendarEvents(email) {
  return api.post('/agents/delete-source-calendar-events', { email }, { timeout: 0 });
}

export function cleanSource(email) {
  return api.post('/agents/clean-source', { email }, { timeout: 0 });
}

export function getTestRepositoryData() {
  return api.get('/test-repository/data');
}

/** Sync vs UI read model (MongoDB vs JSON file). */
export function getTestRepositoryStatus() {
  return api.get('/test-repository/status');
}

export function getTestRepositoryDefaults() {
  return api.get('/test-repository/defaults');
}

/** Long timeout: import walks every folder and paginates tests. */
export function importTestRepository(payload) {
  return api.post('/test-repository/import', payload, { timeout: 0 });
}

/** Same as import — pull Test Repository from Xray into MongoDB (+ JSON backup). */
export function syncTestRepositoryToMongo(payload) {
  return api.post('/test-repository/sync', payload, { timeout: 0 });
}

/** Remove saved snapshot (backend/data/test-repository.json + MongoDB if used). */
export function clearTestRepositorySnapshot() {
  return api.post('/test-repository/clear');
}

/** Live Xray expanded test for modal (?issueId= or ?key=) */
export function getTestRepositoryTestDetail(params) {
  return api.get('/test-repository/test-detail', { params, timeout: 120000 });
}

// Local (user-created) folders and tests
export function getLocalRepoData() {
  return api.get('/test-repository/local');
}
export function createLocalFolder(payload) {
  return api.post('/test-repository/local/folders', payload);
}
export function deleteLocalFolder(id) {
  return api.delete(`/test-repository/local/folders/${encodeURIComponent(id)}`);
}
export function createLocalTest(payload) {
  return api.post('/test-repository/local/tests', payload);
}
export function deleteLocalTest(id) {
  return api.delete(`/test-repository/local/tests/${encodeURIComponent(id)}`);
}

export function generateTestCases({ scenarios, count, productType, combination, folder }, signal) {
  return api.post(
    '/test-cases/generate',
    { scenarios, count, productType, combination, folder },
    { timeout: 120000, ...(signal ? { signal } : {}) },
  );
}

export function getCustomTestCases() {
  return api.get('/test-cases/custom');
}

export function addCustomTestCase(payload) {
  return api.post('/test-cases/custom', payload);
}

export function addBulkTestCases(testType, testCases) {
  return api.post('/test-cases/custom/bulk', { testType, testCases });
}

export function updateCustomTestCase(id, testType, updates) {
  return api.put(`/test-cases/custom/${id}`, { testType, updates });
}

export function deleteCustomTestCase(id, testType) {
  return api.delete(`/test-cases/custom/${id}?testType=${encodeURIComponent(testType)}`);
}

// ─── OAuth / Connect Accounts ────────────────────────────────────────────────

export function getAuthStatus() {
  return api.get('/auth/status');
}

export function getConnectedAccounts() {
  return api.get('/auth/accounts');
}

export function getGoogleOAuthUrl(source, tenant) {
  const params = new URLSearchParams();
  if (source) params.set('source', source);
  if (tenant && tenant !== '1') params.set('tenant', tenant);
  const qs = params.toString();
  return api.get('/auth/google/url' + (qs ? `?${qs}` : ''));
}

export function signOutGoogle(email) {
  return api.post('/auth/google/signout', { email });
}

export function getMicrosoftOAuthUrl(source, tenant) {
  const params = new URLSearchParams();
  if (source) params.set('source', source);
  if (tenant && tenant !== '1') params.set('tenant', tenant);
  const qs = params.toString();
  return api.get('/auth/microsoft/url' + (qs ? `?${qs}` : ''));
}

export function signOutMicrosoft(email) {
  return api.post('/auth/microsoft/signout', { email: email || null });
}

export default api;

