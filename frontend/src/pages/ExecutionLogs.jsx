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
        <h1 className="text-2xl font-bold" style={{ color: '#0129ac' }}>Execution Logs</h1>
        <p className="text-sm mt-1" style={{ color: '#4a65c0' }}>View detailed logs for each agent execution</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1">
          <div className="bg-white rounded-xl overflow-hidden" style={{ border: '1px solid #c5cef5' }}>
            <div className="px-4 py-3" style={{ borderBottom: '1px solid #eef1fb' }}>
              <h2 className="text-sm font-semibold" style={{ color: '#0129ac' }}>Executions</h2>
            </div>
            {loading ? (
              <div className="p-4 text-sm" style={{ color: '#7a8fd4' }}>Loading...</div>
            ) : executions.length === 0 ? (
              <div className="p-4 text-sm" style={{ color: '#4a65c0' }}>No executions found</div>
            ) : (
              <div className="max-h-[600px] overflow-y-auto">
                {executions.map((exec) => (
                  <button
                    key={exec.executionId}
                    onClick={() => setSelectedId(exec.executionId)}
                    className="w-full text-left px-4 py-3 transition-colors border-t"
                    style={{
                      borderColor: '#eef1fb',
                      backgroundColor: selectedId === exec.executionId ? '#eef1fb' : 'transparent',
                      borderLeft: selectedId === exec.executionId ? '3px solid #0129ac' : '3px solid transparent',
                    }}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-xs" style={{ color: '#2a40a8' }}>{exec.executionId.slice(0, 8)}...</span>
                      <StatusBadge status={exec.status} />
                    </div>
                    <p className="text-xs mt-1" style={{ color: '#7a8fd4' }}>{new Date(exec.createdAt).toLocaleString()}</p>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="lg:col-span-2 space-y-4">
          {selectedExec && (
            <div className="bg-white rounded-xl p-4" style={{ border: '1px solid #c5cef5' }}>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium" style={{ color: '#0129ac' }}>
                    {selectedExec.context?.sourceEmail} → {selectedExec.context?.destinationEmail}
                  </p>
                  <p className="text-xs mt-0.5" style={{ color: '#7a8fd4' }}>
                    {selectedExec.context?.migrationType} | {new Date(selectedExec.createdAt).toLocaleString()}
                  </p>
                </div>
                <StatusBadge status={selectedExec.status} />
              </div>
              {selectedExec.currentAgent && (
                <p className="text-xs mt-2" style={{ color: '#0129ac' }}>
                  <span className="font-medium">Agent:</span> {selectedExec.currentAgent}
                </p>
              )}
              {selectedExec.progress && (
                <p className="text-xs mt-1" style={{ color: '#2a40a8' }}>{selectedExec.progress}</p>
              )}
            </div>
          )}

          {logsLoading ? (
            <div className="rounded-xl p-6 text-sm" style={{ backgroundColor: '#0129ac', color: 'rgba(255,255,255,0.6)' }}>Loading logs...</div>
          ) : (
            <LogViewer logs={logs} />
          )}
        </div>
      </div>
    </div>
  );
}
