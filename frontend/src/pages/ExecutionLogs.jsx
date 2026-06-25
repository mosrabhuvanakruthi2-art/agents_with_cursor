import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { getExecutions, getExecutionLogs, cancelExecution, resumeExecution, downloadValidationPdf } from '../services/api';
import StatusBadge from '../components/StatusBadge';
import LogViewer from '../components/LogViewer';
import ResultsView from '../components/ResultsView';
import ProductTabs from '../components/ProductTabs';
import { productOf, productCounts, PRODUCT_LABEL } from '../utils/product';

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

  const counts = productCounts(executions);
  const visibleExecutions = product === 'all' ? executions : executions.filter((e) => productOf(e) === product);
  // Collapse a bulk run into ONE entry (keyed by bulkId) so the list shows one row per run and
  // there's a single PDF button — its download already combines all pairs into one report.
  const groupedExecutions = (() => {
    const seen = new Set();
    const out = [];
    for (const e of visibleExecutions) {
      const bid = e.context?.bulkId;
      if (bid) { if (seen.has(bid)) continue; seen.add(bid); }
      out.push(e);
    }
    return out;
  })();
  const selectedExec = executions.find((e) => e.executionId === selectedId);
  const steps = deriveSteps(selectedExec);
  const hasResults = !!selectedExec?.result?.validationSummary;
  const ctx = selectedExec?.context || {};

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
      // Bulk runs return one combined report (all pairs) — name the file accordingly so repeated
      // downloads (from any pair) resolve to the same file rather than N per-pair names.
      const bulkId = selectedExec?.context?.bulkId;
      a.href = url;
      a.download = bulkId
        ? `bulk-validation-report-${String(bulkId).slice(0, 8)}.pdf`
        : `validation-report-${selectedId.slice(0, 8)}.pdf`;
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
          {selectedExec ? (() => {
            const pairCount = Array.isArray(ctx.userEmailMappings) ? ctx.userEmailMappings.length : 0;
            const isBulk = pairCount > 1;
            return (
              <p className="text-sm text-gray-500 truncate">
                {isBulk ? (
                  <span className="inline-flex items-center gap-1 mr-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-indigo-100 text-indigo-700">
                    Bulk · {pairCount} pairs
                  </span>
                ) : ctx.sourceEmail && ctx.destinationEmail ? (
                  <>{ctx.sourceEmail} <span className="text-gray-400">→</span> {ctx.destinationEmail} · </>
                ) : null}
                <span className="font-mono text-gray-400">{selectedId.slice(0, 8)}</span>
              </p>
            );
          })() : <p className="text-sm text-gray-500">Open the menu to pick a run</p>}
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
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Previous runs ({groupedExecutions.length})</p>
                    <ProductTabs value={product} onChange={setProduct} counts={counts} />
                  </div>
                  <div className="max-h-[60vh] overflow-y-auto divide-y divide-gray-50">
                    {groupedExecutions.length === 0 && <p className="p-4 text-sm text-gray-400">No {product === 'all' ? '' : PRODUCT_LABEL[product] + ' '}runs yet.</p>}
                    {groupedExecutions.map((e) => {
                      const active = e.executionId === selectedId;
                      const src = e.context?.sourceEmail, dst = e.context?.destinationEmail;
                      const mappings = e.context?.userEmailMappings;
                      const bulkCount = Array.isArray(mappings) && mappings.length > 1 ? mappings.length : 0;
                      return (
                        <button key={e.executionId} type="button" onClick={() => pickExecution(e.executionId)}
                          className={`w-full px-4 py-2.5 text-left transition-colors ${active ? 'bg-indigo-50' : 'hover:bg-gray-50'}`}>
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-sm font-medium text-gray-800">{e.executionId.slice(0, 8)}</span>
                            {bulkCount > 0 && <span className="text-[10px] font-semibold bg-indigo-100 text-indigo-700 px-1.5 py-0.5 rounded-full">Bulk · {bulkCount}</span>}
                            {active && <span className="text-[10px] font-semibold bg-indigo-600 text-white px-1.5 py-0.5 rounded-full">active</span>}
                            <span className="ml-auto"><StatusBadge status={e.status} /></span>
                          </div>
                          <p className="text-xs text-gray-500 truncate mt-0.5">
                            {bulkCount > 0 ? `${bulkCount} pairs` : (src && dst ? `${src} → ${dst}` : (e.status || ''))}
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
