import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { getExecutions, getExecutionLogs } from '../services/api';
import StatusBadge from '../components/StatusBadge';
import LogViewer from '../components/LogViewer';
import MigrationReports from './MigrationReports';

export default function ExecutionLogs() {
  const [searchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState('logs');
  const [executions, setExecutions] = useState([]);
  const [selectedId, setSelectedId] = useState(searchParams.get('id') || '');
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [logsLoading, setLogsLoading] = useState(false);

  const selectedExec = executions.find((e) => e.executionId === selectedId);

  useEffect(() => { loadExecutions(); }, []);
  useEffect(() => { if (selectedId) loadLogs(selectedId); }, [selectedId]);
  useEffect(() => {
    if (!selectedExec || selectedExec.status !== 'RUNNING') return undefined;
    const t = setInterval(() => { loadExecutions(); if (selectedId) loadLogs(selectedId); }, 3000);
    return () => clearInterval(t);
  }, [selectedExec?.status, selectedId]);

  async function loadExecutions() {
    try {
      const { data } = await getExecutions();
      setExecutions(data);
      if (!selectedId && data.length > 0) setSelectedId(data[0].executionId);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }

  async function loadLogs(id) {
    setLogsLoading(true);
    try {
      const { data } = await getExecutionLogs(id);
      setLogs(data.logs || []);
    } catch { setLogs([]); }
    finally { setLogsLoading(false); }
  }

  return (
    <div className="page-wrap">
      <div className="page-header">
        <div>
          <h1 className="page-title">Execution Logs</h1>
          <p className="page-subtitle">View detailed logs for each agent execution</p>
        </div>
        <div style={{ display: 'flex', borderRadius: 10, overflow: 'hidden', border: '2px solid #0129ac' }}>
          {[
            { key: 'logs',    label: 'Execution Logs' },
            { key: 'reports', label: 'CF Migration Reports' },
          ].map((tab) => (
            <button key={tab.key} onClick={() => setActiveTab(tab.key)}
              style={{
                padding: '10px 20px', fontSize: 14, fontWeight: 600, border: 'none', cursor: 'pointer', transition: 'all 0.14s',
                backgroundColor: activeTab === tab.key ? '#0129ac' : '#fff',
                color: activeTab === tab.key ? '#fff' : '#0129ac',
              }}>
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {activeTab === 'reports' && <MigrationReports />}

      {activeTab === 'logs' && (
        <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: 24 }}>
          {/* Left: execution list */}
          <div className="card" style={{ overflow: 'hidden', alignSelf: 'start' }}>
            <div className="card-header"><div className="card-title">Executions</div></div>
            {loading ? (
              <div style={{ padding: '20px 24px', fontSize: 14, color: '#9ca3af' }}>Loading…</div>
            ) : executions.length === 0 ? (
              <div style={{ padding: '24px', fontSize: 14, color: '#6b7280', textAlign: 'center' }}>No executions found</div>
            ) : (
              <div style={{ maxHeight: 600, overflowY: 'auto' }}>
                {executions.map((exec) => (
                  <button key={exec.executionId} onClick={() => setSelectedId(exec.executionId)}
                    style={{
                      width: '100%', textAlign: 'left', padding: '14px 20px', border: 'none', cursor: 'pointer', transition: 'background 0.12s',
                      borderBottom: '1px solid #eef1fb',
                      backgroundColor: selectedId === exec.executionId ? '#eef1fd' : 'transparent',
                      borderLeft: selectedId === exec.executionId ? '4px solid #0129ac' : '4px solid transparent',
                    }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                      <span style={{ fontFamily: 'monospace', fontSize: 13, fontWeight: 700, color: '#0129ac' }}>{exec.executionId.slice(0, 8)}…</span>
                      <StatusBadge status={exec.status} />
                    </div>
                    <p style={{ fontSize: 12, color: '#9ca3af' }}>{new Date(exec.createdAt).toLocaleString()}</p>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Right: log detail */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {selectedExec && (
              <div className="card">
                <div className="card-body" style={{ padding: '20px 24px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                    <p style={{ fontSize: 15, fontWeight: 700, color: '#0129ac' }}>
                      {selectedExec.context?.sourceEmail} → {selectedExec.context?.destinationEmail}
                    </p>
                    <StatusBadge status={selectedExec.status} />
                  </div>
                  <p style={{ fontSize: 13, color: '#9ca3af' }}>
                    {selectedExec.context?.migrationType} | {new Date(selectedExec.createdAt).toLocaleString()}
                  </p>
                  {selectedExec.currentAgent && (
                    <p style={{ fontSize: 13, color: '#0129ac', marginTop: 10 }}>
                      <span style={{ fontWeight: 700 }}>Agent:</span> {selectedExec.currentAgent}
                    </p>
                  )}
                  {selectedExec.progress && (
                    <p style={{ fontSize: 13, color: '#3d5296', marginTop: 4 }}>{selectedExec.progress}</p>
                  )}
                </div>
              </div>
            )}

            {logsLoading ? (
              <div className="card">
                <div className="card-body" style={{ padding: '24px', textAlign: 'center', fontSize: 14, color: '#9ca3af' }}>
                  Loading logs…
                </div>
              </div>
            ) : (
              <LogViewer logs={logs} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
