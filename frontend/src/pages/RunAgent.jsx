import { Link } from 'react-router-dom';
import { useState, useEffect } from 'react';
import AgentForm from '../components/AgentForm';
import StatusBadge from '../components/StatusBadge';
import useAgentExecution from '../hooks/useAgentExecution';
import { runDocsSync, getDocsSyncStatus } from '../services/api';

/** Merge stored execution row with nested `result` once the run finishes (GET /executions/:id shape). */
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

export default function RunAgent() {
  const { execution, loading, error, run } = useAgentExecution();
  const [syncStatus, setSyncStatus] = useState(null);
  const [syncing, setSyncing] = useState(false);

  const isBulk = execution?.bulk;
  const isRunning = execution && !isBulk && execution.status === 'RUNNING';
  const runView = normalizeRunResult(execution);

  // Load last sync status on mount
  useEffect(() => {
    getDocsSyncStatus().then(({ data }) => setSyncStatus(data)).catch(() => {});
  }, []);

  async function handleDocsSync() {
    setSyncing(true);
    try {
      const { data } = await runDocsSync();
      setSyncStatus(data);
    } catch (e) {
      // silent — non-blocking
    } finally {
      setSyncing(false);
    }
  }

  const newInscope  = syncStatus?.newInscopeFeatures?.length  || 0;
  const newOutscope = syncStatus?.newOutscopeFeatures?.length || 0;
  const hasNew      = newInscope + newOutscope > 0;

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Run Agent</h1>
          <p className="text-sm text-gray-500 mt-1">Configure and trigger a migration QA flow</p>
        </div>

        {/* ── Docs Sync widget ── */}
        <div className="flex items-center gap-3 bg-white border border-gray-200 rounded-xl px-4 py-2.5 shadow-sm">
          <div className="text-xs text-gray-500 leading-tight">
            <p className="font-medium text-gray-700">Docs Sync</p>
            {syncStatus?.lastSyncAt ? (
              <p>{new Date(syncStatus.lastSyncAt).toLocaleString()}</p>
            ) : (
              <p>Never synced</p>
            )}
          </div>
          {hasNew ? (
            <span className="inline-flex items-center gap-1 text-xs font-semibold bg-amber-100 text-amber-700 border border-amber-200 rounded-full px-2 py-0.5">
              {newInscope + newOutscope} new
            </span>
          ) : syncStatus ? (
            <span className="inline-flex items-center gap-1 text-xs text-green-600">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
              </svg>
              Up to date
            </span>
          ) : null}
          <button
            onClick={handleDocsSync}
            disabled={syncing}
            title="Sync CloudFuze documentation"
            className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
          >
            <svg className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" />
            </svg>
            {syncing ? 'Syncing…' : 'Sync'}
          </button>
          {hasNew && (
            <span className="text-xs text-amber-700 font-medium whitespace-nowrap">
              ↑ New features detected
            </span>
          )}
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <AgentForm onSubmit={run} loading={loading} />
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4">
          <p className="text-sm text-red-700 font-medium">Error</p>
          <p className="text-sm text-red-600 mt-1">{error}</p>
        </div>
      )}

      {isBulk && (
        <div className="space-y-6">
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Bulk Migration Results</h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
              <div className="bg-indigo-50 rounded-lg p-4">
                <p className="text-xs text-indigo-600 font-medium uppercase">Total Pairs</p>
                <p className="text-2xl font-bold text-indigo-700 mt-1">{execution.totalPairs}</p>
              </div>
              <div className="bg-green-50 rounded-lg p-4">
                <p className="text-xs text-green-600 font-medium uppercase">Completed</p>
                <p className="text-2xl font-bold text-green-700 mt-1">{execution.completed}</p>
              </div>
              <div className="bg-red-50 rounded-lg p-4">
                <p className="text-xs text-red-600 font-medium uppercase">Failed</p>
                <p className="text-2xl font-bold text-red-700 mt-1">{execution.failed}</p>
              </div>
            </div>
          </div>

          {execution.results?.map((result, idx) => (
            <div key={idx} className="bg-white rounded-xl border border-gray-200 p-5">
              <div className="flex items-center justify-between mb-3">
                <div className="text-sm">
                  <span className="font-medium text-gray-900">{result.sourceEmail || result.context?.sourceEmail}</span>
                  <span className="text-gray-400 mx-2">→</span>
                  <span className="font-medium text-gray-900">{result.destinationEmail || result.context?.destinationEmail}</span>
                </div>
                <StatusBadge status={result.status} />
              </div>
              {result.error && <p className="text-xs text-red-500">{result.error}</p>}
              {result.duration && <p className="text-xs text-gray-500">Duration: {(result.duration / 1000).toFixed(1)}s</p>}
            </div>
          ))}
        </div>
      )}

      {isRunning && execution?.executionId && (
        <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-6 space-y-3">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <h2 className="text-lg font-semibold text-indigo-900">Execution in progress</h2>
            <StatusBadge status="RUNNING" />
          </div>
          <p className="text-sm text-indigo-800">
            The server is running the full flow. Migration can take many minutes while Outlook is polled.
          </p>
          <div className="text-sm space-y-1">
            <p>
              <span className="text-indigo-600 font-medium">Execution ID:</span>{' '}
              <span className="font-mono text-indigo-900">{execution.executionId}</span>
            </p>
            <p>
              <span className="text-indigo-600 font-medium">Current agent:</span>{' '}
              <span className="text-indigo-900">{execution.currentAgent || 'Starting…'}</span>
            </p>
            {execution.progress && (
              <p>
                <span className="text-indigo-600 font-medium">Detail:</span>{' '}
                <span className="text-indigo-900">{execution.progress}</span>
              </p>
            )}
          </div>
          <Link
            to={`/logs?id=${execution.executionId}`}
            className="inline-flex text-sm font-medium text-indigo-700 hover:text-indigo-900 underline"
          >
            Open execution logs (live JSON lines)
          </Link>
        </div>
      )}

      {runView && !isBulk && !isRunning && (
        <div className="space-y-6">
          {runView.error && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-4">
              <p className="text-sm font-medium text-red-800">Run failed</p>
              <p className="text-sm text-red-700 mt-1">{runView.error}</p>
            </div>
          )}
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-gray-900">Execution Result</h2>
              <StatusBadge status={runView.status} />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
              <div>
                <p className="text-gray-500">Execution ID</p>
                <p className="font-mono text-gray-900 mt-0.5">{runView.executionId}</p>
              </div>
              <div>
                <p className="text-gray-500">Duration</p>
                <p className="text-gray-900 mt-0.5">
                  {runView.duration ? `${(runView.duration / 1000).toFixed(1)}s` : 'N/A'}
                </p>
              </div>
              <div>
                <p className="text-gray-500">Status</p>
                <p className="text-gray-900 mt-0.5">{runView.status}</p>
              </div>
            </div>
          </div>

          {runView.migrationResult && (
            <div className="bg-white rounded-xl border border-gray-200 p-6 text-sm">
              <h3 className="text-sm font-semibold text-gray-900 mb-2">Migration (CloudFuze)</h3>
              <p className="text-gray-600">
                Job ID: <span className="font-mono">{String(runView.migrationResult.jobId)}</span>
              </p>
              <p className="text-gray-600 mt-1">
                Final status: <span className="font-medium">{runView.migrationResult.finalStatus}</span>
              </p>
              {runView.migrationResult.ownerValidation?.skipped && (
                <p className="text-amber-700 mt-1">
                  validateUser skipped: {runView.migrationResult.ownerValidation.reason}
                </p>
              )}
              {runView.migrationResult.ownerValidation && !runView.migrationResult.ownerValidation.skipped && (
                <p className="text-gray-600 mt-1">
                  CloudFuze user: {runView.migrationResult.ownerValidation.userName} (
                  {runView.migrationResult.ownerValidation.id})
                </p>
              )}
            </div>
          )}

          {runView.agentResults && (
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-100">
                <h3 className="text-sm font-semibold text-gray-900">Agent Results</h3>
              </div>
              <div className="divide-y divide-gray-100">
                {runView.agentResults.map((agent, idx) => (
                  <div key={idx} className="px-6 py-4 flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-gray-900">{agent.name}</p>
                      {agent.error && <p className="text-xs text-red-500 mt-0.5">{agent.error}</p>}
                    </div>
                    <StatusBadge status={agent.status} />
                  </div>
                ))}
              </div>
            </div>
          )}

          {runView.validationSummary && (
            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <h3 className="text-sm font-semibold text-gray-900 mb-4">Validation Summary</h3>
              <div className="flex items-center gap-3 mb-4">
                <span className="text-sm text-gray-600">Overall:</span>
                <StatusBadge status={runView.validationSummary.overallStatus} />
                <span className="text-sm text-gray-500">
                  ({runView.validationSummary.mismatches?.length || 0} mismatches)
                </span>
              </div>
              {runView.validationSummary.mismatches?.length > 0 && (
                <div className="space-y-2">
                  {runView.validationSummary.mismatches.map((m, idx) => (
                    <div key={idx} className="flex items-start gap-3 bg-red-50 rounded-lg p-3 text-sm">
                      <span className="text-red-500 font-medium flex-shrink-0">{m.category}</span>
                      <span className="text-gray-700">{m.field}: expected <code className="bg-red-100 px-1 rounded">{String(m.expected)}</code>, got <code className="bg-red-100 px-1 rounded">{String(m.actual)}</code></span>
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
