import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { getExecutions, getExecutionLogs } from '../services/api';
import StatusBadge from '../components/StatusBadge';
import LogViewer from '../components/LogViewer';

export default function ExecutionLogs() {
  const [searchParams] = useSearchParams();
  const [executions, setExecutions] = useState([]);
  const [selectedId, setSelectedId] = useState(searchParams.get('id') || '');
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [logsLoading, setLogsLoading] = useState(false);

  const selectedExec = executions.find((e) => e.executionId === selectedId);

  useEffect(() => {
    loadExecutions();
  }, []);

  useEffect(() => {
    if (selectedId) loadLogs(selectedId);
  }, [selectedId]);

  useEffect(() => {
    if (!selectedExec || selectedExec.status !== 'RUNNING') return undefined;
    const t = setInterval(() => {
      loadExecutions();
      if (selectedId) loadLogs(selectedId);
    }, 3000);
    return () => clearInterval(t);
  }, [selectedExec?.status, selectedId]);

  async function loadExecutions() {
    try {
      const { data } = await getExecutions();
      setExecutions(data);
      if (!selectedId && data.length > 0) {
        setSelectedId(data[0].executionId);
      }
    } catch {
      // API may not be running
    } finally {
      setLoading(false);
    }
  }

  async function loadLogs(id) {
    setLogsLoading(true);
    try {
      const { data } = await getExecutionLogs(id);
      setLogs(data.logs || []);
    } catch {
      setLogs([]);
    } finally {
      setLogsLoading(false);
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Execution Logs</h1>
        <p className="text-sm text-gray-500 mt-1">View detailed logs for each agent execution</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1">
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100">
              <h2 className="text-sm font-semibold text-gray-900">Executions</h2>
            </div>
            {loading ? (
              <div className="p-4 text-sm text-gray-400">Loading...</div>
            ) : executions.length === 0 ? (
              <div className="p-4 text-sm text-gray-500">No executions found</div>
            ) : (
              <div className="divide-y divide-gray-100 max-h-[600px] overflow-y-auto">
                {executions.map((exec) => (
                  <button
                    key={exec.executionId}
                    onClick={() => setSelectedId(exec.executionId)}
                    className={`w-full text-left px-4 py-3 hover:bg-gray-50 transition-colors ${
                      selectedId === exec.executionId ? 'bg-indigo-50 border-l-2 border-indigo-500' : ''
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-xs text-gray-600">{exec.executionId.slice(0, 8)}...</span>
                      <StatusBadge status={exec.status} />
                    </div>
                    <p className="text-xs text-gray-400 mt-1">{new Date(exec.createdAt).toLocaleString()}</p>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="lg:col-span-2 space-y-4">
          {selectedExec && (
            <div className="bg-white rounded-xl border border-gray-200 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-900">
                    {selectedExec.context?.sourceEmail} → {selectedExec.context?.destinationEmail}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {selectedExec.context?.migrationType} | {new Date(selectedExec.createdAt).toLocaleString()}
                  </p>
                </div>
                <StatusBadge status={selectedExec.status} />
              </div>
              {selectedExec.currentAgent && (
                <p className="text-xs text-indigo-700 mt-2">
                  <span className="font-medium">Agent:</span> {selectedExec.currentAgent}
                </p>
              )}
              {selectedExec.progress && (
                <p className="text-xs text-gray-600 mt-1">{selectedExec.progress}</p>
              )}
            </div>
          )}

          {logsLoading ? (
            <div className="bg-gray-900 rounded-xl p-6 text-gray-400 text-sm">Loading logs...</div>
          ) : (
            <LogViewer logs={logs} />
          )}
        </div>
      </div>
    </div>
  );
}
