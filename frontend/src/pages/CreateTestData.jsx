import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { getSourceUsers, createTestData, getExecution } from '../services/api';
import usePersistedState from '../hooks/usePersistedState';
import StatusBadge from '../components/StatusBadge';

const TEST_TYPES = [
  { value: 'SMOKE',  label: 'Smoke',  desc: '5 msgs · Inbox only' },
  { value: 'SANITY', label: 'Sanity', desc: '20 msgs · Inbox, Drafts, Sent + 2 custom' },
  { value: 'E2E',    label: 'E2E',    desc: '50 msgs · all folders + 5 custom' },
];

const PROVIDERS = [
  { key: 'microsoft', label: 'Microsoft 365', short: 'Outlook' },
  { key: 'google',    label: 'Google Workspace', short: 'Gmail' },
];

export default function CreateTestData() {
  const [provider, setProvider]     = usePersistedState('ctd-provider', 'microsoft');
  const [adminEmail, setAdminEmail] = usePersistedState('ctd-adminEmail', '');
  const [testType, setTestType]     = usePersistedState('ctd-testType', 'SMOKE');
  const [users, setUsers]           = usePersistedState('ctd-users', []);
  const [fetched, setFetched]       = usePersistedState('ctd-fetched', false);
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState(null);
  // email → { executionId, status, error }
  const [jobMap, setJobMap]         = useState({});
  const pollersRef                  = useRef({});

  // Clean up pollers on unmount
  useEffect(() => {
    const pollers = pollersRef.current;
    return () => Object.values(pollers).forEach(clearInterval);
  }, []);

  async function fetchUsers() {
    if (!adminEmail) return;
    setLoading(true);
    setError(null);
    setUsers([]);
    setFetched(false);
    setJobMap({});
    Object.values(pollersRef.current).forEach(clearInterval);
    pollersRef.current = {};
    try {
      const { data } = await getSourceUsers(adminEmail, provider);
      setUsers(data.users || []);
      setFetched(true);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  }

  function startPolling(email, executionId) {
    if (pollersRef.current[email]) clearInterval(pollersRef.current[email]);
    pollersRef.current[email] = setInterval(async () => {
      try {
        const { data } = await getExecution(executionId);
        if (data.status !== 'RUNNING') {
          setJobMap((prev) => ({ ...prev, [email]: { executionId, status: data.status } }));
          clearInterval(pollersRef.current[email]);
          delete pollersRef.current[email];
        }
      } catch {
        clearInterval(pollersRef.current[email]);
        delete pollersRef.current[email];
      }
    }, 3000);
  }

  async function handleCreate(email) {
    setJobMap((prev) => ({ ...prev, [email]: { status: 'RUNNING', executionId: null } }));
    try {
      const { data } = await createTestData({ sourceEmail: email, sourceProvider: provider, testType });
      setJobMap((prev) => ({ ...prev, [email]: { status: 'RUNNING', executionId: data.executionId } }));
      startPolling(email, data.executionId);
    } catch (err) {
      const msg = err.response?.data?.error || err.message;
      setJobMap((prev) => ({ ...prev, [email]: { status: 'FAILED', executionId: null, error: msg } }));
    }
  }

  async function handleCreateAll() {
    const pending = users.filter((u) => jobMap[u.email]?.status !== 'RUNNING');
    for (const user of pending) {
      await handleCreate(user.email);
      await new Promise((r) => setTimeout(r, 200)); // slight stagger
    }
  }

  const anyRunning = Object.values(jobMap).some((j) => j.status === 'RUNNING');
  const completedCount = Object.values(jobMap).filter((j) => j.status === 'COMPLETED').length;
  const failedCount = Object.values(jobMap).filter((j) => j.status === 'FAILED').length;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Create Test Data</h1>
        <p className="text-sm text-gray-500 mt-1">
          Populate source mailboxes with test emails before running migration
        </p>
      </div>

      {anyRunning && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 flex items-center gap-3">
          <svg className="animate-spin h-5 w-5 text-blue-600 flex-shrink-0" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <div>
            <p className="text-sm font-medium text-blue-800">
              Creating test data ({Object.values(jobMap).filter((j) => j.status === 'RUNNING').length} running)
            </p>
            <p className="text-xs text-blue-600">You can navigate away — creation continues in the background.</p>
          </div>
        </div>
      )}

      {/* Config card */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
        {/* Provider */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Source Provider</label>
          <div className="flex gap-1.5 p-1 bg-gray-100 rounded-lg w-fit">
            {PROVIDERS.map((p) => (
              <button key={p.key} type="button"
                onClick={() => { setProvider(p.key); setFetched(false); setUsers([]); setJobMap({}); }}
                className={`px-4 py-2 rounded-md text-sm font-medium transition-all ${
                  provider === p.key ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-700'
                }`}>
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* Test type */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Test Type</label>
          <div className="flex flex-wrap gap-2">
            {TEST_TYPES.map((t) => (
              <button key={t.value} type="button"
                onClick={() => setTestType(t.value)}
                className={`relative px-4 py-2.5 rounded-xl border-2 text-left transition-all ${
                  testType === t.value
                    ? 'border-indigo-500 bg-indigo-50'
                    : 'border-gray-200 bg-white hover:border-gray-300'
                }`}>
                <p className={`text-sm font-semibold ${testType === t.value ? 'text-indigo-700' : 'text-gray-900'}`}>
                  {t.label}
                </p>
                <p className="text-xs text-gray-500 mt-0.5">{t.desc}</p>
                {testType === t.value && (
                  <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-indigo-500" />
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Admin email */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Admin Email</label>
          <div className="flex gap-3">
            <input type="email" data-hj-suppress value={adminEmail}
              onChange={(e) => setAdminEmail(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && fetchUsers()}
              placeholder={provider === 'microsoft' ? 'admin@company.com' : 'admin@yourdomain.com'}
              className="flex-1 px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none" />
            <button onClick={fetchUsers} disabled={loading || !adminEmail}
              className="px-6 py-2.5 bg-gray-900 text-white text-sm font-semibold rounded-lg hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-all">
              {loading ? 'Fetching...' : 'Fetch Users'}
            </button>
          </div>
          {error && (
            <div className="mt-2 bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-600">{error}</div>
          )}
        </div>
      </div>

      {fetched && (
        <>
          {/* Summary bar */}
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-3 text-sm text-gray-600">
              <span>{users.length} user{users.length !== 1 ? 's' : ''}</span>
              {completedCount > 0 && <span className="text-green-600 font-medium">{completedCount} completed</span>}
              {failedCount > 0 && <span className="text-red-600 font-medium">{failedCount} failed</span>}
            </div>
            <button onClick={handleCreateAll}
              disabled={anyRunning || users.length === 0}
              className="px-5 py-2.5 bg-indigo-600 text-white text-sm font-semibold rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center gap-2">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 0 1 0 1.972l-11.54 6.347a1.125 1.125 0 0 1-1.667-.986V5.653Z" />
              </svg>
              Create Data for All ({users.length})
            </button>
          </div>

          {/* Users table */}
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="px-5 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">User</th>
                  <th className="px-5 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                  <th className="px-5 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {users.map((user) => {
                  const job = jobMap[user.email];
                  const isRunning = job?.status === 'RUNNING';
                  const isDone = job?.status === 'COMPLETED';
                  return (
                    <tr key={user.email}
                      className={`transition-colors ${isRunning ? 'bg-blue-50/30' : isDone ? 'bg-green-50/30' : 'hover:bg-gray-50'}`}>
                      <td className="px-5 py-3">
                        <p data-hj-suppress className="font-medium text-gray-900">{user.email}</p>
                        {user.displayName && <p className="text-xs text-gray-500">{user.displayName}</p>}
                      </td>
                      <td className="px-5 py-3">
                        {job ? (
                          <div className="flex items-center gap-2">
                            <StatusBadge status={job.status} />
                            {job.executionId && (
                              <Link to={`/logs?id=${job.executionId}`}
                                className="text-xs text-indigo-600 hover:underline">
                                View logs
                              </Link>
                            )}
                            {job.error && (
                              <span className="text-xs text-red-500 truncate max-w-48" title={job.error}>{job.error}</span>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs text-gray-400">Not started</span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-right">
                        <button onClick={() => handleCreate(user.email)}
                          disabled={isRunning}
                          className="px-3 py-1.5 bg-indigo-600 text-white text-xs font-semibold rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center gap-1 ml-auto">
                          {isRunning ? (
                            <>
                              <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                              </svg>
                              Running…
                            </>
                          ) : isDone ? 'Re-create' : 'Create Data'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
