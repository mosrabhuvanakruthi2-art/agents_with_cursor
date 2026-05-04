import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import MessageAgentForm from '../components/MessageAgentForm';
import StatusBadge from '../components/StatusBadge';
import useMessageAgentExecution from '../hooks/useMessageAgentExecution';
import { startCFBrowserMigration, abortCFBrowserMigration, getCFBrowserEvents } from '../services/api';

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
  const {
    // legacy full-flow (kept for any bulk pair runs that still use /message-run)
    execution, loading, error, run,
    // split flow
    seed, seedExecution, seedLoading, seedError,
    migrate, migrateExecution, migrateLoading, migrateError,
  } = useMessageAgentExecution();

  // CF Browser automation state
  const [cfBrowserLoading, setCfBrowserLoading] = useState(false);
  const [cfBrowserStatus, setCfBrowserStatus]   = useState(null);  // { reportsUrl, message } | null
  const [cfBrowserError, setCfBrowserError]     = useState(null);
  const [browserEvents, setBrowserEvents]       = useState([]);    // live step log
  const [browserRunning, setBrowserRunning]     = useState(false);
  const eventsIntervalRef = useRef(null);

  // Start polling for browser step events as soon as automation begins
  function startEventPolling() {
    if (eventsIntervalRef.current) clearInterval(eventsIntervalRef.current);
    setBrowserEvents([]);
    setBrowserRunning(true);

    eventsIntervalRef.current = setInterval(async () => {
      try {
        const { data } = await getCFBrowserEvents();
        if (Array.isArray(data.events)) setBrowserEvents(data.events);
        if (!data.running) {
          // Session finished — do one final fetch then stop polling
          clearInterval(eventsIntervalRef.current);
          eventsIntervalRef.current = null;
          setBrowserRunning(false);
        }
      } catch { /* ignore poll errors */ }
    }, 1000);
  }

  // Clean up interval on unmount
  useEffect(() => () => {
    if (eventsIntervalRef.current) clearInterval(eventsIntervalRef.current);
  }, []);

  async function handleCFBrowserMigrate(payload) {
    setCfBrowserLoading(true);
    setCfBrowserError(null);
    setCfBrowserStatus(null);
    try {
      const { data } = await startCFBrowserMigration(payload);
      setCfBrowserStatus(data);
      startEventPolling();
    } catch (err) {
      setCfBrowserError(err?.response?.data?.error || err.message || 'Browser automation failed to start');
    } finally {
      setCfBrowserLoading(false);
    }
  }

  async function handleAbortCFBrowser() {
    try {
      await abortCFBrowserMigration();
      if (eventsIntervalRef.current) clearInterval(eventsIntervalRef.current);
      setBrowserRunning(false);
      setCfBrowserStatus(null);
    } catch { /* ignore */ }
  }

  // The Initiate Migration button now calls the split /message-migrate endpoint.
  // Keep `execution` for compatibility, but prefer the new split-phase state.
  const activeExecution = migrateExecution || execution;
  const activeLoading = migrateLoading || loading;
  const activeError = migrateError || error;
  const isBulk = activeExecution?.bulk;
  const isRunning = activeExecution && !isBulk && activeExecution.status === 'RUNNING';
  const runView = normalizeRunResult(activeExecution);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold" style={{ color: '#000000' }}>Message Agent</h1>
        <p className="text-sm mt-1" style={{ color: '#555555' }}>
          Select test cases from Agent Repo, post them to source channels & DMs, then initiate migration.
        </p>
      </div>

      <div className="bg-white rounded-xl p-6" style={{ border: '1px solid #c5cef5' }}>
        <MessageAgentForm
          onSubmit={migrate}
          onSeed={seed}
          onCFBrowserMigrate={handleCFBrowserMigrate}
          loading={activeLoading}
          cfBrowserLoading={cfBrowserLoading}
          seedLoading={seedLoading}
          seedExecution={seedExecution}
          seedError={seedError}
        />
      </div>

      {/* CF Browser automation — live step log */}
      {(cfBrowserStatus || cfBrowserError || browserEvents.length > 0) && (
        <div className="rounded-xl overflow-hidden"
          style={{ border: `1px solid ${cfBrowserError ? '#cc0000' : '#0129ac'}` }}>

          {/* Header */}
          <div className="px-5 py-3 flex items-center justify-between gap-4 flex-wrap"
            style={{ backgroundColor: cfBrowserError ? '#fff0f0' : '#0129ac' }}>
            <div className="flex items-center gap-2">
              {browserRunning && !cfBrowserError && (
                <span className="inline-flex items-center gap-1.5">
                  <svg className="animate-spin h-3.5 w-3.5 text-white" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                </span>
              )}
              {!browserRunning && !cfBrowserError && browserEvents.length > 0 && (
                <span className="text-white text-xs font-bold">✓</span>
              )}
              <h3 className="text-sm font-semibold" style={{ color: cfBrowserError ? '#cc0000' : '#fff' }}>
                {cfBrowserError ? 'Browser Launch Failed' : browserRunning ? 'Browser Running — Migration in Progress' : 'Browser Session Complete'}
              </h3>
            </div>
            <div className="flex items-center gap-3">
              {cfBrowserStatus?.reportsUrl && !cfBrowserError && (
                <a href={cfBrowserStatus.reportsUrl} target="_blank" rel="noreferrer"
                  className="text-xs font-semibold px-3 py-1 rounded-lg"
                  style={{ backgroundColor: 'rgba(255,255,255,0.15)', color: '#fff', textDecoration: 'none' }}>
                  Open Reports ↗
                </a>
              )}
              {browserRunning && (
                <button onClick={handleAbortCFBrowser}
                  className="text-xs font-semibold px-3 py-1 rounded-lg"
                  style={{ backgroundColor: 'rgba(255,255,255,0.15)', color: '#fff' }}>
                  Stop
                </button>
              )}
              <button onClick={() => { setCfBrowserStatus(null); setCfBrowserError(null); setBrowserEvents([]); setBrowserRunning(false); if (eventsIntervalRef.current) clearInterval(eventsIntervalRef.current); }}
                className="text-xs"
                style={{ color: cfBrowserError ? '#cc0000' : 'rgba(255,255,255,0.7)' }}>
                Dismiss
              </button>
            </div>
          </div>

          {/* Error */}
          {cfBrowserError && (
            <div className="px-5 py-4">
              <p className="text-sm" style={{ color: '#cc0000' }}>{cfBrowserError}</p>
            </div>
          )}

          {/* Live step log */}
          {!cfBrowserError && (
            <div className="px-5 py-4 space-y-1 max-h-72 overflow-y-auto font-mono text-xs"
              style={{ backgroundColor: '#0a0e2e', color: '#c5d0ff' }}>
              {browserEvents.length === 0 && (
                <p style={{ color: '#6070b0' }}>Launching CloudFuze browser — steps will appear here…</p>
              )}
              {browserEvents.map((evt, i) => {
                const isError  = evt.type === 'error-step' || evt.type === 'failed';
                const isDone   = evt.type === 'done';
                const label    = evt.step || evt.type || '';
                const detail   = evt.detail || evt.error || evt.message || '';
                const color    = isError ? '#ff6b6b' : isDone ? '#69db7c' : '#c5d0ff';
                const prefix   = isError ? '✗' : isDone ? '✓' : '›';
                return (
                  <div key={i} className="flex gap-2" style={{ color }}>
                    <span className="flex-shrink-0 w-3">{prefix}</span>
                    <span>
                      <strong>{label}</strong>
                      {detail && <span style={{ color: isDone ? '#69db7c' : isError ? '#ff9898' : '#8899cc' }}> — {detail}</span>}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Footer — reports link when done */}
          {!cfBrowserError && !browserRunning && cfBrowserStatus?.reportsUrl && (
            <div className="px-5 py-3 flex items-center gap-3"
              style={{ backgroundColor: '#f0f4ff', borderTop: '1px solid #c5cef5' }}>
              <span className="text-xs font-semibold" style={{ color: '#155724' }}>
                Migration submitted to CloudFuze — track progress in Reports
              </span>
              <a href={cfBrowserStatus.reportsUrl} target="_blank" rel="noreferrer"
                className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-bold flex-shrink-0"
                style={{ backgroundColor: '#0129ac', color: '#fff', textDecoration: 'none' }}>
                Open CloudFuze Reports ↗
              </a>
            </div>
          )}
        </div>
      )}

      {activeError && (
        <div className="rounded-xl p-4" style={{ backgroundColor: '#f0f4ff', border: '1px solid #0129ac' }}>
          <p className="text-sm font-medium" style={{ color: '#000000' }}>Error</p>
          <p className="text-sm mt-1" style={{ color: '#000000' }}>{activeError}</p>
        </div>
      )}

      {isBulk && (
        <div className="space-y-6">
          <div className="bg-white rounded-xl p-6" style={{ border: '1px solid #c5cef5' }}>
            <h2 className="text-lg font-semibold mb-4" style={{ color: '#000000' }}>Bulk Message Migration Results</h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
              <div className="rounded-lg p-4" style={{ backgroundColor: '#f0f4ff' }}>
                <p className="text-xs font-medium uppercase" style={{ color: '#555555' }}>Total Pairs</p>
                <p className="text-2xl font-bold mt-1" style={{ color: '#000000' }}>{activeExecution?.totalPairs ?? 0}</p>
              </div>
              <div className="rounded-lg p-4" style={{ backgroundColor: '#0129ac' }}>
                <p className="text-xs font-medium uppercase text-white/70">Completed</p>
                <p className="text-2xl font-bold mt-1 text-white">{activeExecution?.completed ?? 0}</p>
              </div>
              <div className="rounded-lg p-4" style={{ backgroundColor: '#011e8a' }}>
                <p className="text-xs font-medium uppercase text-white/70">Failed</p>
                <p className="text-2xl font-bold mt-1 text-white">{activeExecution?.failed ?? 0}</p>
              </div>
            </div>
          </div>

          {activeExecution?.results?.map((result, idx) => (
            <div key={idx} className="bg-white rounded-xl p-5" style={{ border: '1px solid #c5cef5' }}>
              <div className="flex items-center justify-between mb-3">
                <div className="text-sm">
                  <span className="font-medium" style={{ color: '#000000' }}>{result.sourceEmail || result.context?.sourceEmail}</span>
                  <span className="mx-2" style={{ color: '#555555' }}>→</span>
                  <span className="font-medium" style={{ color: '#000000' }}>{result.destinationEmail || result.context?.destinationEmail}</span>
                </div>
                <StatusBadge status={result.status} />
              </div>
              {result.error && <p className="text-xs" style={{ color: '#000000' }}>{result.error}</p>}
              {result.duration && <p className="text-xs" style={{ color: '#555555' }}>Duration: {(result.duration / 1000).toFixed(1)}s</p>}
            </div>
          ))}
        </div>
      )}

      {isRunning && activeExecution?.executionId && (
        <div className="rounded-xl p-6 space-y-3" style={{ backgroundColor: '#f0f4ff', border: '1px solid #0129ac' }}>
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <h2 className="text-lg font-semibold" style={{ color: '#000000' }}>Migration in progress</h2>
            <StatusBadge status="RUNNING" />
          </div>
          <p className="text-sm" style={{ color: '#000000' }}>
            CloudFuze chat-migration + validation are running on the selected channels and DMs.
          </p>
          <div className="text-sm space-y-1">
            <p>
              <span className="font-medium" style={{ color: '#000000' }}>Execution ID:</span>{' '}
              <span className="font-mono" style={{ color: '#000000' }}>{activeExecution.executionId}</span>
            </p>
            <p>
              <span className="font-medium" style={{ color: '#000000' }}>Current agent:</span>{' '}
              <span style={{ color: '#000000' }}>{activeExecution.currentAgent || 'Starting…'}</span>
            </p>
            {activeExecution.progress && (
              <p>
                <span className="font-medium" style={{ color: '#000000' }}>Detail:</span>{' '}
                <span style={{ color: '#000000' }}>{activeExecution.progress}</span>
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Link
              to={`/logs?id=${activeExecution.executionId}`}
              className="inline-flex text-sm font-medium underline"
              style={{ color: '#000000' }}
            >
              Open execution logs (live JSON lines)
            </Link>
            <a
              href="https://s2cdev.cloudfuze.com/pages/reports.html"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-sm font-medium underline"
              style={{ color: '#0129ac' }}
            >
              View CloudFuze Reports ↗
            </a>
          </div>
        </div>
      )}

      {runView && !isBulk && !isRunning && (
        <div className="space-y-6">
          {runView.error && (
            <div className="rounded-xl p-4" style={{ backgroundColor: '#f0f4ff', border: '1px solid #0129ac' }}>
              <p className="text-sm font-medium" style={{ color: '#000000' }}>Run failed</p>
              <p className="text-sm mt-1" style={{ color: '#000000' }}>{runView.error}</p>
            </div>
          )}

          <div className="bg-white rounded-xl p-6" style={{ border: '1px solid #c5cef5' }}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold" style={{ color: '#000000' }}>Execution Result</h2>
              <StatusBadge status={runView.status} />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
              <div>
                <p style={{ color: '#555555' }}>Execution ID</p>
                <p className="font-mono mt-0.5" style={{ color: '#000000' }}>{runView.executionId}</p>
              </div>
              <div>
                <p style={{ color: '#555555' }}>Duration</p>
                <p className="mt-0.5" style={{ color: '#000000' }}>
                  {runView.duration ? `${(runView.duration / 1000).toFixed(1)}s` : 'N/A'}
                </p>
              </div>
              <div>
                <p style={{ color: '#555555' }}>Status</p>
                <p className="mt-0.5" style={{ color: '#000000' }}>{runView.status}</p>
              </div>
            </div>
            {runView.executionId && (
              <div className="flex flex-wrap items-center gap-3 mt-4">
                <Link
                  to={`/logs?id=${runView.executionId}`}
                  className="inline-flex text-sm font-medium underline"
                  style={{ color: '#000000' }}
                >
                  Open execution logs
                </Link>
                <a
                  href={`/api/agents/executions/${runView.executionId}/pdf`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-semibold"
                  style={{ backgroundColor: '#0129ac', color: '#fff', textDecoration: 'none' }}
                >
                  Download Validation Report (PDF)
                </a>
              </div>
            )}
          </div>

          {runView.sourceData && (
            <div className="bg-white rounded-xl p-6 text-sm" style={{ border: '1px solid #c5cef5' }}>
              <h3 className="text-sm font-semibold mb-3" style={{ color: '#000000' }}>Test Data (from Agent Repo)</h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <Stat label="Matching cases" value={runView.sourceData.totalCases} />
                <Stat label="Targets" value={runView.sourceData.totalTargets} />
                <Stat label="Posts attempted" value={runView.sourceData.postsAttempted} />
                <Stat label="Posts succeeded" value={runView.sourceData.postsSucceeded} />
              </div>
              <p className="mt-3 text-xs" style={{ color: '#555555' }}>
                Combination: <span className="font-mono">{runView.sourceData.combination || 'n/a'}</span>
                {' · '}Live Slack posting: <strong>{runView.sourceData.liveSlackPosting ? 'yes' : 'no (dry-run)'}</strong>
              </p>
              {runView.sourceData.errors?.length > 0 && (
                <div className="mt-3 space-y-1">
                  {runView.sourceData.errors.slice(0, 5).map((e, i) => (
                    <p key={i} className="text-xs" style={{ color: '#000000' }}>
                      {e.case} → {e.target}: {e.error}
                    </p>
                  ))}
                </div>
              )}
            </div>
          )}

          {runView.migrationResult && (
            <MigrationResultPanel result={runView.migrationResult} />
          )}

          {runView.agentResults && (
            <div className="bg-white rounded-xl overflow-hidden" style={{ border: '1px solid #c5cef5' }}>
              <div className="px-6 py-4" style={{ borderBottom: '1px solid #eef1fb' }}>
                <h3 className="text-sm font-semibold" style={{ color: '#000000' }}>Agent Results</h3>
              </div>
              <div>
                {runView.agentResults.map((agent, idx) => (
                  <div key={idx} className="px-6 py-4 flex items-center justify-between border-t" style={{ borderColor: '#eef1fb' }}>
                    <div>
                      <p className="text-sm font-medium" style={{ color: '#000000' }}>{agent.name}</p>
                      {agent.error && <p className="text-xs mt-0.5" style={{ color: '#000000' }}>{agent.error}</p>}
                    </div>
                    <StatusBadge status={agent.status} />
                  </div>
                ))}
              </div>
            </div>
          )}

          {runView.validationSummary && (
            <div className="bg-white rounded-xl p-6" style={{ border: '1px solid #c5cef5' }}>
              <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
                <h3 className="text-sm font-semibold" style={{ color: '#000000' }}>Validation Summary</h3>
                {runView.executionId && (
                  <a
                    href={`/api/agents/executions/${runView.executionId}/pdf`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold"
                    style={{ backgroundColor: '#0129ac', color: '#fff', textDecoration: 'none' }}
                  >
                    Download PDF Report
                  </a>
                )}
              </div>
              <div className="flex items-center gap-3 mb-4">
                <span className="text-sm" style={{ color: '#555555' }}>Overall:</span>
                <StatusBadge status={runView.validationSummary.overallStatus} />
                <span className="text-sm" style={{ color: '#555555' }}>
                  ({runView.validationSummary.mismatches?.length || 0} mismatches)
                </span>
              </div>
              {runView.validationSummary.counts && (
                <>
                  <p className="text-xs font-medium mb-2" style={{ color: '#555555' }}>Source (seed)</p>
                  <div className="grid grid-cols-3 md:grid-cols-5 gap-3 text-xs mb-4">
                    <Stat small label="Cases" value={runView.validationSummary.counts.testCases} />
                    <Stat small label="Targets" value={runView.validationSummary.counts.targets} />
                    <Stat small label="Attempted" value={runView.validationSummary.counts.postsAttempted} />
                    <Stat small label="Seeded ✓" value={runView.validationSummary.counts.postsSucceeded} />
                    <Stat small label="Failed ✗" value={runView.validationSummary.counts.postsFailed} />
                  </div>
                  {(runView.validationSummary.counts.messagesRead != null ||
                    runView.validationSummary.counts.messagesMigrated != null) && (
                    <>
                      <p className="text-xs font-medium mb-2" style={{ color: '#555555' }}>
                        Destination (migrated
                        {runView.validationSummary.migrationMode === 'simulated' ? ' — simulated' : ' — live'})
                      </p>
                      <div className="grid grid-cols-3 gap-3 text-xs mb-4">
                        <Stat small label="Read from Source" value={runView.validationSummary.counts.messagesRead} />
                        <Stat small label="Migrated ✓" value={runView.validationSummary.counts.messagesMigrated} />
                        <Stat small label="Failed ✗" value={runView.validationSummary.counts.messagesFailed} />
                      </div>
                    </>
                  )}
                  {runView.validationSummary.migrationNote && (
                    <p className="text-xs mb-3" style={{ color: '#555555' }}>{runView.validationSummary.migrationNote}</p>
                  )}
                </>
              )}
              {runView.validationSummary.mismatches?.length > 0 && (
                <div className="space-y-2 mb-4">
                  {runView.validationSummary.mismatches.map((m, idx) => (
                    <div key={idx} className="flex items-start gap-3 rounded-lg p-3 text-sm" style={{ backgroundColor: '#f0f4ff' }}>
                      <span className="font-medium flex-shrink-0" style={{ color: '#000000' }}>{m.category}</span>
                      <span style={{ color: '#000000' }}>
                        {m.field}: expected <code className="px-1 rounded" style={{ backgroundColor: '#d0d8f0' }}>{String(m.expected)}</code>, got <code className="px-1 rounded" style={{ backgroundColor: '#d0d8f0' }}>{String(m.actual)}</code>
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {/* Per-channel/DM breakdown */}
              {runView.validationSummary.perTarget?.length > 0 && (
                <div className="rounded-lg overflow-hidden" style={{ border: '1px solid #0129ac' }}>
                  <div className="px-4 py-2.5" style={{ backgroundColor: '#0129ac' }}>
                    <span className="text-xs font-bold text-white">Per-channel / DM validation breakdown</span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr style={{ backgroundColor: '#f0f4ff', borderBottom: '1px solid #c5cef5' }}>
                          <th className="px-3 py-2 text-left font-semibold" style={{ color: '#000' }}>Target</th>
                          <th className="px-3 py-2 text-center font-semibold" style={{ color: '#000' }}>Seeded ✓</th>
                          <th className="px-3 py-2 text-center font-semibold" style={{ color: '#000' }}>Failed ✗</th>
                          <th className="px-3 py-2 text-center font-semibold" style={{ color: '#000' }}>Migration</th>
                          <th className="px-3 py-2 text-center font-semibold" style={{ color: '#000' }}>Job ID</th>
                          <th className="px-3 py-2 text-center font-semibold" style={{ color: '#000' }}>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {runView.validationSummary.perTarget.map((t, i) => (
                          <tr key={t.id} style={{ borderBottom: '1px solid #eef1fb', backgroundColor: i % 2 === 0 ? '#fff' : '#fafbff' }}>
                            <td className="px-3 py-2" style={{ color: '#000' }}>
                              <span className="block font-mono text-[10px]" style={{ color: '#555' }}>
                                {t.id.length > 24 ? t.id.slice(0, 22) + '…' : t.id}
                              </span>
                              <span className="text-[10px]" style={{ color: '#aaa' }}>{t.kind}</span>
                            </td>
                            <td className="px-3 py-2 text-center font-semibold" style={{ color: '#155724' }}>
                              {t.seeding?.isDryRun ? '—' : t.seeding?.succeeded ?? 0}
                            </td>
                            <td className="px-3 py-2 text-center font-semibold" style={{ color: (t.seeding?.failed ?? 0) > 0 ? '#cc0000' : '#155724' }}>
                              {t.seeding?.failed ?? 0}
                            </td>
                            <td className="px-3 py-2 text-center" style={{ color: '#000' }}>
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-bold"
                                style={{
                                  backgroundColor: t.migration?.status === 'INITIATED' ? '#d4edda'
                                    : t.migration?.status === 'FAILED' ? '#fff0f0'
                                    : t.migration?.status === 'SIMULATED' ? '#f0f0f0'
                                    : '#f0f4ff',
                                  color: t.migration?.status === 'INITIATED' ? '#155724'
                                    : t.migration?.status === 'FAILED' ? '#cc0000'
                                    : t.migration?.status === 'SIMULATED' ? '#555'
                                    : '#0129ac',
                                }}>
                                {t.migration?.status || '—'}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-center font-mono text-[10px]" style={{ color: '#555' }}>
                              {t.migration?.jobId ? String(t.migration.jobId).slice(0, 12) : '—'}
                            </td>
                            <td className="px-3 py-2 text-center">
                              <span className="px-2 py-0.5 rounded-full text-[10px] font-bold"
                                style={{
                                  backgroundColor: t.status === 'PASS' ? '#d4edda'
                                    : t.status === 'FAIL' ? '#fff0f0'
                                    : t.status === 'DRY-RUN' ? '#f0f0f0'
                                    : '#fff8e5',
                                  color: t.status === 'PASS' ? '#155724'
                                    : t.status === 'FAIL' ? '#cc0000'
                                    : t.status === 'DRY-RUN' ? '#555'
                                    : '#7a5400',
                                }}>
                                {t.status}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Migration Result Panel ────────────────────────────────────────────────────

function MigrationResultPanel({ result }) {
  const {
    finalStatus, mode, note,
    chatMigrationResults = [],
    errors = [],
    cloudFuzeReportsUrl,
    combination, sourcePlatform, destinationPlatform,
    targetsAttempted,
  } = result;

  const initiated  = chatMigrationResults.filter(r => r.status === 'INITIATED').length;
  const failed     = chatMigrationResults.filter(r => r.status === 'FAILED').length;
  const isLive     = mode === 'live';
  const isSim      = mode === 'simulated';

  const cfReportsUrl = cloudFuzeReportsUrl || 'https://s2cdev.cloudfuze.com/pages/reports.html';

  return (
    <div className="bg-white rounded-xl overflow-hidden" style={{ border: '2px solid #0129ac' }}>
      {/* Header bar */}
      <div className="px-6 py-4 flex items-center justify-between flex-wrap gap-3"
        style={{ backgroundColor: '#0129ac' }}>
        <div>
          <h3 className="text-base font-bold text-white">Migration Initiated</h3>
          <p className="text-xs text-white/70 mt-0.5">
            {combination || `${sourcePlatform} → ${destinationPlatform}`}
            {' · '}{targetsAttempted} target{targetsAttempted !== 1 ? 's' : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isSim && (
            <span className="text-xs px-3 py-1 rounded-full font-bold"
              style={{ backgroundColor: '#f0f4ff', color: '#555' }}>SIMULATED</span>
          )}
          {isLive && (
            <span className="text-xs px-3 py-1 rounded-full font-bold"
              style={{ backgroundColor: '#d4edda', color: '#155724' }}>✓ LIVE</span>
          )}
          <StatusBadge status={finalStatus} />
        </div>
      </div>

      <div className="p-6 space-y-5">
        {/* Summary stat cards */}
        <div className="grid grid-cols-3 gap-4">
          <div className="rounded-xl p-4 text-center" style={{ backgroundColor: '#f0f4ff', border: '2px solid #0129ac' }}>
            <p className="text-2xl font-black" style={{ color: '#0129ac' }}>{targetsAttempted || chatMigrationResults.length}</p>
            <p className="text-xs font-semibold mt-1" style={{ color: '#555' }}>Targets Submitted</p>
          </div>
          <div className="rounded-xl p-4 text-center" style={{ backgroundColor: '#d4edda', border: '2px solid #28a745' }}>
            <p className="text-2xl font-black" style={{ color: '#155724' }}>{initiated}</p>
            <p className="text-xs font-semibold mt-1" style={{ color: '#155724' }}>Jobs Initiated ✓</p>
          </div>
          <div className="rounded-xl p-4 text-center"
            style={{ backgroundColor: failed > 0 ? '#fff0f0' : '#f0f4ff', border: `2px solid ${failed > 0 ? '#cc0000' : '#0129ac'}` }}>
            <p className="text-2xl font-black" style={{ color: failed > 0 ? '#cc0000' : '#0129ac' }}>{failed}</p>
            <p className="text-xs font-semibold mt-1" style={{ color: failed > 0 ? '#cc0000' : '#555' }}>Failed ✗</p>
          </div>
        </div>

        {/* CloudFuze Reports — prominent CTA */}
        <div className="rounded-xl p-4 flex items-center justify-between gap-4 flex-wrap"
          style={{ backgroundColor: '#f0f4ff', border: '1px solid #0129ac' }}>
          <div>
            <p className="text-sm font-bold" style={{ color: '#000' }}>
              {initiated > 0
                ? `${initiated} job${initiated !== 1 ? 's' : ''} submitted to CloudFuze — migration is running in the background`
                : 'Migration submitted to CloudFuze'}
            </p>
            <p className="text-xs mt-1" style={{ color: '#555' }}>
              Track real-time progress, message counts, and completion status in CloudFuze Reports.
            </p>
          </div>
          <div className="flex flex-col gap-2 flex-shrink-0">
            <a href={cfReportsUrl} target="_blank" rel="noreferrer"
              className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-lg text-sm font-bold"
              style={{ backgroundColor: '#0129ac', color: '#fff', textDecoration: 'none' }}>
              Open CloudFuze Reports ↗
            </a>
            <Link to="/migration-reports"
              className="inline-flex items-center gap-1.5 px-5 py-2 rounded-lg text-xs font-semibold text-center"
              style={{ border: '1px solid #0129ac', color: '#0129ac', textDecoration: 'none', justifyContent: 'center' }}>
              View In-App Reports
            </Link>
          </div>
        </div>

        {/* Per-channel job table */}
        {chatMigrationResults.length > 0 && (
          <div className="rounded-xl overflow-hidden" style={{ border: '1px solid #0129ac' }}>
            <div className="px-4 py-2.5 flex items-center justify-between" style={{ backgroundColor: '#0129ac' }}>
              <span className="text-xs font-bold text-white">Per-Channel / DM Migration Jobs</span>
              <span className="text-xs text-white/70">{chatMigrationResults.length} target{chatMigrationResults.length !== 1 ? 's' : ''}</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr style={{ backgroundColor: '#f0f4ff', borderBottom: '1px solid #c5cef5' }}>
                    <th className="px-3 py-2 text-left font-semibold" style={{ color: '#000' }}>Channel / DM ID</th>
                    <th className="px-3 py-2 text-left font-semibold" style={{ color: '#000' }}>Kind</th>
                    <th className="px-3 py-2 text-left font-semibold" style={{ color: '#000' }}>CF Job ID</th>
                    <th className="px-3 py-2 text-center font-semibold" style={{ color: '#000' }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {chatMigrationResults.map((r, i) => (
                    <tr key={`${r.target}-${i}`}
                      style={{ borderBottom: '1px solid #eef1fb', backgroundColor: i % 2 === 0 ? '#fff' : '#fafbff' }}>
                      <td className="px-3 py-2.5 font-mono text-[11px]" style={{ color: '#000' }}>
                        <span className="block max-w-[180px] truncate" title={r.target}>{r.target}</span>
                      </td>
                      <td className="px-3 py-2.5" style={{ color: '#555' }}>
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold"
                          style={{ backgroundColor: '#f0f4ff', color: '#0129ac' }}>
                          {r.kind || 'channel'}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 font-mono text-[11px] font-semibold" style={{ color: '#0129ac' }}>
                        {r.jobId && r.jobId !== 'initiated' ? r.jobId : '—'}
                      </td>
                      <td className="px-3 py-2.5 text-center">
                        {r.status === 'INITIATED' ? (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold"
                            style={{ backgroundColor: '#d4edda', color: '#155724' }}>✓ INITIATED</span>
                        ) : r.status === 'FAILED' ? (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold"
                            style={{ backgroundColor: '#fff0f0', color: '#cc0000' }}>✗ FAILED</span>
                        ) : (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold"
                            style={{ backgroundColor: '#f0f4ff', color: '#555' }}>{r.status}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* Errors */}
            {errors.length > 0 && (
              <div className="px-4 py-3 space-y-1" style={{ borderTop: '1px solid #eef1fb', backgroundColor: '#fff8f8' }}>
                <p className="text-xs font-semibold mb-1" style={{ color: '#cc0000' }}>Errors</p>
                {errors.map((e, i) => (
                  <p key={i} className="text-xs font-mono" style={{ color: '#000' }}>
                    <span style={{ color: '#cc0000' }}>✗</span> {e.target}: {e.error}
                  </p>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Note */}
        {note && (
          <p className="text-xs rounded-lg px-3 py-2" style={{ backgroundColor: '#f9f9f9', color: '#555', border: '1px solid #e0e0e0' }}>
            {note}
          </p>
        )}

        {/* Simulation warning */}
        {isSim && (
          <div className="rounded-lg px-4 py-3 text-xs" style={{ backgroundColor: '#fff8e5', border: '1px solid #e5b94a', color: '#000' }}>
            <strong>Simulation mode</strong> — CloudFuze API was not reachable or not configured.
            Check <code>MIGRATION_API_URL</code> and <code>MIGRATION_API_BASIC_AUTH</code> in <code>.env</code>.
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, small = false }) {
  return (
    <div>
      <p className={small ? 'text-[11px]' : 'text-xs'} style={{ color: '#555555' }}>{label}</p>
      <p className={`${small ? 'text-base' : 'text-lg'} font-semibold mt-0.5`} style={{ color: '#000000' }}>
        {value ?? 0}
      </p>
    </div>
  );
}
