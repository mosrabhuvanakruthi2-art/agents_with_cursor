import { useState, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { getExecutions, getExecutionLogs } from '../services/api';
import StatusBadge from '../components/StatusBadge';
import LogViewer from '../components/LogViewer';
import { inferMessageLogPlatform, PLATFORM_FILTERS } from '../utils/messageLogPlatform';

export default function ExecutionLogs() {
  const [searchParams] = useSearchParams();
  const [executions, setExecutions] = useState([]);
  const [selectedId, setSelectedId] = useState(searchParams.get('id') || '');
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [logsLoading, setLogsLoading] = useState(false);
  const [platformFilter, setPlatformFilter] = useState('all');

  const filteredExecutions = useMemo(() => {
    if (platformFilter === 'all') return executions;
    return executions.filter((e) => inferMessageLogPlatform(e.context) === platformFilter);
  }, [executions, platformFilter]);

  const selectedExec = useMemo(() => {
    const byId = (list, id) => list.find((e) => e.executionId === id);
    const inFiltered = byId(filteredExecutions, selectedId);
    if (inFiltered) return inFiltered;
    if (platformFilter === 'all') return byId(executions, selectedId);
    return null;
  }, [filteredExecutions, executions, selectedId, platformFilter]);

  useEffect(() => {
    loadExecutions();
  }, []);

  useEffect(() => {
    if (!selectedId || !selectedExec) {
      setLogs([]);
      return;
    }
    loadLogs(selectedId);
  }, [selectedId, selectedExec?.executionId]);

  useEffect(() => {
    if (!selectedExec || selectedExec.status !== 'RUNNING') return undefined;
    const t = setInterval(() => {
      loadExecutions();
      if (selectedId) loadLogs(selectedId);
    }, 3000);
    return () => clearInterval(t);
  }, [selectedExec?.status, selectedId]);

  useEffect(() => {
    if (filteredExecutions.length === 0) return;
    const stillThere = filteredExecutions.some((e) => e.executionId === selectedId);
    if (!stillThere) {
      setSelectedId(filteredExecutions[0].executionId);
    }
  }, [filteredExecutions, selectedId]);

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

      <div className="space-y-4">
        <div>
          <p className="text-sm font-medium mb-3" style={{ color: '#0129ac' }}>Filter by platform</p>
          <div className="flex flex-wrap gap-2 mb-4">
            {PLATFORM_FILTERS.map((p) => (
              <button
                key={p.id}
                type="button"
                title={p.description}
                onClick={() => setPlatformFilter(p.id)}
                className="px-4 py-2 rounded-lg text-xs font-semibold transition-all"
                style={{
                  border:
                    platformFilter === p.id ? '2px solid #0129ac' : '1px solid #c5cef5',
                  backgroundColor: platformFilter === p.id ? '#eef1fb' : '#fff',
                  color: '#0129ac',
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
          <p className="text-xs mb-4" style={{ color: '#4a65c0' }}>
            Slack / Teams / Google Chat use the same execution log files as Mail runs — filter narrows the list by <strong>message migration</strong> source (from your combo). Mail runs include Gmail agent flows.
          </p>
          <p className="text-sm font-medium mb-2" style={{ color: '#0129ac' }}>Message platforms (same style as CloudFuze clouds)</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-4xl">
            <PlatformLogTile
              active={platformFilter === 'slack'}
              onClick={() => setPlatformFilter('slack')}
              name="Slack"
              bg="#faf5fb"
              border="#e8d4ec"
            >
              <SlackMark className="w-14 h-14" />
            </PlatformLogTile>
            <PlatformLogTile
              active={platformFilter === 'teams'}
              onClick={() => setPlatformFilter('teams')}
              name="Microsoft Teams"
              bg="#f4f4fb"
              border="#d6d8f5"
            >
              <TeamsMark className="w-14 h-14" />
            </PlatformLogTile>
            <PlatformLogTile
              active={platformFilter === 'googleChat'}
              onClick={() => setPlatformFilter('googleChat')}
              name="Google Chat"
              bg="#e8f7ec"
              border="#b8e0c8"
            >
              <GoogleChatMark className="w-14 h-14" />
            </PlatformLogTile>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1">
          <div className="bg-white rounded-xl overflow-hidden" style={{ border: '1px solid #c5cef5' }}>
            <div className="px-4 py-3" style={{ borderBottom: '1px solid #eef1fb' }}>
              <h2 className="text-sm font-semibold" style={{ color: '#0129ac' }}>Executions</h2>
              <p className="text-xs mt-0.5" style={{ color: '#7a8fd4' }}>
                {filteredExecutions.length} run{filteredExecutions.length !== 1 ? 's' : ''} in this filter
              </p>
            </div>
            {loading ? (
              <div className="p-4 text-sm" style={{ color: '#7a8fd4' }}>Loading...</div>
            ) : filteredExecutions.length === 0 ? (
              <div className="p-4 text-sm" style={{ color: '#4a65c0' }}>
                {executions.length === 0 ? 'No executions found' : 'No runs for this platform — try All or another tile.'}
              </div>
            ) : (
              <div className="max-h-[600px] overflow-y-auto">
                {filteredExecutions.map((exec) => {
                  const plat = inferMessageLogPlatform(exec.context);
                  return (
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
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <span className="font-mono text-xs" style={{ color: '#2a40a8' }}>{exec.executionId.slice(0, 8)}...</span>
                      <div className="flex items-center gap-2">
                        <PlatformBadge platform={plat} />
                        <StatusBadge status={exec.status} />
                      </div>
                    </div>
                    <p className="text-xs mt-1" style={{ color: '#7a8fd4' }}>{new Date(exec.createdAt).toLocaleString()}</p>
                  </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className="lg:col-span-2 space-y-4">
          {platformFilter !== 'all' && !selectedExec && !loading && (
            <div className="rounded-xl p-4 text-sm" style={{ backgroundColor: '#eef1fb', border: '1px solid #c5cef5', color: '#2a40a8' }}>
              No execution selected for this filter. Choose <strong>All</strong> or pick another platform tile.
            </div>
          )}
          {selectedExec && (
            <div className="bg-white rounded-xl p-4" style={{ border: '1px solid #c5cef5' }}>
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div>
                  <p className="text-sm font-medium" style={{ color: '#0129ac' }}>
                    {selectedExec.context?.sourceEmail} → {selectedExec.context?.destinationEmail}
                  </p>
                  <p className="text-xs mt-0.5" style={{ color: '#7a8fd4' }}>
                    {selectedExec.context?.migrationType} | {new Date(selectedExec.createdAt).toLocaleString()}
                    {selectedExec.context?.productType === 'Message' && selectedExec.context?.messageCombination && (
                      <span> · {selectedExec.context.messageCombination}</span>
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <PlatformBadge platform={inferMessageLogPlatform(selectedExec.context)} />
                  <StatusBadge status={selectedExec.status} />
                </div>
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

function PlatformLogTile({ children, name, active, onClick, bg, border }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col items-center justify-center gap-3 rounded-2xl p-8 transition-all min-h-[180px]"
      style={{
        backgroundColor: active ? '#eef1fb' : bg,
        border: active ? '2px solid #0129ac' : `1px solid ${border}`,
        boxShadow: active ? '0 0 0 1px #0129ac22' : '0 1px 3px rgba(1,41,172,0.08)',
      }}
    >
      {children}
      <span className="text-sm font-semibold text-center" style={{ color: '#0129ac' }}>
        {name}
      </span>
      <span className="text-[11px] text-center" style={{ color: '#7a8fd4' }}>
        View logs
      </span>
    </button>
  );
}

function PlatformBadge({ platform }) {
  const map = {
    mail: { label: 'Mail', bg: '#eef1fb', color: '#0129ac' },
    slack: { label: 'Slack', bg: '#faf5fb', color: '#4A154B' },
    teams: { label: 'Teams', bg: '#f4f4fb', color: '#5558AF' },
    googleChat: { label: 'Chat', bg: '#e8f7ec', color: '#00832D' },
    message: { label: 'Message', bg: '#eef1fb', color: '#0129ac' },
  };
  const m = map[platform] || map.message;
  return (
    <span
      className="text-[10px] font-bold uppercase px-2 py-0.5 rounded"
      style={{ backgroundColor: m.bg, color: m.color }}
    >
      {m.label}
    </span>
  );
}

function SlackMark({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="#4A154B">
      <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.527 2.527 0 0 1 2.52-2.52h6.313A2.528 2.528 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" />
    </svg>
  );
}

function TeamsMark({ className }) {
  return (
    <svg className={className} viewBox="0 0 23 23">
      <rect x="1" y="1" width="10" height="10" fill="#5558AF" />
      <rect x="12" y="1" width="10" height="10" fill="#7B83EB" />
      <rect x="1" y="12" width="10" height="10" fill="#505AC9" />
      <rect x="12" y="12" width="10" height="10" fill="#8B8CC7" />
    </svg>
  );
}

function GoogleChatMark({ className }) {
  return (
    <svg className={className} viewBox="0 0 48 48">
      <path fill="#00AC47" d="M24 4C13.5 4 5 12.1 5 22c0 5.2 2.7 9.8 7 12.6V44l7.2-4c1 .3 2.1.4 3.2.4 10.5 0 19-8.1 19-18S34.5 4 24 4z" />
      <path fill="#fff" d="M17 18h14v2H17zm0 5h10v2H17zm0 5h7v2h-7z" opacity="0.95" />
    </svg>
  );
}
