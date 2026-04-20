export default function LogViewer({ logs }) {
  if (!logs || logs.length === 0) {
    return (
      <div className="rounded-xl p-6 text-sm" style={{ backgroundColor: '#0129ac', color: 'rgba(255,255,255,0.6)' }}>
        No logs available
      </div>
    );
  }

  return (
    <div className="rounded-xl overflow-hidden" style={{ backgroundColor: '#0129ac' }}>
      <div className="px-4 py-3 flex items-center gap-2" style={{ backgroundColor: '#011e8a', borderBottom: '1px solid rgba(255,255,255,0.15)' }}>
        <div className="flex gap-1.5">
          <span className="w-3 h-3 rounded-full" style={{ backgroundColor: 'rgba(255,255,255,0.3)' }} />
          <span className="w-3 h-3 rounded-full" style={{ backgroundColor: 'rgba(255,255,255,0.5)' }} />
          <span className="w-3 h-3 rounded-full" style={{ backgroundColor: 'rgba(255,255,255,0.8)' }} />
        </div>
        <span className="text-xs ml-2" style={{ color: 'rgba(255,255,255,0.6)' }}>Execution Logs</span>
      </div>
      <div className="p-4 max-h-96 overflow-y-auto font-mono text-xs space-y-0.5">
        {logs.map((log, idx) => (
          <div key={idx} className="flex gap-3">
            <span className="select-none flex-shrink-0" style={{ color: 'rgba(255,255,255,0.3)' }}>{String(idx + 1).padStart(3, ' ')}</span>
            <span style={{ color: getLogColor(log.level) }}>
              {log.timestamp && (
                <span style={{ color: 'rgba(255,255,255,0.4)' }}>{new Date(log.timestamp).toLocaleTimeString()} </span>
              )}
              {log.level && <span className="uppercase">[{log.level}] </span>}
              {log.agent && <span style={{ color: '#93b4ff' }}>({log.agent}) </span>}
              <span>{log.message}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function getLogColor(level) {
  switch (level) {
    case 'error': return '#ff9999';
    case 'warn':  return '#ffe066';
    case 'info':  return '#99ccff';
    default:      return 'rgba(255,255,255,0.85)';
  }
}
