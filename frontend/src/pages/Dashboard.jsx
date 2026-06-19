import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { getExecutions } from '../services/api';
import DonutChart from '../components/DonutChart';
import ProductTabs from '../components/ProductTabs';
import usePersistedState from '../hooks/usePersistedState';
import { productOf, productCounts, PRODUCT_LABEL } from '../utils/product';

export default function Dashboard() {
  const [allExecutions, setAllExecutions] = useState([]);
  const [product, setProduct] = usePersistedState('dash:product', 'all');
  const navigate = useNavigate();

  useEffect(() => {
    getExecutions()
      .then(({ data }) => setAllExecutions(data))
      .catch(() => { /* API may not be running yet */ });
  }, []);

  // Segregate by product (Mail / Content / Message). "all" shows everything.
  const counts = productCounts(allExecutions);
  const executions = product === 'all' ? allExecutions : allExecutions.filter((e) => productOf(e) === product);
  const productQ = product === 'all' ? '' : `&product=${product}`;

  const count = (s) => executions.filter((e) => e.status === s).length;
  const stats = {
    total: executions.length,
    completed: count('COMPLETED'),
    failed: executions.filter((e) => e.status === 'FAILED' || e.status === 'INTERRUPTED').length,
    running: count('RUNNING'),
  };

  // Execution outcome breakdown
  const statusData = [
    { key: 'COMPLETED', label: 'Completed', value: count('COMPLETED'), color: '#22c55e' },
    { key: 'FAILED', label: 'Failed', value: count('FAILED'), color: '#ef4444' },
    { key: 'CANCELLED', label: 'Cancelled', value: count('CANCELLED'), color: '#f59e0b' },
    { key: 'INTERRUPTED', label: 'Interrupted', value: count('INTERRUPTED'), color: '#a855f7' },
    { key: 'RUNNING', label: 'Running', value: count('RUNNING'), color: '#3b82f6' },
  ].filter((d) => d.value > 0);

  // Validation pass/fail for runs that produced results
  const isPassed = (e) => {
    const v = e.result?.validationSummary;
    return !!v && (String(v.overallStatus || '').toUpperCase().includes('PASS') || (v.mismatches?.length || 0) === 0);
  };
  const withVal = executions.filter((e) => e.result?.validationSummary);
  const passed = withVal.filter(isPassed).length;
  const validationData = [
    { key: 'PASS', label: 'Passed', value: passed, color: '#22c55e' },
    { key: 'FAIL', label: 'Failed', value: withVal.length - passed, color: '#ef4444' },
  ].filter((d) => d.value > 0);

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
          <p className="text-sm text-gray-500 mt-1">
            {product === 'all' ? 'Migration QA Agent System overview' : `${PRODUCT_LABEL[product]} migration overview`}
          </p>
        </div>
        <Link
          to="/run"
          className="px-5 py-2.5 bg-indigo-600 text-white text-sm font-semibold rounded-lg hover:bg-indigo-700 transition-colors"
        >
          New Run
        </Link>
      </div>

      {/* Product segregation: Mail / Content / Message (or All) */}
      <ProductTabs value={product} onChange={setProduct} counts={counts} />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
        <StatCard label="Total Runs" value={stats.total} sub="Initiated runs" color="blue" icon={<GearIcon />} to={`/executions?_=1${productQ}`} />
        <StatCard label="Completed" value={stats.completed} sub="Completed runs" color="green" icon={<UsersIcon />} to={`/executions?status=COMPLETED${productQ}`} />
        <StatCard label="In Progress" value={stats.running} sub="Currently running" color="amber" icon={<ClockIcon />} to={`/executions?status=RUNNING${productQ}`} />
        <StatCard label="Failed" value={stats.failed} sub="Failed or interrupted" color="red" icon={<AlertIcon />} to={`/executions?status=FAILED,INTERRUPTED${productQ}`} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <ChartCard title="Execution Outcomes" subtitle="Click a slice to open its runs">
          {statusData.length > 0
            ? <DonutChart data={statusData} centerLabel="runs" onSelect={(k) => k && navigate(`/executions?status=${k}${productQ}`)} />
            : <Empty text="No executions yet." />}
        </ChartCard>
        <ChartCard title="Validation Results" subtitle="Click a slice to open its runs">
          {validationData.length > 0
            ? <DonutChart data={validationData} centerLabel="validated" onSelect={(k) => k && navigate(`/executions?validation=${k}${productQ}`)} />
            : <Empty text="No validation results yet." />}
        </ChartCard>
      </div>
    </div>
  );
}

function StatCard({ label, value, sub, icon, color, to }) {
  const iconBg = {
    blue: 'bg-blue-500',
    green: 'bg-green-500',
    amber: 'bg-amber-400',
    red: 'bg-red-500',
  };
  return (
    <Link to={to} className="group bg-white rounded-xl border border-gray-200 p-5 hover:shadow-md hover:border-gray-300 transition-all">
      <div className="flex items-start justify-between">
        <p className="text-sm font-medium text-gray-500">{label}</p>
        <span className={`w-10 h-10 rounded-lg flex items-center justify-center text-white flex-shrink-0 ${iconBg[color]}`}>{icon}</span>
      </div>
      <p className="text-3xl font-bold text-gray-900 mt-2 tabular-nums">{value}</p>
      <div className="flex items-center justify-between mt-1">
        <p className="text-xs text-gray-400">{sub}</p>
        <svg className="w-4 h-4 text-gray-300 group-hover:text-indigo-500 group-hover:translate-x-0.5 transition-all"
          fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3" />
        </svg>
      </div>
    </Link>
  );
}

function ChartCard({ title, subtitle, children }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
      {subtitle ? <p className="text-xs text-gray-400 mb-4 mt-0.5">{subtitle}</p> : <div className="mb-4" />}
      {children}
    </div>
  );
}

function Empty({ text }) {
  return <p className="text-sm text-gray-400 py-8 text-center">{text}</p>;
}

/* ── Card icons ── */
function GearIcon() {
  return (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
    </svg>
  );
}
function UsersIcon() {
  return (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z" />
    </svg>
  );
}
function ClockIcon() {
  return (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
    </svg>
  );
}
function AlertIcon() {
  return (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
    </svg>
  );
}
