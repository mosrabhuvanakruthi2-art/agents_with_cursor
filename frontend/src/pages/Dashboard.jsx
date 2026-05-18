import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { getExecutions } from '../services/api';
import StatusBadge from '../components/StatusBadge';

export default function Dashboard() {
  const [executions, setExecutions] = useState([]);
  const [loading, setLoading]       = useState(true);

  useEffect(() => { loadExecutions(); }, []);

  async function loadExecutions() {
    try {
      const { data } = await getExecutions();
      setExecutions(data);
    } catch { /* API may not be running */ }
    finally { setLoading(false); }
  }

  const total       = executions.length;
  const completed   = executions.filter(e => e.status === 'COMPLETED').length;
  const failed      = executions.filter(e => e.status === 'FAILED').length;
  const running     = executions.filter(e => e.status === 'RUNNING').length;
  const successRate = total > 0 ? Math.round((completed / total) * 100) : 0;
  const recent      = executions.slice(0, 10);

  return (
    <div className="animate-fade-up" style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, color: '#0129ac', letterSpacing: '-0.4px', lineHeight: 1.2 }}>
            Dashboard
          </h1>
          <p style={{ fontSize: 13, color: '#6b7280', marginTop: 5 }}>
            Migration QA Agent System · real-time execution overview
          </p>
        </div>
        <Link to="/run" className="btn btn-primary" style={{ textDecoration: 'none', flexShrink: 0 }}>
          <svg style={{ width: 14, height: 14 }} fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          New Run
        </Link>
      </div>

      {/* ── Stat cards ──────────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 16 }}>
        <StatCard label="Total Executions"  value={total}          accent="#0129ac" cls="blue" />
        <StatCard label="Completed"         value={completed}      accent="#10b981" cls="green" />
        <StatCard label="Success Rate"      value={`${successRate}%`} accent="#f59e0b" cls="amber" />
        <StatCard label="Failed"            value={failed}         accent="#ef4444" cls="red" />
      </div>

      {/* ── Quick-action tiles ──────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14 }}>
        {[
          { to: '/message-agent', label: 'Message Agent',      sub: 'CF browser automation',  bg: '#0129ac', icon: '💬' },
          { to: '/agent-repo',    label: 'Agent Repo',         sub: 'Browse & manage agents',  bg: '#0f6fbd', icon: '📦' },
          { to: '/test-repository', label: 'Test Repository',  sub: 'QA test case library',    bg: '#0c5ea0', icon: '🗂️' },
          { to: '/validation',    label: 'Validation Results', sub: 'Review run outcomes',      bg: '#1143be', icon: '✅' },
        ].map(t => (
          <Link key={t.to} to={t.to} style={{ textDecoration: 'none' }}>
            <div style={{
              background: t.bg,
              borderRadius: 12,
              padding: '16px 18px',
              cursor: 'pointer',
              transition: 'transform 0.15s, box-shadow 0.15s',
              boxShadow: '0 4px 14px rgba(1,41,172,0.2)',
            }}
              onMouseEnter={e => { e.currentTarget.style.transform='translateY(-2px)'; e.currentTarget.style.boxShadow='0 8px 20px rgba(1,41,172,0.3)'; }}
              onMouseLeave={e => { e.currentTarget.style.transform=''; e.currentTarget.style.boxShadow='0 4px 14px rgba(1,41,172,0.2)'; }}
            >
              <div style={{ fontSize: 22, marginBottom: 10 }}>{t.icon}</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>{t.label}</div>
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', marginTop: 3 }}>{t.sub}</div>
            </div>
          </Link>
        ))}
      </div>

      {/* ── Recent executions table ─────────────────────────────────────── */}
      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="card-header">
          <div>
            <div className="card-title">Recent Executions</div>
            <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>Last {recent.length} runs</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {running > 0 && (
              <span className="badge badge-blue">
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#0129ac', animation: 'pulse 1.5s infinite', display: 'inline-block' }} />
                {running} running
              </span>
            )}
            <button onClick={loadExecutions} className="btn btn-ghost" style={{ padding: '6px 12px', fontSize: 12 }}>
              Refresh
            </button>
          </div>
        </div>

        {loading ? (
          <div style={{ padding: 48, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
            <div style={{ marginBottom: 8, fontSize: 24 }}>⏳</div>
            Loading executions…
          </div>
        ) : recent.length === 0 ? (
          <div style={{ padding: 56, textAlign: 'center' }}>
            <div style={{ fontSize: 40, marginBottom: 14 }}>🚀</div>
            <p style={{ fontSize: 15, fontWeight: 600, color: '#0129ac', marginBottom: 6 }}>No executions yet</p>
            <p style={{ fontSize: 13, color: '#9ca3af', marginBottom: 16 }}>Run your first migration to see results here</p>
            <Link to="/run" className="btn btn-primary" style={{ textDecoration: 'none' }}>Start First Run</Link>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Execution ID</th>
                  <th>Source</th>
                  <th>Destination</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {recent.map(exec => (
                  <tr key={exec.executionId}>
                    <td>
                      <Link to={`/logs?id=${exec.executionId}`}
                        style={{ color: '#0129ac', fontFamily: 'monospace', fontSize: 12, fontWeight: 700, textDecoration: 'none' }}>
                        {exec.executionId.slice(0, 8)}…
                      </Link>
                    </td>
                    <td style={{ color: '#3d5296' }}>{exec.context?.sourceEmail || '—'}</td>
                    <td style={{ color: '#3d5296' }}>{exec.context?.destinationEmail || '—'}</td>
                    <td>
                      {exec.context?.migrationType && (
                        <span className="badge badge-blue">{exec.context.migrationType}</span>
                      )}
                    </td>
                    <td><StatusBadge status={exec.status} /></td>
                    <td style={{ color: '#9ca3af', fontSize: 12 }}>
                      {new Date(exec.createdAt).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

    </div>
  );
}

function StatCard({ label, value, accent, cls }) {
  return (
    <div className={`stat-card ${cls}`}>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>
        {label}
      </div>
      <div style={{ fontSize: 32, fontWeight: 800, color: accent, letterSpacing: '-1px' }}>
        {value}
      </div>
    </div>
  );
}
