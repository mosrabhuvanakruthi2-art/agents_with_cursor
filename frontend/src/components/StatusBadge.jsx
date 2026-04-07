const statusConfig = {
  COMPLETED: { bg: 'bg-green-100', text: 'text-green-700', dot: 'bg-green-500' },
  SUCCESS: { bg: 'bg-green-100', text: 'text-green-700', dot: 'bg-green-500' },
  PASS: { bg: 'bg-green-100', text: 'text-green-700', dot: 'bg-green-500' },
  RUNNING: { bg: 'bg-yellow-100', text: 'text-yellow-700', dot: 'bg-yellow-500' },
  PENDING: { bg: 'bg-gray-100', text: 'text-gray-600', dot: 'bg-gray-400' },
  FAILED: { bg: 'bg-red-100', text: 'text-red-700', dot: 'bg-red-500' },
  FAIL: { bg: 'bg-red-100', text: 'text-red-700', dot: 'bg-red-500' },
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
