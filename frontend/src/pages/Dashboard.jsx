import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { getExecutions } from '../services/api';
import StatusBadge from '../components/StatusBadge';

export default function Dashboard() {
  const [executions, setExecutions] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadExecutions();
  }, []);

  async function loadExecutions() {
    try {
      const { data } = await getExecutions();
      setExecutions(data);
    } catch {
      // API may not be running yet
    } finally {
      setLoading(false);
    }
  }

  const stats = {
    total: executions.length,
    completed: executions.filter((e) => e.status === 'COMPLETED').length,
    failed: executions.filter((e) => e.status === 'FAILED').length,
    running: executions.filter((e) => e.status === 'RUNNING').length,
    successRate: executions.length > 0
      ? Math.round((executions.filter((e) => e.status === 'COMPLETED').length / executions.length) * 100)
      : 0,
  };

  const recentExecutions = executions.slice(0, 10);

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: '#0129ac' }}>Dashboard</h1>
          <p className="text-sm mt-1" style={{ color: '#4a65c0' }}>Migration QA Agent System overview</p>
        </div>
        <Link
          to="/run"
          className="px-5 py-2.5 text-white text-sm font-semibold rounded-lg transition-colors"
          style={{ backgroundColor: '#0129ac' }}
          onMouseEnter={e => e.currentTarget.style.backgroundColor = '#011e8a'}
          onMouseLeave={e => e.currentTarget.style.backgroundColor = '#0129ac'}
        >
          New Run
        </Link>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
        <StatCard label="Total Executions" value={stats.total} variant="solid" />
        <StatCard label="Success Rate" value={`${stats.successRate}%`} variant="light" />
        <StatCard label="Failed" value={stats.failed} variant="dark" />
        <StatCard label="Running" value={stats.running} variant="outline" />
      </div>

      <div className="bg-white rounded-xl overflow-hidden" style={{ border: '1px solid #c5cef5' }}>
        <div className="px-6 py-4" style={{ borderBottom: '1px solid #eef1fb' }}>
          <h2 className="text-sm font-semibold" style={{ color: '#0129ac' }}>Recent Executions</h2>
        </div>
        {loading ? (
          <div className="p-8 text-center text-sm" style={{ color: '#7a8fd4' }}>Loading...</div>
        ) : recentExecutions.length === 0 ? (
          <div className="p-8 text-center">
            <p className="text-sm" style={{ color: '#4a65c0' }}>No executions yet.</p>
            <Link to="/run" className="text-sm font-medium mt-1 inline-block" style={{ color: '#0129ac' }}>
              Start your first run
            </Link>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ backgroundColor: '#eef1fb' }}>
                  <th className="px-6 py-3 text-left text-xs font-medium uppercase" style={{ color: '#4a65c0' }}>Execution ID</th>
                  <th className="px-6 py-3 text-left text-xs font-medium uppercase" style={{ color: '#4a65c0' }}>Source</th>
                  <th className="px-6 py-3 text-left text-xs font-medium uppercase" style={{ color: '#4a65c0' }}>Destination</th>
                  <th className="px-6 py-3 text-left text-xs font-medium uppercase" style={{ color: '#4a65c0' }}>Type</th>
                  <th className="px-6 py-3 text-left text-xs font-medium uppercase" style={{ color: '#4a65c0' }}>Status</th>
                  <th className="px-6 py-3 text-left text-xs font-medium uppercase" style={{ color: '#4a65c0' }}>Created</th>
                </tr>
              </thead>
              <tbody>
                {recentExecutions.map((exec) => (
                  <tr key={exec.executionId} className="border-t" style={{ borderColor: '#eef1fb' }}>
                    <td className="px-6 py-3 font-mono text-xs">
                      <Link to={`/logs?id=${exec.executionId}`} style={{ color: '#0129ac' }}>
                        {exec.executionId.slice(0, 8)}...
                      </Link>
                    </td>
                    <td className="px-6 py-3" style={{ color: '#2a40a8' }}>{exec.context?.sourceEmail}</td>
                    <td className="px-6 py-3" style={{ color: '#2a40a8' }}>{exec.context?.destinationEmail}</td>
                    <td className="px-6 py-3" style={{ color: '#2a40a8' }}>{exec.context?.migrationType}</td>
                    <td className="px-6 py-3"><StatusBadge status={exec.status} /></td>
                    <td className="px-6 py-3 text-xs" style={{ color: '#7a8fd4' }}>{new Date(exec.createdAt).toLocaleString()}</td>
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

function StatCard({ label, value, variant }) {
  const styles = {
    solid:   { bg: '#0129ac', text: '#ffffff', border: '#0129ac' },
    light:   { bg: '#eef1fb', text: '#0129ac', border: '#c5cef5' },
    dark:    { bg: '#011e8a', text: '#ffffff', border: '#011e8a' },
    outline: { bg: '#ffffff', text: '#0129ac', border: '#0129ac' },
  };
  const s = styles[variant] || styles.light;

  return (
    <div
      className="rounded-xl border p-5"
      style={{ backgroundColor: s.bg, color: s.text, borderColor: s.border }}
    >
      <p className="text-xs font-medium uppercase tracking-wider opacity-75">{label}</p>
      <p className="text-3xl font-bold mt-2">{value}</p>
    </div>
  );
}
