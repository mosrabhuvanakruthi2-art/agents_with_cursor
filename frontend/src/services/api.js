import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
  headers: { 'Content-Type': 'application/json' },
});

export function runAgents(payload) {
  return api.post('/agents/run', payload);
}

export function runMessageAgent(payload) {
  return api.post('/agents/message-run', payload);
}

/** Stage 1 of split Message-Agent flow — seed Agent Repo test cases into source channels/DMs. */
export function seedMessageAgent(payload) {
  return api.post('/agents/message-seed', payload);
}

/** Stage 2 — migrate + validate on the user-selected subset of already-seeded targets. */
export function migrateMessageAgent(payload) {
  return api.post('/agents/message-migrate', payload);
}

/**
 * Upload a user-mapping CSV to the server as text.
 * Backend saves it to a temp file and returns the absolute path used by Playwright.
 * @param {string} content  Raw CSV text
 * @param {string} filename Original filename (used only for temp file naming)
 * @returns `{ filePath: string, rows: number }`
 */
export function uploadMappingCsv(content, filename) {
  return api.post('/agents/upload-mapping-csv', { content, filename });
}

/**
 * Fetch source channels + DMs by name for the Message Agent picker.
 *
 * @param {'slack'|'microsoft'|'google'} provider
 * @param {string} adminEmail
 * @returns `{ provider, adminEmail, publicChannels, privateChannels, dms, groupDms }`
 */
export function getMessageTargets(provider, adminEmail) {
  const params = new URLSearchParams({ provider, adminEmail });
  return api.get(`/agents/message-targets?${params}`);
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

export function closeCFChatMigration(jobIds) {
  return api.post('/agents/cf-close-migration', { jobIds }, { timeout: 60000 });
}

export function validateCFChatMigration(payload) {
  return api.post('/agents/cf-validate-migration', payload, { timeout: 30000 });
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
    { timeout: 0, ...(signal ? { signal } : {}) },
  );
}

export function getCustomTestCases() {
  return api.get('/test-cases/custom');
}

export function addCustomTestCase(testCase) {
  return api.post('/test-cases/custom', { testCase });
}

export function addBulkTestCases(testCases) {
  return api.post('/test-cases/custom/bulk', { testCases });
}

export function updateCustomTestCase(id, updates) {
  return api.put(`/test-cases/custom/${id}`, { updates });
}

export function deleteCustomTestCase(id) {
  return api.delete(`/test-cases/custom/${id}`);
}

// ─── OAuth / Connect Accounts ────────────────────────────────────────────────

export function getAuthStatus(agent) {
  const qs = agent ? `?agent=${encodeURIComponent(agent)}` : '';
  return api.get('/auth/status' + qs);
}

export function getConnectedAccounts(agent) {
  const qs = agent ? `?agent=${encodeURIComponent(agent)}` : '';
  return api.get('/auth/accounts' + qs);
}

export function getGoogleOAuthUrl(source, tenant, agent) {
  const params = new URLSearchParams();
  if (source) params.set('source', source);
  if (tenant && tenant !== '1') params.set('tenant', tenant);
  if (agent) params.set('agent', agent);
  params.set('origin', window.location.origin);
  return api.get('/auth/google/url?' + params.toString());
}

export function signOutGoogle(email) {
  return api.post('/auth/google/signout', { email });
}

export function getMicrosoftOAuthUrl(source, tenant, agent) {
  const params = new URLSearchParams();
  if (source) params.set('source', source);
  if (tenant && tenant !== '1') params.set('tenant', tenant);
  if (agent) params.set('agent', agent);
  params.set('origin', window.location.origin);
  return api.get('/auth/microsoft/url?' + params.toString());
}

export function signOutMicrosoft(email) {
  return api.post('/auth/microsoft/signout', { email: email || null });
}

export function connectMicrosoftAdmin(email, tenant = '1', agent) {
  const body = { email, tenant };
  if (agent) body.agent = agent;
  return api.post('/auth/microsoft/admin', body);
}

export function getSlackOAuthUrl(source = 'popup', agent) {
  const params = new URLSearchParams();
  if (source) params.set('source', source);
  if (agent) params.set('agent', agent);
  params.set('origin', window.location.origin);
  return api.get('/auth/slack/url?' + params.toString());
}

export function signOutSlack(email) {
  return api.post('/auth/slack/signout', { email });
}

export function connectSlackToken(token, agent) {
  const body = { token };
  if (agent) body.agent = agent;
  return api.post('/auth/slack/token', body);
}

export function getMessageUserStatus(emails, platform) {
  const params = new URLSearchParams({ emails: emails.join(','), platform });
  return api.get(`/agents/message-user-status?${params}`);
}

// ─── CloudFuze direct API proxies ────────────────────────────────────────────

/** Returns all cloud accounts connected to the CloudFuze subscriber. */
export function getCFCloudAccounts() {
  return api.get('/agents/cf-cloud-accounts');
}

/** Returns the list of CloudFuze server login accounts (env + user-added). */
export function getCFLoginAccounts() {
  return api.get('/agents/cf-login-accounts');
}

/** Add a new CF server login account (stored in backend/data/cf-extra-accounts.json). */
export function addCFLoginAccount(email, password) {
  return api.post('/agents/cf-login-accounts', { email, password });
}

/** Remove a user-added CF server login account. */
export function removeCFLoginAccount(email) {
  return api.delete(`/agents/cf-login-accounts/${encodeURIComponent(email)}`);
}

/**
 * Fetch channels from CloudFuze for the given cloud account IDs.
 * @param {{ srcCloudId?: string, dstCloudId?: string, channelType?: 'public'|'private'|'all', combination?: string }} params
 */
export function getCFChannels(params = {}) {
  return api.get('/agents/cf-channels', { params });
}

/**
 * Fetch DMs from CloudFuze for the given cloud account IDs.
 * @param {{ srcCloudId?: string, dstCloudId?: string, combination?: string }} params
 */
export function getCFDMs(params = {}) {
  return api.get('/agents/cf-dms', { params });
}

/**
 * Fetch public channels + private channels + DMs in a single request.
 * Saves all three to the server-side cache for the given combination.
 * @param {{ srcCloudId: string, dstCloudId: string, combination?: string }} params
 */
export function getCFChannelsAll(params = {}) {
  return api.get('/agents/cf-channels-all', { params });
}

/**
 * Return previously cached channels/DMs without hitting the CF API.
 * @param {{ srcCloudId: string, dstCloudId: string, combination?: string }} params
 * @returns `{ cached: boolean, publicChannels, privateChannels, dms, fetchedAt? }`
 */
export function getCFChannelsCache(params = {}) {
  return api.get('/agents/cf-channels-cache', { params });
}

/**
 * Fetch migration jobs/reports from CloudFuze.
 * @param {{ combination?: string, migrationStatus?: string }} params
 */
export function getCFReports(params = {}) {
  return api.get('/agents/cf-reports', { params });
}

/**
 * Launch CloudFuze browser automation — opens a visible Chromium window,
 * logs in, maps users, selects channels/DMs, starts migration, goes to reports.
 */
export function startCFBrowserMigration(payload) {
  return api.post('/agents/cf-browser-migrate', payload);
}

/** Stop the active CloudFuze browser automation session. */
export function abortCFBrowserMigration() {
  return api.post('/agents/cf-browser-abort');
}

/**
 * Poll the current browser automation session events.
 * Returns { running: boolean, events: [{type, step, detail, ts}] }
 */
export function getCFBrowserEvents() {
  return api.get('/agents/cf-browser-events');
}

export default api;

