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
          <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
          <p className="text-sm text-gray-500 mt-1">Migration QA Agent System overview</p>
        </div>
        <Link
          to="/run"
          className="px-5 py-2.5 bg-indigo-600 text-white text-sm font-semibold rounded-lg hover:bg-indigo-700 transition-colors"
        >
          New Run
        </Link>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
        <StatCard label="Total Executions" value={stats.total} color="indigo" />
        <StatCard label="Success Rate" value={`${stats.successRate}%`} color="green" />
        <StatCard label="Failed" value={stats.failed} color="red" />
        <StatCard label="Running" value={stats.running} color="yellow" />
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-900">Recent Executions</h2>
        </div>
        {loading ? (
          <div className="p-8 text-center text-sm text-gray-400">Loading...</div>
        ) : recentExecutions.length === 0 ? (
          <div className="p-8 text-center">
            <p className="text-sm text-gray-500">No executions yet.</p>
            <Link to="/run" className="text-sm text-indigo-600 hover:text-indigo-700 font-medium mt-1 inline-block">
              Start your first run
            </Link>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50">
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Execution ID</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Source</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Destination</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Type</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {recentExecutions.map((exec) => (
                  <tr key={exec.executionId} className="hover:bg-gray-50">
                    <td className="px-6 py-3 font-mono text-xs text-gray-600">
                      <Link to={`/logs?id=${exec.executionId}`} className="text-indigo-600 hover:text-indigo-700">
                        {exec.executionId.slice(0, 8)}...
                      </Link>
                    </td>
                    <td className="px-6 py-3 text-gray-700">{exec.context?.sourceEmail}</td>
                    <td className="px-6 py-3 text-gray-700">{exec.context?.destinationEmail}</td>
                    <td className="px-6 py-3 text-gray-700">{exec.context?.migrationType}</td>
                    <td className="px-6 py-3"><StatusBadge status={exec.status} /></td>
                    <td className="px-6 py-3 text-gray-500 text-xs">{new Date(exec.createdAt).toLocaleString()}</td>
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

function StatCard({ label, value, color }) {
  const colorMap = {
    indigo: 'bg-indigo-50 text-indigo-700 border-indigo-100',
    green: 'bg-green-50 text-green-700 border-green-100',
    red: 'bg-red-50 text-red-700 border-red-100',
    yellow: 'bg-yellow-50 text-yellow-700 border-yellow-100',
  };

  return (
    <div className={`rounded-xl border p-5 ${colorMap[color]}`}>
      <p className="text-xs font-medium opacity-75 uppercase tracking-wider">{label}</p>
      <p className="text-3xl font-bold mt-2">{value}</p>
    </div>
  );
}
