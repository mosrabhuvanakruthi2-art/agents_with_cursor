import { useState, useRef, useEffect } from 'react';

const CLEANERS = {
  gchat: {
    name: 'Google Chat Cleaner',
    spaceLabel: 'Spaces', dmLabel: 'Direct Messages',
    colSpaceName: 'Space Name', colSpaceId: 'Space ID',
    deleteVerb: 'Delete',
    preview: '/api/chat-cleaner/preview',
    delete: '/api/chat-cleaner/delete',
    deleteSelected: '/api/chat-cleaner/delete-selected',
    dmNote: null,
  },
  teams: {
    name: 'Teams Cleaner',
    spaceLabel: 'Teams', dmLabel: 'Chats / DMs',
    colSpaceName: 'Team Name', colSpaceId: 'Team ID',
    deleteVerb: 'Delete',
    preview: '/api/chat-cleaner/teams/preview',
    delete: '/api/chat-cleaner/teams/delete',
    deleteSelected: '/api/chat-cleaner/teams/delete-selected',
    dmNote: 'Microsoft Graph does not support deleting Teams chats. Selecting a chat will soft-delete all messages within it — the chat container itself will remain visible in Teams.',
  },
  slack: {
    name: 'Slack Cleaner',
    spaceLabel: 'Channels', dmLabel: 'DMs / Group DMs',
    colSpaceName: 'Channel Name', colSpaceId: 'Channel ID',
    deleteVerb: 'Archive',
    preview: '/api/chat-cleaner/slack/preview',
    delete: '/api/chat-cleaner/slack/delete',
    deleteSelected: '/api/chat-cleaner/slack/delete-selected',
    dmNote: null,
  },
};

