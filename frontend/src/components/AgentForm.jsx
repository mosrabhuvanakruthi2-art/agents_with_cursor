import { useState } from 'react';
import UserMapping from './UserMapping';

export default function AgentForm({ onSubmit, loading }) {
  const [form, setForm] = useState({
    testType: 'SANITY',
    migrationType: 'FULL',
    includeMail: true,
    includeCalendar: true,
  });
  const [mappedPairs, setMappedPairs] = useState(null);

  function handleChange(e) {
    const { name, value, type, checked } = e.target;
    setForm((prev) => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value,
    }));
  }

  function handleMappingComplete(pairs) {
    setMappedPairs(pairs);
  }

  function clearMapping() {
    setMappedPairs(null);
  }

  function handleSubmit(e) {
    e.preventDefault();
    if (!mappedPairs || mappedPairs.length === 0) return;
    if (mappedPairs.length === 1) {
      onSubmit({ ...form, sourceEmail: mappedPairs[0].sourceEmail, destinationEmail: mappedPairs[0].destinationEmail });
    } else {
      onSubmit({ ...form, mappedPairs });
    }
  }

  const hasBulkMapping = mappedPairs && mappedPairs.length > 1;

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="rounded-xl p-5 space-y-4" style={{ border: '1px solid #c5cef5', backgroundColor: '#f5f7fd' }}>
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold" style={{ color: '#0129ac' }}>Auto-Map Users</h3>
            <p className="text-xs mt-0.5" style={{ color: '#4a65c0' }}>Enter admin email to fetch and auto-map users by first name</p>
          </div>
          {mappedPairs && (
            <button type="button" onClick={clearMapping} className="text-xs transition-colors" style={{ color: '#4a65c0' }}>
              Clear mapping
            </button>
          )}
        </div>
        <UserMapping onMappingComplete={handleMappingComplete} />
        {mappedPairs && (
          <div className="rounded-lg p-3 text-sm" style={{ backgroundColor: '#eef1fb', border: '1px solid #c5cef5', color: '#0129ac' }}>
            {mappedPairs.length} pair{mappedPairs.length > 1 ? 's' : ''} mapped.
            {mappedPairs.length === 1 && ` Source: ${mappedPairs[0].sourceEmail} → Destination: ${mappedPairs[0].destinationEmail}`}
            {mappedPairs.length > 1 && ' All pairs will be migrated together.'}
          </div>
        )}
      </div>

      <div>
        <label className="block text-sm font-medium mb-2" style={{ color: '#0129ac' }}>Test Type</label>
        <div className="grid grid-cols-2 gap-3">
          {[
            { value: 'SMOKE', label: 'Smoke', desc: 'Quick connectivity check' },
            { value: 'SANITY', label: 'Sanity', desc: 'Core feature validation' },
          ].map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setForm((prev) => ({ ...prev, testType: opt.value }))}
              className="relative rounded-xl p-4 text-left transition-all"
              style={{
                border: form.testType === opt.value ? '2px solid #0129ac' : '2px solid #c5cef5',
                backgroundColor: form.testType === opt.value ? '#eef1fb' : '#ffffff',
              }}
            >
              <p className="text-sm font-semibold" style={{ color: '#0129ac' }}>{opt.label}</p>
              <p className="text-xs mt-0.5" style={{ color: '#4a65c0' }}>{opt.desc}</p>
              {form.testType === opt.value && (
                <span className="absolute top-2 right-2 w-2 h-2 rounded-full" style={{ backgroundColor: '#0129ac' }} />
              )}
            </button>
          ))}
        </div>
        <div className="mt-2 text-xs" style={{ color: '#4a65c0' }}>
          {form.testType === 'SMOKE' && 'Creates 1 plain text email. Validates inbox accessibility and message count. Fastest.'}
          {form.testType === 'SANITY' && 'Creates plain text, HTML, attachment emails + labels + drafts. Validates folders, subjects, and attachments.'}
        </div>
      </div>

      <div>
        <label htmlFor="migrationType" className="block text-sm font-medium mb-1" style={{ color: '#0129ac' }}>
          Migration Type
        </label>
        <select
          id="migrationType"
          name="migrationType"
          value={form.migrationType}
          onChange={handleChange}
          className="w-full px-4 py-2.5 rounded-lg text-sm outline-none bg-white"
          style={{ border: '1px solid #c5cef5', color: '#0129ac' }}
        >
          <option value="FULL">One Time Migration</option>
          <option value="DELTA">Delta Migration</option>
        </select>
      </div>

      <div className="flex gap-8">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            name="includeMail"
            checked={form.includeMail}
            onChange={handleChange}
            className="w-4 h-4 rounded"
            style={{ accentColor: '#0129ac' }}
          />
          <span className="text-sm" style={{ color: '#0129ac' }}>Include Mail</span>
        </label>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            name="includeCalendar"
            checked={form.includeCalendar}
            onChange={handleChange}
            className="w-4 h-4 rounded"
            style={{ accentColor: '#0129ac' }}
          />
          <span className="text-sm" style={{ color: '#0129ac' }}>Include Calendar</span>
        </label>
      </div>

      <button
        type="submit"
        disabled={loading || !mappedPairs || mappedPairs.length === 0}
        className="w-full md:w-auto px-8 py-3 text-white text-sm font-semibold rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-all"
        style={{ backgroundColor: '#0129ac' }}
        onMouseEnter={e => { if (!e.currentTarget.disabled) e.currentTarget.style.backgroundColor = '#011e8a'; }}
        onMouseLeave={e => e.currentTarget.style.backgroundColor = '#0129ac'}
      >
        {loading ? (
          <span className="flex items-center gap-2">
            <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            Running...
          </span>
        ) : hasBulkMapping ? (
          `Run Migration Agent (${mappedPairs.length} pairs)`
        ) : (
          'Run Migration Agent'
        )}
      </button>
    </form>
  );
}
