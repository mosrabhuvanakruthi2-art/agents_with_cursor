import StatusBadge from './StatusBadge';
import ValidationTable from './ValidationTable';

/**
 * Renders the validation results for a single execution.
 * Reads exec.result.validationSummary + exec.context (the execution shape from the API).
 */
export default function ResultsView({ exec }) {
  if (!exec) return <p className="text-sm text-gray-400">Select a run to see its results.</p>;

  const validation = exec.result?.validationSummary;
  const migration = exec.result?.migrationResult;
  const comparison = validation?.comparison;
  const sourceData = validation?.sourceData;
  const destData = validation?.destinationData;
  const ctx = exec.context || {};

  if (!validation) {
    return (
      <div className="bg-white rounded-xl border border-orange-200 p-6">
        <div className="flex items-start gap-4">
          <div className="shrink-0 w-10 h-10 rounded-full bg-orange-100 flex items-center justify-center">
            <svg className="w-5 h-5 text-orange-500" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
            </svg>
          </div>
          <div className="flex-1">
            <h3 className="text-base font-semibold text-gray-900 mb-1">No validation data available</h3>
            <p className="text-sm text-gray-600 mb-3">
              This run didn't complete the validation step — it likely failed during migration or was cancelled before validation ran.
            </p>
            {(() => {
              const mappings = Array.isArray(ctx.userEmailMappings) && ctx.userEmailMappings.length > 1
                ? ctx.userEmailMappings : null;
              return (
                <>
                  <div className={`grid gap-3 text-sm ${mappings ? 'grid-cols-2 sm:grid-cols-3' : 'grid-cols-2 sm:grid-cols-4'}`}>
                    <Mini label="Execution ID" value={<span className="font-mono text-xs break-all">{exec.executionId}</span>} />
                    <Mini label="Status" value={<StatusBadge status={exec.status} />} />
                    {!mappings && <Mini label="Direction" value={<span className="text-xs">{ctx.sourceEmail} → {ctx.destinationEmail}</span>} />}
                    <Mini label="Created" value={<span className="text-xs">{exec.createdAt ? new Date(exec.createdAt).toLocaleString() : '—'}</span>} />
                  </div>
                  {mappings && (
                    <div className="bg-gray-50 rounded-lg p-3 mt-3">
                      <p className="text-xs text-gray-500 mb-2">Direction · {mappings.length} pairs</p>
                      <div className="space-y-1">
                        {mappings.map((p, i) => (
                          <p key={i} className="text-xs text-gray-800">
                            {p.sourceEmail} <span className="text-gray-400">→</span> {p.destinationEmail}
                          </p>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              );
            })()}
            {exec.error && (
              <div className="mt-3 bg-red-50 border border-red-200 rounded-lg p-3">
                <p className="text-xs font-semibold text-red-700 mb-1">Error</p>
                <p className="text-xs text-red-600 font-mono break-all">{exec.error}</p>
              </div>
            )}
            {exec.progress && <p className="mt-2 text-xs text-gray-500">Last progress: <span className="font-medium text-gray-700">{exec.progress}</span></p>}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Run info — stays visible after validation completes; shows all pairs for bulk runs */}
      <RunInfoCard exec={exec} ctx={ctx} />
      {/* Overall status */}
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <div className="flex items-center gap-4 mb-2">
          <h2 className="text-lg font-semibold text-gray-900">Overall Status</h2>
          <StatusBadge status={validation.overallStatus} />
          <span className="text-sm text-gray-500">({validation.mismatches?.length || 0} mismatches)</span>
        </div>
        {validation.overallStatus === 'SKIPPED' ? (
          <p className="text-sm text-gray-600">
            {validation.note || 'Automated validation was skipped for this product type — verify in the destination app.'}
          </p>
        ) : validation.mismatches?.length === 0 ? (
          <p className="text-sm text-green-600">All validations passed — source and destination data match.</p>
        ) : null}
        {validation.overallStatus !== 'SKIPPED' && validation.mismatches?.length > 0 && (
          <div className="mt-3 space-y-2">
            {validation.mismatches.map((m, idx) => (
              <div key={idx} className="flex items-start gap-3 bg-red-50 rounded-lg p-3 text-sm">
                <span className="text-red-500 font-medium flex-shrink-0">{m.category}</span>
                <span className="text-gray-700">{m.field}: expected <code className="bg-red-100 px-1 rounded">{String(m.expected)}</code>, got <code className="bg-red-100 px-1 rounded">{String(m.actual)}</code></span>
              </div>
            ))}
          </div>
        )}
        {exec.knownLimitationsNote && (
          <div className="mt-3 flex items-center gap-2 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
            <span className="text-gray-500">ℹ️</span>
            <p className="text-sm text-gray-600">{exec.knownLimitationsNote}</p>
          </div>
        )}
      </div>

      {/* Message migration outcome — what CloudFuze actually accepted */}
      {migration?.kind === 'message' || migration?.chatMigrationResults ? (
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-3">Chat Migration</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
            <Stat label="Targets" value={migration.targetsAttempted ?? '—'} />
            <Stat label="Initiated" value={(migration.chatMigrationResults || []).filter((r) => r.status === 'INITIATED').length} />
            <Stat label="Failed" value={migration.messagesFailed ?? (migration.chatMigrationResults || []).filter((r) => r.status === 'FAILED').length} />
            <Stat label="Mode" value={migration.mode || '—'} />
          </div>
          {(migration.chatMigrationResults || []).length > 0 && (
            <div className="space-y-1 mb-3">
              {migration.chatMigrationResults.map((r, i) => (
                <div key={i} className="flex items-center gap-2 text-sm">
                  <span className={r.status === 'INITIATED' ? 'text-green-600' : 'text-red-600'}>
                    {r.status === 'INITIATED' ? '✓' : '✗'}
                  </span>
                  <span className="text-gray-700">{r.kind} {r.target}</span>
                  {r.jobId && <code className="bg-gray-100 px-1 rounded text-xs text-gray-600">job {r.jobId}</code>}
                  {r.error && <span className="text-xs text-red-600">{r.error}</span>}
                </div>
              ))}
            </div>
          )}
          {migration.note && <p className="text-sm text-gray-600">{migration.note}</p>}
          {migration.cloudFuzeReportsUrl && (
            <a href={migration.cloudFuzeReportsUrl} target="_blank" rel="noreferrer"
              className="inline-block mt-2 text-sm text-indigo-600 hover:text-indigo-800">
              Open CloudFuze Reports →
            </a>
          )}
        </div>
      ) : null}

      {/* Source vs Destination comparison */}
      {sourceData && destData && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold text-gray-900">Source vs Destination Comparison</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <MatchCard label="Default Labels/Folders" ok={comparison?.defaultLabelsMatch} />
            <MatchCard label="Custom Labels/Folders" ok={comparison?.customLabelsMatch} />
          </div>
          <ComparisonTable title="Default Labels / Folders"
            sourceItems={sourceData.defaultLabels || []} destItems={destData.defaultFolders || []}
            mapping={{ INBOX: 'Inbox', SENT: 'Sent Items', DRAFT: 'Drafts', TRASH: 'Deleted Items', SPAM: 'Junk Email', 'Archive[Gmail]': 'Archive' }} />
          <CustomComparisonTable title="Custom Labels / Folders"
            sourceItems={sourceData.customLabels || []} destItems={destData.customFolders || []} />
          {comparison?.issues?.length > 0 && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-5">
              <h3 className="text-sm font-semibold text-red-800 mb-3">Comparison Issues ({comparison.issues.length})</h3>
              <div className="space-y-2">
                {comparison.issues.map((issue, idx) => (
                  <div key={idx} className="flex items-center gap-3 text-sm">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${issue.type === 'default' ? 'bg-orange-100 text-orange-700' : 'bg-purple-100 text-purple-700'}`}>{issue.type}</span>
                    <span className="font-medium text-gray-900">{issue.label}</span>
                    <span className="text-gray-500">source: <code className="bg-gray-100 px-1 rounded">{issue.sourceCount}</code> → destination: <code className="bg-gray-100 px-1 rounded">{String(issue.destCount)}</code></span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Mail validation */}
      {validation.mailValidation && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold text-gray-900">Mail Validation</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <ResultCard label="Total Messages" value={validation.mailValidation.destinationCount} />
            <ResultCard label="Folders Found" value={validation.mailValidation.folderMapping?.length || 0} />
            <ResultCard label="Emails with Attachments" value={validation.mailValidation.attachmentChecks?.length || 0} />
          </div>
          <ValidationTable title="Destination Folders" rows={validation.mailValidation.folderMapping || []}
            columns={[{ key: 'folderName', label: 'Folder Name' }, { key: 'messageCount', label: 'Messages' }, { key: 'unreadCount', label: 'Unread' }]} />
          {validation.mailValidation.subjectChecks?.length > 0 && (
            <ValidationTable title="Inbox Emails" rows={validation.mailValidation.subjectChecks}
              columns={[
                { key: 'subject', label: 'Subject' },
                { key: 'hasAttachments', label: 'Attachments', render: (v) => <span className={v ? 'text-indigo-600 font-medium' : 'text-gray-400'}>{v ? 'Yes' : 'No'}</span> },
                { key: 'receivedDateTime', label: 'Received', render: (v) => v ? new Date(v).toLocaleString() : '-' },
              ]} />
          )}
          {validation.mailValidation.attachmentChecks?.length > 0 && (
            <ValidationTable title="Attachment Details"
              rows={validation.mailValidation.attachmentChecks.flatMap((c) => (c.attachments || []).map((att) => ({
                messageSubject: c.messageSubject, name: typeof att === 'string' ? att : att.name,
                size: typeof att === 'object' ? att.size : '-', contentType: typeof att === 'object' ? att.contentType : '-',
              })))}
              columns={[
                { key: 'messageSubject', label: 'Email Subject' }, { key: 'name', label: 'Attachment Name' },
                { key: 'size', label: 'Size', render: (v) => typeof v === 'number' ? `${(v / 1024).toFixed(1)} KB` : '-' },
                { key: 'contentType', label: 'Type' },
              ]} />
          )}
        </div>
      )}

      {/* Calendar validation */}
      {validation.calendarValidation && validation.calendarValidation.destinationEventCount > 0 && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold text-gray-900">Calendar Validation</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <ResultCard label="Total Events" value={validation.calendarValidation.destinationEventCount} />
            <ResultCard label="Recurring Events" value={validation.calendarValidation.recurringEvents?.length || 0} />
            <ResultCard label="Secondary Calendars" value={validation.calendarValidation.secondaryCalendars?.length || 0} />
          </div>
          {validation.calendarValidation.eventDetails?.length > 0 && (
            <ValidationTable title="Event Details" rows={validation.calendarValidation.eventDetails}
              columns={[
                { key: 'subject', label: 'Subject' }, { key: 'calendarName', label: 'Calendar' },
                { key: 'isRecurring', label: 'Recurring', render: (v) => v ? 'Yes' : 'No' },
                { key: 'isAllDay', label: 'All Day', render: (v) => v ? 'Yes' : 'No' },
              ]} />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Run metadata card — Execution ID, Status, Created, and the Direction (single pair) or a full
 * "Direction · N pairs" list (bulk runs). Rendered both in the empty state and above the validation
 * results so the pair context (esp. all bulk pairs) stays visible after validation completes.
 */
function RunInfoCard({ exec, ctx }) {
  const mappings = Array.isArray(ctx.userEmailMappings) && ctx.userEmailMappings.length > 1
    ? ctx.userEmailMappings : null;
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <div className={`grid gap-3 text-sm ${mappings ? 'grid-cols-2 sm:grid-cols-3' : 'grid-cols-2 sm:grid-cols-4'}`}>
        <Mini label="Execution ID" value={<span className="font-mono text-xs break-all">{exec.executionId}</span>} />
        <Mini label="Status" value={<StatusBadge status={exec.status} />} />
        {!mappings && <Mini label="Direction" value={<span className="text-xs">{ctx.sourceEmail} → {ctx.destinationEmail}</span>} />}
        <Mini label="Created" value={<span className="text-xs">{exec.createdAt ? new Date(exec.createdAt).toLocaleString() : '—'}</span>} />
      </div>
      {mappings && (
        <div className="bg-gray-50 rounded-lg p-3 mt-3">
          <p className="text-xs text-gray-500 mb-2">Direction · {mappings.length} pairs</p>
          <div className="space-y-1">
            {mappings.map((p, i) => (
              <p key={i} className="text-xs text-gray-800">
                {p.sourceEmail} <span className="text-gray-400">→</span> {p.destinationEmail}
              </p>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Mini({ label, value }) {
  return <div className="bg-gray-50 rounded-lg p-3"><p className="text-xs text-gray-500 mb-1">{label}</p><div className="text-gray-800">{value}</div></div>;
}
function MatchCard({ label, ok }) {
  return (
    <div className={`rounded-xl border p-4 ${ok ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
      <p className="text-xs font-medium uppercase tracking-wider opacity-75">{label}</p>
      <p className={`text-xl font-bold mt-1 ${ok ? 'text-green-700' : 'text-red-700'}`}>{ok ? 'Match' : 'Mismatch'}</p>
    </div>
  );
}
function ResultCard({ label, value }) {
  return <div className="bg-white rounded-xl border border-gray-200 p-4"><p className="text-xs font-medium text-gray-500 uppercase tracking-wider">{label}</p><p className="text-2xl font-bold text-gray-900 mt-1">{value}</p></div>;
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
      <div className="px-5 py-3 border-b border-gray-100"><h3 className="text-sm font-semibold text-gray-900">{title}</h3></div>
      <table className="w-full text-sm">
        <thead><tr className="bg-gray-50">
          <th className="px-5 py-2.5 text-left text-xs font-medium text-gray-500 uppercase">Label / Folder</th>
          <th className="px-5 py-2.5 text-right text-xs font-medium text-gray-500 uppercase">Source</th>
          <th className="px-5 py-2.5 text-right text-xs font-medium text-gray-500 uppercase">Destination</th>
          <th className="px-5 py-2.5 text-right text-xs font-medium text-gray-500 uppercase">Status</th>
        </tr></thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((r, idx) => (
            <tr key={idx} className={r.match ? 'bg-green-50/50' : 'bg-red-50/50'}>
              <td className="px-5 py-2.5 font-medium text-gray-900">{r.label}</td>
              <td className="px-5 py-2.5 text-right text-gray-700">{r.srcCount}</td>
              <td className="px-5 py-2.5 text-right text-gray-700">{r.destCount}</td>
              <td className="px-5 py-2.5 text-right"><span className={`text-xs font-semibold ${r.match ? 'text-green-600' : 'text-red-600'}`}>{r.match ? 'Match' : 'Mismatch'}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function CustomComparisonTable({ title, sourceItems, destItems }) {
  if (sourceItems.length === 0 && destItems.length === 0) {
    return <div className="bg-white rounded-xl border border-gray-200 p-5"><h3 className="text-sm font-semibold text-gray-900">{title}</h3><p className="text-sm text-gray-500 mt-1">No custom labels/folders found.</p></div>;
  }
  const rows = sourceItems.map((src) => {
    const dest = destItems.find((f) => f.name.toLowerCase() === src.name.toLowerCase());
    return { name: src.name, srcCount: src.messageCount || 0, destCount: dest ? dest.messageCount : null, match: dest ? src.messageCount === dest.messageCount : false, found: !!dest };
  });
  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-100"><h3 className="text-sm font-semibold text-gray-900">{title} ({sourceItems.length} source, {destItems.length} destination)</h3></div>
      <table className="w-full text-sm">
        <thead><tr className="bg-gray-50">
          <th className="px-5 py-2.5 text-left text-xs font-medium text-gray-500 uppercase">Label / Folder</th>
          <th className="px-5 py-2.5 text-right text-xs font-medium text-gray-500 uppercase">Source</th>
          <th className="px-5 py-2.5 text-right text-xs font-medium text-gray-500 uppercase">Destination</th>
          <th className="px-5 py-2.5 text-right text-xs font-medium text-gray-500 uppercase">Status</th>
        </tr></thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((r, idx) => (
            <tr key={idx} className={r.match ? 'bg-green-50/50' : 'bg-red-50/50'}>
              <td className="px-5 py-2.5 font-medium text-gray-900">{r.name}</td>
              <td className="px-5 py-2.5 text-right text-gray-700">{r.srcCount}</td>
              <td className="px-5 py-2.5 text-right text-gray-700">{r.found ? r.destCount : <span className="text-red-500">NOT FOUND</span>}</td>
              <td className="px-5 py-2.5 text-right"><span className={`text-xs font-semibold ${r.match ? 'text-green-600' : 'text-red-600'}`}>{r.match ? 'Match' : r.found ? 'Mismatch' : 'Missing'}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Small labelled stat tile used by the Chat Migration summary. */
function Stat({ label, value }) {
  return (
    <div className="bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
      <p className="text-xs text-gray-500">{label}</p>
      <p className="text-sm font-semibold text-gray-900 break-words">{String(value)}</p>
    </div>
  );
}
