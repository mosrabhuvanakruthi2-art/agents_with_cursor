export default function LogViewer({ logs }) {
  if (!logs || logs.length === 0) {
    return (
      <div className="bg-gray-900 rounded-xl p-6 text-gray-400 text-sm">
        No logs available
      </div>
    );
  }

  return (
    <div className="bg-gray-900 rounded-xl overflow-hidden">
      <div className="px-4 py-3 bg-gray-800 border-b border-gray-700 flex items-center gap-2">
        <div className="flex gap-1.5">
          <span className="w-3 h-3 rounded-full bg-red-500" />
          <span className="w-3 h-3 rounded-full bg-yellow-500" />
          <span className="w-3 h-3 rounded-full bg-green-500" />
        </div>
        <span className="text-xs text-gray-400 ml-2">Execution Logs</span>
      </div>
      <div className="p-4 max-h-96 overflow-y-auto font-mono text-xs space-y-0.5">
        {logs.map((log, idx) => (
          <div key={idx} className="flex gap-3">
            <span className="text-gray-600 select-none flex-shrink-0">{String(idx + 1).padStart(3, ' ')}</span>
            <span className={getLogColor(log.level)}>
              {log.timestamp && (
                <span className="text-gray-500">{new Date(log.timestamp).toLocaleTimeString()} </span>
              )}
              {log.level && <span className="uppercase">[{log.level}] </span>}
              {log.agent && <span className="text-cyan-400">({log.agent}) </span>}
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
    case 'error': return 'text-red-400';
    case 'warn': return 'text-yellow-400';
    case 'info': return 'text-green-400';
    default: return 'text-gray-300';
  }
}
