import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import MessageAgentForm from '../components/MessageAgentForm';
import StatusBadge from '../components/StatusBadge';
import useMessageAgentExecution from '../hooks/useMessageAgentExecution';
import { startCFBrowserMigration, abortCFBrowserMigration, getCFBrowserEvents, validateCFChatMigration } from '../services/api';

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
    execution, loading, error, run,
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

  // Post-migration close & validate state (One Time Migration only)
  const [lastMigPayload, setLastMigPayload]       = useState(null);
  const [closeState, setCloseState]               = useState('idle');  // idle | loading | done | error
  const [closeLogs, setCloseLogs]                 = useState([]);
  const [closeError, setCloseError]               = useState(null);
  const [validateState, setValidateState]         = useState('idle');  // idle | loading | done | error
  const [validationResult, setValidationResult]   = useState(null);
  const [validateError, setValidateError]         = useState(null);

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
    setLastMigPayload(payload);
    setCfBrowserLoading(true);
    setCfBrowserError(null);
    setCfBrowserStatus(null);
    setCloseState('idle');
    setCloseLogs([]);
    setCloseError(null);
    setValidateState('idle');
    setValidationResult(null);
    setValidateError(null);
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

  // ── Post-migration helpers ────────────────────────────────────────────────

  function getPlatformKey(platform) {
    const p = (platform || '').toLowerCase();
    if (p.includes('google') || p.includes('chat')) return 'gchat';
    if (p.includes('microsoft') || p.includes('team')) return 'teams';
    if (p.includes('slack')) return 'slack';
    return 'gchat';
  }

  function buildCloseIds(payload) {
    const { channelIds = [], dmIds = [], sourcePlatform } = payload;
    const pk = getPlatformKey(sourcePlatform);
    if (pk === 'gchat') {
      return [...channelIds, ...dmIds].map(id => id.startsWith('spaces/') ? id : `spaces/${id}`);
    }
    if (pk === 'teams') {
      const ch = channelIds.map(id => id.startsWith('groups/') ? id : `groups/${id}`);
      const dm = dmIds.map(id => id.startsWith('chats/') ? id : `chats/${id}`);
      return [...ch, ...dm];
    }
    return [...channelIds, ...dmIds]; // Slack: use as-is
  }

  async function handleCloseSource() {
    if (!lastMigPayload) return;
    setCloseState('loading');
    setCloseLogs([]);
    setCloseError(null);

    const pk = getPlatformKey(lastMigPayload.sourcePlatform);
    const endpoint = pk === 'teams' ? '/api/chat-cleaner/teams/delete-selected'
      : pk === 'slack' ? '/api/chat-cleaner/slack/delete-selected'
      : '/api/chat-cleaner/delete-selected';

    const ids = buildCloseIds(lastMigPayload);
    if (ids.length === 0) {
      setCloseState('error');
      setCloseError('No channels or DMs to close.');
      return;
    }

    let closeFailed = false;

    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ids),
      });

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let currentEvent = 'message';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            const raw = line.slice(6).trim();
            let parsed;
            try { parsed = JSON.parse(raw); } catch { parsed = raw; }
            const msg = typeof parsed === 'string' ? parsed : (parsed.msg || JSON.stringify(parsed));
            setCloseLogs(prev => [...prev, { type: currentEvent, msg }]);
            if (currentEvent === 'done') setCloseState('done');
            if (currentEvent === 'fail') { setCloseState('error'); setCloseError(msg); closeFailed = true; }
            currentEvent = 'message';
          }
        }
      }
      setCloseState(prev => prev === 'loading' ? 'done' : prev);
    } catch (err) {
      setCloseState('error');
      setCloseError(err.message || 'Close operation failed');
      closeFailed = true;
    }

    // Auto-trigger validation once close completes successfully
    if (!closeFailed) {
      await handleValidate();
    }
  }

  async function handleValidate() {
    if (!lastMigPayload) return;
    setValidateState('loading');
    setValidationResult(null);
    setValidateError(null);
    try {
      const { data } = await validateCFChatMigration({
        combination:  lastMigPayload.combination || '',
        sourceLabel:  lastMigPayload.sourcePlatform || '',
        destLabel:    lastMigPayload.destinationPlatform || '',
      });
      setValidationResult(data);
      setValidateState('done');
    } catch (err) {
      setValidateState('error');
      setValidateError(err?.response?.data?.error || err.message || 'Validation failed');
    }
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
    <div className="animate-fade-up" style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>

      {/* ── Page Header ── */}
      <div style={{
        borderRadius: 16, overflow: 'hidden',
        background: 'linear-gradient(135deg, #020c6b 0%, #0129ac 60%, #1845d4 100%)',
        boxShadow: '0 6px 32px rgba(1,41,172,0.22)',
      }}>
        <div style={{ padding: '28px 32px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 20, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <div style={{ width: 48, height: 48, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.12)', border: '1.5px solid rgba(255,255,255,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
              </svg>
            </div>
            <div>
              <h1 style={{ fontSize: 22, fontWeight: 800, color: '#fff', margin: 0, letterSpacing: '-0.4px' }}>Message Agent</h1>
              <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.65)', margin: '4px 0 0' }}>
                Map users · Select channels · Seed test data · Migrate · Close source · Validate
              </p>
            </div>
          </div>
          {/* Workflow pill steps */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            {['Map Users', 'Select Channels', 'Seed Data', 'Migrate', 'Close & Validate'].map((step, i, arr) => (
              <div key={step} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.85)', backgroundColor: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 20, padding: '3px 12px', whiteSpace: 'nowrap' }}>
                  {step}
                </span>
                {i < arr.length - 1 && (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.4)" strokeWidth="2.5"><polyline points="9 18 15 12 9 6"/></svg>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Configuration Form ── */}
      <div style={{ borderRadius: 16, overflow: 'hidden', border: '1px solid #c5cef5', boxShadow: '0 2px 12px rgba(1,41,172,0.06)' }}>
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

      {/* ── CF Browser Automation — Live Log ── */}
      {(cfBrowserStatus || cfBrowserError || browserEvents.length > 0) && (
        <div style={{ borderRadius: 16, overflow: 'hidden', border: `2px solid ${cfBrowserError ? '#fca5a5' : '#0129ac'}`, boxShadow: '0 4px 20px rgba(1,41,172,0.12)' }}>
          {/* Header bar */}
          <div style={{
            padding: '14px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap',
            background: cfBrowserError ? 'linear-gradient(135deg, #7f1d1d, #991b1b)' : 'linear-gradient(135deg, #020c6b 0%, #0129ac 100%)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ width: 32, height: 32, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                {browserRunning && !cfBrowserError ? (
                  <svg style={{ width: 14, height: 14, animation: 'spin 1s linear infinite' }} viewBox="0 0 24 24">
                    <circle cx="12" cy="12" r="10" stroke="white" strokeWidth="4" fill="none" opacity="0.3"/>
                    <path fill="white" opacity="0.8" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                  </svg>
                ) : cfBrowserError ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                )}
              </div>
              <div>
                <p style={{ fontSize: 13, fontWeight: 700, color: '#fff', margin: 0 }}>
                  {cfBrowserError ? 'Browser Launch Failed' : browserRunning ? 'Browser Running — Migration in Progress' : 'Migration Submitted to CloudFuze'}
                </p>
                <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', margin: 0 }}>
                  {cfBrowserError ? 'Check the error below and retry' : browserRunning ? `${browserEvents.length} steps completed` : 'Track real-time progress in CloudFuze Reports'}
                </p>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {cfBrowserStatus?.reportsUrl && !cfBrowserError && (
                <a href={cfBrowserStatus.reportsUrl} target="_blank" rel="noreferrer"
                  style={{ fontSize: 12, fontWeight: 700, padding: '6px 16px', borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.15)', color: '#fff', textDecoration: 'none', border: '1px solid rgba(255,255,255,0.25)' }}>
                  Open Reports ↗
                </a>
              )}
              {browserRunning && (
                <button onClick={handleAbortCFBrowser}
                  style={{ fontSize: 12, fontWeight: 700, padding: '6px 14px', borderRadius: 8, backgroundColor: 'rgba(220,38,38,0.25)', color: '#fca5a5', border: '1px solid rgba(252,165,165,0.3)', cursor: 'pointer' }}>
                  Stop
                </button>
              )}
              <button onClick={() => { setCfBrowserStatus(null); setCfBrowserError(null); setBrowserEvents([]); setBrowserRunning(false); if (eventsIntervalRef.current) clearInterval(eventsIntervalRef.current); }}
                style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 8px' }}>
                ✕
              </button>
            </div>
          </div>

          {/* Error state */}
          {cfBrowserError && (
            <div style={{ padding: '16px 20px', backgroundColor: '#fff5f5' }}>
              <p style={{ fontSize: 13, color: '#dc2626', margin: 0, fontWeight: 500 }}>{cfBrowserError}</p>
            </div>
          )}

          {/* Live terminal log */}
          {!cfBrowserError && (
            <div style={{ padding: '16px 20px', maxHeight: 300, overflowY: 'auto', backgroundColor: '#060d1a', fontFamily: 'monospace', fontSize: 11, lineHeight: 1.7 }}>
              {browserEvents.length === 0 ? (
                <p style={{ color: '#4a5568', margin: 0 }}>Launching CloudFuze browser — steps will appear here…</p>
              ) : browserEvents.map((evt, i) => {
                const isError = evt.type === 'error-step' || evt.type === 'failed';
                const isDone  = evt.type === 'done';
                const label   = evt.step || evt.type || '';
                const detail  = evt.detail || evt.error || evt.message || '';
                return (
                  <div key={i} style={{ display: 'flex', gap: 8, color: isError ? '#f87171' : isDone ? '#6ee7b7' : '#c9d1d9', marginBottom: 2 }}>
                    <span style={{ flexShrink: 0, width: 14, color: isError ? '#f87171' : isDone ? '#6ee7b7' : '#4a5568' }}>
                      {isError ? '✗' : isDone ? '✓' : '›'}
                    </span>
                    <span>
                      <strong style={{ color: isError ? '#f87171' : isDone ? '#6ee7b7' : '#7dd3fc' }}>{label}</strong>
                      {detail && <span style={{ color: isError ? '#fca5a5' : isDone ? '#a7f3d0' : '#6b7280' }}> — {detail}</span>}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Footer — reports CTA when done */}
          {!cfBrowserError && !browserRunning && cfBrowserStatus?.reportsUrl && (
            <div style={{ padding: '12px 20px', backgroundColor: '#f0f4ff', borderTop: '1px solid #c5cef5', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#155724' }}>
                Migration jobs running in CloudFuze — check Reports for real-time status
              </span>
              <a href={cfBrowserStatus.reportsUrl} target="_blank" rel="noreferrer"
                style={{ fontSize: 12, fontWeight: 700, padding: '7px 18px', borderRadius: 8, backgroundColor: '#0129ac', color: '#fff', textDecoration: 'none' }}>
                Open CloudFuze Reports ↗
              </a>
            </div>
          )}
        </div>
      )}

      {/* ── Post-Migration Actions — One Time Migration only ── */}
      {lastMigPayload?.migrationType === 'FULL' && !browserRunning && !cfBrowserError && cfBrowserStatus && (
        <div style={{ borderRadius: 16, overflow: 'hidden', border: '2px solid #c5cef5', boxShadow: '0 4px 20px rgba(1,41,172,0.08)' }}>
          {/* Section header */}
          <div style={{ padding: '16px 24px', background: 'linear-gradient(135deg, #020c6b 0%, #0129ac 100%)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
                </svg>
              </div>
              <div>
                <p style={{ fontSize: 14, fontWeight: 800, color: '#fff', margin: 0 }}>Post-Migration Actions</p>
                <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)', margin: 0 }}>One Time Migration · Click Close to archive source, then validation runs automatically</p>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <span style={{ fontSize: 11, padding: '4px 12px', borderRadius: 20, backgroundColor: closeState === 'done' ? 'rgba(110,231,183,0.2)' : 'rgba(255,255,255,0.1)', color: closeState === 'done' ? '#6ee7b7' : 'rgba(255,255,255,0.6)', border: `1px solid ${closeState === 'done' ? 'rgba(110,231,183,0.3)' : 'rgba(255,255,255,0.15)'}`, fontWeight: 700 }}>
                {closeState === 'done' ? '✓ Closed' : closeState === 'loading' ? 'Closing…' : 'Step 1: Close'}
              </span>
              <span style={{ fontSize: 11, padding: '4px 12px', borderRadius: 20, backgroundColor: validateState === 'done' ? 'rgba(110,231,183,0.2)' : 'rgba(255,255,255,0.1)', color: validateState === 'done' ? '#6ee7b7' : 'rgba(255,255,255,0.6)', border: `1px solid ${validateState === 'done' ? 'rgba(110,231,183,0.3)' : 'rgba(255,255,255,0.15)'}`, fontWeight: 700 }}>
                {validateState === 'done' ? '✓ Validated' : validateState === 'loading' ? 'Validating…' : 'Step 2: Validate'}
              </span>
            </div>
          </div>

          <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 20, backgroundColor: '#fff' }}>
            {/* Step 1 — Close */}
            <div style={{ borderRadius: 12, border: `2px solid ${closeState === 'done' ? '#86efac' : closeState === 'error' ? '#fca5a5' : '#e4e9f5'}`, overflow: 'hidden' }}>
              <div style={{ padding: '14px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', backgroundColor: closeState === 'done' ? '#f0fdf4' : '#fafbff' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ width: 32, height: 32, borderRadius: 8, backgroundColor: closeState === 'done' ? '#059669' : '#e4e9f5', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    {closeState === 'done' ? (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                    ) : (
                      <span style={{ fontSize: 12, fontWeight: 800, color: '#0129ac' }}>1</span>
                    )}
                  </div>
                  <div>
                    <p style={{ fontSize: 13, fontWeight: 700, color: closeState === 'done' ? '#065f46' : '#111', margin: 0 }}>
                      Close Source Channels &amp; DMs
                    </p>
                    <p style={{ fontSize: 12, color: '#6b7280', margin: '2px 0 0' }}>
                      Archive / delete migrated source on {lastMigPayload.sourcePlatform}
                      {' '}· {(lastMigPayload.channelIds?.length || 0) + (lastMigPayload.dmIds?.length || 0)} item{((lastMigPayload.channelIds?.length || 0) + (lastMigPayload.dmIds?.length || 0)) !== 1 ? 's' : ''}
                    </p>
                  </div>
                </div>
                <button onClick={handleCloseSource} disabled={closeState === 'loading' || closeState === 'done'}
                  style={{
                    flexShrink: 0, padding: '9px 22px', borderRadius: 9, fontSize: 13, fontWeight: 700, border: 'none',
                    cursor: closeState === 'loading' || closeState === 'done' ? 'not-allowed' : 'pointer',
                    backgroundColor: closeState === 'done' ? '#059669' : closeState === 'loading' ? '#e0e4f5' : '#0129ac',
                    color: closeState === 'loading' ? '#555' : '#fff',
                    boxShadow: closeState === 'idle' ? '0 2px 8px rgba(1,41,172,0.3)' : 'none',
                  }}>
                  {closeState === 'done' ? '✓ Closed' : closeState === 'loading' ? 'Closing…' : 'Close Source'}
                </button>
              </div>

              {(closeLogs.length > 0 || closeState === 'loading') && (
                <div style={{ backgroundColor: '#060d1a', padding: '12px 16px', maxHeight: 160, overflowY: 'auto', fontFamily: 'monospace', fontSize: 11, lineHeight: 1.6 }}>
                  {closeState === 'loading' && closeLogs.length === 0 && (
                    <p style={{ color: '#4a5568', margin: 0 }}>Connecting…</p>
                  )}
                  {closeLogs.map((l, i) => (
                    <div key={i} style={{ color: l.type === 'fail' || l.type === 'failed' ? '#f87171' : l.type === 'done' ? '#6ee7b7' : '#c9d1d9', marginBottom: 2 }}>
                      <span style={{ marginRight: 8 }}>{l.type === 'fail' || l.type === 'failed' ? '✗' : l.type === 'done' ? '✓' : '›'}</span>
                      {l.msg}
                    </div>
                  ))}
                </div>
              )}

              {closeError && (
                <div style={{ padding: '10px 18px', backgroundColor: '#fff5f5', borderTop: '1px solid #fca5a5' }}>
                  <p style={{ fontSize: 12, color: '#dc2626', margin: 0 }}>{closeError}</p>
                </div>
              )}
            </div>

            {/* Arrow between steps */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ flex: 1, height: 1, backgroundColor: '#e4e9f5' }} />
              <span style={{ fontSize: 11, color: '#94a3b8', fontWeight: 600, whiteSpace: 'nowrap' }}>Auto-triggers after Close completes</span>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2"><path d="M12 5v14M5 12l7 7 7-7"/></svg>
              <div style={{ flex: 1, height: 1, backgroundColor: '#e4e9f5' }} />
            </div>

            {/* Step 2 — Validate */}
            <div style={{ borderRadius: 12, border: `2px solid ${validateState === 'done' ? '#86efac' : validateState === 'loading' ? '#c5cef5' : validateState === 'error' ? '#fca5a5' : '#e4e9f5'}`, overflow: 'hidden' }}>
              <div style={{ padding: '14px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', backgroundColor: validateState === 'done' ? '#f0fdf4' : validateState === 'loading' ? '#f0f4ff' : '#fafbff' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ width: 32, height: 32, borderRadius: 8, backgroundColor: validateState === 'done' ? '#059669' : validateState === 'loading' ? '#0129ac' : '#e4e9f5', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    {validateState === 'done' ? (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                    ) : validateState === 'loading' ? (
                      <svg style={{ width: 14, height: 14, animation: 'spin 1s linear infinite' }} viewBox="0 0 24 24">
                        <circle cx="12" cy="12" r="10" stroke="white" strokeWidth="4" fill="none" opacity="0.3"/>
                        <path fill="white" opacity="0.8" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                      </svg>
                    ) : (
                      <span style={{ fontSize: 12, fontWeight: 800, color: '#0129ac' }}>2</span>
                    )}
                  </div>
                  <div>
                    <p style={{ fontSize: 13, fontWeight: 700, color: validateState === 'done' ? '#065f46' : '#111', margin: 0 }}>Validate Migration</p>
                    <p style={{ fontSize: 12, color: '#6b7280', margin: '2px 0 0' }}>
                      Fetches CF jobs · Compares total vs processed messages · Saves to Validation Results
                    </p>
                  </div>
                </div>
                <button onClick={handleValidate} disabled={validateState === 'loading'}
                  style={{
                    flexShrink: 0, padding: '9px 22px', borderRadius: 9, fontSize: 13, fontWeight: 700, border: 'none',
                    cursor: validateState === 'loading' ? 'not-allowed' : 'pointer',
                    backgroundColor: validateState === 'done' ? '#059669' : validateState === 'loading' ? '#e0e4f5' : '#0129ac',
                    color: validateState === 'loading' ? '#555' : '#fff',
                  }}>
                  {validateState === 'done' ? '✓ Validated' : validateState === 'loading' ? 'Validating…' : 'Re-Validate'}
                </button>
              </div>

              {validateError && (
                <div style={{ padding: '10px 18px', backgroundColor: '#fff5f5', borderTop: '1px solid #fca5a5' }}>
                  <p style={{ fontSize: 12, color: '#dc2626', margin: 0 }}>{validateError}</p>
                </div>
              )}

              {validationResult && (
                <div style={{ padding: '16px 18px', backgroundColor: '#f0f4ff', borderTop: '1px solid #c5cef5' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
                    <span style={{
                      fontSize: 12, fontWeight: 800, padding: '4px 14px', borderRadius: 20,
                      backgroundColor: validationResult.overallStatus === 'MATCHED' ? '#d1fae5' : '#fee2e2',
                      color: validationResult.overallStatus === 'MATCHED' ? '#065f46' : '#dc2626',
                      border: `1px solid ${validationResult.overallStatus === 'MATCHED' ? '#a7f3d0' : '#fca5a5'}`,
                    }}>
                      {validationResult.overallStatus}
                    </span>
                    <span style={{ fontSize: 12, color: '#374151' }}>
                      {validationResult.summary?.completedJobs ?? 0}/{validationResult.summary?.totalJobs ?? 0} jobs completed
                      &nbsp;·&nbsp;{validationResult.summary?.totalMessages ?? 0} messages
                      &nbsp;·&nbsp;{validationResult.summary?.mismatches ?? 0} mismatch{(validationResult.summary?.mismatches ?? 0) !== 1 ? 'es' : ''}
                    </span>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    <Link to="/validation-results"
                      style={{ fontSize: 12, fontWeight: 700, padding: '7px 16px', borderRadius: 8, backgroundColor: '#0129ac', color: '#fff', textDecoration: 'none' }}>
                      View Validation Results
                    </Link>
                    {validationResult.executionId && (
                      <a href={`/api/agents/executions/${validationResult.executionId}/pdf`} target="_blank" rel="noreferrer"
                        style={{ fontSize: 12, fontWeight: 700, padding: '7px 16px', borderRadius: 8, border: '1.5px solid #0129ac', color: '#0129ac', textDecoration: 'none' }}>
                        Download PDF Report
                      </a>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
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
