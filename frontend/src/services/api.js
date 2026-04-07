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

export function getSourceUsers(adminEmail) {
  return api.get(`/agents/users/source?adminEmail=${encodeURIComponent(adminEmail)}`);
}

export function getDestinationUsers(adminEmail) {
  const params = adminEmail ? `?adminEmail=${encodeURIComponent(adminEmail)}` : '';
  return api.get(`/agents/users/destination${params}`);
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


export function getSourceMailboxStats(email) {
  return api.get('/agents/source-mailbox-stats?email=' + encodeURIComponent(email), { timeout: 60000 });
}

export function cleanSource(email) {
  return api.post('/agents/clean-source', { email }, { timeout: 0 });
}
export default api;

