import { useState, useEffect, useCallback } from 'react';
import { getCFReports, getCFCloudAccounts } from '../services/api';

const COMBINATIONS = [
  { code: '',    label: 'All Combinations' },
  { code: 'S2T', label: 'Slack → Teams' },
  { code: 'S2C', label: 'Slack → Google Chat' },
  { code: 'S2S', label: 'Slack → Slack' },
  { code: 'T2T', label: 'Teams → Teams' },
  { code: 'T2C', label: 'Teams → Google Chat' },
  { code: 'T2S', label: 'Teams → Slack' },
  { code: 'C2T', label: 'Google Chat → Teams' },
  { code: 'C2C', label: 'Google Chat → Google Chat' },
  { code: 'C2S', label: 'Google Chat → Slack' },
];

const STATUSES = [
  { value: 'All',         label: 'All Statuses' },
  { value: 'InProgress',  label: 'In Progress' },
  { value: 'Completed',   label: 'Completed' },
  { value: 'Failed',      label: 'Failed' },
  { value: 'Pending',     label: 'Pending' },
];

function statusStyle(status) {
  const s = (status || '').toLowerCase();
  if (s === 'completed' || s === 'success')
    return { bg: '#d4edda', color: '#155724', border: '#c3e6cb' };
  if (s === 'failed' || s === 'error')
    return { bg: '#fff0f0', color: '#cc0000', border: '#f5c6cb' };
  if (s === 'inprogress' || s === 'running' || s === 'processing')
    return { bg: '#fff8e5', color: '#7a5400', border: '#ffeeba' };
  return { bg: '#f0f4ff', color: '#0129ac', border: '#c5cef5' };
}

function formatDate(raw) {
  if (!raw) return '—';
  const d = new Date(typeof raw === 'number' ? raw * 1000 : raw);
  if (isNaN(d.getTime())) return String(raw);
  return d.toLocaleString();
}

