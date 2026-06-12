import { useState, useEffect } from 'react';
import { getExecutions, downloadValidationPdf } from '../services/api';
import StatusBadge from '../components/StatusBadge';
import ValidationTable from '../components/ValidationTable';

export default function ValidationResults() {
  const [executions, setExecutions] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchStatus, setSearchStatus] = useState(null); // 'found' | 'not_found' | null

  useEffect(() => {
    loadExecutions();
  }, []);

  async function loadExecutions() {
    try {
      const { data } = await getExecutions();
      // Include ALL executions that have any result, not just validationSummary
      const completed = data.filter((e) => e.result?.validationSummary || e.result?.status);
      setExecutions(completed);
      if (completed.length > 0) setSelectedId(completed[0].executionId);
    } catch {
      // API may not be running
    } finally {
      setLoading(false);
    }
  }

  function handleSearch(q) {
    setSearchQuery(q);
    if (!q.trim()) { setSearchStatus(null); return; }
    const match = executions.find((ex) =>
      ex.executionId.toLowerCase().includes(q.trim().toLowerCase())
    );
    if (match) {
      setSelectedId(match.executionId);
      setSearchStatus('found');
    } else {
      setSearchStatus('not_found');
    }
  }

  async function handleDownloadPdf() {
    if (!selectedId) return;
    setDownloading(true);
    try {
      const response = await downloadValidationPdf(selectedId);
      const url = window.URL.createObjectURL(new Blob([response.data], { type: 'application/pdf' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `validation-report-${selectedId.slice(0, 8)}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      alert('Failed to download PDF: ' + (err.response?.data?.error || err.message));
    } finally {
      setDownloading(false);
    }
  }

  const selected = executions.find((e) => e.executionId === selectedId);
  const validation = selected?.result?.validationSummary;
  const comparison = validation?.comparison;
  const sourceData = validation?.sourceData;
  const destData = validation?.destinationData;

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Validation Results</h1>
          <p className="text-sm text-gray-500 mt-1">Review migration validation details</p>
        </div>
        {selectedId && (
          <button
            onClick={handleDownloadPdf}
            disabled={downloading}
            className="px-5 py-2.5 bg-indigo-600 text-white text-sm font-semibold rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-all flex items-center gap-2"
          >
            {downloading ? (
              <>
                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Generating...
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
                </svg>
                Download PDF
              </>
            )}
          </button>
        )}
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
        <div className="flex flex-col sm:flex-row gap-4">
          {/* Search by Execution ID */}
          <div className="flex-1">
            <label className="block text-sm font-medium text-gray-700 mb-2">Search by Execution ID</label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <svg className="h-4 w-4 text-gray-400" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 15.803a7.5 7.5 0 0 0 10.607 0Z" />
                </svg>
              </div>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => handleSearch(e.target.value)}
                placeholder="Paste or type execution ID…"
                className={`w-full pl-9 pr-10 py-2.5 border rounded-lg text-sm focus:ring-2 outline-none transition-colors ${
                  searchStatus === 'found'     ? 'border-green-400 focus:ring-green-300 bg-green-50' :
                  searchStatus === 'not_found' ? 'border-red-400 focus:ring-red-300 bg-red-50' :
                  'border-gray-300 focus:ring-indigo-500 focus:border-indigo-500'
                }`}
              />
              {searchQuery && (
                <button
                  onClick={() => { setSearchQuery(''); setSearchStatus(null); }}
                  className="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-400 hover:text-gray-600"
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>

            {/* Search feedback */}
            {searchStatus === 'found' && (() => {
              const match = executions.find((ex) => ex.executionId.toLowerCase().includes(searchQuery.trim().toLowerCase()));
              return (
                <div className="mt-2 flex items-center gap-2 text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
                  <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                  </svg>
                  <span>
                    <span className="font-semibold font-mono">{match?.executionId}</span>
                    {' '}— {match?.context?.sourceEmail} → {match?.context?.destinationEmail}
                    {' '}| {match?.result?.validationSummary?.overallStatus || match?.result?.status}
                    {' '}| {new Date(match?.createdAt).toLocaleString()}
                  </span>
                </div>
              );
            })()}
            {searchStatus === 'not_found' && (
              <div className="mt-2 flex items-center gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" />
                </svg>
                <span>No execution found matching <span className="font-mono font-semibold">"{searchQuery}"</span></span>
              </div>
            )}
          </div>

          {/* OR divider */}
          <div className="flex sm:flex-col items-center gap-2 text-xs text-gray-400 font-medium pt-7">
            <div className="flex-1 sm:w-px sm:h-full w-full h-px bg-gray-200" />
            OR
            <div className="flex-1 sm:w-px sm:h-full w-full h-px bg-gray-200" />
          </div>

          {/* Execution dropdown */}
          <div className="flex-1">
            <label className="block text-sm font-medium text-gray-700 mb-2">Browse Executions</label>
            {loading ? (
              <p className="text-sm text-gray-400">Loading...</p>
            ) : executions.length === 0 ? (
              <p className="text-sm text-gray-500">No completed executions found</p>
            ) : (
              <select
                value={selectedId}
                onChange={(e) => { setSelectedId(e.target.value); setSearchQuery(''); setSearchStatus(null); }}
                className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none bg-white"
              >
                {executions.map((exec) => (
                  <option key={exec.executionId} value={exec.executionId}>
                    {exec.executionId} | {exec.context?.sourceEmail} → {exec.context?.destinationEmail} | {new Date(exec.createdAt).toLocaleString()}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
      </div>

      {/* No validation data — execution failed before validation ran */}
      {selected && !validation && (
        <div className="bg-white rounded-xl border border-orange-200 p-6">
          <div className="flex items-start gap-4">
            <div className="shrink-0 w-10 h-10 rounded-full bg-orange-100 flex items-center justify-center">
              <svg className="w-5 h-5 text-orange-500" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
              </svg>
            </div>
            <div className="flex-1">
              <h3 className="text-base font-semibold text-gray-900 mb-1">No Validation Data Available</h3>
              <p className="text-sm text-gray-600 mb-3">
                This execution did not complete the validation step. It likely failed during migration or was cancelled before validation ran.
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                <div className="bg-gray-50 rounded-lg p-3">
                  <p className="text-xs text-gray-500 mb-1">Execution ID</p>
                  <p className="font-mono text-xs text-gray-800 break-all">{selected.executionId}</p>
                </div>
                <div className="bg-gray-50 rounded-lg p-3">
                  <p className="text-xs text-gray-500 mb-1">Status</p>
                  <span className={`inline-flex px-2 py-0.5 rounded text-xs font-semibold ${
                    selected.status === 'FAILED'    ? 'bg-red-100 text-red-700' :
                    selected.status === 'CANCELLED' ? 'bg-yellow-100 text-yellow-700' :
                    selected.status === 'RUNNING'   ? 'bg-blue-100 text-blue-700' :
                    'bg-gray-100 text-gray-700'
                  }`}>{selected.status}</span>
                </div>
                <div className="bg-gray-50 rounded-lg p-3">
                  <p className="text-xs text-gray-500 mb-1">Direction</p>
                  <p className="text-xs text-gray-800">{selected.context?.sourceEmail} → {selected.context?.destinationEmail}</p>
                </div>
                <div className="bg-gray-50 rounded-lg p-3">
                  <p className="text-xs text-gray-500 mb-1">Created</p>
                  <p className="text-xs text-gray-800">{new Date(selected.createdAt).toLocaleString()}</p>
                </div>
              </div>
              {selected.error && (
                <div className="mt-3 bg-red-50 border border-red-200 rounded-lg p-3">
                  <p className="text-xs font-semibold text-red-700 mb-1">Error</p>
                  <p className="text-xs text-red-600 font-mono break-all">{selected.error}</p>
                </div>
              )}
              {selected.progress && (
                <div className="mt-2 text-xs text-gray-500">
                  Last progress: <span className="font-medium text-gray-700">{selected.progress}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {validation && (
        <div className="space-y-6">
          {/* Overall Status */}
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <div className="flex items-center gap-4 mb-4">
              <h2 className="text-lg font-semibold text-gray-900">Overall Status</h2>
              <StatusBadge status={validation.overallStatus} />
            </div>
            {validation.mismatches?.length === 0 && (
              <p className="text-sm text-green-600">All validations passed — source and destination data match.</p>
            )}
            {selected?.knownLimitationsNote && (
              <div className="mt-3 flex items-center gap-2 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
                <span className="text-gray-500">ℹ️</span>
                <p className="text-sm text-gray-600">{selected.knownLimitationsNote}</p>
              </div>
            )}
          </div>

          {/* Source vs Destination Comparison */}
          {sourceData && destData && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold text-gray-900">Source vs Destination Comparison</h2>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className={`rounded-xl border p-4 ${comparison?.defaultLabelsMatch ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
                  <p className="text-xs font-medium uppercase tracking-wider opacity-75">Default Labels/Folders</p>
                  <p className={`text-xl font-bold mt-1 ${comparison?.defaultLabelsMatch ? 'text-green-700' : 'text-red-700'}`}>
                    {comparison?.defaultLabelsMatch ? 'Match' : 'Mismatch'}
                  </p>
                </div>
                <div className={`rounded-xl border p-4 ${comparison?.customLabelsMatch ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
                  <p className="text-xs font-medium uppercase tracking-wider opacity-75">Custom Labels/Folders</p>
                  <p className={`text-xl font-bold mt-1 ${comparison?.customLabelsMatch ? 'text-green-700' : 'text-red-700'}`}>
                    {comparison?.customLabelsMatch ? 'Match' : 'Mismatch'}
                  </p>
                </div>
              </div>

              {/* Default Labels Comparison Table */}
              <ComparisonTable
                title="Default Labels / Folders"
                sourceItems={sourceData.defaultLabels || []}
                destItems={destData.defaultFolders || []}
                mapping={{ INBOX: 'Inbox', SENT: 'Sent Items', DRAFT: 'Drafts', TRASH: 'Deleted Items', SPAM: 'Junk Email', 'Archive[Gmail]': 'Archive' }}
              />

              {/* Custom Labels Comparison Table */}
              <CustomComparisonTable
                title="Custom Labels / Folders"
                sourceItems={sourceData.customLabels || []}
                destItems={destData.customFolders || []}
              />

              {/* Issues */}
              {comparison?.issues?.length > 0 && (
                <div className="bg-red-50 border border-red-200 rounded-xl p-5">
                  <h3 className="text-sm font-semibold text-red-800 mb-3">
                    Comparison Issues ({comparison.issues.length})
                  </h3>
                  <div className="space-y-2">
                    {comparison.issues.map((issue, idx) => (
                      <div key={idx} className="flex items-center gap-3 text-sm">
                        <span className={`px-2 py-0.5 rounded text-xs font-medium ${issue.type === 'default' ? 'bg-orange-100 text-orange-700' : 'bg-purple-100 text-purple-700'}`}>
                          {issue.type}
                        </span>
                        <span className="font-medium text-gray-900">{issue.label}</span>
                        <span className="text-gray-500">
                          source: <code className="bg-gray-100 px-1 rounded">{issue.sourceCount}</code>
                          {' → '}
                          destination: <code className="bg-gray-100 px-1 rounded">{String(issue.destCount)}</code>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Mail Validation Details */}
          {validation.mailValidation && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold text-gray-900">Mail Validation</h2>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <ResultCard label="Total Messages" value={validation.mailValidation.destinationCount} />
                <ResultCard label="Folders Found" value={validation.mailValidation.folderMapping?.length || 0} />
                <ResultCard label="Emails with Attachments" value={validation.mailValidation.attachmentChecks?.length || 0} />
              </div>

              <ValidationTable
                title="Destination Folders"
                rows={validation.mailValidation.folderMapping || []}
                columns={[
                  { key: 'folderName', label: 'Folder Name' },
                  { key: 'messageCount', label: 'Messages' },
                  { key: 'unreadCount', label: 'Unread' },
                ]}
              />

              {validation.mailValidation.subjectChecks?.length > 0 && (
                <ValidationTable
                  title="Inbox Emails"
                  rows={validation.mailValidation.subjectChecks}
                  columns={[
                    { key: 'subject', label: 'Subject' },
                    { key: 'hasAttachments', label: 'Attachments', render: (val) => <span className={val ? 'text-indigo-600 font-medium' : 'text-gray-400'}>{val ? 'Yes' : 'No'}</span> },
                    { key: 'receivedDateTime', label: 'Received', render: (val) => val ? new Date(val).toLocaleString() : '-' },
                  ]}
                />
              )}

              {validation.mailValidation.attachmentChecks?.length > 0 && (
                <ValidationTable
                  title="Attachment Details"
                  rows={validation.mailValidation.attachmentChecks.flatMap((check) =>
                    (check.attachments || []).map((att) => ({
                      messageSubject: check.messageSubject,
                      name: typeof att === 'string' ? att : att.name,
                      size: typeof att === 'object' ? att.size : '-',
                      contentType: typeof att === 'object' ? att.contentType : '-',
                    }))
                  )}
                  columns={[
                    { key: 'messageSubject', label: 'Email Subject' },
                    { key: 'name', label: 'Attachment Name' },
                    { key: 'size', label: 'Size', render: (val) => typeof val === 'number' ? `${(val / 1024).toFixed(1)} KB` : '-' },
                    { key: 'contentType', label: 'Type' },
                  ]}
                />
              )}
            </div>
          )}

          {/* Calendar Validation */}
          {validation.calendarValidation && validation.calendarValidation.destinationEventCount > 0 && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold text-gray-900">Calendar Validation</h2>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <ResultCard label="Total Events" value={validation.calendarValidation.destinationEventCount} />
                <ResultCard label="Recurring Events" value={validation.calendarValidation.recurringEvents?.length || 0} />
                <ResultCard label="Secondary Calendars" value={validation.calendarValidation.secondaryCalendars?.length || 0} />
              </div>

              {validation.calendarValidation.eventDetails?.length > 0 && (
                <ValidationTable
                  title="Event Details"
                  rows={validation.calendarValidation.eventDetails}
                  columns={[
                    { key: 'subject', label: 'Subject' },
                    { key: 'calendarName', label: 'Calendar' },
                    { key: 'isRecurring', label: 'Recurring', render: (val) => val ? 'Yes' : 'No' },
                    { key: 'isAllDay', label: 'All Day', render: (val) => val ? 'Yes' : 'No' },
                  ]}
                />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ComparisonTable({ title, sourceItems, destItems, mapping }) {
  const rows = Object.entries(mapping).map(([gmailId, outlookName]) => {
    const src = sourceItems.find((l) => l.id === gmailId || l.name === gmailId);
    const dest = destItems.find((f) => f.name === outlookName || f.name === gmailId || f.id === gmailId);
    const srcCount = src?.messageCount || 0;
    const destCount = dest?.messageCount || 0;
    return { label: `${gmailId} → ${outlookName}`, srcCount, destCount, match: srcCount === destCount };
  });

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-100">
        <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-gray-50">
            <th className="px-5 py-2.5 text-left text-xs font-medium text-gray-500 uppercase">Label / Folder</th>
            <th className="px-5 py-2.5 text-right text-xs font-medium text-gray-500 uppercase">Source</th>
            <th className="px-5 py-2.5 text-right text-xs font-medium text-gray-500 uppercase">Destination</th>
            <th className="px-5 py-2.5 text-right text-xs font-medium text-gray-500 uppercase">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((r, idx) => (
            <tr key={idx} className={r.match ? 'bg-green-50/50' : 'bg-red-50/50'}>
              <td className="px-5 py-2.5 font-medium text-gray-900">{r.label}</td>
              <td className="px-5 py-2.5 text-right text-gray-700">{r.srcCount}</td>
              <td className="px-5 py-2.5 text-right text-gray-700">{r.destCount}</td>
              <td className="px-5 py-2.5 text-right">
                <span className={`text-xs font-semibold ${r.match ? 'text-green-600' : 'text-red-600'}`}>
                  {r.match ? 'Match' : 'Mismatch'}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CustomComparisonTable({ title, sourceItems, destItems }) {
  if (sourceItems.length === 0 && destItems.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
        <p className="text-sm text-gray-500 mt-1">No custom labels/folders found.</p>
      </div>
    );
  }

  const rows = sourceItems.map((src) => {
    const dest = destItems.find((f) => f.name.toLowerCase() === src.name.toLowerCase());
    return {
      name: src.name,
      srcCount: src.messageCount || 0,
      destCount: dest ? dest.messageCount : null,
      match: dest ? src.messageCount === dest.messageCount : false,
      found: !!dest,
    };
  });

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-100">
        <h3 className="text-sm font-semibold text-gray-900">{title} ({sourceItems.length} source, {destItems.length} destination)</h3>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-gray-50">
            <th className="px-5 py-2.5 text-left text-xs font-medium text-gray-500 uppercase">Label / Folder</th>
            <th className="px-5 py-2.5 text-right text-xs font-medium text-gray-500 uppercase">Source</th>
            <th className="px-5 py-2.5 text-right text-xs font-medium text-gray-500 uppercase">Destination</th>
            <th className="px-5 py-2.5 text-right text-xs font-medium text-gray-500 uppercase">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((r, idx) => (
            <tr key={idx} className={r.match ? 'bg-green-50/50' : 'bg-red-50/50'}>
              <td className="px-5 py-2.5 font-medium text-gray-900">{r.name}</td>
              <td className="px-5 py-2.5 text-right text-gray-700">{r.srcCount}</td>
              <td className="px-5 py-2.5 text-right text-gray-700">{r.found ? r.destCount : <span className="text-red-500">NOT FOUND</span>}</td>
              <td className="px-5 py-2.5 text-right">
                <span className={`text-xs font-semibold ${r.match ? 'text-green-600' : 'text-red-600'}`}>
                  {r.match ? 'Match' : r.found ? 'Mismatch' : 'Missing'}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ResultCard({ label, value }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">{label}</p>
      <p className="text-2xl font-bold text-gray-900 mt-1">{value}</p>
    </div>
  );
}
