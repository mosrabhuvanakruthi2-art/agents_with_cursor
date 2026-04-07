import { useState, useEffect, useCallback } from 'react';
import { getDestinationUsers, getMailboxStats } from '../services/api';
import { startClean, startCleanAll, subscribe, getActiveCleans, getAllResults, clearResults } from '../services/cleanManager';
import usePersistedState from '../hooks/usePersistedState';

export default function CleanDestinationPage() {
  const [adminEmail, setAdminEmail] = usePersistedState('clean-adminEmail', '');
  const [users, setUsers] = usePersistedState('clean-users', []);
  const [loading, setLoading] = useState(false);
  const [statsLoading, setStatsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [fetched, setFetched] = usePersistedState('clean-fetched', false);
  const [activeCleans, setActiveCleans] = useState(getActiveCleans());
  const [cleanResults, setCleanResults] = useState(getAllResults);

  useEffect(() => {
    const unsubscribe = subscribe(() => {
      setActiveCleans(getActiveCleans());
      const results = getAllResults();
      setCleanResults(results);
      setUsers((prev) => prev.map((u) => {
        const r = results[u.email];
        if (r && r.refreshedStats && !r.error) {
          return { ...u, stats: r.refreshedStats };
        }
        return u;
      }));
    });
    return unsubscribe;
  }, [setUsers]);

  async function fetchUsers() {
    if (!adminEmail) return;
    setLoading(true);
    setError(null);
    setUsers([]);
    setFetched(false);
    setCleanResults({});
    clearResults();

    try {
      const { data } = await getDestinationUsers(adminEmail);
      const userList = (data.users || []).map((u) => ({ ...u, stats: null }));
      setUsers(userList);
      setFetched(true);

      setStatsLoading(true);
      const batchSize = 3;
      const updatedUsers = [...userList];
      for (let i = 0; i < updatedUsers.length; i += batchSize) {
        const batch = updatedUsers.slice(i, i + batchSize);
        const results = await Promise.allSettled(
          batch.map((u) => getMailboxStats(u.email, true))
        );
        results.forEach((r, idx) => {
          const userIdx = i + idx;
          updatedUsers[userIdx] = {
            ...updatedUsers[userIdx],
            stats: r.status === 'fulfilled' ? r.value.data : { error: true },
          };
        });
        setUsers([...updatedUsers]);
      }
      setStatsLoading(false);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  }

  const handleCleanUser = useCallback((email) => {
    if (!window.confirm('Delete ALL emails, custom folders, and calendar events from:\n\n' + email + '\n\nThis cannot be undone. Continue?')) return;
    setCleanResults((prev) => { const next = { ...prev }; delete next[email]; return next; });
    startClean(email);
  }, []);

  const handleCleanAll = useCallback(() => {
    const toClean = users.filter((u) => u.stats && !u.stats.error && (u.stats.mailCount > 0 || u.stats.folderCount > 0 || u.stats.eventCount > 0));
    if (toClean.length === 0) return;
    if (!window.confirm('Delete ALL data from ' + toClean.length + ' mailbox(es):\n\n' + toClean.map((u) => u.email).join('\n') + '\n\nThis cannot be undone. Continue?')) return;
    startCleanAll(toClean.map((u) => u.email));
  }, [users]);

  const [refreshing, setRefreshing] = useState(false);

  async function handleRefreshStats() {
    if (users.length === 0) return;
    setRefreshing(true);
    const batchSize = 3;
    const updatedUsers = [...users];
    for (let i = 0; i < updatedUsers.length; i += batchSize) {
      const batch = updatedUsers.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map((u) => getMailboxStats(u.email, true))
      );
      results.forEach((r, idx) => {
        const userIdx = i + idx;
        if (r.status === 'fulfilled') {
          updatedUsers[userIdx] = { ...updatedUsers[userIdx], stats: r.value.data };
        }
      });
      setUsers([...updatedUsers]);
    }
    setRefreshing(false);
  }

  const totalMails = users.reduce((sum, u) => sum + (u.stats?.mailCount || 0), 0);
  const totalFolders = users.reduce((sum, u) => sum + (u.stats?.folderCount || 0), 0);
  const totalEvents = users.reduce((sum, u) => sum + (u.stats?.eventCount || 0), 0);
  const usersWithData = users.filter((u) => u.stats && !u.stats.error && (u.stats.mailCount > 0 || u.stats.folderCount > 0 || u.stats.eventCount > 0));
  const anyCleanRunning = activeCleans.size > 0;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Clean Destination</h1>
        <p className="text-sm text-gray-500 mt-1">
          View mailbox stats and clean destination Outlook accounts before migration
        </p>
      </div>

      {anyCleanRunning && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-4 flex items-center gap-3">
          <svg className="animate-spin h-5 w-5 text-yellow-600" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <div>
            <p className="text-sm font-medium text-yellow-800">
              Cleaning in progress ({activeCleans.size} mailbox{activeCleans.size > 1 ? 'es' : ''})
            </p>
            <p className="text-xs text-yellow-600">You can navigate to other pages - cleaning continues in the background.</p>
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Destination Admin Email (Outlook)
        </label>
        <div className="flex items-end gap-4">
          <input
            type="email"
            value={adminEmail}
            onChange={(e) => setAdminEmail(e.target.value)}
            placeholder="granger@gajha.com"
            className="flex-1 px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
          />
          <button
            onClick={fetchUsers}
            disabled={loading || !adminEmail}
            className="px-6 py-2.5 bg-gray-900 text-white text-sm font-semibold rounded-lg hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
          >
            {loading ? 'Fetching...' : 'Fetch Users'}
          </button>
        </div>
        {error && (
          <div className="mt-3 bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-600">{error}</div>
        )}
      </div>

      {fetched && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
            <StatCard label="Mailbox Users" value={users.length} color="indigo" />
            <StatCard label="Total Emails" value={statsLoading ? '...' : totalMails} color="blue" />
            <StatCard label="Custom Folders" value={statsLoading ? '...' : totalFolders} color="purple" />
            <StatCard label="Total Events" value={statsLoading ? '...' : totalEvents} color="green" />
          </div>

          <div className="flex justify-end gap-3">
            <button
              onClick={handleRefreshStats}
              disabled={refreshing}
              className="px-5 py-2.5 bg-white border border-gray-300 text-gray-700 text-sm font-semibold rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center gap-2"
            >
              <svg className={'w-4 h-4' + (refreshing ? ' animate-spin' : '')} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182" />
              </svg>
              {refreshing ? 'Refreshing...' : 'Refresh Stats'}
            </button>
            {usersWithData.length > 0 && (
              <button
                onClick={handleCleanAll}
                disabled={anyCleanRunning}
                className="px-6 py-2.5 bg-red-600 text-white text-sm font-semibold rounded-lg hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center gap-2"
              >
                <TrashIcon />
                Clean All {usersWithData.length} Mailboxes
              </button>
            )}
          </div>

          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th className="px-5 py-3 text-left text-xs font-medium text-gray-500 uppercase">User</th>
                    <th className="px-5 py-3 text-right text-xs font-medium text-gray-500 uppercase">Emails</th>
                    <th className="px-5 py-3 text-right text-xs font-medium text-gray-500 uppercase">Custom Folders</th>
                    <th className="px-5 py-3 text-right text-xs font-medium text-gray-500 uppercase">Calendars</th>
                    <th className="px-5 py-3 text-right text-xs font-medium text-gray-500 uppercase">Events</th>
                    <th className="px-5 py-3 text-right text-xs font-medium text-gray-500 uppercase">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {users.map((user) => {
                    const s = user.stats;
                    const isClean = s && !s.error && s.mailCount === 0 && s.folderCount === 0 && s.eventCount === 0;
                    const result = cleanResults[user.email];
                    const isCleaning = activeCleans.has(user.email);

                    return (
                      <tr key={user.email} className={'hover:bg-gray-50' + (isClean ? ' bg-green-50/50' : '') + (isCleaning ? ' bg-yellow-50/50' : '')}>
                        <td className="px-5 py-3">
                          <p className="font-medium text-gray-900">{user.email}</p>
                          <p className="text-xs text-gray-500">{user.displayName}</p>
                        </td>
                        <td className="px-5 py-3 text-right">
                          {!s ? (
                            <span className="text-gray-400 text-xs">loading...</span>
                          ) : s.error ? (
                            <span className="text-red-400 text-xs">error</span>
                          ) : (
                            <span className={'font-semibold ' + (s.mailCount === 0 ? 'text-green-600' : 'text-gray-900')}>
                              {s.mailCount.toLocaleString()}
                            </span>
                          )}
                        </td>
                        <td className="px-5 py-3 text-right">
                          {s && !s.error ? (
                            <span className={s.folderCount === 0 ? 'text-green-600' : 'text-gray-700'}>{s.folderCount}</span>
                          ) : s?.error ? <span className="text-red-400 text-xs">-</span> : <span className="text-gray-400 text-xs">...</span>}
                        </td>
                        <td className="px-5 py-3 text-right">
                          {s && !s.error ? <span className="text-gray-700">{s.calendarCount}</span> : <span className="text-gray-400 text-xs">...</span>}
                        </td>
                        <td className="px-5 py-3 text-right">
                          {s && !s.error ? (
                            <span className={s.eventCount === 0 ? 'text-green-600' : 'text-gray-700'}>{s.eventCount}</span>
                          ) : <span className="text-gray-400 text-xs">...</span>}
                        </td>
                        <td className="px-5 py-3 text-right">
                          <div className="flex flex-col items-end gap-1">
                            {result && !result.error && result.deleted && (
                              <span className="text-xs text-green-600 font-medium">
                                Deleted {result.deleted.messagesDeleted} msgs, {result.deleted.foldersDeleted} folders, {result.deleted.eventsDeleted || 0} events
                              </span>
                            )}
                            {result?.error && (
                              <span className="text-xs text-red-500">{result.error}</span>
                            )}
                            {isCleaning ? (
                              <span className="inline-flex items-center gap-1.5 text-xs text-yellow-700 font-medium">
                                <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24">
                                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                                </svg>
                                Cleaning...
                              </span>
                            ) : isClean ? (
                              <span className="inline-flex items-center gap-1 text-xs text-green-600 font-medium">
                                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                                </svg>
                                Clean
                              </span>
                            ) : (
                              <button
                                onClick={() => handleCleanUser(user.email)}
                                disabled={!s || s.error || isCleaning}
                                className="px-3 py-1.5 bg-red-600 text-white text-xs font-semibold rounded-lg hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center gap-1"
                              >
                                <TrashIcon size={12} />
                                Clean
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function StatCard({ label, value, color }) {
  const colors = {
    indigo: 'bg-indigo-50 text-indigo-700 border-indigo-100',
    blue: 'bg-blue-50 text-blue-700 border-blue-100',
    purple: 'bg-purple-50 text-purple-700 border-purple-100',
    green: 'bg-green-50 text-green-700 border-green-100',
  };
  return (
    <div className={'rounded-xl border p-4 ' + colors[color]}>
      <p className="text-xs font-medium opacity-75 uppercase tracking-wider">{label}</p>
      <p className="text-2xl font-bold mt-1">{value}</p>
    </div>
  );
}

function TrashIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
    </svg>
  );
}
