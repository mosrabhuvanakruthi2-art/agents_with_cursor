const statusConfig = {
  COMPLETED: { bg: 'bg-green-100', text: 'text-green-700', dot: 'bg-green-500' },
  SUCCESS: { bg: 'bg-green-100', text: 'text-green-700', dot: 'bg-green-500' },
  PASS: { bg: 'bg-green-100', text: 'text-green-700', dot: 'bg-green-500' },
  RUNNING: { bg: 'bg-yellow-100', text: 'text-yellow-700', dot: 'bg-yellow-500' },
  PENDING: { bg: 'bg-gray-100', text: 'text-gray-600', dot: 'bg-gray-400' },
  FAILED: { bg: 'bg-red-100', text: 'text-red-700', dot: 'bg-red-500' },
  FAIL: { bg: 'bg-red-100', text: 'text-red-700', dot: 'bg-red-500' },
  CANCELLED: { bg: 'bg-orange-100', text: 'text-orange-700', dot: 'bg-orange-500' },
  INTERRUPTED: { bg: 'bg-purple-100', text: 'text-purple-700', dot: 'bg-purple-500' },
  PARTIAL:     { bg: 'bg-amber-100',  text: 'text-amber-700',  dot: 'bg-amber-500'  },
  INCOMPLETE:  { bg: 'bg-purple-100', text: 'text-purple-700', dot: 'bg-purple-400' },
  SKIPPED:     { bg: 'bg-gray-100',   text: 'text-gray-500',   dot: 'bg-gray-400'   },
};

export default function StatusBadge({ status }) {
  const config = statusConfig[status] || statusConfig.PENDING;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium ${config.bg} ${config.text}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${config.dot}`} />
      {status}
    </span>
  );
}
