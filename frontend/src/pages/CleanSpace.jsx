import { useState, useRef, useEffect } from 'react';

const CLEANERS = {
  gchat: {
    name: 'Google Chat Cleaner',
    spaceLabel: 'Spaces', dmLabel: 'Direct Messages',
    preview: '/api/chat-cleaner/preview',
    delete: '/api/chat-cleaner/delete',
    deleteSelected: '/api/chat-cleaner/delete-selected',
  },
  teams: {
    name: 'Teams Cleaner',
    spaceLabel: 'Teams', dmLabel: 'Chats / DMs',
    preview: '/api/chat-cleaner/teams/preview',
    delete: '/api/chat-cleaner/teams/delete',
    deleteSelected: '/api/chat-cleaner/teams/delete-selected',
  },
};

export default function CleanSpace() {
  const [cleaner, setCleaner] = useState('gchat');
  const [startDate, setStartDate] = useState('2024-01-01');
  const [endDate, setEndDate] = useState('2024-12-31');
  const [loading, setLoading] = useState(false);
  const [progressMsg, setProgressMsg] = useState('');
  const [items, setItems] = useState([]);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [logs, setLogs] = useState([]);
  const [tab, setTab] = useState('spaces');
  const [showConfirmAll, setShowConfirmAll] = useState(false);
  const [showConfirmSel, setShowConfirmSel] = useState(false);
  const [hasResults, setHasResults] = useState(false);

  const esRef = useRef(null);
  const logRef = useRef(null);

  const cfg = CLEANERS[cleaner];
  const spaces = items.filter(i => i.spaceType === 'SPACE');
  const dms = items.filter(i => i.spaceType !== 'SPACE');
  const dupGroups = detectDuplicates(items);
  const dupCount = dupGroups.reduce((s, g) => s + g.items.length, 0);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  function switchCleaner(val) {
    setCleaner(val);
    setItems([]);
    setSelectedIds(new Set());
    setLogs([]);
    setHasResults(false);
    setProgressMsg('');
    if (esRef.current) { esRef.current.close(); esRef.current = null; }
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
    setLoading(true);
    setHasResults(false);
    setItems([]);
    setSelectedIds(new Set());
    setLogs([]);
    setProgressMsg('Connecting...');

    if (esRef.current) esRef.current.close();
    const es = new EventSource(`${cfg.preview}?startDate=${startDate}&endDate=${endDate}`);
    esRef.current = es;

    es.addEventListener('progress', ev => setProgressMsg(safeParse(ev.data)));
    es.addEventListener('result', ev => {
      const data = safeParse(ev.data);
      setItems(Array.isArray(data) ? data : []);
      setHasResults(true);
      setLoading(false);
      es.close();
    });
    es.addEventListener('fail', ev => {
      setProgressMsg('Error: ' + safeParse(ev.data));
      setLoading(false);
      es.close();
    });
    es.onerror = () => { setLoading(false); es.close(); };
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
    addLog(`Deleting ${ids.length} selected item(s)...`, '');

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
          else if (evtName === 'deleted') { addLog(data.msg, 'success'); setItems(prev => prev.filter(i => i.name !== data.id)); setSelectedIds(prev => { const n = new Set(prev); n.delete(data.id); return n; }); }
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

  const tabList = [
    { id: 'spaces', label: cfg.spaceLabel, count: spaces.length },
    { id: 'dms', label: cfg.dmLabel, count: dms.length },
    { id: 'dup', label: 'Duplicates', count: dupCount },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: '#0129ac' }}>Clean Space</h1>
          <p className="text-sm mt-1" style={{ color: '#4a65c0' }}>Delete spaces, DMs, and channels by date range</p>
        </div>
        <select
          value={cleaner}
          onChange={e => switchCleaner(e.target.value)}
          className="px-4 py-2 rounded-lg text-sm font-semibold outline-none bg-white"
          style={{ border: '2px solid #0129ac', color: '#0129ac' }}
        >
          <option value="gchat">Google Chat Cleaner</option>
          <option value="teams">Teams Cleaner</option>
        </select>
      </div>

      {/* Date range + actions */}
      <div className="bg-white rounded-xl p-6 space-y-4" style={{ border: '1px solid #c5cef5' }}>
        <div className="flex flex-wrap gap-4 items-end">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-bold uppercase tracking-wider" style={{ color: '#0129ac' }}>Start Date</label>
            <input
              type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
              className="px-3 py-2 rounded-lg text-sm outline-none bg-white"
              style={{ border: '2px solid #c5cef5', color: '#0129ac' }}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-bold uppercase tracking-wider" style={{ color: '#0129ac' }}>End Date</label>
            <input
              type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
              className="px-3 py-2 rounded-lg text-sm outline-none bg-white"
              style={{ border: '2px solid #c5cef5', color: '#0129ac' }}
            />
          </div>
          <button
            onClick={runPreview} disabled={loading}
            className="px-5 py-2 rounded-lg text-sm font-bold transition-all disabled:opacity-40"
            style={{ border: '2px solid #0129ac', color: '#0129ac', backgroundColor: '#fff' }}
          >
            Preview
          </button>
          {hasResults && items.length > 0 && (
            <button
              onClick={() => setShowConfirmAll(true)} disabled={loading}
              className="px-5 py-2 rounded-lg text-sm font-bold text-white transition-all disabled:opacity-40"
              style={{ backgroundColor: '#0129ac' }}
            >
              Delete All
            </button>
          )}
          {selectedIds.size > 0 && (
            <button
              onClick={() => setShowConfirmSel(true)} disabled={loading}
              className="px-5 py-2 rounded-lg text-sm font-bold transition-all disabled:opacity-40"
              style={{ border: '2px solid #0129ac', color: '#0129ac', backgroundColor: '#eef1fb' }}
            >
              Delete Selected ({selectedIds.size})
            </button>
          )}
        </div>

        {loading && (
          <div className="flex items-center gap-3 px-4 py-3 rounded-lg" style={{ backgroundColor: '#eef1fb', borderLeft: '4px solid #0129ac' }}>
            <div className="w-4 h-4 rounded-full border-2 border-t-transparent animate-spin" style={{ borderColor: '#c5cef5', borderTopColor: '#0129ac' }} />
            <span className="text-sm font-medium" style={{ color: '#0129ac' }}>{progressMsg || 'Loading...'}</span>
          </div>
        )}
      </div>

      {/* Stats + Results */}
      {hasResults && (
        <div className="bg-white rounded-xl overflow-hidden" style={{ border: '1px solid #c5cef5' }}>
          {/* Stat boxes */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 p-6">
            <StatBox num={spaces.length} label={cfg.spaceLabel} solid />
            <StatBox num={dms.length} label={cfg.dmLabel} />
            <StatBox num={items.length} label="Total" />
            <StatBox num={dupCount} label="Duplicates" dark />
          </div>

          {/* Tabs */}
          <div className="flex" style={{ borderBottom: '2px solid #eef1fb' }}>
            {tabList.map(t => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className="px-5 py-3 text-sm font-bold flex items-center gap-2 transition-colors"
                style={{
                  color: tab === t.id ? '#0129ac' : '#7a8fd4',
                  borderBottom: tab === t.id ? '3px solid #0129ac' : '3px solid transparent',
                  marginBottom: '-2px',
                  backgroundColor: 'transparent',
                  border: 'none',
                  borderBottom: tab === t.id ? '3px solid #0129ac' : '3px solid transparent',
                  cursor: 'pointer',
                }}
              >
                {t.label}
                <span className="px-2 py-0.5 rounded-full text-xs font-bold" style={{ backgroundColor: tab === t.id ? '#0129ac' : '#eef1fb', color: tab === t.id ? '#fff' : '#4a65c0' }}>
                  {t.count}
                </span>
              </button>
            ))}
          </div>

          {/* Spaces tab */}
          {tab === 'spaces' && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ backgroundColor: '#0129ac', color: '#fff' }}>
                    <th className="w-10 px-3 py-3 text-center">
                      <input type="checkbox" style={{ accentColor: '#fff' }}
                        checked={spaces.length > 0 && spaces.every(s => selectedIds.has(s.name))}
                        onChange={e => toggleAll(spaces, e.target.checked)}
                      />
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-bold uppercase">#</th>
                    <th className="px-4 py-3 text-left text-xs font-bold uppercase">{cfg.spaceLabel} Name</th>
                    <th className="px-4 py-3 text-left text-xs font-bold uppercase">{cfg.spaceLabel} ID</th>
                    <th className="px-4 py-3 text-left text-xs font-bold uppercase">Last Activity</th>
                  </tr>
                </thead>
                <tbody>
                  {spaces.length === 0 ? (
                    <tr><td colSpan={5} className="px-4 py-8 text-center text-sm" style={{ color: '#7a8fd4' }}>No {cfg.spaceLabel.toLowerCase()} in this date range</td></tr>
                  ) : spaces.map((sp, i) => (
                    <tr key={sp.name} className="border-t" style={{ borderColor: '#eef1fb', backgroundColor: selectedIds.has(sp.name) ? '#eef1fb' : 'transparent' }}>
                      <td className="px-3 py-2.5 text-center">
                        <input type="checkbox" style={{ accentColor: '#0129ac' }} checked={selectedIds.has(sp.name)} onChange={e => toggleId(sp.name, e.target.checked)} />
                      </td>
                      <td className="px-4 py-2.5 text-xs" style={{ color: '#7a8fd4' }}>{i + 1}</td>
                      <td className="px-4 py-2.5 font-medium" style={{ color: '#0129ac' }}>{sp.displayName}</td>
                      <td className="px-4 py-2.5">
                        <span className="font-mono text-xs px-2 py-1 rounded" style={{ backgroundColor: '#eef1fb', color: '#0129ac' }}>{sp.name}</span>
                      </td>
                      <td className="px-4 py-2.5">
                        <span className="text-xs px-2 py-1 rounded" style={{ backgroundColor: '#eef1fb', color: '#0129ac' }}>{sp.lastActivity || 'N/A'}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* DMs tab */}
          {tab === 'dms' && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ backgroundColor: '#0129ac', color: '#fff' }}>
                    <th className="w-10 px-3 py-3 text-center">
                      <input type="checkbox" style={{ accentColor: '#fff' }}
                        checked={dms.length > 0 && dms.every(s => selectedIds.has(s.name))}
                        onChange={e => toggleAll(dms, e.target.checked)}
                      />
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-bold uppercase">#</th>
                    <th className="px-4 py-3 text-left text-xs font-bold uppercase">Name</th>
                    <th className="px-4 py-3 text-left text-xs font-bold uppercase">ID</th>
                    <th className="px-4 py-3 text-left text-xs font-bold uppercase">Type</th>
                    <th className="px-4 py-3 text-left text-xs font-bold uppercase">Last Activity</th>
                  </tr>
                </thead>
                <tbody>
                  {dms.length === 0 ? (
                    <tr><td colSpan={6} className="px-4 py-8 text-center text-sm" style={{ color: '#7a8fd4' }}>No {cfg.dmLabel.toLowerCase()} in this date range</td></tr>
                  ) : dms.map((sp, i) => (
                    <tr key={sp.name} className="border-t" style={{ borderColor: '#eef1fb', backgroundColor: selectedIds.has(sp.name) ? '#eef1fb' : 'transparent' }}>
                      <td className="px-3 py-2.5 text-center">
                        <input type="checkbox" style={{ accentColor: '#0129ac' }} checked={selectedIds.has(sp.name)} onChange={e => toggleId(sp.name, e.target.checked)} />
                      </td>
                      <td className="px-4 py-2.5 text-xs" style={{ color: '#7a8fd4' }}>{i + 1}</td>
                      <td className="px-4 py-2.5 font-medium" style={{ color: '#0129ac' }}>{sp.displayName}</td>
                      <td className="px-4 py-2.5">
                        <span className="font-mono text-xs px-2 py-1 rounded" style={{ backgroundColor: '#eef1fb', color: '#0129ac' }}>{sp.name}</span>
                      </td>
                      <td className="px-4 py-2.5">
                        <span className="text-xs px-2 py-1 rounded font-bold" style={{ backgroundColor: sp.spaceType === 'GROUP_CHAT' ? '#0129ac' : '#eef1fb', color: sp.spaceType === 'GROUP_CHAT' ? '#fff' : '#0129ac' }}>
                          {sp.spaceType === 'GROUP_CHAT' ? 'Group Chat' : 'DM'}
                        </span>
                      </td>
                      <td className="px-4 py-2.5">
                        <span className="text-xs px-2 py-1 rounded" style={{ backgroundColor: '#eef1fb', color: '#0129ac' }}>{sp.lastActivity || 'N/A'}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Duplicates tab */}
          {tab === 'dup' && (
            <div className="p-4 space-y-4">
              {dupGroups.length === 0 ? (
                <div className="py-10 text-center text-sm" style={{ color: '#7a8fd4' }}>No duplicate spaces or DMs found in this date range</div>
              ) : dupGroups.map((g, gi) => (
                <div key={gi} className="rounded-xl overflow-hidden" style={{ border: '1.5px solid #0129ac' }}>
                  <div className="px-4 py-3 flex items-center justify-between" style={{ backgroundColor: '#0129ac' }}>
                    <span className="text-sm font-bold text-white">{g.name}</span>
                    <span className="text-xs text-white/80">{g.items.length} duplicates</span>
                  </div>
                  <table className="w-full text-sm">
                    <thead>
                      <tr style={{ backgroundColor: '#eef1fb' }}>
                        <th className="w-10 px-3 py-2 text-center"><input type="checkbox" style={{ accentColor: '#0129ac' }} onChange={e => toggleAll(g.items, e.target.checked)} /></th>
                        <th className="px-4 py-2 text-left text-xs font-bold uppercase" style={{ color: '#4a65c0' }}>#</th>
                        <th className="px-4 py-2 text-left text-xs font-bold uppercase" style={{ color: '#4a65c0' }}>Internal Name</th>
                        <th className="px-4 py-2 text-left text-xs font-bold uppercase" style={{ color: '#4a65c0' }}>Last Activity</th>
                      </tr>
                    </thead>
                    <tbody>
                      {g.items.map((it, i) => (
                        <tr key={it.name} className="border-t" style={{ borderColor: '#eef1fb', backgroundColor: selectedIds.has(it.name) ? '#eef1fb' : '#fff' }}>
                          <td className="px-3 py-2 text-center"><input type="checkbox" style={{ accentColor: '#0129ac' }} checked={selectedIds.has(it.name)} onChange={e => toggleId(it.name, e.target.checked)} /></td>
                          <td className="px-4 py-2 text-xs" style={{ color: '#7a8fd4' }}>{i + 1}</td>
                          <td className="px-4 py-2"><span className="font-mono text-xs px-2 py-0.5 rounded" style={{ backgroundColor: '#eef1fb', color: '#0129ac' }}>{it.name}</span></td>
                          <td className="px-4 py-2"><span className="text-xs px-2 py-0.5 rounded" style={{ backgroundColor: '#eef1fb', color: '#0129ac' }}>{it.lastActivity || 'N/A'}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Deletion Logs */}
      {logs.length > 0 && (
        <div className="bg-white rounded-xl p-6" style={{ border: '1px solid #c5cef5' }}>
          <h3 className="text-xs font-bold uppercase tracking-wider mb-4" style={{ color: '#0129ac' }}>Deletion Logs</h3>
          <div ref={logRef} className="rounded-xl p-5 max-h-96 overflow-y-auto font-mono text-xs space-y-0.5" style={{ backgroundColor: '#0129ac' }}>
            {logs.map((l, i) => (
              <div key={i} className="leading-loose" style={{
                color: l.cls === 'success' ? '#fff'
                  : l.cls === 'done' ? '#fff'
                  : l.cls === 'failed' ? 'rgba(255,255,255,0.4)'
                  : l.cls === 'err' ? 'rgba(255,255,255,0.5)'
                  : 'rgba(255,255,255,0.7)',
                fontWeight: l.cls === 'done' ? 800 : l.cls === 'success' ? 600 : 400,
              }}>
                {'> '}{l.msg}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Confirm Delete All */}
      {showConfirmAll && (
        <Modal
          title="Confirm Delete All"
          message={`This will permanently delete ${spaces.length} space(s) and ${dms.length} direct message(s) including ${dupCount} duplicate(s). This action cannot be undone.`}
          onCancel={() => setShowConfirmAll(false)}
          onConfirm={startDeleteAll}
        />
      )}

      {/* Confirm Delete Selected */}
      {showConfirmSel && (
        <Modal
          title="Confirm Delete Selected"
          message={`This will permanently delete ${selectedIds.size} selected item(s). This action cannot be undone.`}
          onCancel={() => setShowConfirmSel(false)}
          onConfirm={startDeleteSelected}
        />
      )}
    </div>
  );
}

function StatBox({ num, label, solid, dark }) {
  const style = solid
    ? { backgroundColor: '#0129ac', color: '#fff', borderColor: '#0129ac' }
    : dark
    ? { backgroundColor: '#011e8a', color: '#fff', borderColor: '#011e8a' }
    : { backgroundColor: '#eef1fb', color: '#0129ac', borderColor: '#c5cef5' };

  return (
    <div className="rounded-xl border p-4 text-center" style={style}>
      <div className="text-3xl font-black">{num}</div>
      <div className="text-xs font-bold uppercase tracking-wider mt-1 opacity-80">{label}</div>
    </div>
  );
}

function Modal({ title, message, onCancel, onConfirm }) {
  return (
    <div className="fixed inset-0 flex items-center justify-center z-50" style={{ backgroundColor: 'rgba(1,41,172,0.2)', backdropFilter: 'blur(3px)' }}>
      <div className="bg-white rounded-2xl p-8 max-w-md w-[90%] shadow-2xl">
        <div className="w-12 h-12 rounded-full flex items-center justify-center mb-4" style={{ backgroundColor: '#eef1fb' }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="#0129ac"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>
        </div>
        <h3 className="text-lg font-bold mb-3" style={{ color: '#0129ac' }}>{title}</h3>
        <p className="text-sm mb-6" style={{ color: '#4a65c0' }}>{message}</p>
        <div className="flex gap-3 justify-end">
          <button onClick={onCancel} className="px-4 py-2 rounded-lg text-sm font-bold transition-colors" style={{ border: '2px solid #0129ac', color: '#0129ac', backgroundColor: '#fff' }}>
            Cancel
          </button>
          <button onClick={onConfirm} className="px-4 py-2 rounded-lg text-sm font-bold text-white transition-colors" style={{ backgroundColor: '#0129ac' }}>
            Yes, Delete
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
    if (!name || name === 'Direct Message' || name === 'Group Chat') return;
    const key = item.spaceType + '::' + name.toLowerCase();
    if (!map[key]) map[key] = { name, type: item.spaceType, items: [] };
    map[key].items.push(item);
  });
  return Object.values(map).filter(g => g.items.length > 1);
}

function safeParse(str) {
  try { return JSON.parse(str); } catch { return str; }
}
