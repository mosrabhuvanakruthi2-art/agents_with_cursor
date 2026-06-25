import { PRODUCTS } from '../utils/product';

/**
 * Segmented tabs to filter views by migration product (Mail / Content / Message),
 * with an optional "All". Used on Dashboard and the Reports & Logs page.
 */
export default function ProductTabs({ value, onChange, counts = {}, includeAll = true }) {
  const tabs = includeAll ? [{ key: 'all', label: 'All' }, ...PRODUCTS] : PRODUCTS;
  return (
    <div className="inline-flex rounded-lg border border-gray-200 bg-gray-50 p-1">
      {tabs.map((t) => {
        const active = value === t.key;
        const n = counts[t.key];
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => onChange(t.key)}
            className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${
              active ? 'bg-white text-indigo-700 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {t.label}
            {typeof n === 'number' ? <span className="ml-1 text-xs text-gray-400">{n}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
