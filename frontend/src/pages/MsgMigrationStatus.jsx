import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { getCFReports, closeCFChatMigration, validateCFChatMigration } from '../services/api';

const COMBINATION_LABELS = {
  S2T: 'Slack → Teams',
  S2C: 'Slack → Google Chat',
  T2T: 'Teams → Teams',
  C2T: 'Google Chat → Teams',
  S2S: 'Slack → Slack',
};

const STATUS_COLORS = {
  completed:           { bg: '#dcfce7', color: '#15803d' },
  'in progress':       { bg: '#dbeafe', color: '#1d4ed8' },
  'partially completed': { bg: '#fef9c3', color: '#a16207' },
  failed:              { bg: '#fee2e2', color: '#dc2626' },
};

function getStatusStyle(status) {
  const key = (status || '').toLowerCase();
  return STATUS_COLORS[key] || { bg: '#f1f5f9', color: '#475569' };
}

export default function MsgMigrationStatus() {
  const navigate = useNavigate();
  const [combination, setCombination] = useState('S2T');
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(new Set());
  const [closing, setClosing] = useState(false);
  const [closeResult, setCloseResult] = useState(null);
  const [validating, setValidating] = useState(false);
  const [validateResult, setValidateResult] = useState(null);
  const [fetchedAt, setFetchedAt] = useState(null);

  const fetchJobs = useCallback(async () => {
    setLoading(true);
    setError('');
    setSelected(new Set());
    setCloseResult(null);
    setValidateResult(null);
    try {
      const { data } = await getCFReports({ combination, migrationStatus: 'All' });
      setJobs(Array.isArray(data.jobs) ? data.jobs : []);
      setFetchedAt(new Date().toLocaleTimeString());
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to fetch migration reports');
      setJobs([]);
    } finally {
      setLoading(false);
    }
  }, [combination]);

  useEffect(() => { fetchJobs(); }, [fetchJobs]);

  function toggleJob(id) {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleAll(checked) {
    setSelected(checked ? new Set(jobs.map(j => String(j.id))) : new Set());
  }

  async function handleCloseTeams() {
    const ids = Array.from(selected);
    if (!ids.length) return;
    if (!window.confirm(`Close ${ids.length} selected migration job(s)? This will archive the destination Teams groups.`)) return;
    setClosing(true);
    setCloseResult(null);
    try {
      const { data } = await closeCFChatMigration(ids);
      setCloseResult({ success: true, msg: `Successfully closed ${data.closed} job(s).` });
      fetchJobs();
    } catch (err) {
      setCloseResult({ success: false, msg: err.response?.data?.error || err.message });
    } finally {
      setClosing(false);
    }
  }

  async function handleValidate() {
    setValidating(true);
    setValidateResult(null);
    try {
      const { data } = await validateCFChatMigration({ combination });
      setValidateResult({ success: true, ...data });
    } catch (err) {
      setValidateResult({ success: false, msg: err.response?.data?.error || err.message });
    } finally {
      setValidating(false);
    }
  }

  const totalMessages    = jobs.reduce((s, j) => s + (Number(j.totalMessages) || 0), 0);
  const processedMessages = jobs.reduce((s, j) => s + (Number(j.processedMessages) || 0), 0);
  const completedJobs    = jobs.filter(j => (j.migrationStatus || '').toLowerCase() === 'completed').length;
  const inProgressJobs   = jobs.filter(j => (j.migrationStatus || '').toLowerCase().includes('progress')).length;

  return (
    <div className="page-wrap">
      {/* ── Header ── */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Msg Migration Status</h1>
          <p className="page-subtitle">Review CloudFuze migration jobs — close Teams and validate after migration completes</p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <select
            value={combination}
            onChange={e => setCombination(e.target.value)}
            style={{ border: '2px solid #0129ac', color: '#0129ac', padding: '9px 14px', fontSize: 13, fontWeight: 700, borderRadius: 8, backgroundColor: '#fff', outline: 'none', cursor: 'pointer' }}
          >
            {Object.entries(COMBINATION_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
          <button
            onClick={fetchJobs} disabled={loading}
            style={{ padding: '9px 18px', borderRadius: 8, fontSize: 13, fontWeight: 700, border: '2px solid #0129ac', color: '#0129ac', backgroundColor: '#fff', cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.5 : 1 }}
          >
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* ── Error ── */}
      {error && (
        <div style={{ borderRadius: 10, padding: '12px 16px', backgroundColor: '#fee2e2', border: '1px solid #fca5a5', color: '#991b1b', fontSize: 13 }}>
          <strong>Error:</strong> {error}
        </div>
      )}

      {/* ── Close / Validate result banners ── */}
      {closeResult && (
        <div style={{ borderRadius: 10, padding: '12px 16px', backgroundColor: closeResult.success ? '#dcfce7' : '#fee2e2', border: `1px solid ${closeResult.success ? '#86efac' : '#fca5a5'}`, color: closeResult.success ? '#15803d' : '#991b1b', fontSize: 13 }}>
          {closeResult.msg}
        </div>
      )}
      {validateResult && (
        <div style={{ borderRadius: 10, padding: '14px 18px', backgroundColor: validateResult.success ? '#eef1fb' : '#fee2e2', border: `1px solid ${validateResult.success ? '#c5cef5' : '#fca5a5'}`, color: validateResult.success ? '#0129ac' : '#991b1b', fontSize: 13 }}>
          {validateResult.success ? (
            <div>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>
                Validation complete —{' '}
                <span style={{ color: validateResult.overallStatus === 'MATCHED' ? '#15803d' : '#dc2626', fontWeight: 800 }}>
                  {validateResult.overallStatus}
                </span>
              </div>
              <div style={{ fontSize: 12, color: '#4a65c0' }}>
                {validateResult.summary?.completedJobs} / {validateResult.summary?.totalJobs} jobs completed •{' '}
                {validateResult.summary?.processedMessages?.toLocaleString()} / {validateResult.summary?.totalMessages?.toLocaleString()} messages migrated •{' '}
                {validateResult.summary?.mismatches} mismatch(es)
              </div>
              <button
                onClick={() => navigate('/validation')}
                style={{ marginTop: 10, padding: '7px 16px', borderRadius: 7, fontSize: 12, fontWeight: 700, backgroundColor: '#0129ac', color: '#fff', border: 'none', cursor: 'pointer' }}
              >
                View in Validation Results →
              </button>
            </div>
          ) : (
            <span><strong>Validation failed:</strong> {validateResult.msg}</span>
          )}
        </div>
      )}

      {/* ── Stats ── */}
      {!loading && jobs.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }}>
          <StatCard num={jobs.length} label="Total Jobs" blue />
          <StatCard num={completedJobs} label="Completed" green />
          <StatCard num={inProgressJobs} label="In Progress" yellow />
          <StatCard num={`${processedMessages.toLocaleString()} / ${totalMessages.toLocaleString()}`} label="Messages Migrated" />
        </div>
      )}

      {/* ── Action buttons ── */}
      {!loading && jobs.length > 0 && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          {selected.size > 0 && (
            <button
              onClick={handleCloseTeams} disabled={closing}
              style={{ padding: '9px 20px', borderRadius: 8, fontSize: 13, fontWeight: 700, backgroundColor: '#dc2626', color: '#fff', border: 'none', cursor: closing ? 'not-allowed' : 'pointer', opacity: closing ? 0.6 : 1, display: 'flex', alignItems: 'center', gap: 7 }}
            >
              {closing ? 'Closing…' : `Close Teams (${selected.size})`}
            </button>
          )}
          <button
            onClick={handleValidate} disabled={validating || loading}
            style={{ padding: '9px 20px', borderRadius: 8, fontSize: 13, fontWeight: 700, backgroundColor: '#0129ac', color: '#fff', border: 'none', cursor: (validating || loading) ? 'not-allowed' : 'pointer', opacity: (validating || loading) ? 0.6 : 1, display: 'flex', alignItems: 'center', gap: 7 }}
          >
            {validating ? 'Validating…' : 'Validate & Store Results'}
          </button>
          <span style={{ fontSize: 12, color: '#9ca3af', marginLeft: 'auto' }}>
            {fetchedAt && `Updated ${fetchedAt}`} • {jobs.length} total job(s)
          </span>
        </div>
      )}

      {/* ── Jobs table ── */}
      <div className="card" style={{ overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: '48px', textAlign: 'center', color: '#7a8fd4', fontSize: 14 }}>
            <div style={{ width: 28, height: 28, borderRadius: '50%', border: '3px solid #c5cef5', borderTopColor: '#0129ac', animation: 'spin 0.8s linear infinite', margin: '0 auto 12px' }} />
            Loading migration jobs…
          </div>
        ) : jobs.length === 0 ? (
          <div style={{ padding: '48px', textAlign: 'center', color: '#7a8fd4', fontSize: 14 }}>
            No migration jobs found for {COMBINATION_LABELS[combination] || combination}.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ backgroundColor: '#0129ac', color: '#fff' }}>
                  <th style={{ width: 40, padding: '10px 12px', textAlign: 'center' }}>
                    <input
                      type="checkbox"
                      style={{ accentColor: '#fff' }}
                      checked={jobs.length > 0 && selected.size === jobs.length}
                      onChange={e => toggleAll(e.target.checked)}
                    />
                  </th>
                  {['Team Name', 'Total Ch.', 'Total Msgs', 'Processed', 'In-Progress', 'Migration Status', 'Team Status', 'Initiated On'].map(h => (
                    <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {jobs.map((job, i) => {
                  const id = String(job.id ?? i);
                  const sel = selected.has(id);
                  const ss = getStatusStyle(job.migrationStatus);
                  const ts = getStatusStyle(job.teamStatus);
                  const total = Number(job.totalMessages) || 0;
                  const processed = Number(job.processedMessages) || 0;
                  const pct = total > 0 ? Math.round((processed / total) * 100) : 0;
                  return (
                    <tr key={id} style={{ borderTop: '1px solid #eef1fb', backgroundColor: sel ? '#eef1fb' : 'transparent' }}>
                      <td style={{ padding: '9px 12px', textAlign: 'center' }}>
                        <input type="checkbox" style={{ accentColor: '#0129ac' }} checked={sel} onChange={() => toggleJob(id)} />
                      </td>
                      <td style={{ padding: '9px 14px', fontWeight: 600, color: '#0129ac', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {job.teamName || id}
                      </td>
                      <td style={{ padding: '9px 14px', color: '#374151' }}>{job.totalChannels ?? '—'}</td>
                      <td style={{ padding: '9px 14px', color: '#374151' }}>{total.toLocaleString()}</td>
                      <td style={{ padding: '9px 14px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ color: processed === total && total > 0 ? '#15803d' : '#0129ac', fontWeight: 600 }}>
                            {processed.toLocaleString()}
                          </span>
                          {total > 0 && (
                            <span style={{ fontSize: 11, color: '#9ca3af' }}>({pct}%)</span>
                          )}
                        </div>
                      </td>
                      <td style={{ padding: '9px 14px', color: '#374151' }}>{(job.inProgressMessages ?? 0).toLocaleString()}</td>
                      <td style={{ padding: '9px 14px' }}>
                        <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 99, backgroundColor: ss.bg, color: ss.color }}>
                          {job.migrationStatus || '—'}
                        </span>
                      </td>
                      <td style={{ padding: '9px 14px' }}>
                        <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 99, backgroundColor: ts.bg, color: ts.color }}>
                          {job.teamStatus || '—'}
                        </span>
                      </td>
                      <td style={{ padding: '9px 14px', color: '#6b7280', fontSize: 12, whiteSpace: 'nowrap' }}>
                        {job.initiatedOn || '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div style={{ padding: '10px 16px', borderTop: '1px solid #eef1fb', fontSize: 12, color: '#9ca3af', display: 'flex', justifyContent: 'space-between' }}>
              <span>Total Jobs: {jobs.length}</span>
              <span>{processedMessages.toLocaleString()} / {totalMessages.toLocaleString()} messages processed</span>
            </div>
          </div>
        )}
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function StatCard({ num, label, blue, green, yellow }) {
  const bg  = blue ? '#0129ac' : green ? '#15803d' : yellow ? '#a16207' : '#eef1fb';
  const col = (blue || green || yellow) ? '#fff' : '#0129ac';
  return (
    <div style={{ borderRadius: 12, padding: '16px 20px', backgroundColor: bg, textAlign: 'center' }}>
      <div style={{ fontSize: 28, fontWeight: 900, color: col }}>{num}</div>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: col, opacity: 0.85, marginTop: 4 }}>{label}</div>
    </div>
  );
}
