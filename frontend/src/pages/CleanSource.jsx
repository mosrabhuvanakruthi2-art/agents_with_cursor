import { useState, useEffect, useCallback } from 'react';
import { getSourceUsers, getSourceMailboxStats, getSourceCalendarStats } from '../services/api';
import { startClean, startCleanAll, subscribe, getActiveCleans, getAllResults, clearResults } from '../services/cleanSourceManager';
import usePersistedState from '../hooks/usePersistedState';

export default function CleanSourcePage() {
  const [adminEmail, setAdminEmail] = usePersistedState('clean-src-adminEmail', '');
  const [users, setUsers] = usePersistedState('clean-src-users', []);
  const [loading, setLoading] = useState(false);
  const [statsLoading, setStatsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [fetched, setFetched] = usePersistedState('clean-src-fetched', false);
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
      const { data } = await getSourceUsers(adminEmail);
      const userList = (data.users || []).map((u) => ({ ...u, stats: null }));
      setUsers(userList);
      setFetched(true);

      setStatsLoading(true);
      const batchSize = 3;
      const updatedUsers = [...userList];
      for (let i = 0; i < updatedUsers.length; i += batchSize) {
        const batch = updatedUsers.slice(i, i + batchSize);
        const [mailResults, calResults] = await Promise.all([
          Promise.allSettled(batch.map((u) => getSourceMailboxStats(u.email))),
          Promise.allSettled(batch.map((u) => getSourceCalendarStats(u.email))),
        ]);
        mailResults.forEach((r, idx) => {
          const userIdx = i + idx;
          const baseStats = r.status === 'fulfilled' ? r.value.data : { error: true };
          const calData = calResults[idx];
          const bulkEventCount = calData.status === 'fulfilled'
            ? (calData.value.data?.eventCount ?? null)
            : null;
          updatedUsers[userIdx] = {
            ...updatedUsers[userIdx],
            stats: bulkEventCount !== null
              ? { ...baseStats, eventCount: bulkEventCount }
              : baseStats,
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
    const toClean = users.filter((u) => u.stats && !u.stats.tokenError && !u.stats.error && ((u.stats.mailCount ?? 0) > 0 || (u.stats.folderCount ?? 0) > 0 || (u.stats.eventCount ?? 0) > 0 || (u.stats.calendarCount ?? 0) > 0));
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
      const [mailResults, calResults] = await Promise.all([
        Promise.allSettled(batch.map((u) => getSourceMailboxStats(u.email))),
        Promise.allSettled(batch.map((u) => getSourceCalendarStats(u.email))),
      ]);
      mailResults.forEach((r, idx) => {
        const userIdx = i + idx;
        if (r.status === 'fulfilled') {
          const baseStats = r.value.data;
          const calData = calResults[idx];
          const bulkEventCount = calData.status === 'fulfilled'
            ? (calData.value.data?.eventCount ?? null)
            : null;
          updatedUsers[userIdx] = {
            ...updatedUsers[userIdx],
            stats: bulkEventCount !== null
              ? { ...baseStats, eventCount: bulkEventCount }
              : baseStats,
          };
        }
      });
      setUsers([...updatedUsers]);
    }
    setRefreshing(false);
  }

  const totalMails = users.reduce((sum, u) => sum + (u.stats?.mailCount || 0), 0);
  const totalFolders = users.reduce((sum, u) => sum + (u.stats?.folderCount || 0), 0);
  const totalEvents = users.reduce((sum, u) => sum + (u.stats?.eventCount || 0), 0);
  const usersWithData = users.filter((u) => u.stats && !u.stats.tokenError && !u.stats.error && ((u.stats.mailCount ?? 0) > 0 || (u.stats.folderCount ?? 0) > 0 || (u.stats.eventCount ?? 0) > 0 || (u.stats.calendarCount ?? 0) > 0));
  const anyCleanRunning = activeCleans.size > 0;

  return (
    <div className="page-wrap">
      <div className="page-header">
        <div>
          <h1 className="page-title">Clean Source</h1>
          <p className="page-subtitle">View mailbox stats and clean source Gmail accounts before migration</p>
        </div>
      </div>

      {anyCleanRunning && (
        <div className="card" style={{ border: '1px solid #fcd34d' }}>
          <div className="card-body" style={{ padding: '16px 24px', display: 'flex', alignItems: 'center', gap: 12, backgroundColor: '#fffbeb' }}>
            <svg className="animate-spin h-5 w-5" style={{ color: '#b45309' }} viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <div>
              <p style={{ fontSize: 14, fontWeight: 700, color: '#92400e' }}>Cleaning in progress ({activeCleans.size} mailbox{activeCleans.size > 1 ? 'es' : ''})</p>
              <p style={{ fontSize: 13, color: '#b45309', marginTop: 2 }}>You can navigate to other pages — cleaning continues in the background.</p>
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-body" style={{ padding: '28px 32px' }}>
          <label className="block" style={{ fontSize: 14, fontWeight: 700, color: '#0129ac', marginBottom: 10 }}>
            Source Admin Email (Gmail)
          </label>
          <div style={{ display: 'flex', gap: 12 }}>
            <input type="email" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} placeholder="granger@cloudfuze.us"
              className="input" style={{ flex: 1, fontSize: 14, padding: '12px 16px' }} />
            <button onClick={fetchUsers} disabled={loading || !adminEmail}
              className="btn btn-primary" style={{ padding: '12px 24px', fontSize: 14, flexShrink: 0 }}>
              {loading ? 'Fetching…' : 'Fetch Users'}
            </button>
          </div>
          {error && <div style={{ marginTop: 12, padding: '12px 16px', borderRadius: 8, backgroundColor: '#fee2e2', border: '1px solid #fca5a5', fontSize: 13, color: '#dc2626' }}>{error}</div>}
        </div>
      </div>

      {fetched && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 16 }}>
            {[
              { label: 'Mailbox Users', value: users.length, cls: 'blue', accent: '#0129ac' },
              { label: 'Total Emails', value: statsLoading ? '…' : totalMails.toLocaleString(), cls: 'green', accent: '#10b981' },
              { label: 'Custom Folders', value: statsLoading ? '…' : totalFolders, cls: 'amber', accent: '#f59e0b' },
              { label: 'Total Events', value: statsLoading ? '…' : totalEvents.toLocaleString(), cls: 'red', accent: '#ef4444' },
            ].map(c => (
              <div key={c.label} className={`stat-card ${c.cls}`}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>{c.label}</div>
                <div style={{ fontSize: 32, fontWeight: 800, color: c.accent }}>{c.value}</div>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
            <button onClick={handleRefreshStats} disabled={refreshing} className="btn btn-ghost" style={{ gap: 8 }}>
              <svg className={'w-4 h-4' + (refreshing ? ' animate-spin' : '')} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182" />
              </svg>
              {refreshing ? 'Refreshing…' : 'Refresh Stats'}
            </button>
            {usersWithData.length > 0 && (
              <button onClick={handleCleanAll} disabled={anyCleanRunning}
                className="btn" style={{ backgroundColor: '#dc2626', color: '#fff', border: '1px solid #dc2626', gap: 8 }}>
                <TrashIcon />
                Clean All {usersWithData.length} Mailboxes
              </button>
            )}
          </div>

          <div className="card" style={{ overflow: 'hidden' }}>
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>User</th>
                    <th style={{ textAlign: 'right' }}>Emails</th>
                    <th style={{ textAlign: 'right' }}>Custom Folders</th>
                    <th style={{ textAlign: 'right' }}>Calendars</th>
                    <th style={{ textAlign: 'right' }}>Events</th>
                    <th style={{ textAlign: 'right' }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((user) => {
                    const s = user.stats;
                    const hasTokenError = s?.tokenError || s?.error;
                    const isClean = s && !hasTokenError && (s.mailCount ?? 0) === 0 && (s.folderCount ?? 0) === 0 && (s.eventCount ?? 0) === 0 && (s.calendarCount ?? 0) === 0;
                    const result = cleanResults[user.email];
                    const isCleaning = activeCleans.has(user.email);
                    return (
                      <tr key={user.email} style={{ backgroundColor: isClean ? '#f0fdf4' : isCleaning ? '#fffbeb' : hasTokenError ? '#fff7ed' : undefined }}>
                        <td>
                          <p style={{ fontWeight: 600, color: '#0f172a', fontSize: 14 }}>{user.email}</p>
                          <p style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>{user.displayName}</p>
                          {s?.tokenError && <p style={{ fontSize: 12, color: '#f97316', marginTop: 2 }}>⚠ Token expired — update in .env</p>}
                          {s?.noToken && <p style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>No token configured</p>}
                        </td>
                        <td style={{ textAlign: 'right', fontWeight: 700, fontSize: 14, color: !s ? '#9ca3af' : hasTokenError ? '#f97316' : (s.mailCount ?? 0) === 0 ? '#10b981' : '#0f172a' }}>
                          {!s ? '…' : (s.mailCount ?? 0).toLocaleString()}
                        </td>
                        <td style={{ textAlign: 'right', fontSize: 14, color: !s ? '#9ca3af' : hasTokenError ? '#f97316' : (s.folderCount ?? 0) === 0 ? '#10b981' : '#374151' }}>
                          {!s ? '…' : s.folderCount ?? 0}
                        </td>
                        <td style={{ textAlign: 'right', fontSize: 14, color: !s ? '#9ca3af' : hasTokenError ? '#f97316' : '#374151' }}>
                          {!s ? '…' : s.calendarCount ?? 0}
                        </td>
                        <td style={{ textAlign: 'right', fontSize: 14, color: !s ? '#9ca3af' : hasTokenError ? '#f97316' : (s.eventCount ?? 0) === 0 ? '#10b981' : '#374151' }}>
                          {!s ? '…' : (s.eventCount ?? 0).toLocaleString()}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
                            {result && !result.error && result.deleted && (
                              <span style={{ fontSize: 12, color: '#10b981', fontWeight: 600 }}>
                                Deleted {result.deleted.messagesDeleted} msgs, {result.deleted.foldersDeleted} folders
                              </span>
                            )}
                            {result?.error && <span style={{ fontSize: 12, color: '#ef4444' }}>{result.error}</span>}
                            {isCleaning ? (
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#b45309', fontWeight: 600 }}>
                                <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                                Cleaning…
                              </span>
                            ) : isClean ? (
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 13, color: '#10b981', fontWeight: 700 }}>
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5"/></svg>
                                Clean
                              </span>
                            ) : (
                              <button onClick={() => handleCleanUser(user.email)} disabled={!s || hasTokenError || isCleaning}
                                className="btn" style={{ padding: '6px 14px', fontSize: 12, backgroundColor: '#dc2626', color: '#fff', border: '1px solid #dc2626', gap: 6 }}>
                                <TrashIcon size={13} /> Clean
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

function StatCard() { return null; }

function TrashIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
    </svg>
  );
}


