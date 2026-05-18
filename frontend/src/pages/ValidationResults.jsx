import { useState, useEffect } from 'react';
import { getExecutions, downloadValidationPdf } from '../services/api';
import StatusBadge from '../components/StatusBadge';
import ValidationTable from '../components/ValidationTable';

export default function ValidationResults() {
  const [executions, setExecutions] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    loadExecutions();
  }, []);

  async function loadExecutions() {
    try {
      const { data } = await getExecutions();
      const completed = data.filter((e) => e.result?.validationSummary);
      setExecutions(completed);
      if (completed.length > 0) setSelectedId(completed[0].executionId);
    } catch {
      // API may not be running
    } finally {
      setLoading(false);
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
    <div className="page-wrap">
      <div className="page-header">
        <div>
          <h1 className="page-title">Validation Results</h1>
          <p className="page-subtitle">Review migration validation details</p>
        </div>
        {selectedId && (
          <button
            onClick={handleDownloadPdf}
            disabled={downloading}
            className="btn btn-primary disabled:opacity-50 flex items-center gap-2"
            style={{ padding: '10px 20px', fontSize: 14 }}
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

      <div className="card">
        <div className="card-body" style={{ padding: '20px 24px' }}>
        <label className="block font-bold mb-3" style={{ color: '#0129ac', fontSize: 14 }}>Select Execution</label>
        {loading ? (
          <p style={{ fontSize: 14, color: '#7a8fd4' }}>Loading...</p>
        ) : executions.length === 0 ? (
          <p style={{ fontSize: 14, color: '#4a65c0' }}>No completed executions with validation data</p>
        ) : (
          <select
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            className="w-full rounded-lg outline-none bg-white"
            style={{ border: '1px solid #c5cef5', color: '#0129ac', padding: '12px 16px', fontSize: 14 }}
          >
            {executions.map((exec) => {
              const isMsg = exec.context?.kind === 'message-validation';
              const label = isMsg
                ? `${exec.executionId.slice(0, 8)}... | Msg Migration (${exec.context?.combination || ''}) | ${new Date(exec.createdAt).toLocaleString()}`
                : `${exec.executionId.slice(0, 8)}... | ${exec.context?.sourceEmail} → ${exec.context?.destinationEmail} | ${new Date(exec.createdAt).toLocaleString()}`;
              return <option key={exec.executionId} value={exec.executionId}>{label}</option>;
            })}
          </select>
        )}
        </div>
      </div>

      {validation && (
        <div className="page-wrap">
          <div className="card">
            <div className="card-header">
              <div className="card-title">Overall Status</div>
              <StatusBadge status={validation.overallStatus} />
            </div>
            {validation.mismatches?.length === 0 && (
              <div className="card-body" style={{ padding: '16px 24px' }}>
                <p style={{ fontSize: 14, color: '#0129ac' }}>All validations passed — source and destination data match.</p>
              </div>
            )}
          </div>

          {sourceData && destData && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <h2 style={{ fontSize: 18, fontWeight: 700, color: '#0129ac' }}>Source vs Destination Comparison</h2>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="rounded-xl border p-4" style={{
                  backgroundColor: comparison?.defaultLabelsMatch ? '#eef1fb' : '#011e8a',
                  borderColor: comparison?.defaultLabelsMatch ? '#c5cef5' : '#0129ac',
                }}>
                  <p className="text-xs font-medium uppercase tracking-wider opacity-75" style={{ color: comparison?.defaultLabelsMatch ? '#0129ac' : 'white' }}>Default Labels/Folders</p>
                  <p className="text-xl font-bold mt-1" style={{ color: comparison?.defaultLabelsMatch ? '#0129ac' : 'white' }}>
                    {comparison?.defaultLabelsMatch ? 'Match' : 'Mismatch'}
                  </p>
                </div>
                <div className="rounded-xl border p-4" style={{
                  backgroundColor: comparison?.customLabelsMatch ? '#eef1fb' : '#011e8a',
                  borderColor: comparison?.customLabelsMatch ? '#c5cef5' : '#0129ac',
                }}>
                  <p className="text-xs font-medium uppercase tracking-wider opacity-75" style={{ color: comparison?.customLabelsMatch ? '#0129ac' : 'white' }}>Custom Labels/Folders</p>
                  <p className="text-xl font-bold mt-1" style={{ color: comparison?.customLabelsMatch ? '#0129ac' : 'white' }}>
                    {comparison?.customLabelsMatch ? 'Match' : 'Mismatch'}
                  </p>
                </div>
              </div>

              <ComparisonTable
                title="Default Labels / Folders"
                sourceItems={sourceData.defaultLabels || []}
                destItems={destData.defaultFolders || []}
                mapping={{ INBOX: 'Inbox', SENT: 'Sent Items', DRAFT: 'Drafts', TRASH: 'Deleted Items', SPAM: 'Junk Email' }}
              />

              <CustomComparisonTable
                title="Custom Labels / Folders"
                sourceItems={sourceData.customLabels || []}
                destItems={destData.customFolders || []}
              />

              {comparison?.issues?.length > 0 && (
                <div className="rounded-xl p-5" style={{ backgroundColor: '#eef1fb', border: '1px solid #0129ac' }}>
                  <h3 className="text-sm font-semibold mb-3" style={{ color: '#0129ac' }}>
                    Comparison Issues ({comparison.issues.length})
                  </h3>
                  <div className="space-y-2">
                    {comparison.issues.map((issue, idx) => (
                      <div key={idx} className="flex items-center gap-3 text-sm">
                        <span className="px-2 py-0.5 rounded text-xs font-medium" style={{ backgroundColor: '#0129ac', color: 'white' }}>
                          {issue.type}
                        </span>
                        <span className="font-medium" style={{ color: '#0129ac' }}>{issue.label}</span>
                        <span style={{ color: '#2a40a8' }}>
                          source: <code className="px-1 rounded" style={{ backgroundColor: '#c5cef5' }}>{issue.sourceCount}</code>
                          {' → '}
                          destination: <code className="px-1 rounded" style={{ backgroundColor: '#c5cef5' }}>{String(issue.destCount)}</code>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {validation.mailValidation && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <h2 style={{ fontSize: 18, fontWeight: 700, color: '#0129ac' }}>Mail Validation</h2>
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
                    { key: 'hasAttachments', label: 'Attachments', render: (val) => <span style={{ color: '#0129ac', fontWeight: val ? 600 : 400 }}>{val ? 'Yes' : 'No'}</span> },
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

          {validation.kind === 'message' && validation.messageValidation && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <h2 style={{ fontSize: 18, fontWeight: 700, color: '#0129ac' }}>
                Message Migration Validation — {validation.combination}
              </h2>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }}>
                <ResultCard label="Total Jobs" value={validation.messageValidation.totalJobs} />
                <ResultCard label="Completed Jobs" value={validation.messageValidation.completedJobs} />
                <ResultCard label="Total Messages" value={(validation.messageValidation.totalMessages || 0).toLocaleString()} />
                <ResultCard label="Processed" value={(validation.messageValidation.processedMessages || 0).toLocaleString()} />
              </div>
              {validation.messageValidation.channelDetails?.length > 0 && (
                <ValidationTable
                  title="Channel / Team Details"
                  rows={validation.messageValidation.channelDetails}
                  columns={[
                    { key: 'name', label: 'Team / Channel' },
                    { key: 'totalMessages', label: 'Total Messages', render: (val) => (val || 0).toLocaleString() },
                    { key: 'processedMessages', label: 'Processed', render: (val) => (val || 0).toLocaleString() },
                    { key: 'migrationStatus', label: 'Migration Status' },
                    { key: 'teamStatus', label: 'Team Status' },
                    { key: 'match', label: 'Match', render: (val) => (
                      <span style={{ fontSize: 12, fontWeight: 700, color: val ? '#059669' : '#dc2626' }}>
                        {val ? 'Match' : 'Mismatch'}
                      </span>
                    )},
                  ]}
                />
              )}
              {validation.mismatches?.length > 0 && (
                <div style={{ borderRadius: 12, padding: '16px 20px', backgroundColor: '#fff0f0', border: '1px solid #fca5a5' }}>
                  <h3 style={{ fontSize: 14, fontWeight: 700, color: '#dc2626', marginBottom: 10 }}>
                    Mismatches ({validation.mismatches.length})
                  </h3>
                  {validation.mismatches.map((m, idx) => (
                    <div key={idx} style={{ fontSize: 13, color: '#991b1b', padding: '6px 0', borderTop: idx > 0 ? '1px solid #fecdd3' : 'none' }}>
                      <strong>{m.field}</strong>: expected {(m.expected || 0).toLocaleString()} msgs — got {(m.actual || 0).toLocaleString()} msgs
                      {m.migrationStatus && <span style={{ marginLeft: 8, fontSize: 11, color: '#7f1d1d' }}>({m.migrationStatus})</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {validation.calendarValidation && validation.calendarValidation.destinationEventCount > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <h2 style={{ fontSize: 18, fontWeight: 700, color: '#0129ac' }}>Calendar Validation</h2>
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
    const dest = destItems.find((f) => f.name === outlookName);
    const srcCount = src?.messageCount || 0;
    const destCount = dest?.messageCount || 0;
    return { label: `${gmailId} → ${outlookName}`, srcCount, destCount, match: srcCount === destCount };
  });

  return (
    <div className="card overflow-hidden">
      <div className="card-header">
        <div className="card-title">{title}</div>
      </div>
      <table className="data-table">
        <thead>
          <tr>
            <th>Label / Folder</th>
            <th style={{ textAlign: 'right' }}>Source</th>
            <th style={{ textAlign: 'right' }}>Destination</th>
            <th style={{ textAlign: 'right' }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, idx) => (
            <tr key={idx} style={{ backgroundColor: r.match ? '#f5f7fd' : '#fff9eb' }}>
              <td style={{ fontWeight: 600, color: '#0129ac' }}>{r.label}</td>
              <td style={{ textAlign: 'right', color: '#2a40a8' }}>{r.srcCount}</td>
              <td style={{ textAlign: 'right', color: '#2a40a8' }}>{r.destCount}</td>
              <td style={{ textAlign: 'right' }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: r.match ? '#059669' : '#dc2626' }}>
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
      <div className="card">
        <div className="card-body" style={{ padding: '16px 24px' }}>
          <p style={{ fontSize: 14, fontWeight: 600, color: '#0129ac', marginBottom: 6 }}>{title}</p>
          <p style={{ fontSize: 14, color: '#4a65c0' }}>No custom labels/folders found.</p>
        </div>
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
    <div className="card overflow-hidden">
      <div className="card-header">
        <div className="card-title">{title} ({sourceItems.length} source, {destItems.length} destination)</div>
      </div>
      <table className="data-table">
        <thead>
          <tr>
            <th>Label / Folder</th>
            <th style={{ textAlign: 'right' }}>Source</th>
            <th style={{ textAlign: 'right' }}>Destination</th>
            <th style={{ textAlign: 'right' }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, idx) => (
            <tr key={idx} style={{ backgroundColor: r.match ? '#f5f7fd' : '#fff9eb' }}>
              <td style={{ fontWeight: 600, color: '#0129ac' }}>{r.name}</td>
              <td style={{ textAlign: 'right', color: '#2a40a8' }}>{r.srcCount}</td>
              <td style={{ textAlign: 'right', color: '#2a40a8' }}>
                {r.found ? r.destCount : <span style={{ color: '#dc2626', fontWeight: 600 }}>NOT FOUND</span>}
              </td>
              <td style={{ textAlign: 'right' }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: r.match ? '#059669' : '#dc2626' }}>
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
    <div className="stat-card blue">
      <div style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>{label}</div>
      <div style={{ fontSize: 32, fontWeight: 800, color: '#0129ac' }}>{value}</div>
    </div>
  );
}
