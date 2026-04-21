import { Link } from 'react-router-dom';
import MessageAgentForm from '../components/MessageAgentForm';
import StatusBadge from '../components/StatusBadge';
import useAgentExecution from '../hooks/useAgentExecution';

function normalizeRunResult(exec) {
  if (!exec || exec.bulk) return exec;
  if (exec.result && (exec.status === 'COMPLETED' || exec.status === 'FAILED')) {
    return {
      ...exec.result,
      executionId: exec.executionId,
      status: exec.status,
    };
  }
  return exec;
}

export default function MessageAgent() {
  const { execution, loading, error, run } = useAgentExecution();

  const isBulk = execution?.bulk;
  const isRunning = execution && !isBulk && execution.status === 'RUNNING';
  const runView = normalizeRunResult(execution);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold" style={{ color: '#0129ac' }}>Message Agent</h1>
        <p className="text-sm mt-1" style={{ color: '#4a65c0' }}>
          Seed Slack, Google Chat, or Microsoft Teams and run message migration QA (custom cases from Test Case Generator).
        </p>
      </div>

      <div className="bg-white rounded-xl p-6" style={{ border: '1px solid #c5cef5' }}>
        <MessageAgentForm onSubmit={run} loading={loading} />
      </div>

      {error && (
        <div className="rounded-xl p-4" style={{ backgroundColor: '#eef1fb', border: '1px solid #0129ac' }}>
          <p className="text-sm font-medium" style={{ color: '#0129ac' }}>Error</p>
          <p className="text-sm mt-1" style={{ color: '#2a40a8' }}>{error}</p>
        </div>
      )}

      {isBulk && (
        <div className="space-y-6">
          <div className="bg-white rounded-xl p-6" style={{ border: '1px solid #c5cef5' }}>
            <h2 className="text-lg font-semibold mb-4" style={{ color: '#0129ac' }}>Bulk Message Runs</h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
              <div className="rounded-lg p-4" style={{ backgroundColor: '#eef1fb' }}>
                <p className="text-xs font-medium uppercase" style={{ color: '#4a65c0' }}>Total Pairs</p>
                <p className="text-2xl font-bold mt-1" style={{ color: '#0129ac' }}>{execution.totalPairs}</p>
              </div>
              <div className="rounded-lg p-4" style={{ backgroundColor: '#0129ac' }}>
                <p className="text-xs font-medium uppercase text-white/70">Completed</p>
                <p className="text-2xl font-bold mt-1 text-white">{execution.completed}</p>
              </div>
              <div className="rounded-lg p-4" style={{ backgroundColor: '#011e8a' }}>
                <p className="text-xs font-medium uppercase text-white/70">Failed</p>
                <p className="text-2xl font-bold mt-1 text-white">{execution.failed}</p>
              </div>
            </div>
          </div>

          {execution.results?.map((result, idx) => (
            <div key={idx} className="bg-white rounded-xl p-5" style={{ border: '1px solid #c5cef5' }}>
              <div className="flex items-center justify-between mb-3">
                <div className="text-sm">
                  <span className="font-medium" style={{ color: '#0129ac' }}>{result.sourceEmail || result.context?.sourceEmail}</span>
                  <span className="mx-2" style={{ color: '#7a8fd4' }}>→</span>
                  <span className="font-medium" style={{ color: '#0129ac' }}>{result.destinationEmail || result.context?.destinationEmail}</span>
                </div>
                <StatusBadge status={result.status} />
              </div>
              {result.error && <p className="text-xs" style={{ color: '#2a40a8' }}>{result.error}</p>}
              {result.duration && <p className="text-xs" style={{ color: '#7a8fd4' }}>Duration: {(result.duration / 1000).toFixed(1)}s</p>}
            </div>
          ))}
        </div>
      )}

      {isRunning && execution?.executionId && (
        <div className="rounded-xl p-6 space-y-3" style={{ backgroundColor: '#eef1fb', border: '1px solid #0129ac' }}>
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <h2 className="text-lg font-semibold" style={{ color: '#0129ac' }}>Execution in progress</h2>
            <StatusBadge status="RUNNING" />
          </div>
          <p className="text-sm" style={{ color: '#2a40a8' }}>
            Message agents are running. If CloudFuze migration is enabled, polling may take several minutes.
          </p>
          <div className="text-sm space-y-1">
            <p>
              <span className="font-medium" style={{ color: '#0129ac' }}>Execution ID:</span>{' '}
              <span className="font-mono" style={{ color: '#0129ac' }}>{execution.executionId}</span>
            </p>
            <p>
              <span className="font-medium" style={{ color: '#0129ac' }}>Current agent:</span>{' '}
              <span style={{ color: '#2a40a8' }}>{execution.currentAgent || 'Starting…'}</span>
            </p>
            {execution.progress && (
              <p>
                <span className="font-medium" style={{ color: '#0129ac' }}>Detail:</span>{' '}
                <span style={{ color: '#2a40a8' }}>{execution.progress}</span>
              </p>
            )}
          </div>
          <Link
            to={`/logs?id=${execution.executionId}`}
            className="inline-flex text-sm font-medium underline"
            style={{ color: '#0129ac' }}
          >
            Open execution logs (live JSON lines)
          </Link>
        </div>
      )}

      {runView && !isBulk && !isRunning && (
        <div className="space-y-6">
          {runView.error && (
            <div className="rounded-xl p-4" style={{ backgroundColor: '#eef1fb', border: '1px solid #0129ac' }}>
              <p className="text-sm font-medium" style={{ color: '#0129ac' }}>Run failed</p>
              <p className="text-sm mt-1" style={{ color: '#2a40a8' }}>{runView.error}</p>
            </div>
          )}
          <div className="bg-white rounded-xl p-6" style={{ border: '1px solid #c5cef5' }}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold" style={{ color: '#0129ac' }}>Execution Result</h2>
              <StatusBadge status={runView.status} />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
              <div>
                <p style={{ color: '#7a8fd4' }}>Execution ID</p>
                <p className="font-mono mt-0.5" style={{ color: '#0129ac' }}>{runView.executionId}</p>
              </div>
              <div>
                <p style={{ color: '#7a8fd4' }}>Duration</p>
                <p className="mt-0.5" style={{ color: '#0129ac' }}>
                  {runView.duration ? `${(runView.duration / 1000).toFixed(1)}s` : 'N/A'}
                </p>
              </div>
              <div>
                <p style={{ color: '#7a8fd4' }}>Status</p>
                <p className="mt-0.5" style={{ color: '#0129ac' }}>{runView.status}</p>
              </div>
            </div>
          </div>

          {runView.migrationResult && !runView.migrationResult.skipped && (
            <div className="bg-white rounded-xl p-6 text-sm" style={{ border: '1px solid #c5cef5' }}>
              <h3 className="text-sm font-semibold mb-2" style={{ color: '#0129ac' }}>Migration (CloudFuze)</h3>
              <p style={{ color: '#2a40a8' }}>
                Job ID: <span className="font-mono">{String(runView.migrationResult.jobId)}</span>
              </p>
              <p className="mt-1" style={{ color: '#2a40a8' }}>
                Final status: <span className="font-medium">{runView.migrationResult.finalStatus}</span>
              </p>
            </div>
          )}
          {runView.migrationResult?.skipped && (
            <div className="rounded-xl p-4 text-sm" style={{ backgroundColor: '#eef1fb', border: '1px solid #c5cef5', color: '#2a40a8' }}>
              CloudFuze step skipped: {runView.migrationResult.reason}
            </div>
          )}

          {runView.agentResults && (
            <div className="bg-white rounded-xl overflow-hidden" style={{ border: '1px solid #c5cef5' }}>
              <div className="px-6 py-4" style={{ borderBottom: '1px solid #eef1fb' }}>
                <h3 className="text-sm font-semibold" style={{ color: '#0129ac' }}>Agent Results</h3>
              </div>
              <div>
                {runView.agentResults.map((agent, idx) => (
                  <div key={idx} className="px-6 py-4 flex items-center justify-between border-t" style={{ borderColor: '#eef1fb' }}>
                    <div>
                      <p className="text-sm font-medium" style={{ color: '#0129ac' }}>{agent.name}</p>
                      {agent.error && <p className="text-xs mt-0.5" style={{ color: '#2a40a8' }}>{agent.error}</p>}
                    </div>
                    <StatusBadge status={agent.status} />
                  </div>
                ))}
              </div>
            </div>
          )}

          {runView.validationSummary && (
            <div className="bg-white rounded-xl p-6" style={{ border: '1px solid #c5cef5' }}>
              <h3 className="text-sm font-semibold mb-4" style={{ color: '#0129ac' }}>Validation Summary</h3>
              <div className="flex items-center gap-3 mb-4">
                <span className="text-sm" style={{ color: '#4a65c0' }}>Overall:</span>
                <StatusBadge status={runView.validationSummary.overallStatus} />
                <span className="text-sm" style={{ color: '#7a8fd4' }}>
                  ({runView.validationSummary.mismatches?.length || 0} mismatches)
                </span>
              </div>
              {runView.validationSummary.note && (
                <p className="text-sm mb-3" style={{ color: '#2a40a8' }}>{runView.validationSummary.note}</p>
              )}
              {runView.validationSummary.mismatches?.length > 0 && (
                <div className="space-y-2">
                  {runView.validationSummary.mismatches.map((m, idx) => (
                    <div key={idx} className="flex items-start gap-3 rounded-lg p-3 text-sm" style={{ backgroundColor: '#eef1fb' }}>
                      <span className="font-medium flex-shrink-0" style={{ color: '#0129ac' }}>{m.category}</span>
                      <span style={{ color: '#2a40a8' }}>{m.field}: expected <code className="px-1 rounded" style={{ backgroundColor: '#c5cef5' }}>{String(m.expected)}</code>, got <code className="px-1 rounded" style={{ backgroundColor: '#c5cef5' }}>{String(m.actual)}</code></span>
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