export default function MigrationReports() {
  const [combination, setCombination]       = useState('S2T');
  const [migrationStatus, setMigrationStatus] = useState('All');
  const [jobs, setJobs]                     = useState(null);
  const [loading, setLoading]               = useState(false);
  const [error, setError]                   = useState(null);
  const [cloudAccounts, setCloudAccounts]   = useState([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [selectedJob, setSelectedJob]       = useState(null);
  const [autoRefresh, setAutoRefresh]       = useState(false);

  const fetchReports = useCallback(async (combo, status) => {
    setLoading(true);
    setError(null);
    try {
      const params = { migrationStatus: status || 'All' };
      if (combo) params.combination = combo;
      const { data } = await getCFReports(params);
      setJobs(Array.isArray(data.jobs) ? data.jobs : []);
    } catch (err) {
      setError(err?.response?.data?.error || err.message || 'Failed to fetch reports');
      setJobs(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchCloudAccounts = useCallback(async () => {
    setAccountsLoading(true);
    try {
      const { data } = await getCFCloudAccounts();
      setCloudAccounts(Array.isArray(data.accounts) ? data.accounts : []);
    } catch {
      setCloudAccounts([]);
    } finally {
      setAccountsLoading(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    fetchReports(combination, migrationStatus);
    fetchCloudAccounts();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-refresh every 30 s
  useEffect(() => {
    if (!autoRefresh) return;
    const t = setInterval(() => fetchReports(combination, migrationStatus), 30000);
    return () => clearInterval(t);
  }, [autoRefresh, combination, migrationStatus, fetchReports]);

  function handleSearch() {
    fetchReports(combination, migrationStatus);
    setSelectedJob(null);
  }

  const totalJobs = Array.isArray(jobs) ? jobs.length : 0;
  const completedJobs = Array.isArray(jobs) ? jobs.filter(j => (j.migrationStatus || j.status || '').toLowerCase() === 'completed').length : 0;
  const failedJobs = Array.isArray(jobs) ? jobs.filter(j => (j.migrationStatus || j.status || '').toLowerCase() === 'failed').length : 0;
  const runningJobs = Array.isArray(jobs) ? jobs.filter(j => {
    const s = (j.migrationStatus || j.status || '').toLowerCase();
    return s === 'inprogress' || s === 'running' || s === 'processing';
  }).length : 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: '#000000' }}>Migration Reports</h1>
          <p className="text-sm mt-1" style={{ color: '#555555' }}>
            CloudFuze message migration jobs — live status from{' '}
            <span className="font-mono text-xs" style={{ color: '#0129ac' }}>s2cdev.cloudfuze.com</span>
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs cursor-pointer select-none" style={{ color: '#555' }}>
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              style={{ accentColor: '#0129ac' }}
            />
            Auto-refresh (30 s)
          </label>
          <a
            href="https://s2cdev.cloudfuze.com/pages/reports.html"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold"
            style={{ backgroundColor: '#0129ac', color: '#fff', textDecoration: 'none' }}
          >
            Open CloudFuze ↗
          </a>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-xl p-5" style={{ border: '1px solid #c5cef5' }}>
        <div className="flex flex-wrap gap-4 items-end">
          <div className="flex-1 min-w-[180px]">
            <label className="block text-xs font-semibold mb-1" style={{ color: '#000' }}>Combination</label>
            <select
              value={combination}
              onChange={(e) => setCombination(e.target.value)}
              className="w-full px-3 py-2 rounded-lg text-sm outline-none bg-white"
              style={{ border: '2px solid #0129ac', color: '#000' }}
            >
              {COMBINATIONS.map((c) => (
                <option key={c.code} value={c.code}>{c.label}</option>
              ))}
            </select>
          </div>
          <div className="flex-1 min-w-[180px]">
            <label className="block text-xs font-semibold mb-1" style={{ color: '#000' }}>Status</label>
            <select
              value={migrationStatus}
              onChange={(e) => setMigrationStatus(e.target.value)}
              className="w-full px-3 py-2 rounded-lg text-sm outline-none bg-white"
              style={{ border: '2px solid #0129ac', color: '#000' }}
            >
              {STATUSES.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </div>
          <button
            onClick={handleSearch}
            disabled={loading}
            className="px-5 py-2 rounded-lg text-sm font-semibold disabled:opacity-50"
            style={{ backgroundColor: '#0129ac', color: '#fff' }}
          >
            {loading ? 'Loading…' : 'Fetch Reports'}
          </button>
        </div>
      </div>

      {/* Connected cloud accounts */}
      {cloudAccounts.length > 0 && (
        <div className="bg-white rounded-xl p-4" style={{ border: '1px solid #c5cef5' }}>
          <p className="text-xs font-semibold mb-2" style={{ color: '#555' }}>Connected Cloud Accounts ({cloudAccounts.length})</p>
          <div className="flex flex-wrap gap-2">
            {cloudAccounts.map((acct) => (
              <div
                key={acct.id}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs"
                style={{ backgroundColor: '#f0f4ff', border: '1px solid #c5cef5' }}
              >
                <span className="font-semibold" style={{ color: '#0129ac' }}>{acct.cloudName}</span>
                <span style={{ color: '#555' }}>{acct.emailId || acct.metadataUrl || acct.id}</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded font-bold"
                  style={{
                    backgroundColor: acct.cloudStatus === 'active' ? '#d4edda' : '#fff8e5',
                    color: acct.cloudStatus === 'active' ? '#155724' : '#7a5400',
                  }}>
                  {acct.cloudStatus || 'connected'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      {accountsLoading && (
        <div className="text-xs" style={{ color: '#555' }}>Loading cloud accounts…</div>
      )}

      {/* Error */}
      {error && (
        <div className="rounded-xl p-4" style={{ backgroundColor: '#fff0f0', border: '1px solid #cc0000' }}>
          <p className="text-sm font-medium" style={{ color: '#cc0000' }}>Error loading reports</p>
          <p className="text-xs mt-1" style={{ color: '#000' }}>{error}</p>
        </div>
      )}

      {/* Summary stats */}
      {jobs !== null && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard label="Total Jobs" value={totalJobs} color="#0129ac" bg="#f0f4ff" />
          <StatCard label="Completed" value={completedJobs} color="#155724" bg="#d4edda" />
          <StatCard label="In Progress" value={runningJobs} color="#7a5400" bg="#fff8e5" />
          <StatCard label="Failed" value={failedJobs} color="#cc0000" bg="#fff0f0" />
        </div>
      )}

      {/* Jobs table */}
      {jobs !== null && (
        <div className="bg-white rounded-xl overflow-hidden" style={{ border: '1px solid #c5cef5' }}>
          <div className="px-5 py-3 flex items-center justify-between" style={{ borderBottom: '1px solid #eef1fb', backgroundColor: '#f9fafb' }}>
            <span className="text-sm font-semibold" style={{ color: '#000' }}>
              {totalJobs === 0 ? 'No jobs found' : `${totalJobs} job${totalJobs !== 1 ? 's' : ''}`}
            </span>
            {loading && <span className="text-xs" style={{ color: '#555' }}>Refreshing…</span>}
          </div>

          {totalJobs === 0 ? (
            <div className="px-5 py-8 text-center text-sm" style={{ color: '#555' }}>
              No migration jobs found for the selected filters.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr style={{ backgroundColor: '#f0f4ff', borderBottom: '2px solid #c5cef5' }}>
                    <th className="px-4 py-3 text-left font-semibold" style={{ color: '#000' }}>Job ID</th>
                    <th className="px-4 py-3 text-left font-semibold" style={{ color: '#000' }}>Combination</th>
                    <th className="px-4 py-3 text-left font-semibold" style={{ color: '#000' }}>Workspace</th>
                    <th className="px-4 py-3 text-left font-semibold" style={{ color: '#000' }}>Channel</th>
                    <th className="px-4 py-3 text-center font-semibold" style={{ color: '#000' }}>Status</th>
                    <th className="px-4 py-3 text-center font-semibold" style={{ color: '#000' }}>Messages</th>
                    <th className="px-4 py-3 text-left font-semibold" style={{ color: '#000' }}>Started</th>
                    <th className="px-4 py-3 text-left font-semibold" style={{ color: '#000' }}>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((job, i) => {
                    const jobId = job.id || job.jobId || job._id || `job-${i}`;
                    const status = job.migrationStatus || job.status || '—';
                    const sStyle = statusStyle(status);
                    const isSelected = selectedJob === jobId;

                    return (
                      <tr
                        key={jobId}
                        onClick={() => setSelectedJob(isSelected ? null : jobId)}
                        className="cursor-pointer transition-colors"
                        style={{
                          borderBottom: '1px solid #eef1fb',
                          backgroundColor: isSelected ? '#e8eeff' : i % 2 === 0 ? '#fff' : '#fafbff',
                        }}
                      >
                        <td className="px-4 py-3 font-mono" style={{ color: '#0129ac' }}>
                          {String(jobId).length > 20 ? String(jobId).slice(0, 20) + '…' : String(jobId)}
                        </td>
                        <td className="px-4 py-3">
                          <span className="px-2 py-0.5 rounded text-[11px] font-bold"
                            style={{ backgroundColor: '#0129ac', color: '#fff' }}>
                            {job.combination || '—'}
                          </span>
                        </td>
                        <td className="px-4 py-3" style={{ color: '#000' }}>
                          {job.workSpaceName || job.workspace || job.fromWorkspace || '—'}
                        </td>
                        <td className="px-4 py-3" style={{ color: '#000' }}>
                          <span className="truncate block max-w-[160px]" title={job.channelName}>
                            {job.channelName || job.channel || '—'}
                          </span>
                          {job.channelType && (
                            <span className="text-[10px]" style={{ color: '#888' }}>{job.channelType}</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-center">
                          <span className="px-2 py-0.5 rounded-full text-[11px] font-bold"
                            style={{ backgroundColor: sStyle.bg, color: sStyle.color, border: `1px solid ${sStyle.border}` }}>
                            {status}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-center" style={{ color: '#000' }}>
                          <div className="flex flex-col items-center gap-0.5">
                            <span className="font-semibold">{job.migratedCount ?? job.messagesMigrated ?? '—'}</span>
                            {(job.totalCount != null || job.totalMessages != null) && (
                              <span className="text-[10px]" style={{ color: '#888' }}>
                                / {job.totalCount ?? job.totalMessages}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3" style={{ color: '#555' }}>
                          {formatDate(job.createdAt || job.startedAt || job.startTime)}
                        </td>
                        <td className="px-4 py-3" style={{ color: '#555' }}>
                          {formatDate(job.updatedAt || job.lastUpdated || job.endTime)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Expanded job detail */}
      {selectedJob && jobs && (() => {
        const job = jobs.find(j => (j.id || j.jobId || j._id) === selectedJob);
        if (!job) return null;
        return (
          <div className="bg-white rounded-xl p-5 space-y-4" style={{ border: '2px solid #0129ac' }}>
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold" style={{ color: '#000' }}>Job Detail</h3>
              <button onClick={() => setSelectedJob(null)} className="text-xs" style={{ color: '#0129ac' }}>Close ✕</button>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
              {Object.entries(job)
                .filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object')
                .map(([key, value]) => (
                  <div key={key}>
                    <p className="font-semibold mb-0.5" style={{ color: '#555' }}>{key}</p>
                    <p className="font-mono break-all" style={{ color: '#000' }}>{String(value)}</p>
                  </div>
                ))}
            </div>
            {/* Nested objects */}
            {Object.entries(job)
              .filter(([, v]) => v !== null && typeof v === 'object' && !Array.isArray(v))
              .map(([key, obj]) => (
                <div key={key}>
                  <p className="text-xs font-semibold mb-1" style={{ color: '#555' }}>{key}</p>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs px-3 py-2 rounded" style={{ backgroundColor: '#f0f4ff' }}>
                    {Object.entries(obj).map(([k, v]) => (
                      <div key={k}>
                        <p className="font-medium" style={{ color: '#555' }}>{k}</p>
                        <p className="font-mono break-all" style={{ color: '#000' }}>{String(v ?? '—')}</p>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
          </div>
        );
      })()}

      {loading && jobs === null && (
        <div className="flex justify-center py-12">
          <div className="flex items-center gap-3" style={{ color: '#555' }}>
            <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="#0129ac" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="#0129ac" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <span className="text-sm">Loading migration reports…</span>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, color, bg }) {
  return (
    <div className="rounded-xl p-4 text-center" style={{ backgroundColor: bg, border: `1px solid ${color}22` }}>
      <p className="text-2xl font-black" style={{ color }}>{value}</p>
      <p className="text-xs font-medium mt-1" style={{ color: '#555' }}>{label}</p>
    </div>
  );
}
