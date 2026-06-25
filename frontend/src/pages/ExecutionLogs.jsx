import { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { getExecutions, getExecutionLogs, cancelExecution, resumeExecution, downloadValidationPdf, getCFReports, getCFJobWorkspaces } from '../services/api';
import StatusBadge from '../components/StatusBadge';
import LogViewer from '../components/LogViewer';
import ResultsView from '../components/ResultsView';
import ProductTabs from '../components/ProductTabs';
import { productOf, productCounts, PRODUCT_LABEL } from '../utils/product';

function toCombCode(str) {
  const s = (str || '').toLowerCase();
  const parts = s.split(/→|->|\s+to\s+/);
  const src = (parts[0] || '').trim();
  const dst = (parts.length > 1 ? parts[1] : s).trim();
  const letter = (x) => {
    if (x.includes('slack')) return 'S';
    if (x.includes('teams') || x.includes('microsoft')) return 'T';
    if (x.includes('chat') || x.includes('google')) return 'C';
    return '';
  };
  const a = letter(src), b = letter(dst);
  return a && b ? `${a}2${b}` : '';
}

// The fixed agent pipeline; each run's agentResults / currentAgent map onto these.
const PIPELINE = [
  { key: 'cleanup', label: 'Cleanup', match: /clean/i },
  { key: 'seed', label: 'Seed Test Data', match: /testdata|test data|seed/i },
  { key: 'migration', label: 'Migration', match: /migrat/i },
  { key: 'validation', label: 'Validation', match: /validat/i },
];

// Agent results report varied status words (SUCCESS, ERROR, …) — map them to our set.
function normalizeStatus(s) {
  const v = String(s || '').toUpperCase();
  if (['SUCCESS', 'COMPLETED', 'DONE', 'OK', 'PASS', 'PASSED'].includes(v)) return 'COMPLETED';
  if (['FAILED', 'FAILURE', 'ERROR'].includes(v)) return 'FAILED';
  if (['RUNNING', 'IN_PROGRESS', 'IN-PROGRESS'].includes(v)) return 'RUNNING';
  if (['SKIPPED', 'SKIP', 'NOT_RUN'].includes(v)) return 'SKIPPED';
  return v || 'PENDING';
}

function deriveSteps(exec) {
  const results = exec?.agentResults || exec?.result?.agentResults || [];
  const current = exec?.currentAgent || '';
  const st = exec?.status;
  const running = st === 'RUNNING';
  const completed = st === 'COMPLETED';
  // Which pipeline step the active agent is on (for live runs without per-step results yet).
  const currentIdx = PIPELINE.findIndex((s) => s.match.test(current));
  return PIPELINE.map((s, i) => {
    const r = results.find((a) => s.match.test(a.name || ''));
    let status = 'PENDING';
    if (r) status = normalizeStatus(r.status);                     // explicit result wins (e.g. "SUCCESS" → COMPLETED)
    else if (running && currentIdx >= 0) {
      status = i < currentIdx ? 'COMPLETED' : i === currentIdx ? 'RUNNING' : 'PENDING'; // before = done, on = running, after = pending
    } else if (running && s.match.test(current)) status = 'RUNNING';
    else if (completed) status = 'COMPLETED';                      // whole flow finished → all steps done
    else if (st === 'FAILED' || st === 'CANCELLED' || st === 'INTERRUPTED') status = 'SKIPPED';
    return { ...s, status, error: r?.error };
  });
}

export default function ExecutionLogs() {
  const [searchParams] = useSearchParams();
  const [executions, setExecutions] = useState([]);
  const [selectedId, setSelectedId] = useState(searchParams.get('id') || '');
  const [logs, setLogs] = useState([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [tab, setTab] = useState('logs'); // 'results' | 'logs'
  // Product segregation for the runs list. Honors ?domain= from the migrate redirect.
  const initialProduct = ['mail', 'content', 'message'].includes(searchParams.get('domain')) ? searchParams.get('domain') : 'all';
  const [product, setProduct] = useState(initialProduct);
  // CF server-side migration jobs (message product only)
  const [cfJobs, setCfJobs] = useState([]);
  const [cfLoading, setCfLoading] = useState(false);
  const [cfError, setCfError] = useState(null);
  const [cfRefreshed, setCfRefreshed] = useState(null);
  const cfAutoRef = useRef(null);
  // Expanded job rows → workspace (per-channel) details
  const [expandedJobs, setExpandedJobs] = useState({}); // { jobId: { loading, error, rows[] } }

  const counts = productCounts(executions);
  const visibleExecutions = product === 'all' ? executions : executions.filter((e) => productOf(e) === product);
  const selectedExec = executions.find((e) => e.executionId === selectedId);
  const steps = deriveSteps(selectedExec);
  const hasResults = !!selectedExec?.result?.validationSummary;
  const ctx = selectedExec?.context || {};
  const isMessageExec = selectedExec ? productOf(selectedExec) === 'message' : product === 'message';
  const combCode = toCombCode(selectedExec?.context?.messageCombination || '');

  useEffect(() => { loadExecutions(); }, []);
  useEffect(() => { if (selectedId) loadLogs(selectedId); }, [selectedId]);
  useEffect(() => {
    if (!selectedExec || selectedExec.status !== 'RUNNING') return undefined;
    const t = setInterval(() => { loadExecutions(); if (selectedId) loadLogs(selectedId); }, 3000);
    return () => clearInterval(t);
  }, [selectedExec?.status, selectedId]);
  // Default to Results for a finished run with data, otherwise show the live Logs.
  useEffect(() => {
    if (!selectedExec) return;
    setTab(selectedExec.status === 'COMPLETED' && selectedExec.result?.validationSummary ? 'results' : 'logs');
  }, [selectedId, selectedExec?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  // Load CF jobs when a message execution is selected, and auto-refresh every 15s.
  useEffect(() => {
    if (!isMessageExec) { setCfJobs([]); return undefined; }
    loadCFJobs();
    cfAutoRef.current = setInterval(loadCFJobs, 15000);
    return () => { clearInterval(cfAutoRef.current); };
  }, [isMessageExec]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadExecutions() {
    try {
      const { data } = await getExecutions();
      setExecutions(data);
      if (!selectedId && data.length > 0) setSelectedId(data[0].executionId);
    } catch { /* api may be down */ }
  }
  async function loadLogs(id) {
    setLogsLoading(true);
    try { const { data } = await getExecutionLogs(id); setLogs(data.logs || []); }
    catch { setLogs([]); }
    finally { setLogsLoading(false); }
  }
  async function loadCFJobs() {
    setCfLoading(true);
    setCfError(null);
    try {
      const { data } = await getCFReports({ migrationStatus: 'All' });
      setCfJobs(data.jobs || []);
      setCfRefreshed(new Date());
    } catch (err) {
      setCfError(err.response?.data?.error || err.message || 'Failed to fetch CF jobs');
    } finally {
      setCfLoading(false);
    }
  }
  async function loadWorkspaces(jobId) {
    setExpandedJobs((prev) => ({ ...prev, [jobId]: { loading: true, error: null, rows: prev[jobId]?.rows || [] } }));
    try {
      const { data } = await getCFJobWorkspaces(jobId);
      setExpandedJobs((prev) => ({ ...prev, [jobId]: { loading: false, error: null, rows: data.workspaces || [] } }));
    } catch (err) {
      setExpandedJobs((prev) => ({ ...prev, [jobId]: { loading: false, error: err.response?.data?.error || err.message, rows: [] } }));
    }
  }
  function toggleJob(jobId) {
    setExpandedJobs((prev) => {
      if (prev[jobId]) {
        const next = { ...prev };
        delete next[jobId];
        return next;
      }
      return prev;
    });
    if (!expandedJobs[jobId]) loadWorkspaces(jobId);
  }
  async function handleCancel() {
    setCancelling(true);
    try { await cancelExecution(selectedId); await loadExecutions(); } catch { /* ignore */ } finally { setCancelling(false); }
  }
  async function handleResume() {
    setResuming(true);
    try { await resumeExecution(selectedId); await loadExecutions(); } catch { /* ignore */ } finally { setResuming(false); }
  }
  async function handleDownloadPdf() {
    if (!selectedId) return;
    setDownloading(true);
    try {
      const res = await downloadValidationPdf(selectedId);
      const url = window.URL.createObjectURL(new Blob([res.data], { type: 'application/pdf' }));
      const a = document.createElement('a');
      a.href = url; a.download = `validation-report-${selectedId.slice(0, 8)}.pdf`;
      document.body.appendChild(a); a.click(); a.remove(); window.URL.revokeObjectURL(url);
    } catch (err) { alert('Failed to download PDF: ' + (err.response?.data?.error || err.message)); }
    finally { setDownloading(false); }
  }
  function pickExecution(id) { setSelectedId(id); setMenuOpen(false); }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-gray-900">Reports &amp; Logs</h1>
          {selectedExec ? (
            <p className="text-sm text-gray-500 truncate">
              {ctx.sourceEmail && ctx.destinationEmail
                ? <>{ctx.sourceEmail} <span className="text-gray-400">→</span> {ctx.destinationEmail} · </>
                : null}
              <span className="font-mono text-gray-400">{selectedId.slice(0, 8)}</span>
            </p>
          ) : <p className="text-sm text-gray-500">Open the menu to pick a run</p>}
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          {selectedExec && <StatusBadge status={selectedExec.status} />}
          {hasResults && (
            <button type="button" onClick={handleDownloadPdf} disabled={downloading}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" /></svg>
              {downloading ? 'Generating…' : 'PDF'}
            </button>
          )}
          {selectedExec?.status === 'RUNNING' && (
            <button type="button" onClick={handleCancel} disabled={cancelling}
              className="px-3 py-1.5 text-xs font-medium rounded-lg border border-red-200 bg-red-50 text-red-700 hover:bg-red-100 disabled:opacity-50">
              {cancelling ? 'Cancelling…' : 'Cancel'}
            </button>
          )}
          {selectedExec?.status === 'INTERRUPTED' && (
            <button type="button" onClick={handleResume} disabled={resuming}
              className="px-3 py-1.5 text-xs font-medium rounded-lg border border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 disabled:opacity-50">
              {resuming ? 'Resuming…' : 'Resume'}
            </button>
          )}

          {/* Hamburger → Previous runs dropdown (anchored right) */}
          <div className="relative">
            <button type="button" onClick={() => setMenuOpen((o) => !o)} title="Previous runs"
              className={`p-2 rounded-lg border transition-colors ${menuOpen ? 'border-indigo-400 bg-indigo-50 text-indigo-600' : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50'}`}>
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5M3.75 17.25h16.5" /></svg>
            </button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
                <div className="absolute right-0 mt-2 w-96 max-w-[92vw] bg-white rounded-xl shadow-2xl border border-gray-200 z-20 overflow-hidden">
                  <div className="px-4 py-3 border-b border-gray-100 space-y-2">
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Previous runs ({visibleExecutions.length})</p>
                    <ProductTabs value={product} onChange={setProduct} counts={counts} />
                  </div>
                  <div className="max-h-[60vh] overflow-y-auto divide-y divide-gray-50">
                    {visibleExecutions.length === 0 && <p className="p-4 text-sm text-gray-400">No {product === 'all' ? '' : PRODUCT_LABEL[product] + ' '}runs yet.</p>}
                    {visibleExecutions.map((e) => {
                      const active = e.executionId === selectedId;
                      const src = e.context?.sourceEmail, dst = e.context?.destinationEmail;
                      return (
                        <button key={e.executionId} type="button" onClick={() => pickExecution(e.executionId)}
                          className={`w-full px-4 py-2.5 text-left transition-colors ${active ? 'bg-indigo-50' : 'hover:bg-gray-50'}`}>
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-sm font-medium text-gray-800">{e.executionId.slice(0, 8)}</span>
                            {active && <span className="text-[10px] font-semibold bg-indigo-600 text-white px-1.5 py-0.5 rounded-full">active</span>}
                            <span className="ml-auto"><StatusBadge status={e.status} /></span>
                          </div>
                          <p className="text-xs text-gray-500 truncate mt-0.5">
                            {src && dst ? `${src} → ${dst}` : (e.status || '')}
                            {e.createdAt ? ` · ${new Date(e.createdAt).toLocaleString()}` : ''}
                          </p>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Horizontal agent pipeline */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <ol className="flex items-center w-full">
          {steps.map((s, i) => (
            <li key={s.key} className={`flex items-center ${i < steps.length - 1 ? 'flex-1' : ''}`}>
              <div className="flex items-center gap-2.5" title={s.error || ''}>
                <StepDot status={s.status} index={i + 1} />
                <div className="min-w-0">
                  <p className={`text-sm font-medium whitespace-nowrap ${s.status === 'RUNNING' ? 'text-indigo-700' : s.status === 'SKIPPED' ? 'text-gray-400' : 'text-gray-800'}`}>{s.label}</p>
                  <p className={`text-[11px] ${s.status === 'FAILED' ? 'text-red-500' : 'text-gray-400'}`}>{labelFor(s.status)}</p>
                </div>
              </div>
              {i < steps.length - 1 && <span className={`flex-1 h-0.5 mx-3 rounded ${s.status === 'COMPLETED' ? 'bg-indigo-500' : 'bg-gray-200'}`} />}
            </li>
          ))}
        </ol>
        {selectedExec?.progress && (
          <p className="mt-4 pt-3 border-t border-gray-100 text-xs text-gray-500">{selectedExec.progress}</p>
        )}
      </div>

      {/* Tabs: Results | Logs */}
      <div className="flex items-center gap-1 border-b border-gray-200">
        <Tab label="Results" active={tab === 'results'} onClick={() => setTab('results')} />
        <Tab label="Logs" active={tab === 'logs'} onClick={() => setTab('logs')} />
      </div>

      {tab === 'results' ? (
        <ResultsView exec={selectedExec} />
      ) : logsLoading && logs.length === 0 ? (
        <div className="bg-gray-900 rounded-xl p-6 text-gray-400 text-sm">Loading logs…</div>
      ) : logs.length === 0 ? (
        <div className="bg-gray-900 rounded-xl p-6 text-gray-400 text-sm">No logs yet for this run.</div>
      ) : (
        <LogViewer logs={logs} />
      )}

      {/* CF Migration Jobs — live status from CloudFuze server (message product only) */}
      {isMessageExec && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100">
            <div>
              <h3 className="text-sm font-semibold text-gray-800">CF Migration Jobs</h3>
              <p className="text-xs text-gray-500 mt-0.5">
                Live job status from the CloudFuze server — all combinations
              </p>
            </div>
            <div className="flex items-center gap-3">
              {cfRefreshed && (
                <span className="text-xs text-gray-400">
                  Updated {cfRefreshed.toLocaleTimeString()}
                </span>
              )}
              <button
                type="button"
                onClick={loadCFJobs}
                disabled={cfLoading}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-300 bg-white text-gray-600 hover:bg-gray-50 disabled:opacity-50"
              >
                <svg className={`w-3.5 h-3.5 ${cfLoading ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" />
                </svg>
                {cfLoading ? 'Loading…' : 'Refresh'}
              </button>
            </div>
          </div>

          {cfError && (
            <div className="px-5 py-3 text-sm text-red-600 bg-red-50 border-b border-red-100">
              {cfError}
            </div>
          )}

          {!cfLoading && cfJobs.length === 0 && !cfError ? (
            <div className="p-8 text-center">
              <p className="text-sm text-gray-400">No migration jobs found on the CF server.</p>
              <button type="button" onClick={loadCFJobs} className="mt-2 text-xs text-indigo-600 hover:underline">
                Click to refresh
              </button>
            </div>
          ) : cfJobs.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 text-xs font-medium text-gray-500 uppercase tracking-wide">
                    <th className="px-4 py-2.5 text-left w-6"></th>
                    <th className="px-4 py-2.5 text-left">Job / Channel</th>
                    <th className="px-4 py-2.5 text-left">Type</th>
                    <th className="px-4 py-2.5 text-left">Status</th>
                    <th className="px-4 py-2.5 text-right">Processed / Total</th>
                    <th className="px-4 py-2.5 text-left">Started</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {cfJobs.map((job) => {
                    const jobId = job.id || job.jobId || job._id;
                    const name = job.channelName || job.workSpaceName || job.teamName || jobId || '—';
                    const started = job.initiatedOn || job.createdTime || job.createdAt;
                    const isExpanded = !!expandedJobs[jobId];
                    const ws = expandedJobs[jobId];
                    return (
                      <>
                        <tr
                          key={jobId || name}
                          className="hover:bg-gray-50 transition-colors cursor-pointer select-none"
                          onClick={() => jobId && toggleJob(jobId)}
                        >
                          <td className="px-4 py-2.5 text-gray-400 text-xs">
                            {jobId ? (isExpanded ? '▾' : '▸') : ''}
                          </td>
                          <td className="px-4 py-2.5 font-medium text-gray-800 max-w-xs truncate" title={name}>
                            {name}
                          </td>
                          <td className="px-4 py-2.5 text-gray-500 capitalize text-xs">
                            {job.combination || job.channelType || '—'}
                          </td>
                          <td className="px-4 py-2.5">
                            <CfStatusBadge status={job.migrationStatus} />
                          </td>
                          <td className="px-4 py-2.5 text-right tabular-nums text-gray-700">
                            {job.processedMessages != null ? (
                              <>
                                <span className="font-medium">{job.processedMessages}</span>
                                {job.totalMessages != null && (
                                  <span className="text-gray-400"> / {job.totalMessages}</span>
                                )}
                              </>
                            ) : '—'}
                          </td>
                          <td className="px-4 py-2.5 text-xs text-gray-400">
                            {started ? new Date(Number(started) > 1e10 ? Number(started) : started).toLocaleString() : '—'}
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr key={`ws-${jobId}`}>
                            <td colSpan={6} className="px-0 py-0 bg-gray-50">
                              {ws?.loading ? (
                                <p className="px-10 py-3 text-xs text-gray-400">Loading channels…</p>
                              ) : ws?.error ? (
                                <p className="px-10 py-3 text-xs text-red-500">{ws.error}</p>
                              ) : ws?.rows?.length === 0 ? (
                                <p className="px-10 py-3 text-xs text-gray-400">No channel workspaces found for this job.</p>
                              ) : (
                                <table className="w-full text-xs">
                                  <thead>
                                    <tr className="text-gray-400 uppercase tracking-wide border-b border-gray-200">
                                      <th className="pl-10 pr-4 py-2 text-left">Channel</th>
                                      <th className="px-4 py-2 text-left">Pick Status</th>
                                      <th className="px-4 py-2 text-left">Move Status</th>
                                      <th className="px-4 py-2 text-right">Picked / Total</th>
                                      <th className="px-4 py-2 text-right">Moved</th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-gray-100">
                                    {ws.rows.map((ch, idx) => {
                                      const chName = ch.channelName || ch.workspaceName || ch.teamName || `Channel ${idx + 1}`;
                                      return (
                                        <tr key={ch.id || chName + idx} className="hover:bg-white">
                                          <td className="pl-10 pr-4 py-2 font-medium text-gray-700 max-w-xs truncate" title={chName}>{chName}</td>
                                          <td className="px-4 py-2"><CfStatusBadge status={ch.pickStatus || ch.processStatus} /></td>
                                          <td className="px-4 py-2"><CfStatusBadge status={ch.moveStatus || ch.migrationStatus} /></td>
                                          <td className="px-4 py-2 text-right tabular-nums text-gray-600">
                                            {ch.pickedMessages != null ? <><span className="font-medium">{ch.pickedMessages}</span>{ch.totalMessages != null && <span className="text-gray-400"> / {ch.totalMessages}</span>}</> : '—'}
                                          </td>
                                          <td className="px-4 py-2 text-right tabular-nums text-gray-600">
                                            {ch.movedMessages != null ? ch.movedMessages : ch.processedMessages != null ? ch.processedMessages : '—'}
                                          </td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              )}
                            </td>
                          </tr>
                        )}
                      </>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function Tab({ label, active, onClick }) {
  return (
    <button type="button" onClick={onClick}
      className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${active ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
      {label}
    </button>
  );
}
function labelFor(status) {
  return { PENDING: 'Pending', RUNNING: 'Running…', COMPLETED: 'Done', FAILED: 'Failed', SKIPPED: 'Not run', CANCELLED: 'Cancelled', INTERRUPTED: 'Interrupted' }[status] || status;
}
function StepDot({ status, index }) {
  if (status === 'COMPLETED') return <Dot className="bg-indigo-600 text-white">✓</Dot>;
  if (status === 'FAILED') return <Dot className="bg-red-500 text-white">✕</Dot>;
  if (status === 'RUNNING') return <Dot className="bg-indigo-600 text-white animate-pulse">●</Dot>;
  if (status === 'SKIPPED') return <Dot className="bg-gray-100 text-gray-300 border border-gray-200">–</Dot>;
  return <Dot className="bg-white border-2 border-gray-300 text-gray-400">{index}</Dot>;
}
function Dot({ className, children }) {
  return <span className={`flex items-center justify-center w-7 h-7 rounded-full text-xs font-bold flex-shrink-0 ${className}`}>{children}</span>;
}

function CfStatusBadge({ status }) {
  const s = (status || '').toLowerCase();
  const isComplete = ['completed', 'processed', 'process'].some((k) => s.includes(k));
  const isActive   = ['picking', 'moving', 'progress', 'running', 'active'].some((k) => s.includes(k));
  const isFailed   = ['failed', 'error'].some((k) => s.includes(k));
  const isWarning  = ['conflict', 'pause', 'partial'].some((k) => s.includes(k));
  const cls = isComplete ? 'bg-green-100 text-green-800'
    : isActive   ? 'bg-blue-100 text-blue-700'
    : isFailed   ? 'bg-red-100 text-red-700'
    : isWarning  ? 'bg-yellow-100 text-yellow-800'
    : 'bg-gray-100 text-gray-600';
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
      {isActive && <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse flex-shrink-0" />}
      {status || '—'}
    </span>
  );
}
