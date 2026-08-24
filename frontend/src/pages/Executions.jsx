import { useState, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { getExecutions } from '../services/api';
import StatusBadge from '../components/StatusBadge';
import ProductTabs from '../components/ProductTabs';
import { productOf, productCounts, PRODUCT_LABEL } from '../utils/product';

const isPassed = (e) => {
  const v = e.result?.validationSummary;
  return !!v && (String(v.overallStatus || '').toUpperCase().includes('PASS') || (v.mismatches?.length || 0) === 0);
};

export default function Executions() {
  const [executions, setExecutions] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [params] = useSearchParams();
  const [product, setProduct] = useState(
    ['mail', 'content', 'message'].includes(params.get('product')) ? params.get('product') : 'all'
  );

  useEffect(() => {
    getExecutions()
      .then(({ data }) => setExecutions(data))
      .catch(() => { /* API may be down */ })
      .finally(() => setLoaded(true));
  }, []);

  const statusParam = params.get('status');         // e.g. "COMPLETED" or "FAILED,INTERRUPTED"
  const validationParam = params.get('validation'); // "PASS" | "FAIL"
  const statuses = statusParam ? statusParam.split(',') : null;

  // Counts reflect the current status/validation filter so the product tabs show
  // how many of THESE runs belong to each product.
  let scoped = executions;
  if (statuses) scoped = scoped.filter((e) => statuses.includes(e.status));
  if (validationParam) {
    scoped = scoped.filter((e) => e.result?.validationSummary)
      .filter((e) => (validationParam === 'PASS' ? isPassed(e) : !isPassed(e)));
  }
  const counts = productCounts(scoped);
  const items = product === 'all' ? scoped : scoped.filter((e) => productOf(e) === product);

  const title = (() => {
    const prefix = product === 'all' ? '' : `${PRODUCT_LABEL[product]} · `;
    if (validationParam) return prefix + (validationParam === 'PASS' ? 'Passed validation' : 'Failed validation');
    if (!statuses) return prefix + 'All executions';
    if (statuses.includes('FAILED') && statuses.includes('INTERRUPTED')) return prefix + 'Failed jobs';
    const map = { COMPLETED: 'Completed jobs', RUNNING: 'Running jobs', FAILED: 'Failed jobs', CANCELLED: 'Cancelled jobs', INTERRUPTED: 'Interrupted jobs' };
    return prefix + statuses.map((s) => map[s] || s).join(', ');
  })();

  return (
    <div className="space-y-6">
      <div>
        <Link to="/" className="text-sm text-gray-400 hover:text-gray-600 inline-flex items-center gap-1">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
          </svg>
          Dashboard
        </Link>
        <h1 className="text-2xl font-bold text-gray-900 mt-1">{title}</h1>
        <p className="text-sm text-gray-500 mt-0.5">{items.length} {items.length === 1 ? 'run' : 'runs'}</p>
      </div>

      {/* Product segregation: Mail / Content / Message */}
      <ProductTabs value={product} onChange={setProduct} counts={counts} />

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {!loaded ? (
          <div className="p-8 text-center text-sm text-gray-400">Loading…</div>
        ) : items.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-500">No runs match this filter.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50">
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Execution ID</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Source</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Destination</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Type</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {items.map((exec) => (
                  <tr key={exec.executionId} className="hover:bg-gray-50">
                    <td className="px-6 py-3 font-mono text-xs">
                      <Link to={`/logs?id=${exec.executionId}`} className="text-indigo-600 hover:text-indigo-700">
                        {exec.executionId.slice(0, 8)}…
                      </Link>
                    </td>
                    <td data-hj-suppress className="px-6 py-3 text-gray-700">{exec.context?.sourceEmail || '—'}</td>
                    <td data-hj-suppress className="px-6 py-3 text-gray-700">{exec.context?.destinationEmail || '—'}</td>
                    <td className="px-6 py-3 text-gray-700">{exec.context?.migrationType || '—'}</td>
                    <td className="px-6 py-3"><StatusBadge status={exec.status} /></td>
                    <td className="px-6 py-3 text-gray-500 text-xs">{new Date(exec.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
