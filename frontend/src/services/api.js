import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
  headers: { 'Content-Type': 'application/json' },
});

// Attach the Microsoft-login JWT so the backend can scope executions to the signed-in user.
api.interceptors.request.use((config) => {
  const token = sessionStorage.getItem('app_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// If the session token is missing/expired, the backend replies 401 — clear it and send the
// user back to the sign-in screen (only when we actually had a token, to avoid redirect loops).
api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err?.response?.status === 401 && sessionStorage.getItem('app_token')) {
      sessionStorage.removeItem('app_token');
      sessionStorage.removeItem('app_user');
      window.location.assign('/');
    }
    return Promise.reject(err);
  }
);

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

export function getSourceUsers(adminEmail, provider, { allDomains = false } = {}) {
  const params = new URLSearchParams({ adminEmail });
  if (provider) params.set('provider', provider);
  // Content runs span every domain in the Workspace. A user missing from this list cannot be mapped
  // at all — CSV import matches against it too — so the scope has to be right at fetch time.
  if (allDomains) params.set('allDomains', '1');
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

export function cleanSourceEmails(email) {
  return api.post('/agents/clean-source-emails', { email }, { timeout: 0 });
}

export function cleanSourceFolders(email) {
  return api.post('/agents/clean-source-folders', { email }, { timeout: 0 });
}

export function cleanSourceCalendars(email) {
  return api.post('/agents/clean-source-calendars', { email }, { timeout: 0 });
}

export function getContentStats(email, adminEmail, provider) {
  const params = new URLSearchParams({ email });
  if (adminEmail) params.set('adminEmail', adminEmail);
  if (provider) params.set('provider', provider);
  return api.get(`/agents/content-stats?${params}`, { timeout: 60000 });
}

export function cleanContent(email, adminEmail, provider) {
  return api.post('/agents/clean-content', { email, adminEmail, provider }, { timeout: 0 });
}

export function cleanContentFiles(email, adminEmail, provider) {
  return api.post('/agents/clean-content-files', { email, adminEmail, provider }, { timeout: 0 });
}

export function cleanContentFolders(email, adminEmail, provider) {
  return api.post('/agents/clean-content-folders', { email, adminEmail, provider }, { timeout: 0 });
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

export function getGoogleOAuthUrl(source, tenant, agent) {
  const params = new URLSearchParams();
  if (source) params.set('source', source);
  if (tenant && tenant !== '1') params.set('tenant', tenant);
  if (agent) params.set('agent', agent);
  const qs = params.toString();
  return api.get('/auth/google/url' + (qs ? `?${qs}` : ''));
}

export function signOutGoogle(email) {
  return api.post('/auth/google/signout', { email });
}

export function getMicrosoftOAuthUrl(source, tenant, agent) {
  const params = new URLSearchParams();
  if (source) params.set('source', source);
  if (tenant && tenant !== '1') params.set('tenant', tenant);
  if (agent) params.set('agent', agent);
  const qs = params.toString();
  return api.get('/auth/microsoft/url' + (qs ? `?${qs}` : ''));
}

export function signOutMicrosoft(email) {
  return api.post('/auth/microsoft/signout', { email: email || null });
}

/** Admin-consent URL for the shared app in the admin email's tenant (app-only access). */
export function getMicrosoftAdminConsentUrl(email) {
  const params = new URLSearchParams({ source: 'popup' });
  if (email) params.set('email', email);
  return api.get(`/auth/microsoft/admin-consent?${params}`);
}

export function getBoxOAuthUrl(source) {
  const params = new URLSearchParams();
  if (source) params.set('source', source);
  const qs = params.toString();
  return api.get('/auth/box/url' + (qs ? `?${qs}` : ''));
}

export function connectBoxAccount(email) {
  return api.post('/auth/box/connect', { email });
}

export function signOutBox(email) {
  return api.post('/auth/box/signout', { email });
}

export function getDropboxOAuthUrl(source) {
  const params = new URLSearchParams();
  if (source) params.set('source', source);
  const qs = params.toString();
  return api.get('/auth/dropbox/url' + (qs ? `?${qs}` : ''));
}

export function signOutDropbox(email) {
  return api.post('/auth/dropbox/signout', { email });
}

export function connectSharePointAccount(email) {
  return api.post('/auth/sharepoint/connect', { email });
}

export function signOutSharePoint(email) {
  return api.post('/auth/sharepoint/signout', { email });
}

export function addDwdAccount(email) {
  return api.post('/auth/dwd', { email });
}

export function removeDwdAccount(email) {
  return api.delete(`/auth/dwd/${encodeURIComponent(email)}`);
}

export function cleanDestinationEmails(email) {
  return api.post('/agents/clean-destination-emails', { email }, { timeout: 0 });
}

export function cleanDestinationFolders(email) {
  return api.post('/agents/clean-destination-folders', { email }, { timeout: 0 });
}

export function cleanDestinationEvents(email) {
  return api.post('/agents/clean-destination-events', { email }, { timeout: 0 });
}

export function createOutlookData(sourceEmail, destinationEmail, testType) {
  return api.post('/agents/create-outlook-data', { sourceEmail, destinationEmail, testType }, { timeout: 0 });
}

export function cancelExecution(id) {
  return api.post(`/agents/executions/${id}/cancel`);
}

export function resumeExecution(id) {
  return api.post(`/agents/executions/${id}/resume`);
}

export function createTestData(payload) {
  return api.post('/agents/create-test-data', payload, { timeout: 0 });
}

// ─── Docs Sync ────────────────────────────────────────────────────────────────

export const runDocsSync = () => api.post('/agents/docs-sync');
export const getDocsSyncStatus = () => api.get('/agents/docs-sync/status');
export const markFeatureImplemented = (featureId) =>
  api.patch('/agents/docs-sync/feature/' + featureId, { status: 'implemented' });

// ── Message product (Slack / Google Chat / Teams) ──────────────────────────────
export function runMessageAgent(payload) { return api.post('/agents/message-run', payload); }
export function seedMessageAgent(payload) { return api.post('/agents/message-seed', payload); }
export function migrateMessageAgent(payload) { return api.post('/agents/message-migrate', payload); }
export function uploadMappingCsv(content, filename, serverCreds) {
  return api.post('/agents/upload-mapping-csv', { content, filename, ...serverCreds });
}
export function getMessageTargets(provider, adminEmail) {
  const params = new URLSearchParams({ provider, adminEmail });
  return api.get(`/agents/message-targets?${params}`, { timeout: 60000 });
}
export function getMessageUserStatus(emails, platform) {
  const params = new URLSearchParams({ emails: emails.join(','), platform });
  return api.get(`/agents/message-user-status?${params}`);
}
export function closeCFChatMigration(jobIds) { return api.post('/agents/cf-close-migration', { jobIds }, { timeout: 60000 }); }
export function validateCFChatMigration(payload) { return api.post('/agents/cf-validate-migration', payload, { timeout: 30000 }); }
export function getSlackOAuthUrl(source = 'popup', agent) {
  const params = new URLSearchParams();
  if (source) params.set('source', source);
  if (agent) params.set('agent', agent);
  params.set('origin', window.location.origin);
  return api.get('/auth/slack/url?' + params.toString());
}
export function signOutSlack(email) { return api.post('/auth/slack/signout', { email }); }
export function connectMicrosoftAdmin(email, tenant = '1', agent) {
  const body = { email, tenant };
  if (agent) body.agent = agent;
  return api.post('/auth/microsoft/admin', body);
}
export function connectSlackToken(token, agent) {
  const body = { token };
  if (agent) body.agent = agent;
  return api.post('/auth/slack/token', body);
}
// CloudFuze direct proxies (chat migration)
export function getCFCloudAccounts() { return api.get('/agents/cf-cloud-accounts'); }
export function getCFLoginAccounts() { return api.get('/agents/cf-login-accounts'); }
export function addCFLoginAccount(email, password) { return api.post('/agents/cf-login-accounts', { email, password }); }
export function removeCFLoginAccount(email) { return api.delete(`/agents/cf-login-accounts/${encodeURIComponent(email)}`); }
export function getCFChannels(params = {}) { return api.get('/agents/cf-channels', { params }); }
export function getCFDMs(params = {}) { return api.get('/agents/cf-dms', { params }); }
export function getCFChannelsAll(params = {}) { return api.get('/agents/cf-channels-all', { params }); }
export function getCFChannelsCache(params = {}) { return api.get('/agents/cf-channels-cache', { params }); }
export function getCFReports(params = {}) { return api.get('/agents/cf-reports', { params }); }
// CF browser automation (requires playwright on the backend — errors if not installed)
export function startCFBrowserMigration(payload) { return api.post('/agents/cf-browser-migrate', payload); }
export function abortCFBrowserMigration() { return api.post('/agents/cf-browser-abort'); }
export function getCFBrowserEvents() { return api.get('/agents/cf-browser-events'); }

export default api;

