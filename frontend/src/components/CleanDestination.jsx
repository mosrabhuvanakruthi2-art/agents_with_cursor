import { useState } from 'react';
import { cleanDestination } from '../services/api';

export default function CleanDestination({ mappedPairs, destinationEmail }) {
  const [manualEmail, setManualEmail] = useState('');
  const [cleaning, setCleaning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const mappedEmails = mappedPairs?.length > 0
    ? [...new Set(mappedPairs.map((p) => p.destinationEmail))]
    : [];

  const emails = mappedEmails.length > 0
    ? mappedEmails
    : (destinationEmail || manualEmail) ? [destinationEmail || manualEmail] : [];

  async function handleClean() {
    if (emails.length === 0) return;
    if (!window.confirm(
      `This will permanently delete ALL emails and custom folders from ${emails.length} destination mailbox(es):\n\n${emails.join('\n')}\n\nAre you sure?`
    )) return;

    setCleaning(true);
    setError(null);
    setResult(null);

    try {
      const results = [];
      for (const email of emails) {
        const { data } = await cleanDestination(email);
        results.push(data);
      }
      setResult(results);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setCleaning(false);
    }
  }

  return (
    <div className="border border-red-200 rounded-xl p-5 space-y-3 bg-red-50/30">
      <div>
        <h3 className="text-sm font-semibold text-gray-900">Clean Destination</h3>
        <p className="text-xs text-gray-500 mt-0.5">
          Delete all emails from default folders and remove custom folders before migration
        </p>
      </div>

      {mappedEmails.length > 0 ? (
        <div className="text-xs text-gray-600">
          <p className="font-medium mb-1">Destination mailboxes to clean:</p>
          <div className="flex flex-wrap gap-1">
            {mappedEmails.map((e) => (
              <span key={e} className="inline-block bg-white border border-gray-200 rounded px-2 py-0.5">{e}</span>
            ))}
          </div>
        </div>
      ) : (
        <div className="flex items-end gap-3">
          <div className="flex-1">
            <label className="block text-xs font-medium text-gray-600 mb-1">Destination Email to Clean</label>
            <input
              type="email"
              value={destinationEmail || manualEmail}
              onChange={(e) => setManualEmail(e.target.value)}
              placeholder="sophia@gajha.com"
              disabled={!!destinationEmail}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-red-400 focus:border-red-400 outline-none disabled:bg-gray-50"
            />
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={handleClean}
        disabled={cleaning || emails.length === 0}
        className="px-5 py-2 bg-red-600 text-white text-sm font-semibold rounded-lg hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center gap-2"
      >
        {cleaning ? (
          <>
            <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            Cleaning...
          </>
        ) : (
          <>
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
            </svg>
            {emails.length > 1 ? `Clean ${emails.length} Mailboxes` : 'Clean Mailbox'}
          </>
        )}
      </button>

      {error && (
        <div className="bg-red-100 border border-red-300 rounded-lg p-3 text-sm text-red-700">{error}</div>
      )}

      {result && (
        <div className="space-y-2">
          {result.map((r, idx) => (
            <div key={idx} className="bg-white border border-green-200 rounded-lg p-3 text-sm">
              <p className="font-medium text-gray-900">{r.email}</p>
              <div className="flex gap-6 mt-1 text-xs text-gray-600">
                <span>Before: {r.before.messages} messages, {r.before.folders} folders</span>
                <span>After: {r.after.messages} messages, {r.after.folders} folders</span>
              </div>
              <div className="flex gap-4 mt-1 text-xs">
                <span className="text-red-600">{r.deleted.messagesDeleted} messages deleted</span>
                <span className="text-red-600">{r.deleted.foldersDeleted} folders deleted</span>
              </div>
              {r.deleted.errors?.length > 0 && (
                <div className="mt-1 text-xs text-yellow-600">
                  {r.deleted.errors.length} warning(s)
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
