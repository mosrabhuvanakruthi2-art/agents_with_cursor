import { Link } from 'react-router-dom';
import AgentForm from '../components/AgentForm';
import StatusBadge from '../components/StatusBadge';
import useAgentExecution from '../hooks/useAgentExecution';

function normalizeRunResult(exec) {
  if (!exec || exec.bulk) return exec;
  if (exec.result && (exec.status === 'COMPLETED' || exec.status === 'FAILED')) {
    return { ...exec.result, executionId: exec.executionId, status: exec.status };
  }
  return exec;
}

export default function RunAgent() {
  const { execution, loading, error, run } = useAgentExecution();

  const isBulk = execution?.bulk;
  const isRunning = execution && !isBulk && execution.status === 'RUNNING';
  const runView = normalizeRunResult(execution);

  return (
    <div className="page-wrap">
      <div className="page-header">
        <div>
          <h1 className="page-title">Run Agent</h1>
          <p className="page-subtitle">Configure and trigger a migration QA flow</p>
        </div>
      </div>

      <div className="card">
        <div className="card-body" style={{ padding: '32px 36px' }}>
          <AgentForm onSubmit={run} loading={loading} />
        </div>
      </div>

      {error && (
        <div className="card" style={{ border: '1px solid #fca5a5' }}>
          <div className="card-body" style={{ padding: '20px 24px' }}>
            <p className="text-base font-bold" style={{ color: '#dc2626' }}>Error</p>
            <p className="text-sm mt-2" style={{ color: '#991b1b' }}>{error}</p>
          </div>
        </div>
      )}

      {isBulk && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div className="card">
            <div className="card-header">
              <div className="card-title" style={{ fontSize: 16 }}>Bulk Migration Results</div>
            </div>
            <div className="card-body">
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 16 }}>
                <div className="stat-card blue">
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>Total Pairs</div>
                  <div style={{ fontSize: 36, fontWeight: 800, color: '#0129ac' }}>{execution.totalPairs}</div>
                </div>
                <div className="stat-card green">
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>Completed</div>
                  <div style={{ fontSize: 36, fontWeight: 800, color: '#10b981' }}>{execution.completed}</div>
                </div>
                <div className="stat-card red">
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>Failed</div>
                  <div style={{ fontSize: 36, fontWeight: 800, color: '#ef4444' }}>{execution.failed}</div>
                </div>
              </div>
            </div>
          </div>

          {execution.results?.map((result, idx) => (
            <div key={idx} className="card">
              <div className="card-body" style={{ padding: '20px 24px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                  <div style={{ fontSize: 14 }}>
                    <span style={{ fontWeight: 700, color: '#0129ac' }}>{result.sourceEmail || result.context?.sourceEmail}</span>
                    <span style={{ margin: '0 10px', color: '#94a3b8' }}>→</span>
                    <span style={{ fontWeight: 700, color: '#0129ac' }}>{result.destinationEmail || result.context?.destinationEmail}</span>
                  </div>
                  <StatusBadge status={result.status} />
                </div>
                {result.error && <p style={{ fontSize: 13, color: '#dc2626' }}>{result.error}</p>}
                {result.duration && <p style={{ fontSize: 13, color: '#94a3b8', marginTop: 6 }}>Duration: {(result.duration / 1000).toFixed(1)}s</p>}
              </div>
            </div>
          ))}
        </div>
      )}

      {isRunning && execution?.executionId && (
        <div className="card" style={{ border: '1px solid #0129ac' }}>
          <div className="card-body" style={{ padding: '28px 32px', background: 'linear-gradient(135deg, #eef1fb 0%, #f0f4ff 100%)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <h2 style={{ fontSize: 18, fontWeight: 700, color: '#0129ac' }}>Execution in progress</h2>
              <StatusBadge status="RUNNING" />
            </div>
            <p style={{ fontSize: 14, color: '#3d5296', marginBottom: 16 }}>
              The server is running the full flow. Migration can take many minutes while Outlook is polled.
            </p>
            <div style={{ fontSize: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <p><span style={{ fontWeight: 700, color: '#0129ac' }}>Execution ID:</span>{' '}<span style={{ fontFamily: 'monospace', color: '#0129ac' }}>{execution.executionId}</span></p>
              <p><span style={{ fontWeight: 700, color: '#0129ac' }}>Current agent:</span>{' '}<span style={{ color: '#3d5296' }}>{execution.currentAgent || 'Starting…'}</span></p>
              {execution.progress && <p><span style={{ fontWeight: 700, color: '#0129ac' }}>Detail:</span>{' '}<span style={{ color: '#3d5296' }}>{execution.progress}</span></p>}
            </div>
            <Link to={`/logs?id=${execution.executionId}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 16, fontSize: 14, fontWeight: 600, color: '#0129ac', textDecoration: 'none' }}>
              Open execution logs (live JSON lines) →
            </Link>
          </div>
        </div>
      )}

      {runView && !isBulk && !isRunning && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {runView.error && (
            <div className="card" style={{ border: '1px solid #fca5a5' }}>
              <div className="card-body">
                <p style={{ fontSize: 14, fontWeight: 700, color: '#dc2626' }}>Run failed</p>
                <p style={{ fontSize: 13, color: '#991b1b', marginTop: 8 }}>{runView.error}</p>
              </div>
            </div>
          )}

          <div className="card">
            <div className="card-header">
              <div className="card-title" style={{ fontSize: 16 }}>Execution Result</div>
              <StatusBadge status={runView.status} />
            </div>
            <div className="card-body">
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 20 }}>
                {[
                  { label: 'Execution ID', value: runView.executionId, mono: true },
                  { label: 'Duration', value: runView.duration ? `${(runView.duration/1000).toFixed(1)}s` : 'N/A' },
                  { label: 'Status', value: runView.status },
                ].map(item => (
                  <div key={item.label}>
                    <p style={{ fontSize: 12, color: '#94a3b8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>{item.label}</p>
                    <p style={{ fontSize: 14, fontWeight: 700, color: '#0129ac', fontFamily: item.mono ? 'monospace' : 'inherit' }}>{item.value}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {runView.migrationResult && (
            <div className="card">
              <div className="card-header"><div className="card-title">Migration (CloudFuze)</div></div>
              <div className="card-body">
                <p style={{ fontSize: 14, color: '#3d5296' }}>Job ID: <span style={{ fontFamily: 'monospace', color: '#0129ac', fontWeight: 700 }}>{String(runView.migrationResult.jobId)}</span></p>
                <p style={{ fontSize: 14, color: '#3d5296', marginTop: 8 }}>Final status: <span style={{ fontWeight: 700, color: '#0129ac' }}>{runView.migrationResult.finalStatus}</span></p>
              </div>
            </div>
          )}

          {runView.agentResults && (
            <div className="card" style={{ overflow: 'hidden' }}>
              <div className="card-header"><div className="card-title">Agent Results</div></div>
              <table className="data-table">
                <thead><tr><th>Agent</th><th>Status</th><th>Error</th></tr></thead>
                <tbody>
                  {runView.agentResults.map((agent, idx) => (
                    <tr key={idx}>
                      <td style={{ fontWeight: 600, color: '#0129ac' }}>{agent.name}</td>
                      <td><StatusBadge status={agent.status} /></td>
                      <td style={{ color: '#dc2626', fontSize: 12 }}>{agent.error || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {runView.validationSummary && (
            <div className="card">
              <div className="card-header">
                <div className="card-title">Validation Summary</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{ fontSize: 13, color: '#6b7280' }}>Overall:</span>
                  <StatusBadge status={runView.validationSummary.overallStatus} />
                  <span style={{ fontSize: 13, color: '#9ca3af' }}>({runView.validationSummary.mismatches?.length || 0} mismatches)</span>
                </div>
              </div>
              {runView.validationSummary.mismatches?.length > 0 && (
                <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {runView.validationSummary.mismatches.map((m, idx) => (
                    <div key={idx} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, borderRadius: 8, padding: '12px 16px', backgroundColor: '#eef1fb', fontSize: 13 }}>
                      <span style={{ fontWeight: 700, color: '#0129ac', flexShrink: 0 }}>{m.category}</span>
                      <span style={{ color: '#3d5296' }}>{m.field}: expected <code style={{ padding: '1px 6px', borderRadius: 4, backgroundColor: '#c5cef5', fontFamily: 'monospace' }}>{String(m.expected)}</code>, got <code style={{ padding: '1px 6px', borderRadius: 4, backgroundColor: '#c5cef5', fontFamily: 'monospace' }}>{String(m.actual)}</code></span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
