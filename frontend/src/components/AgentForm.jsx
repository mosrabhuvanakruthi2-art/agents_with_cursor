import { useState } from 'react';
import UserMapping from './UserMapping';

export default function AgentForm({ onSubmit, loading }) {
  const [form, setForm] = useState({
    sourceEmail: '',
    destinationEmail: '',
    testType: 'E2E',
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
    if (pairs.length === 1) {
      setForm((prev) => ({
        ...prev,
        sourceEmail: pairs[0].sourceEmail,
        destinationEmail: pairs[0].destinationEmail,
      }));
    }
  }

  function clearMapping() {
    setMappedPairs(null);
    setForm((prev) => ({ ...prev, sourceEmail: '', destinationEmail: '' }));
  }

  function handleSubmit(e) {
    e.preventDefault();
    if (mappedPairs && mappedPairs.length > 1) {
      onSubmit({ ...form, mappedPairs });
    } else {
      onSubmit(form);
    }
  }

  const hasBulkMapping = mappedPairs && mappedPairs.length > 1;

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="border border-gray-200 rounded-xl p-5 space-y-4 bg-gray-50/50">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-gray-900">Auto-Map Users</h3>
            <p className="text-xs text-gray-500 mt-0.5">Enter admin email to fetch and auto-map users by first name</p>
          </div>
          {mappedPairs && (
            <button type="button" onClick={clearMapping} className="text-xs text-gray-500 hover:text-red-500 transition-colors">
              Clear mapping
            </button>
          )}
        </div>
        <UserMapping onMappingComplete={handleMappingComplete} />
        {mappedPairs && (
          <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-sm text-green-700">
            {mappedPairs.length} pair{mappedPairs.length > 1 ? 's' : ''} mapped.
            {mappedPairs.length === 1 && ` Source: ${mappedPairs[0].sourceEmail} → Destination: ${mappedPairs[0].destinationEmail}`}
            {mappedPairs.length > 1 && ' All pairs will be migrated together.'}
          </div>
        )}
      </div>

      {!hasBulkMapping && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <label htmlFor="sourceEmail" className="block text-sm font-medium text-gray-700 mb-1">
              Source Email (Gmail)
            </label>
            <input
              id="sourceEmail"
              name="sourceEmail"
              type="email"
              required={!hasBulkMapping}
              value={form.sourceEmail}
              onChange={handleChange}
              placeholder="dan@cloudfuze.us"
              className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-shadow"
            />
          </div>
          <div>
            <label htmlFor="destinationEmail" className="block text-sm font-medium text-gray-700 mb-1">
              Destination Email (Outlook)
            </label>
            <input
              id="destinationEmail"
              name="destinationEmail"
              type="email"
              required={!hasBulkMapping}
              value={form.destinationEmail}
              onChange={handleChange}
              placeholder="sophia@gajha.com"
              className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-shadow"
            />
          </div>
        </div>
      )}

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">Test Type</label>
        <div className="grid grid-cols-3 gap-3">
          {[
            { value: 'SMOKE', label: 'Smoke', desc: 'Quick connectivity check', color: 'amber' },
            { value: 'SANITY', label: 'Sanity', desc: 'Core feature validation', color: 'blue' },
            { value: 'E2E', label: 'End-to-End', desc: 'Full coverage test', color: 'indigo' },
          ].map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setForm((prev) => ({ ...prev, testType: opt.value }))}
              className={`relative rounded-xl border-2 p-4 text-left transition-all ${
                form.testType === opt.value
                  ? 'border-indigo-500 bg-indigo-50 ring-1 ring-indigo-500'
                  : 'border-gray-200 bg-white hover:border-gray-300'
              }`}
            >
              <p className={`text-sm font-semibold ${form.testType === opt.value ? 'text-indigo-700' : 'text-gray-900'}`}>
                {opt.label}
              </p>
              <p className="text-xs text-gray-500 mt-0.5">{opt.desc}</p>
              {form.testType === opt.value && (
                <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-indigo-500" />
              )}
            </button>
          ))}
        </div>
        <div className="mt-2 text-xs text-gray-500">
          {form.testType === 'SMOKE' && 'Creates 1 plain text email. Validates inbox accessibility and message count. Fastest.'}
          {form.testType === 'SANITY' && 'Creates plain text, HTML, attachment emails + labels + drafts. Validates folders, subjects, and attachments.'}
          {form.testType === 'E2E' && 'Full coverage: all email types, inline images, sent mail, labels, drafts, calendar events. Deepest validation.'}
        </div>
      </div>

      <div>
        <label htmlFor="migrationType" className="block text-sm font-medium text-gray-700 mb-1">
          Migration Type
        </label>
        <select
          id="migrationType"
          name="migrationType"
          value={form.migrationType}
          onChange={handleChange}
          className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none bg-white"
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
            className="w-4 h-4 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500"
          />
          <span className="text-sm text-gray-700">Include Mail</span>
        </label>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            name="includeCalendar"
            checked={form.includeCalendar}
            onChange={handleChange}
            className="w-4 h-4 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500"
          />
          <span className="text-sm text-gray-700">Include Calendar</span>
        </label>
      </div>

      <button
        type="submit"
        disabled={loading}
        className="w-full md:w-auto px-8 py-3 bg-indigo-600 text-white text-sm font-semibold rounded-lg hover:bg-indigo-700 focus:ring-4 focus:ring-indigo-200 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
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