export default function CleanSpace() {
  const [cleaner, setCleaner] = useState('gchat');
  const [startDate, setStartDate] = useState('2024-01-01');
  const [endDate, setEndDate] = useState('2024-12-31');
  const [loading, setLoading] = useState(false);
  const [progressMsg, setProgressMsg] = useState('');
  const [previewError, setPreviewError] = useState('');
  const [items, setItems] = useState([]);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [logs, setLogs] = useState([]);
  const [tab, setTab] = useState('spaces');
  const [showConfirmAll, setShowConfirmAll] = useState(false);
  const [showConfirmSel, setShowConfirmSel] = useState(false);
  const [hasResults, setHasResults] = useState(false);
  const [status, setStatus] = useState(null);
  const [statusError, setStatusError] = useState('');
  const [isPartialLoad, setIsPartialLoad] = useState(false);

  const esRef = useRef(null);
  const logRef = useRef(null);

  const cfg = CLEANERS[cleaner];
  const spaces = items.filter(i => i.spaceType === 'SPACE');
  const dms = items.filter(i => i.spaceType !== 'SPACE');
  const dupGroups = detectDuplicates(items);
  const dupCount = dupGroups.reduce((s, g) => s + g.items.length, 0);

  const currentStatus = status ? status[cleaner] : null;
  const isConfigured = currentStatus?.configured !== false;

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/chat-cleaner/status?_=' + Date.now(), {
          cache: 'no-store',
          headers: { 'Cache-Control': 'no-cache' },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) { setStatus(data); setStatusError(''); }
      } catch (err) {
        if (!cancelled) setStatusError(
          `Could not reach the backend (${err.message}). Make sure the Node.js backend is running.`
        );
      }
    })();
    return () => { cancelled = true; };
  }, [cleaner]);

  function switchCleaner(val) {
    setCleaner(val);
    setItems([]);
    setSelectedIds(new Set());
    setLogs([]);
    setHasResults(false);
    setProgressMsg('');
    setPreviewError('');
    setIsPartialLoad(false);
    if (esRef.current) { esRef.current.close(); esRef.current = null; }
  }

  function cancelPreview() {
    if (esRef.current) { esRef.current.close(); esRef.current = null; }
    setLoading(false);
    setProgressMsg('');
    setIsPartialLoad(false);
  }

  function toggleId(id, checked) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      checked ? next.add(id) : next.delete(id);
      return next;
    });
  }

  function toggleAll(list, checked) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      list.forEach(i => checked ? next.add(i.name) : next.delete(i.name));
      return next;
    });
  }

  function runPreview() {
    if (!startDate || !endDate) return alert('Please select both dates.');
    if (startDate > endDate) return alert('End date must be after start date.');
    if (!isConfigured) return;

    setLoading(true);
    setHasResults(false);
    setItems([]);
    setSelectedIds(new Set());
    setLogs([]);
    setProgressMsg('Connecting…');
    setPreviewError('');
    setIsPartialLoad(false);

    if (esRef.current) esRef.current.close();
    const es = new EventSource(`${cfg.preview}?startDate=${startDate}&endDate=${endDate}`);
    esRef.current = es;
    let gotTerminalEvent = false;

    es.addEventListener('progress', ev => setProgressMsg(safeParse(ev.data)));

    es.addEventListener('partial', ev => {
      const data = safeParse(ev.data);
      if (Array.isArray(data)) {
        setItems(data);
        setHasResults(true);
        setIsPartialLoad(true);
        setProgressMsg(`Loaded ${data.length} team(s). Scanning chats…`);
      }
    });

    es.addEventListener('result', ev => {
      gotTerminalEvent = true;
      const data = safeParse(ev.data);
      setItems(Array.isArray(data) ? data : []);
      setHasResults(true);
      setIsPartialLoad(false);
      setLoading(false);
      setProgressMsg('');
      es.close();
    });

    es.addEventListener('fail', ev => {
      gotTerminalEvent = true;
      const msg = safeParse(ev.data);
      setPreviewError(typeof msg === 'string' ? msg : JSON.stringify(msg));
      setLoading(false);
      setProgressMsg('');
      setIsPartialLoad(false);
      es.close();
    });

    es.onerror = () => {
      if (!gotTerminalEvent) {
        setPreviewError(
          cleaner === 'gchat'
            ? 'Connection failed. Sign in via Message Agent (Step 1 → Google tab) with a Google Workspace admin account.'
            : cleaner === 'teams'
            ? 'Connection failed. Check that GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET and GRAPH_TENANT_ID are set in the backend .env file.'
            : 'Connection failed. Sign in via Message Agent (Step 1 → Slack tab) or set SLACK_USER_TOKEN in the backend .env file.'
        );
      }
      setLoading(false);
      setProgressMsg('');
      setIsPartialLoad(false);
      es.close();
    };
  }

  function startDeleteAll() {
    setShowConfirmAll(false);
    setLogs([]);
    setLoading(true);

    if (esRef.current) esRef.current.close();
    const es = new EventSource(`${cfg.delete}?startDate=${startDate}&endDate=${endDate}`);
    esRef.current = es;

    es.addEventListener('log', ev => addLog(safeParse(ev.data), ''));
    es.addEventListener('deleted', ev => {
      const d = safeParse(ev.data);
      addLog(d.msg, 'success');
      setItems(prev => prev.filter(i => i.name !== d.id));
    });
    es.addEventListener('failed', ev => { const d = safeParse(ev.data); addLog(d.msg, 'failed'); });
    es.addEventListener('done', ev => {
      addLog(safeParse(ev.data), 'done');
      setLoading(false);
      es.close();
    });
    es.addEventListener('fail', ev => {
      addLog('ERROR: ' + safeParse(ev.data), 'err');
      setLoading(false);
      es.close();
    });
    es.onerror = () => { setLoading(false); es.close(); };
  }

  async function startDeleteSelected() {
    setShowConfirmSel(false);
    const ids = Array.from(selectedIds);
    if (!ids.length) return;
    setLoading(true);
    setLogs([]);
    addLog(`${cfg.deleteVerb}ing ${ids.length} selected item(s)…`, '');

    try {
      const response = await fetch(cfg.deleteSelected, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ids),
      });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop();

        for (const part of parts) {
          let evtName = '', evtData = '';
          for (const line of part.split('\n')) {
            if (line.startsWith('event:')) evtName = line.slice(6).trim();
            else if (line.startsWith('data:')) evtData = line.slice(5).trim();
          }
          if (!evtData) continue;
          const data = safeParse(evtData);

          if (evtName === 'log') addLog(data, '');
          else if (evtName === 'deleted') {
            addLog(data.msg, 'success');
            setItems(prev => prev.filter(i => i.name !== data.id));
            setSelectedIds(prev => { const n = new Set(prev); n.delete(data.id); return n; });
          }
          else if (evtName === 'failed') addLog(data.msg, 'failed');
          else if (evtName === 'done') { addLog(data, 'done'); setSelectedIds(new Set()); }
          else if (evtName === 'fail') addLog('ERROR: ' + data, 'err');
        }
      }
    } catch (err) {
      addLog('ERROR: ' + err.message, 'err');
    } finally {
      setLoading(false);
    }
  }

  function addLog(msg, cls) {
    setLogs(prev => [...prev, { msg, cls }]);
  }

  function exportCsv() {
    const rows = [['Platform', 'Type', 'Display Name', 'ID', 'Last Activity']];
    for (const item of items) {
      rows.push([cfg.name, item.spaceType, item.displayName, item.name, item.lastActivity || '']);
    }
    const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `clean-msg-destination-${cleaner}-${startDate}-to-${endDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const tabList = [
    { id: 'spaces', label: cfg.spaceLabel, count: spaces.length },
    { id: 'dms', label: cfg.dmLabel, count: dms.length },
    { id: 'dup', label: 'Duplicates', count: dupCount },
  ];

  return (
    <div className="page-wrap">
      {/* ── Header ── */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Clean Msg Destination</h1>
          <p className="page-subtitle">Preview and delete spaces, DMs, and channels by date range</p>
        </div>
        <select
          value={cleaner}
          onChange={e => switchCleaner(e.target.value)}
          style={{ border: '2px solid #0129ac', color: '#0129ac', padding: '10px 16px', fontSize: 14, fontWeight: 700, borderRadius: 8, backgroundColor: '#fff', outline: 'none', cursor: 'pointer' }}
        >
          <option value="gchat">Google Chat{status && !status.gchat?.configured ? ' (not configured)' : ''}</option>
          <option value="teams">Microsoft Teams{status && !status.teams?.configured ? ' (not configured)' : ''}</option>
          <option value="slack">Slack{status && !status.slack?.configured ? ' (not configured)' : ''}</option>
        </select>
      </div>

      {/* ── Backend unreachable ── */}
      {statusError && (
        <div style={{ borderRadius: 10, padding: '14px 18px', backgroundColor: '#fff0f0', border: '1px solid #fca5a5', color: '#991b1b', fontSize: 13 }}>
          <strong>Backend unreachable.</strong> {statusError}
        </div>
      )}

      {/* ── Cleaner not configured ── */}
      {!statusError && status && currentStatus && !currentStatus.configured && (
        <div style={{ borderRadius: 10, padding: '14px 18px', backgroundColor: '#fffbeb', border: '1px solid #fcd34d', color: '#78350f', fontSize: 13 }}>
          <strong>
            {cleaner === 'gchat' && 'Google Chat is not configured.'}
            {cleaner === 'teams' && 'Teams is not configured.'}
            {cleaner === 'slack' && 'Slack is not configured.'}
          </strong>
          <div style={{ marginTop: 6 }}>{currentStatus.reason}</div>
          {cleaner === 'gchat' && (
            <div style={{ marginTop: 8, fontSize: 12 }}>
              Fix: Go to <strong>Message Agent</strong> → Step 1 → Google tab and sign in with a Google Workspace admin account.
            </div>
          )}
          {cleaner === 'teams' && (
            <div style={{ marginTop: 8, fontSize: 12 }}>
              Fix: Add <code style={{ backgroundColor: '#fef3c7', padding: '1px 5px', borderRadius: 3 }}>GRAPH_CLIENT_ID</code>,{' '}
              <code style={{ backgroundColor: '#fef3c7', padding: '1px 5px', borderRadius: 3 }}>GRAPH_CLIENT_SECRET</code>,{' '}
              <code style={{ backgroundColor: '#fef3c7', padding: '1px 5px', borderRadius: 3 }}>GRAPH_TENANT_ID</code> to the backend <code>.env</code> file, then restart the backend.
            </div>
          )}
          {cleaner === 'slack' && (
            <div style={{ marginTop: 8, fontSize: 12 }}>
              Fix: Go to <strong>Message Agent</strong> → Step 1 → Slack tab and connect your Slack account, or add <code style={{ backgroundColor: '#fef3c7', padding: '1px 5px', borderRadius: 3 }}>SLACK_USER_TOKEN</code> to the backend <code>.env</code> file.
            </div>
          )}
        </div>
      )}

      {/* ── Preview error (persistent, shown after loading stops) ── */}
      {previewError && (
        <div style={{ borderRadius: 10, padding: '14px 18px', backgroundColor: '#fff0f0', border: '1px solid #fca5a5', color: '#991b1b', fontSize: 13, display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="#dc2626" style={{ flexShrink: 0, marginTop: 1 }}><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
          <div>
            <strong>Preview failed.</strong>
            <div style={{ marginTop: 4 }}>{previewError}</div>
          </div>
          <button onClick={() => setPreviewError('')} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: '#991b1b', fontSize: 18, lineHeight: 1, flexShrink: 0 }}>×</button>
        </div>
      )}

      {/* ── Date range + action buttons ── */}
      <div className="card">
        <div style={{ padding: '24px 28px' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-end' }}>
            {/* Start Date */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#0129ac' }}>Start Date</label>
              <input
                type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
                style={{ border: '2px solid #c5cef5', color: '#0129ac', padding: '9px 13px', fontSize: 14, borderRadius: 8, outline: 'none', backgroundColor: '#fff' }}
              />
            </div>
            {/* End Date */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#0129ac' }}>End Date</label>
              <input
                type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
                style={{ border: '2px solid #c5cef5', color: '#0129ac', padding: '9px 13px', fontSize: 14, borderRadius: 8, outline: 'none', backgroundColor: '#fff' }}
              />
            </div>

            {/* Preview / Cancel */}
            {!loading ? (
              <button
                onClick={runPreview}
                disabled={!isConfigured}
                title={!isConfigured ? 'Not configured — see banner above' : `Preview ${cfg.name} data in date range`}
                style={{
                  border: '2px solid #0129ac', color: '#0129ac', backgroundColor: '#fff',
                  padding: '9px 22px', fontSize: 14, fontWeight: 700, borderRadius: 8, cursor: isConfigured ? 'pointer' : 'not-allowed',
                  opacity: isConfigured ? 1 : 0.4,
                }}
              >
                Preview
              </button>
            ) : (
              <button
                onClick={cancelPreview}
                style={{ border: '2px solid #dc2626', color: '#dc2626', backgroundColor: '#fff', padding: '9px 22px', fontSize: 14, fontWeight: 700, borderRadius: 8, cursor: 'pointer' }}
              >
                Cancel
              </button>
            )}

            {/* Delete All + Export CSV (shown after preview) */}
            {hasResults && items.length > 0 && !loading && (
              <>
                <button
                  onClick={() => setShowConfirmAll(true)}
                  style={{ padding: '9px 22px', fontSize: 14, fontWeight: 700, borderRadius: 8, cursor: 'pointer', backgroundColor: '#0129ac', color: '#fff', border: '2px solid #0129ac' }}
                >
                  {cfg.deleteVerb} All
                </button>
                <button
                  onClick={exportCsv}
                  style={{ border: '2px solid #059669', color: '#059669', backgroundColor: '#ecfdf5', padding: '9px 22px', fontSize: 14, fontWeight: 700, borderRadius: 8, cursor: 'pointer' }}
                >
                  Export CSV
                </button>
              </>
            )}

            {/* Delete Selected */}
            {selectedIds.size > 0 && !loading && (
              <button
                onClick={() => setShowConfirmSel(true)}
                style={{ border: '2px solid #0129ac', color: '#0129ac', backgroundColor: '#eef1fb', padding: '9px 22px', fontSize: 14, fontWeight: 700, borderRadius: 8, cursor: 'pointer' }}
              >
                {cfg.deleteVerb} Selected ({selectedIds.size})
              </button>
            )}
          </div>

          {/* Loading progress bar */}
          {loading && (
            <div style={{ marginTop: 16, borderRadius: 8, backgroundColor: '#eef1fb', borderLeft: '4px solid #0129ac', padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 18, height: 18, borderRadius: '50%', border: '3px solid #c5cef5', borderTopColor: '#0129ac', animation: 'spin 0.8s linear infinite', flexShrink: 0 }} />
              <span style={{ fontSize: 14, fontWeight: 600, color: '#0129ac', flex: 1 }}>{progressMsg || 'Loading…'}</span>
              {isPartialLoad && <span style={{ fontSize: 12, color: '#4a65c0', backgroundColor: '#c5cef5', padding: '2px 8px', borderRadius: 12 }}>Partial results</span>}
            </div>
          )}
        </div>
      </div>

      {/* ── Results table ── */}
      {hasResults && (
        <div className="card" style={{ overflow: 'hidden' }}>
          {/* Stat boxes */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, padding: '20px 24px' }}>
            <StatBox num={spaces.length} label={cfg.spaceLabel} solid />
            <StatBox num={dms.length} label={cfg.dmLabel} />
            <StatBox num={items.length} label="Total" />
            <StatBox num={dupCount} label="Duplicates" dark />
          </div>

          {/* Empty state */}
          {items.length === 0 && !loading && (
            <div style={{ padding: '40px 24px', textAlign: 'center', color: '#7a8fd4', fontSize: 14 }}>
              No {cfg.spaceLabel.toLowerCase()} or {cfg.dmLabel.toLowerCase()} found in the selected date range.<br />
              <span style={{ fontSize: 13, marginTop: 8, display: 'block' }}>Try expanding the date range.</span>
            </div>
          )}

          {items.length > 0 && (
            <>
              {/* Tabs */}
              <div style={{ display: 'flex', borderBottom: '2px solid #eef1fb' }}>
                {tabList.map(t => (
                  <button
                    key={t.id}
                    onClick={() => setTab(t.id)}
                    style={{
                      padding: '11px 20px', fontSize: 13, fontWeight: 700, cursor: 'pointer', background: 'none',
                      border: 'none', borderBottom: tab === t.id ? '3px solid #0129ac' : '3px solid transparent',
                      marginBottom: '-2px', color: tab === t.id ? '#0129ac' : '#7a8fd4',
                      display: 'flex', alignItems: 'center', gap: 7,
                    }}
                  >
                    {t.label}
                    <span style={{ padding: '2px 8px', borderRadius: 99, fontSize: 11, fontWeight: 800, backgroundColor: tab === t.id ? '#0129ac' : '#eef1fb', color: tab === t.id ? '#fff' : '#4a65c0' }}>
                      {t.count}
                    </span>
                  </button>
                ))}
              </div>

              {/* Spaces tab */}
              {tab === 'spaces' && (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ backgroundColor: '#0129ac', color: '#fff' }}>
                        <th style={{ width: 40, padding: '10px 12px', textAlign: 'center' }}>
                          <input type="checkbox" style={{ accentColor: '#fff' }}
                            checked={spaces.length > 0 && spaces.every(s => selectedIds.has(s.name))}
                            onChange={e => toggleAll(spaces, e.target.checked)}
                          />
                        </th>
                        <th style={{ padding: '10px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>#</th>
                        <th style={{ padding: '10px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{cfg.colSpaceName}</th>
                        <th style={{ padding: '10px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{cfg.colSpaceId}</th>
                        <th style={{ padding: '10px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Last Activity</th>
                      </tr>
                    </thead>
                    <tbody>
                      {spaces.length === 0 ? (
                        <tr><td colSpan={5} style={{ padding: '32px', textAlign: 'center', color: '#7a8fd4' }}>No {cfg.spaceLabel.toLowerCase()} in this date range</td></tr>
                      ) : spaces.map((sp, i) => (
                        <tr key={sp.name} style={{ borderTop: '1px solid #eef1fb', backgroundColor: selectedIds.has(sp.name) ? '#eef1fb' : 'transparent' }}>
                          <td style={{ padding: '9px 12px', textAlign: 'center' }}>
                            <input type="checkbox" style={{ accentColor: '#0129ac' }} checked={selectedIds.has(sp.name)} onChange={e => toggleId(sp.name, e.target.checked)} />
                          </td>
                          <td style={{ padding: '9px 14px', fontSize: 12, color: '#9ca3af' }}>{i + 1}</td>
                          <td style={{ padding: '9px 14px', fontWeight: 600, color: '#0129ac' }}>{sp.displayName}</td>
                          <td style={{ padding: '9px 14px' }}>
                            <span style={{ fontFamily: 'monospace', fontSize: 11, padding: '2px 7px', borderRadius: 4, backgroundColor: '#eef1fb', color: '#0129ac' }}>{sp.name}</span>
                          </td>
                          <td style={{ padding: '9px 14px' }}>
                            <span style={{ fontSize: 11, padding: '2px 7px', borderRadius: 4, backgroundColor: sp.lastActivity ? '#eef1fb' : '#f1f5f9', color: sp.lastActivity ? '#0129ac' : '#9ca3af' }}>
                              {sp.lastActivity || 'N/A'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* DMs tab */}
              {tab === 'dms' && (
                <div>
                  {cfg.dmNote && (
                    <div style={{ margin: '12px 16px 0', padding: '10px 14px', borderRadius: 8, backgroundColor: '#fffbeb', border: '1px solid #fcd34d', fontSize: 12, color: '#78350f', display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="#d97706" style={{ flexShrink: 0, marginTop: 1 }}><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>
                      <span>{cfg.dmNote}</span>
                    </div>
                  )}
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
                      <thead>
                        <tr style={{ backgroundColor: '#0129ac', color: '#fff' }}>
                          <th style={{ width: 40, padding: '10px 12px', textAlign: 'center' }}>
                            <input type="checkbox" style={{ accentColor: '#fff' }}
                              checked={dms.length > 0 && dms.every(s => selectedIds.has(s.name))}
                              onChange={e => toggleAll(dms, e.target.checked)}
                            />
                          </th>
                          <th style={{ padding: '10px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>#</th>
                          <th style={{ padding: '10px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Name</th>
                          <th style={{ padding: '10px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>ID</th>
                          <th style={{ padding: '10px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Type</th>
                          <th style={{ padding: '10px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Last Activity</th>
                        </tr>
                      </thead>
                      <tbody>
                        {dms.length === 0 ? (
                          <tr><td colSpan={6} style={{ padding: '32px', textAlign: 'center', color: '#7a8fd4' }}>No {cfg.dmLabel.toLowerCase()} in this date range</td></tr>
                        ) : dms.map((sp, i) => (
                          <tr key={sp.name} style={{ borderTop: '1px solid #eef1fb', backgroundColor: selectedIds.has(sp.name) ? '#eef1fb' : 'transparent' }}>
                            <td style={{ padding: '9px 12px', textAlign: 'center' }}>
                              <input type="checkbox" style={{ accentColor: '#0129ac' }} checked={selectedIds.has(sp.name)} onChange={e => toggleId(sp.name, e.target.checked)} />
                            </td>
                            <td style={{ padding: '9px 14px', fontSize: 12, color: '#9ca3af' }}>{i + 1}</td>
                            <td style={{ padding: '9px 14px', fontWeight: 600, color: '#0129ac' }}>{sp.displayName}</td>
                            <td style={{ padding: '9px 14px' }}>
                              <span style={{ fontFamily: 'monospace', fontSize: 11, padding: '2px 7px', borderRadius: 4, backgroundColor: '#eef1fb', color: '#0129ac' }}>{sp.name}</span>
                            </td>
                            <td style={{ padding: '9px 14px' }}>
                              <span style={{ fontSize: 11, padding: '2px 7px', borderRadius: 4, fontWeight: 700, backgroundColor: sp.spaceType === 'GROUP_CHAT' ? '#0129ac' : '#eef1fb', color: sp.spaceType === 'GROUP_CHAT' ? '#fff' : '#0129ac' }}>
                                {sp.spaceType === 'GROUP_CHAT' ? 'Group Chat' : 'DM'}
                              </span>
                            </td>
                            <td style={{ padding: '9px 14px' }}>
                              <span style={{ fontSize: 11, padding: '2px 7px', borderRadius: 4, backgroundColor: sp.lastActivity ? '#eef1fb' : '#f1f5f9', color: sp.lastActivity ? '#0129ac' : '#9ca3af' }}>
                                {sp.lastActivity || 'N/A'}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Duplicates tab */}
              {tab === 'dup' && (
                <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
                  {dupGroups.length === 0 ? (
                    <div style={{ padding: '40px', textAlign: 'center', color: '#7a8fd4', fontSize: 14 }}>No duplicate spaces or chats found</div>
                  ) : dupGroups.map((g, gi) => (
                    <div key={gi} style={{ borderRadius: 10, overflow: 'hidden', border: '1.5px solid #0129ac' }}>
                      <div style={{ padding: '10px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#0129ac' }}>
                        <span style={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>{g.name}</span>
                        <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)' }}>{g.items.length} duplicates</span>
                      </div>
                      <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
                        <thead>
                          <tr style={{ backgroundColor: '#eef1fb' }}>
                            <th style={{ width: 40, padding: '8px 12px', textAlign: 'center' }}><input type="checkbox" style={{ accentColor: '#0129ac' }} onChange={e => toggleAll(g.items, e.target.checked)} /></th>
                            <th style={{ padding: '8px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: '#4a65c0' }}>#</th>
                            <th style={{ padding: '8px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: '#4a65c0' }}>ID</th>
                            <th style={{ padding: '8px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: '#4a65c0' }}>Last Activity</th>
                          </tr>
                        </thead>
                        <tbody>
                          {g.items.map((it, i) => (
                            <tr key={it.name} style={{ borderTop: '1px solid #eef1fb', backgroundColor: selectedIds.has(it.name) ? '#eef1fb' : '#fff' }}>
                              <td style={{ padding: '8px 12px', textAlign: 'center' }}><input type="checkbox" style={{ accentColor: '#0129ac' }} checked={selectedIds.has(it.name)} onChange={e => toggleId(it.name, e.target.checked)} /></td>
                              <td style={{ padding: '8px 14px', fontSize: 12, color: '#9ca3af' }}>{i + 1}</td>
                              <td style={{ padding: '8px 14px' }}><span style={{ fontFamily: 'monospace', fontSize: 11, padding: '2px 7px', borderRadius: 4, backgroundColor: '#eef1fb', color: '#0129ac' }}>{it.name}</span></td>
                              <td style={{ padding: '8px 14px' }}><span style={{ fontSize: 11, padding: '2px 7px', borderRadius: 4, backgroundColor: '#eef1fb', color: '#0129ac' }}>{it.lastActivity || 'N/A'}</span></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ── Deletion Logs ── */}
      {logs.length > 0 && (
        <div className="card">
          <div className="card-header"><div className="card-title">Deletion Logs</div></div>
          <div style={{ padding: '16px 24px' }}>
            <div ref={logRef} style={{ borderRadius: 10, padding: '16px 18px', maxHeight: 380, overflowY: 'auto', backgroundColor: '#0c1445', fontSize: 13, fontFamily: 'monospace', display: 'flex', flexDirection: 'column', gap: 3 }}>
              {logs.map((l, i) => (
                <div key={i} style={{
                  color: l.cls === 'success' ? '#6ee7b7'
                    : l.cls === 'done' ? '#fff'
                    : l.cls === 'failed' ? '#fca5a5'
                    : l.cls === 'err' ? '#f87171'
                    : 'rgba(255,255,255,0.65)',
                  fontWeight: l.cls === 'done' ? 800 : l.cls === 'success' ? 600 : 400,
                  lineHeight: 1.7,
                }}>
                  {'> '}{l.msg}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Confirm Delete All ── */}
      {showConfirmAll && (
        <Modal
          title={`Confirm ${cfg.deleteVerb} All`}
          message={`This will ${cfg.deleteVerb.toLowerCase()} all ${items.length} item(s) in the date range ${startDate} → ${endDate}. This action cannot be undone.`}
          confirmLabel={`Yes, ${cfg.deleteVerb} All`}
          onCancel={() => setShowConfirmAll(false)}
          onConfirm={startDeleteAll}
        />
      )}

      {/* ── Confirm Delete Selected ── */}
      {showConfirmSel && (
        <Modal
          title={`Confirm ${cfg.deleteVerb} Selected`}
          message={`This will ${cfg.deleteVerb.toLowerCase()} ${selectedIds.size} selected item(s). This action cannot be undone.`}
          confirmLabel={`Yes, ${cfg.deleteVerb}`}
          onCancel={() => setShowConfirmSel(false)}
          onConfirm={startDeleteSelected}
        />
      )}

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}

function StatBox({ num, label, solid, dark }) {
  const bg = solid ? '#0129ac' : dark ? '#011e8a' : '#eef1fb';
  const col = solid || dark ? '#fff' : '#0129ac';
  return (
    <div style={{ borderRadius: 12, padding: '16px 20px', textAlign: 'center', backgroundColor: bg, border: `1px solid ${bg}` }}>
      <div style={{ fontSize: 32, fontWeight: 900, color: col }}>{num}</div>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 4, color: col, opacity: 0.85 }}>{label}</div>
    </div>
  );
}

function Modal({ title, message, onCancel, onConfirm, confirmLabel = 'Yes, Delete' }) {
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, backgroundColor: 'rgba(1,41,172,0.18)', backdropFilter: 'blur(3px)' }}>
      <div style={{ backgroundColor: '#fff', borderRadius: 18, padding: '32px 36px', maxWidth: 440, width: '90%', boxShadow: '0 20px 60px rgba(1,41,172,0.2)' }}>
        <div style={{ width: 48, height: 48, borderRadius: '50%', backgroundColor: '#eef1fb', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="#0129ac"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>
        </div>
        <h3 style={{ fontSize: 17, fontWeight: 800, color: '#0129ac', margin: '0 0 10px' }}>{title}</h3>
        <p style={{ fontSize: 13, color: '#4a65c0', margin: '0 0 24px', lineHeight: 1.6 }}>{message}</p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} style={{ padding: '9px 20px', borderRadius: 8, fontSize: 13, fontWeight: 700, border: '2px solid #0129ac', color: '#0129ac', backgroundColor: '#fff', cursor: 'pointer' }}>
            Cancel
          </button>
          <button onClick={onConfirm} style={{ padding: '9px 20px', borderRadius: 8, fontSize: 13, fontWeight: 700, border: '2px solid #0129ac', backgroundColor: '#0129ac', color: '#fff', cursor: 'pointer' }}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function detectDuplicates(items) {
  const map = {};
  items.forEach(item => {
    const name = (item.displayName || '').trim();
    if (!name || name === 'Direct Message' || name === 'Group Chat' || name === '1:1 Chat') return;
    const key = item.spaceType + '::' + name.toLowerCase();
    if (!map[key]) map[key] = { name, type: item.spaceType, items: [] };
    map[key].items.push(item);
  });
  return Object.values(map).filter(g => g.items.length > 1);
}

function safeParse(str) {
  try { return JSON.parse(str); } catch { return str; }
}
