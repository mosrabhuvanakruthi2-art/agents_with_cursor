const statusConfig = {
  COMPLETED: { bg: '#eef1fb', text: '#0129ac', dot: '#0129ac' },
  SUCCESS:   { bg: '#eef1fb', text: '#0129ac', dot: '#0129ac' },
  PASS:      { bg: '#eef1fb', text: '#0129ac', dot: '#0129ac' },
  RUNNING:   { bg: '#0129ac', text: '#ffffff', dot: '#ffffff' },
  PENDING:   { bg: '#f5f7fd', text: '#4a65c0', dot: '#4a65c0' },
  FAILED:    { bg: '#001e8c', text: '#ffffff', dot: '#ffffff' },
  FAIL:      { bg: '#001e8c', text: '#ffffff', dot: '#ffffff' },
};

export default function StatusBadge({ status }) {
  const config = statusConfig[status] || statusConfig.PENDING;
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium"
      style={{ backgroundColor: config.bg, color: config.text }}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: config.dot }} />
      {status}
    </span>
  );
}
