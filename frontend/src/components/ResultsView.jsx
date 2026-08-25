import StatusBadge from './StatusBadge';
import ValidationTable from './ValidationTable';
import { combinationLabel } from '../utils/combination';

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
                  <div className={`grid gap-3 text-sm ${mappings ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-2 sm:grid-cols-5'}`}>
                    <Mini label="Execution ID" value={<span className="font-mono text-xs break-all">{exec.executionId}</span>} />
                    <Mini label="Status" value={<StatusBadge status={exec.status} />} />
                    {combinationLabel(ctx) && <Mini label="Combination" value={<span className="text-xs">{combinationLabel(ctx)}</span>} />}
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

  // ── Message migration → dedicated report view ─────────────────────────────
  const isMessage = validation.productType === 'Message' || !!ctx.messageCombination;
  if (isMessage) {
    return <MessageMigrationView exec={exec} ctx={ctx} validation={validation} />;
  }

  return (
    <div className="space-y-6">
      {/* Run info — stays visible after validation completes; shows all pairs for bulk runs */}
      <RunInfoCard exec={exec} ctx={ctx} />
      {/* Overall status */}
      {/* Content runs have no labels/folders pair, so they get their own comparison. */}
      {validation?.perUser?.length > 0 && <ContentComparison perUser={validation.perUser} />}

      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <div className="flex items-center gap-4 mb-2">
          <h2 className="text-lg font-semibold text-gray-900">Overall Status</h2>
          <StatusBadge status={validation.overallStatus} />
          <span className="text-sm text-gray-500">({validation.mismatches?.length || 0} failed)</span>
        </div>
        {validation.overallStatus === 'SKIPPED' ? (
          <p className="text-sm text-gray-600">
            {validation.note || 'Automated validation was skipped for this product type — verify in the destination app.'}
          </p>
        ) : validation.mismatches?.length === 0 ? (
          <p className="text-sm text-green-600">All validations passed — source and destination data match.</p>
        ) : null}
        {validation.overallStatus !== 'SKIPPED' && validation.mismatches?.length > 0 && (() => {
          // Collapse per-message recipient/permission-mapping issues (deepMail + headers) into a
          // single count row instead of one line per mail. Applies to all combinations.
          const isRecipientIssue = (m) => m.category === 'deepMail' && m.kind === 'headers';

          // Content checks report every affected item on one line joined by " | ", each shaped
          // "<path> — <reason>". A permissions failure therefore arrives as 80 segments naming the
          // SAME cause 80 times, and the deep test paths are 400+ characters, so the raw string
          // sprawled across the page and buried the actual problem. Mail already collapses its
          // per-message recipient issues into one counted row; do the same for content.
          const isContentIssue = (m) => m.category === 'content';
          const summarizeContent = (m) => {
            const segments = String(m.actual ?? '').split(' | ').map((x) => x.trim()).filter(Boolean);
            const counts = new Map();
            for (const seg of segments) {
              const cut = seg.lastIndexOf('—');
              const reason = (cut >= 0 ? seg.slice(cut + 1) : seg).trim() || seg;
              counts.set(reason, (counts.get(reason) || 0) + 1);
            }
            const causes = [...counts.entries()]
              .map(([reason, count]) => ({ reason, count }))
              .sort((a, b) => b.count - a.count);
            // The check name often carries the AUTHORITATIVE total, e.g. "— 80 mismatch", while the
            // detail string lists only the first ~20 examples. Reporting the sample size as though
            // it were the total put two contradicting numbers side by side ("80 mismatch" next to
            // "20 affected items"), so prefer the stated total and say how many are shown.
            const stated = /(\d+)\s*(?:mismatch|item|file|issue)/i.exec(String(m.field ?? ''));
            const statedTotal = stated ? Number(stated[1]) : null;
            const shown = segments.length;
            const total = (statedTotal && statedTotal > shown) ? statedTotal : shown;
            return { field: m.field, causes, total, shown, truncated: total > shown };
          };
          // Long deep-nesting paths are unreadable in full; keep the ends, drop the middle.
          const shorten = (text, max = 220) => {
            const t = String(text ?? '');
            if (t.length <= max) return t;
            return `${t.slice(0, max - 60)} … ${t.slice(-55)}`;
          };
          const recipientIssues = validation.mismatches.filter(isRecipientIssue);
          const contentIssues = validation.mismatches.filter(isContentIssue).map(summarizeContent);
          const otherIssues = validation.mismatches
            .filter((m) => !isRecipientIssue(m) && !isContentIssue(m));
          return (
            <div className="mt-4">
              <h3 className="text-sm font-semibold text-red-800 mb-2">
                Key Issues ({validation.mismatches.length} failed)
              </h3>
              <div className="space-y-2">
                {contentIssues.map((c, idx) => (
                  <div key={`c${idx}`} className="bg-red-50 rounded-lg p-3 text-sm">
                    <div className="flex items-baseline gap-2">
                      <span className="font-semibold text-red-800">{c.field}</span>
                      <span className="text-xs text-gray-500">
                        {c.total} affected item{c.total === 1 ? '' : 's'}
                        {c.truncated ? ` (${c.shown} shown)` : ''},{' '}
                        {c.causes.length} distinct cause{c.causes.length === 1 ? '' : 's'}
                        {c.truncated ? ' in the sample' : ''}
                      </span>
                    </div>
                    <ul className="mt-1.5 space-y-1">
                      {c.causes.slice(0, 3).map((r, i) => (
                        <li key={i} className="flex items-start gap-2">
                          <span className={`flex-shrink-0 text-xs font-semibold px-1.5 rounded ${r.count > 1 ? 'bg-red-200 text-red-900' : 'bg-gray-200 text-gray-700'}`}>
                            {r.count > 1 ? `x${r.count}${c.truncated ? '+' : ''}` : '1'}
                          </span>
                          <span className="text-gray-700 break-words">{shorten(r.reason)}</span>
                        </li>
                      ))}
                      {c.causes.length > 3 && (
                        <li className="text-xs text-gray-500 pl-1">
                          + {c.causes.length - 3} further distinct cause(s) — see the PDF for every line
                        </li>
                      )}
                    </ul>
                  </div>
                ))}
                {otherIssues.map((m, idx) => (
                  <div key={idx} className="flex items-start gap-3 bg-red-50 rounded-lg p-3 text-sm">
                    <span className="text-red-500 font-medium flex-shrink-0">{m.category}</span>
                    <span className="text-gray-700">{m.field}: expected <code className="bg-red-100 px-1 rounded">{String(m.expected)}</code>, got <code className="bg-red-100 px-1 rounded">{String(m.actual)}</code></span>
                  </div>
                ))}
                {recipientIssues.length > 0 && (
                  <div className="flex items-start gap-3 bg-red-50 rounded-lg p-3 text-sm">
                    <span className="text-red-500 font-medium flex-shrink-0">deepMail</span>
                    <span className="text-gray-700">
                      <code className="bg-red-100 px-1 rounded">{recipientIssues.length}</code> mail{recipientIssues.length === 1 ? '' : 's'} with a recipient (From/To/Cc/Bcc permission-mapping) mismatch
                    </span>
                  </div>
                )}
              </div>
            </div>
          );
        })()}
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
            <ResultCard label="Destination Mailbox Total" value={validation.mailValidation.destinationCount} />
            <ResultCard label="Folders Found" value={validation.mailValidation.folderMapping?.length || 0} />
            <ResultCard label="Emails with Attachments" value={validation.mailValidation.emailsWithAttachments ?? (validation.mailValidation.attachmentChecks?.length || 0)} />
          </div>
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

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGE MIGRATION VALIDATION VIEW
// ─────────────────────────────────────────────────────────────────────────────

function MessageMigrationView({ exec, ctx, validation }) {
  const summary = validation.summary || {};
  const bugs = validation.bugs || [];
  const channels = validation.channels || [];

  const realBugs = bugs.filter((b) => b.status === 'BUG');
  const knownLimitations = bugs.filter((b) => b.status === 'KNOWN_LIMITATION');

  const bugsByCategory = realBugs.reduce((acc, b) => {
    const cat = b.feature || b.bugType || 'Other';
    if (!acc[cat]) acc[cat] = { category: cat, severity: b.severity, count: 0 };
    acc[cat].count++;
    return acc;
  }, {});
  const bugCategoryList = Object.values(bugsByCategory).sort((a, b) => {
    const order = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
    return (order[a.severity] ?? 9) - (order[b.severity] ?? 9);
  });

  // Deduplicate known limitations by feature for the summary table
  const klByFeature = knownLimitations.reduce((acc, b) => {
    const key = b.feature || b.bugType;
    if (!acc[key]) acc[key] = { feature: b.feature || b.bugType, channels: new Set(), items: 0 };
    acc[key].channels.add(b.channel);
    if (typeof b.expected === 'number' && b.expected > 0) acc[key].items = (acc[key].items || 0) + b.expected;
    return acc;
  }, {});
  const klList = Object.values(klByFeature).map((k) => ({ ...k, channels: k.channels.size }));

  const src = summary.source || {};
  const cf = summary.cfReport || {};
  const dst = summary.destination || {};
  const bugSummary = summary.bugSummary || {};
  const combination = validation.messageCombination || ctx.messageCombination || 'Slack → Teams';

  return (
    <div className="space-y-6">
      <RunInfoCard exec={exec} ctx={ctx} />

      {/* ── Header status ── */}
      <div className={`rounded-xl border p-5 ${
        validation.overallStatus === 'PASS'       ? 'bg-green-50 border-green-200' :
        validation.overallStatus === 'PARTIAL'    ? 'bg-amber-50 border-amber-200' :
        validation.overallStatus === 'FAIL'       ? 'bg-red-50 border-red-200' :
        validation.overallStatus === 'INCOMPLETE' ? 'bg-purple-50 border-purple-200' :
        'bg-gray-50 border-gray-200'
      }`}>
        <div className="flex items-center gap-3 mb-1">
          <h2 className="text-lg font-semibold text-gray-900">Message Migration Validation</h2>
          <StatusBadge status={validation.overallStatus} />
        </div>
        <p className="text-sm text-gray-600">{combination} · {summary.channelsInitiated || 0} channel(s)/DM(s) validated</p>
        {validation.overallStatus === 'PASS' && (
          <p className="text-sm text-green-700 mt-1 font-medium">All validated features match — migration completed successfully.</p>
        )}
        {validation.overallStatus === 'PARTIAL' && realBugs.length > 0 && (
          <p className="text-sm text-amber-700 mt-1 font-medium">
            {realBugs.length} bug(s) found across {summary.channelsInitiated || 0} channel(s). Known limitations are expected and listed separately.
          </p>
        )}
        {validation.overallStatus === 'INCOMPLETE' && (
          <p className="text-sm text-purple-700 mt-1 font-medium">
            Destination channel(s) could not be located — source ↔ destination comparison was not possible.
            Re-run validation after ensuring Teams channels are accessible.
          </p>
        )}
        {validation.overallStatus === 'SKIPPED' && (
          <p className="text-sm text-gray-600 mt-1">{validation.note || 'No channels were initiated for migration.'}</p>
        )}
      </div>

      {/* ── Summary Cards ── */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider mb-3">Migration Summary</h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-3">
          <MetricCard label="Source Messages" value={src.totalMessages ?? '—'} sub={src.totalReplies ? `+${src.totalReplies} replies` : 'Slack'} color="blue" />
          <MetricCard label="Source Files" value={src.totalFiles ?? '—'} sub={src.totalFormatted ? `${src.totalFormatted} formatted` : 'Slack'} color="blue" />
          <MetricCard label="CF Picked" value={cf.totalPicked ?? '—'} sub={cf.processingRate ? `${cf.processingRate} processed` : 'CloudFuze'} color="indigo" />
          <MetricCard label="CF Processed" value={cf.totalProcessed ?? '—'} sub={cf.totalNotProcessed ? `${cf.totalNotProcessed} skipped` : 'All processed'} color="indigo" />
          <MetricCard label="Dest Messages" value={dst.totalMessages ?? '—'} sub={dst.channelsNotFound > 0 ? `${dst.channelsNotFound} ch not found` : (dst.totalReplies ? `+${dst.totalReplies} replies` : 'Teams')} color={dst.channelsNotFound > 0 ? 'orange' : 'green'} />
          <MetricCard label="Bugs Found" value={bugSummary.total ?? realBugs.length} sub={`${bugSummary.knownLimitations ?? knownLimitations.length} known limits`} color={realBugs.length > 0 ? 'red' : 'green'} />
        </div>
        {/* Source vs Destination comparison row */}
        {(src.totalMessages != null || dst.totalMessages != null) && (
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="px-4 py-2.5 border-b border-gray-100 bg-gray-50">
              <p className="text-xs font-semibold text-gray-600 uppercase tracking-wider">Source ↔ Destination Totals</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="bg-gray-50 border-b border-gray-100">
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Metric</th>
                  <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">Source (Slack)</th>
                  <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">CF Picked</th>
                  <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">Destination (Teams)</th>
                  <th className="px-4 py-2 text-center text-xs font-medium text-gray-500 uppercase">Status</th>
                </tr></thead>
                <tbody className="divide-y divide-gray-100">
                  {[
                    { label: 'Messages', src: src.totalMessages, cf: cf.totalPicked, dst: dst.totalMessages, tol: 0.02 },
                    { label: 'Thread Replies', src: src.totalReplies, cf: null, dst: dst.totalReplies, tol: 0.05 },
                    { label: 'Files', src: src.totalFiles, cf: null, dst: dst.totalFiles, tol: 0.05 },
                    { label: 'Mentions', src: src.totalMentions, cf: null, dst: dst.totalMentions, tol: 0.10 },
                    { label: 'Reactions (src only)', src: src.totalReactions, cf: null, dst: null, tol: 0, known: true },
                    { label: 'Pinned (src only)', src: src.totalPinned, cf: null, dst: null, tol: 0, known: true },
                    { label: 'Formatted (src only)', src: src.totalFormatted, cf: null, dst: null, tol: 0, known: true },
                  ].filter(r => r.src != null && r.src > 0).map((row, idx) => {
                    let statusEl;
                    if (row.known) {
                      statusEl = <span className="text-xs px-2 py-0.5 rounded font-semibold bg-amber-100 text-amber-700">KNOWN LIMITATION</span>;
                    } else if (row.dst == null) {
                      statusEl = <span className="text-xs px-2 py-0.5 rounded font-semibold bg-purple-100 text-purple-700">NOT ACCESSIBLE</span>;
                    } else {
                      const tol = Math.max(1, Math.ceil(row.src * row.tol));
                      const delta = row.dst - row.src;
                      const ok = Math.abs(delta) <= tol;
                      statusEl = ok
                        ? <span className="text-xs px-2 py-0.5 rounded font-semibold bg-green-100 text-green-700">MATCH ✓</span>
                        : <span className="text-xs px-2 py-0.5 rounded font-semibold bg-red-100 text-red-700">{delta > 0 ? `+${delta} EXTRA` : `${delta} MISSING`}</span>;
                    }
                    return (
                      <tr key={idx} className="hover:bg-gray-50">
                        <td className="px-4 py-2 text-gray-700 font-medium">{row.label}</td>
                        <td className="px-4 py-2 text-right tabular-nums text-gray-800">{row.src ?? '—'}</td>
                        <td className="px-4 py-2 text-right tabular-nums text-indigo-700">{row.cf ?? '—'}</td>
                        <td className="px-4 py-2 text-right tabular-nums text-gray-800">{row.dst ?? '—'}</td>
                        <td className="px-4 py-2 text-center">{statusEl}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* ── Bug Severity Summary ── */}
      {realBugs.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider mb-3">Bug Breakdown</h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            {[
              { label: 'Critical', key: 'byCritical', color: 'red' },
              { label: 'High', key: 'byHigh', color: 'orange' },
              { label: 'Medium', key: 'byMedium', color: 'amber' },
              { label: 'Low', key: 'byLow', color: 'gray' },
            ].map(({ label, key, color }) => {
              const count = bugSummary[key] ?? 0;
              const colorMap = {
                red: 'bg-red-50 border-red-200 text-red-700',
                orange: 'bg-orange-50 border-orange-200 text-orange-700',
                amber: 'bg-amber-50 border-amber-200 text-amber-700',
                gray: 'bg-gray-50 border-gray-200 text-gray-600',
              };
              return (
                <div key={key} className={`rounded-lg border p-3 ${colorMap[color]}`}>
                  <p className="text-xs font-medium uppercase tracking-wider opacity-75">{label}</p>
                  <p className="text-2xl font-bold mt-0.5">{count}</p>
                </div>
              );
            })}
          </div>

          {/* Bug breakdown by category */}
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100">
              <h3 className="text-sm font-semibold text-gray-900">Bugs by Category</h3>
            </div>
            <table className="w-full text-sm">
              <thead><tr className="bg-gray-50">
                <th className="px-5 py-2.5 text-left text-xs font-medium text-gray-500 uppercase">Category</th>
                <th className="px-5 py-2.5 text-center text-xs font-medium text-gray-500 uppercase">Severity</th>
                <th className="px-5 py-2.5 text-right text-xs font-medium text-gray-500 uppercase">Count</th>
              </tr></thead>
              <tbody className="divide-y divide-gray-100">
                {bugCategoryList.map((cat, idx) => (
                  <tr key={idx} className="hover:bg-gray-50">
                    <td className="px-5 py-2.5 font-medium text-gray-900">{cat.category}</td>
                    <td className="px-5 py-2.5 text-center">
                      <SeverityBadge severity={cat.severity} />
                    </td>
                    <td className="px-5 py-2.5 text-right font-semibold text-gray-900">{cat.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Channel / DM Summary Table ── */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider mb-3">Channel Validation Summary</h3>
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="bg-gray-50">
              <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase">Channel / DM</th>
              <th className="px-4 py-2.5 text-center text-xs font-medium text-gray-500 uppercase">Type</th>
              <th className="px-4 py-2.5 text-right text-xs font-medium text-gray-500 uppercase">Src Msgs</th>
              <th className="px-4 py-2.5 text-right text-xs font-medium text-gray-500 uppercase">+Replies</th>
              <th className="px-4 py-2.5 text-right text-xs font-medium text-gray-500 uppercase">CF Picked</th>
              <th className="px-4 py-2.5 text-right text-xs font-medium text-gray-500 uppercase">Dst Msgs</th>
              <th className="px-4 py-2.5 text-center text-xs font-medium text-gray-500 uppercase">Match Rate</th>
              <th className="px-4 py-2.5 text-center text-xs font-medium text-gray-500 uppercase">CF Status</th>
              <th className="px-4 py-2.5 text-center text-xs font-medium text-gray-500 uppercase">Result</th>
            </tr></thead>
            <tbody className="divide-y divide-gray-100">
              {channels.length === 0 ? (
                <tr><td colSpan={9} className="px-4 py-4 text-center text-gray-400 text-sm">No channels validated</td></tr>
              ) : channels.map((ch, idx) => {
                const isPartial = ch.validationStatus === 'PARTIAL';
                const isFail = ch.validationStatus === 'FAIL';
                const deep = ch.deepMessageValidation;
                const matchRate = deep?.matchRate;
                return (
                  <tr key={idx} className={isPartial ? 'bg-amber-50/40' : isFail ? 'bg-red-50/40' : 'hover:bg-gray-50'}>
                    <td className="px-4 py-2.5">
                      <span className="font-medium text-gray-900">{ch.channelName || ch.channelId}</span>
                      <span className="text-xs text-gray-400 ml-1 font-mono">{ch.channelId !== ch.channelName ? ch.channelId : ''}</span>
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      <span className={`text-xs px-2 py-0.5 rounded font-medium ${ch.kind === 'dm' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'}`}>
                        {ch.kind === 'dm' ? 'DM' : 'Channel'}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right text-gray-700">{ch.source?.messageCount ?? '—'}</td>
                    <td className="px-4 py-2.5 text-right text-gray-500 text-xs">{ch.source?.totalReplyCount != null ? `+${ch.source.totalReplyCount}` : '—'}</td>
                    <td className="px-4 py-2.5 text-right text-gray-700">{ch.cfReport?.totalMessages ?? '—'}</td>
                    <td className="px-4 py-2.5 text-right text-gray-700">
                      {ch.destination?.found ? (ch.destination.messageCount ?? '—') : <span className="text-gray-400 text-xs">not found</span>}
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      {matchRate != null ? (
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded ${matchRate >= 95 ? 'bg-green-100 text-green-700' : matchRate >= 70 ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'}`}>
                          {matchRate}%
                        </span>
                      ) : <span className="text-gray-300 text-xs">—</span>}
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      <JobStatusBadge status={ch.cfReport?.jobStatus || ch.jobStatus} />
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      <ValidationStatusBadge status={ch.validationStatus} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </div>
      </div>

      {/* ── Feature Validation per Channel ── */}
      {channels.filter((ch) => ch.source && Object.keys(ch.source).length > 0).map((ch, idx) => {
        const graphBlocked = ch.destination?.found && ch.destination?.graphAccessible === false;
        return (
        <div key={idx} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 flex items-center gap-3">
            <h3 className="text-sm font-semibold text-gray-900">
              {ch.channelName || ch.channelId}
              <span className="ml-2 text-xs font-normal text-gray-400">({ch.kind})</span>
            </h3>
            <ValidationStatusBadge status={ch.validationStatus} />
            {ch.bugs?.filter(b => b.status === 'BUG').length > 0 && (
              <span className="text-xs text-red-600 font-medium">{ch.bugs.filter(b => b.status === 'BUG').length} bug(s)</span>
            )}
            {ch.validationStatus === 'INCOMPLETE' && ch.bugs?.filter(b => b.status === 'BUG').length === 0 && (
              <span className="text-xs text-purple-600 font-medium">destination not accessible</span>
            )}
            {graphBlocked && (
              <span className="text-xs text-amber-600 font-medium">Teams API not accessible (403)</span>
            )}
          </div>

          {/* Feature comparison table — source ↔ CF ↔ destination per feature */}
          {ch.features && Object.keys(ch.features).length > 0 && (
            <div className="px-5 pt-3 pb-0">
              <div className="overflow-x-auto">
                <table className="w-full text-xs border border-gray-100 rounded-lg overflow-hidden mb-4">
                  <thead>
                    <tr className="bg-gray-50 border-b border-gray-100">
                      <th className="px-3 py-2 text-left text-gray-500 font-medium">Feature</th>
                      <th className="px-3 py-2 text-right text-gray-500 font-medium">Source</th>
                      <th className="px-3 py-2 text-right text-gray-500 font-medium">CF</th>
                      <th className="px-3 py-2 text-right text-gray-500 font-medium">Destination</th>
                      <th className="px-3 py-2 text-right text-gray-500 font-medium">Delta</th>
                      <th className="px-3 py-2 text-center text-gray-500 font-medium">Result</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {Object.entries(ch.features).map(([key, row], fi) => {
                      const statusMap = {
                        MATCH:                { cls: 'bg-green-100 text-green-700', label: '✓ Match' },
                        MISMATCH:             { cls: 'bg-red-100 text-red-700',    label: '✗ Mismatch' },
                        KNOWN_LIMITATION:     { cls: 'bg-amber-100 text-amber-700', label: '~ Limitation' },
                        UNKNOWN:              { cls: 'bg-gray-100 text-gray-500',   label: '? Unknown' },
                        DEST_NOT_FOUND:       { cls: 'bg-purple-100 text-purple-700', label: 'Not Found' },
                        GRAPH_NOT_ACCESSIBLE: { cls: 'bg-amber-100 text-amber-600', label: '403 Blocked' },
                        INFO:                 { cls: 'bg-blue-50 text-blue-600',    label: 'Info' },
                      };
                      const st = statusMap[row.status] || statusMap.UNKNOWN;
                      const isCfRow = key === 'cfPicked' || key === 'cfProcessed';
                      return (
                        <tr key={fi} className={isCfRow ? 'bg-indigo-50/30' : 'hover:bg-gray-50'}>
                          <td className={`px-3 py-1.5 font-medium ${isCfRow ? 'text-indigo-700' : 'text-gray-700'}`}>{row.label}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-gray-700">{row.source ?? '—'}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-indigo-600">
                            {key === 'cfPicked' ? row.destination : (key === 'cfProcessed' ? row.destination : '—')}
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-gray-700">
                            {isCfRow ? '—' : (row.destination ?? '—')}
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums">
                            {row.delta != null
                              ? <span className={row.delta < 0 ? 'text-red-600' : row.delta > 0 ? 'text-amber-600' : 'text-green-600'}>{row.delta > 0 ? `+${row.delta}` : row.delta}</span>
                              : <span className="text-gray-300">—</span>}
                          </td>
                          <td className="px-3 py-1.5 text-center">
                            <span className={`text-xs px-1.5 py-0.5 rounded font-semibold ${st.cls}`}>{st.label}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Feature counts cards */}
          <div className="px-5 py-3">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
              <FeatureStat label="Messages" src={ch.source?.messageCount} dst={ch.destination?.found ? ch.destination?.messageCount : null} cf={ch.cfReport?.totalMessages} graphBlocked={graphBlocked} />
              <FeatureStat label="Files" src={ch.source?.fileCount} dst={ch.destination?.found ? ch.destination?.fileCount : null} graphBlocked={graphBlocked} />
              <FeatureStat label="Thread Replies" src={ch.source?.totalReplyCount} dst={ch.destination?.found ? ch.destination?.threadReplyCount : null} graphBlocked={graphBlocked} />
              <FeatureStat label="Mentions" src={ch.source?.userMentionMsgCount ?? ch.source?.mentionMsgCount} dst={ch.destination?.found ? ch.destination?.mentionMsgCount : null} graphBlocked={graphBlocked} />
            </div>

            {/* Source feature inventory */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-1 text-xs text-gray-600 border-t border-gray-100 pt-3">
              {[
                ['Reactions (src)', ch.source?.totalReactionCount],
                ['Pinned (src)', ch.source?.pinnedCount],
                ['Bold msgs', ch.source?.boldMsgCount],
                ['Italic msgs', ch.source?.italicMsgCount],
                ['Strikethrough', ch.source?.strikethroughMsgCount],
                ['Ordered lists', ch.source?.orderedListMsgCount],
                ['Bullet lists', ch.source?.bulletListMsgCount],
                ['Code blocks', ch.source?.codeBlockMsgCount],
                ['Links', ch.source?.linkMsgCount],
                ['Emojis', ch.source?.emojiMsgCount],
                ['Custom emojis', ch.source?.customEmojiMsgCount],
                ['GIFs', ch.source?.gifMsgCount],
                ['Edited msgs', ch.source?.editedMsgCount],
                ['Group mentions', ch.source?.groupMentionMsgCount],
                ['Forwarded', ch.source?.forwardedMsgCount],
                ['Polly', ch.source?.pollyMsgCount],
              ].filter(([, v]) => v != null && v > 0).map(([label, value], i) => (
                <div key={i} className="flex justify-between py-0.5 border-b border-gray-50">
                  <span className="text-gray-500">{label}</span>
                  <span className="font-medium text-gray-700">{value}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Bugs for this channel */}
          {ch.bugs?.filter(b => b.status === 'BUG').length > 0 && (
            <div className="border-t border-gray-100 px-5 py-3">
              <p className="text-xs font-semibold text-red-700 mb-2">Bugs ({ch.bugs.filter(b => b.status === 'BUG').length})</p>
              <div className="space-y-3">
                {ch.bugs.filter(b => b.status === 'BUG').map((bug, bi) => (
                  <div key={bi} className="bg-red-50 border border-red-100 rounded-xl overflow-hidden">
                    <div className="p-3">
                      <div className="flex items-center gap-2 mb-1">
                        <SeverityBadge severity={bug.severity} />
                        <span className="text-xs font-semibold text-red-800">{bug.feature || bug.bugType}</span>
                      </div>
                      <p className="text-xs text-gray-700">{bug.description}</p>
                      {bug.expected != null && bug.actual != null && (
                        <p className="text-xs text-gray-500 mt-1">
                          Expected <code className="bg-red-100 px-1 rounded">{String(bug.expected)}</code> → Got <code className="bg-red-100 px-1 rounded">{String(bug.actual)}</code>
                          {bug.delta != null && <span className="ml-1 text-red-600">({bug.delta > 0 ? '+' : ''}{bug.delta})</span>}
                        </p>
                      )}
                      {bug.impact && <p className="text-xs text-gray-500 mt-1 italic">{bug.impact}</p>}
                    </div>
                    {bug.evidence?.length > 0 && <BugEvidencePanel bug={bug} />}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Warnings: destination not accessible OR Teams API 403 */}
          {ch.bugs?.filter(b => b.status === 'WARNING').length > 0 && (
            <div className="border-t border-gray-100 px-5 py-3">
              <p className="text-xs font-semibold text-gray-600 mb-2">
                Validation Notices ({ch.bugs.filter(b => b.status === 'WARNING').length})
              </p>
              <div className="space-y-3">
                {ch.bugs.filter(b => b.status === 'WARNING').map((w, wi) => {
                  const isGraph = w.bugType === 'TEAMS_GRAPH_NOT_ACCESSIBLE';
                  return (
                  <div key={wi} className={`border rounded-xl overflow-hidden ${isGraph ? 'bg-amber-50 border-amber-200' : 'bg-purple-50 border-purple-200'}`}>
                    <div className="p-3">
                      <div className="flex items-center gap-2 mb-1">
                        <span className={`text-xs px-2 py-0.5 rounded font-semibold ${isGraph ? 'bg-amber-100 text-amber-700' : 'bg-purple-100 text-purple-700'}`}>
                          {isGraph ? 'API 403' : 'INCOMPLETE'}
                        </span>
                        <span className={`text-xs font-semibold ${isGraph ? 'text-amber-800' : 'text-purple-800'}`}>{w.feature || w.bugType}</span>
                      </div>
                      <p className="text-xs text-gray-700">{w.description}</p>
                      {w.impact && <p className="text-xs text-gray-500 mt-1 italic">{w.impact}</p>}
                    </div>
                    {w.evidence?.length > 0 && <BugEvidencePanel bug={w} isLimitation />}
                  </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Known Limitations for this channel */}
          {ch.bugs?.filter(b => b.status === 'KNOWN_LIMITATION').length > 0 && (
            <div className="border-t border-gray-100 px-5 py-3">
              <p className="text-xs font-semibold text-amber-700 mb-2">
                Known Limitations ({ch.bugs.filter(b => b.status === 'KNOWN_LIMITATION').length})
              </p>
              <div className="space-y-3">
                {ch.bugs.filter(b => b.status === 'KNOWN_LIMITATION').map((kl, ki) => (
                  <div key={ki} className="bg-amber-50 border border-amber-100 rounded-xl overflow-hidden">
                    <div className="p-3">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs px-2 py-0.5 rounded font-semibold bg-amber-100 text-amber-700">LIMITATION</span>
                        <span className="text-xs font-semibold text-amber-800">{kl.feature || kl.bugType}</span>
                      </div>
                      <p className="text-xs text-gray-700">{kl.description}</p>
                      {kl.impact && <p className="text-xs text-gray-500 mt-1 italic">{kl.impact}</p>}
                    </div>
                    {kl.evidence?.length > 0 && <BugEvidencePanel bug={kl} isLimitation />}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Deep Message Comparison (mail-style per-message validation) ── */}
          {ch.deepMessageValidation?.enabled && (
            <div className="border-t border-gray-100 px-5 py-4 space-y-4">

              {/* Summary header */}
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-gray-700">Message-by-Message Comparison</p>
                <div className="flex items-center gap-3 text-xs">
                  <span className="text-green-700 font-medium">
                    {(ch.deepMessageValidation.messageResults || []).filter(m => m.status === 'MATCHED').length} matched
                  </span>
                  {(ch.deepMessageValidation.messageResults || []).filter(m => m.status === 'CONTENT_CHANGED').length > 0 && (
                    <span className="text-amber-600 font-medium">
                      {(ch.deepMessageValidation.messageResults || []).filter(m => m.status === 'CONTENT_CHANGED').length} reformatted
                    </span>
                  )}
                  {ch.deepMessageValidation.unmatchedCount > 0 && (
                    <span className="text-red-600 font-medium">{ch.deepMessageValidation.unmatchedCount} missing</span>
                  )}
                  {ch.deepMessageValidation.extraCount > 0 && (
                    <span className="text-gray-500">{ch.deepMessageValidation.extraCount} extra</span>
                  )}
                  <span className={`font-bold px-2 py-0.5 rounded ${ch.deepMessageValidation.matchRate >= 95 ? 'bg-green-100 text-green-700' : ch.deepMessageValidation.matchRate >= 70 ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'}`}>
                    {ch.deepMessageValidation.matchRate}% match
                  </span>
                </div>
              </div>

              {/* Per-message table */}
              <div className="overflow-x-auto">
                <table className="w-full text-xs border border-gray-100 rounded-lg overflow-hidden">
                  <thead>
                    <tr className="bg-gray-50">
                      <th className="px-3 py-2 text-left text-gray-500 font-medium w-20">Status</th>
                      <th className="px-3 py-2 text-left text-gray-500 font-medium w-32">Slack Time</th>
                      <th className="px-3 py-2 text-left text-gray-500 font-medium w-32">Teams Time</th>
                      <th className="px-3 py-2 text-left text-gray-500 font-medium">Source (Slack)</th>
                      <th className="px-3 py-2 text-left text-gray-500 font-medium">Destination (Teams)</th>
                      <th className="px-3 py-2 text-center text-gray-500 font-medium w-16">Files</th>
                      <th className="px-3 py-2 text-center text-gray-500 font-medium w-14">Replies</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {(ch.deepMessageValidation.messageResults || [])
                      .filter(m => m.status !== 'EXTRA')
                      .map((msg, mi) => {
                        const statusColor = msg.status === 'MATCHED'
                          ? 'text-green-700 bg-green-50'
                          : msg.status === 'CONTENT_CHANGED'
                          ? 'text-amber-700 bg-amber-50'
                          : 'text-red-700 bg-red-50';
                        const rowBg = msg.status === 'MISSING' ? 'bg-red-50/30'
                          : msg.status === 'CONTENT_CHANGED' ? 'bg-amber-50/20' : '';
                        const statusLabel = msg.status === 'MATCHED' ? '✓ Match'
                          : msg.status === 'CONTENT_CHANGED' ? '~ Reformatted' : '✗ Missing';
                        return (
                          <tr key={mi} className={rowBg}>
                            <td className="px-3 py-2">
                              <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${statusColor}`}>{statusLabel}</span>
                              {msg.pairing === 'partial-text' && <span className="ml-1 text-gray-400 text-xs" title="Matched by partial text">~</span>}
                            </td>
                            <td className="px-3 py-2 text-gray-500 font-mono text-xs">
                              {msg.slackTimestampISO ? new Date(msg.slackTimestampISO).toLocaleString() : '—'}
                            </td>
                            <td className="px-3 py-2 text-gray-500 font-mono text-xs">
                              {msg.teamsTimestampISO ? new Date(msg.teamsTimestampISO).toLocaleString() : '—'}
                            </td>
                            <td className="px-3 py-2 text-gray-700 max-w-xs">
                              <span className="truncate block" title={msg.srcText}>{msg.srcText || <em className="text-gray-300">empty</em>}</span>
                              {msg.edited && <span className="text-gray-400 text-xs italic ml-0.5">(edited)</span>}
                            </td>
                            <td className="px-3 py-2 text-gray-600 max-w-xs">
                              {msg.status === 'MISSING'
                                ? <span className="text-red-400 italic">Not found in Teams</span>
                                : <span className="truncate block" title={msg.dstText}>{msg.dstText || <em className="text-gray-300">empty</em>}</span>}
                            </td>
                            <td className="px-3 py-2 text-center text-gray-500">
                              {msg.srcFiles != null ? `${msg.srcFiles}→${msg.dstFiles ?? '?'}` : '—'}
                            </td>
                            <td className="px-3 py-2 text-center text-gray-500">
                              {msg.srcReplies > 0 ? msg.srcReplies : '—'}
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>

              {/* Thread chain results */}
              {(ch.deepMessageValidation.threadChainResults || []).some(t => !t.pass) && (
                <div>
                  <p className="text-xs font-semibold text-gray-700 mb-2">Thread Chain Issues</p>
                  <div className="space-y-1">
                    {ch.deepMessageValidation.threadChainResults.filter(t => !t.pass).map((t, ti) => (
                      <div key={ti} className="flex gap-3 text-xs bg-red-50 border border-red-100 rounded px-3 py-2">
                        <span className="text-red-500 shrink-0 font-medium">✗ Thread</span>
                        <span className="text-gray-700 truncate" title={t.srcText}>{t.srcText || '(empty)'}</span>
                        <span className="text-gray-500 shrink-0">Slack: {t.srcReplyCount} replies → Teams: {t.dstReplyCount ?? '?'}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Order validation */}
              {ch.deepMessageValidation.orderValidation?.outOfOrderCount > 0 && (
                <div>
                  <p className="text-xs font-semibold text-gray-700 mb-2">
                    Message Order Violations ({ch.deepMessageValidation.orderValidation.outOfOrderCount})
                  </p>
                  <div className="space-y-1">
                    {(ch.deepMessageValidation.orderValidation.outOfOrder || []).slice(0, 5).map((o, oi) => (
                      <div key={oi} className="flex gap-3 text-xs bg-amber-50 border border-amber-100 rounded px-3 py-2">
                        <span className="text-amber-600 shrink-0 font-medium">⚠ Reordered</span>
                        <span className="text-gray-700 truncate" title={o.srcText}>{o.srcText || '(empty)'}</span>
                        <span className="text-gray-500 shrink-0">pos {o.srcPosition}→{o.dstPosition}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Extra Teams messages */}
              {ch.deepMessageValidation.extraCount > 0 && (
                <div>
                  <p className="text-xs text-gray-500 mb-1">
                    {ch.deepMessageValidation.extraCount} extra message(s) in Teams not found in Slack source (CF system/info messages — expected):
                  </p>
                  <div className="space-y-1">
                    {(ch.deepMessageValidation.messageResults || [])
                      .filter(m => m.status === 'EXTRA').slice(0, 5).map((em, ei) => (
                        <div key={ei} className="flex gap-2 text-xs bg-gray-50 rounded px-3 py-1.5">
                          <span className="text-gray-400 font-mono shrink-0">
                            {em.teamsTimestampISO ? new Date(em.teamsTimestampISO).toLocaleString() : '—'}
                          </span>
                          <span className="text-gray-600 truncate">{em.dstText}</span>
                          {em.senderName && <span className="text-gray-400 shrink-0">{em.senderName}</span>}
                        </div>
                      ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
        );
      })}

      {/* ── Known Limitations ── */}
      {klList.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider mb-3">
            Known Limitations ({klList.length})
          </h3>
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100 bg-gray-50">
              <p className="text-xs text-gray-500">
                These features are outside CF's migration scope for Slack → Teams. They are expected and do not count as bugs.
              </p>
            </div>
            <table className="w-full text-sm">
              <thead><tr className="bg-gray-50 border-b border-gray-100">
                <th className="px-5 py-2.5 text-left text-xs font-medium text-gray-500 uppercase">Feature</th>
                <th className="px-5 py-2.5 text-right text-xs font-medium text-gray-500 uppercase">Src Count</th>
                <th className="px-5 py-2.5 text-right text-xs font-medium text-gray-500 uppercase">Channels</th>
              </tr></thead>
              <tbody className="divide-y divide-gray-100">
                {klList.map((kl, idx) => (
                  <tr key={idx} className="hover:bg-gray-50">
                    <td className="px-5 py-2.5 font-medium text-gray-700">{kl.feature}</td>
                    <td className="px-5 py-2.5 text-right text-gray-500">{kl.items > 0 ? kl.items : '—'}</td>
                    <td className="px-5 py-2.5 text-right text-gray-500">{kl.channels}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Message-specific sub-components ─────────────────────────────────────────

function SlackMsgCard({ text, ts, userId, hasFiles, highlight }) {
  return (
    <div className={`rounded-lg border p-3 space-y-1.5 ${highlight ? 'border-red-300 bg-red-50' : 'border-purple-100 bg-purple-50/40'}`}>
      <div className="flex items-center gap-2">
        <div className="w-7 h-7 rounded bg-purple-500 flex items-center justify-center text-white text-xs font-bold shrink-0">S</div>
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="text-xs font-semibold text-purple-800 truncate">{userId || 'User'}</span>
          {ts && <span className="text-xs text-gray-400 shrink-0">{new Date(ts).toLocaleString()}</span>}
        </div>
      </div>
      <p className="text-xs text-gray-700 pl-9 break-words whitespace-pre-wrap">{text || <em className="text-gray-400">empty message</em>}</p>
      {hasFiles && <p className="text-xs text-gray-400 pl-9">📎 Contains file(s)</p>}
      {highlight && (
        <div className="pl-9 flex items-center gap-1">
          <span className="inline-block w-2 h-2 rounded-full bg-red-500" />
          <span className="text-xs text-red-600 font-medium">⚠ Bug identified here</span>
        </div>
      )}
    </div>
  );
}

function TeamsMsgCard({ text, ts, senderName, status }) {
  const notFound = status === 'MISSING';
  return (
    <div className={`rounded-lg border p-3 space-y-1.5 ${
      notFound ? 'border-red-200 bg-red-50/60' :
      status === 'CONTENT_CHANGED' ? 'border-amber-200 bg-amber-50/40' :
      'border-blue-100 bg-blue-50/40'
    }`}>
      <div className="flex items-center gap-2">
        <div className={`w-7 h-7 rounded flex items-center justify-center text-white text-xs font-bold shrink-0 ${notFound ? 'bg-red-400' : 'bg-blue-500'}`}>T</div>
        <div className="flex items-baseline gap-2 min-w-0">
          <span className={`text-xs font-semibold truncate ${notFound ? 'text-red-700' : 'text-blue-800'}`}>{senderName || 'Teams'}</span>
          {ts && <span className="text-xs text-gray-400 shrink-0">{new Date(ts).toLocaleString()}</span>}
        </div>
      </div>
      {notFound ? (
        <div className="pl-9">
          <p className="text-xs font-semibold text-red-600">✗ Not found in Teams destination</p>
          <p className="text-xs text-red-400 mt-0.5">This message was not migrated or was lost during migration.</p>
        </div>
      ) : (
        <p className="text-xs text-gray-700 pl-9 break-words whitespace-pre-wrap">{text || <em className="text-gray-400">empty</em>}</p>
      )}
      {status === 'CONTENT_CHANGED' && text && (
        <div className="pl-9 flex items-center gap-1">
          <span className="inline-block w-2 h-2 rounded-full bg-amber-500" />
          <span className="text-xs text-amber-700 font-medium">Content reformatted by CF (expected behaviour)</span>
        </div>
      )}
    </div>
  );
}

function BugEvidencePanel({ bug, isLimitation }) {
  const ev = bug.evidence || [];
  if (!ev.length) return null;
  const firstEv = ev[0];

  const headerCls = isLimitation
    ? 'border-t border-dashed border-amber-200 bg-amber-50/30'
    : 'border-t border-dashed border-red-200 bg-red-50/30';

  // CF used as destination proxy when Teams Graph API returns 403
  if (firstEv.type === 'cf_as_proxy') {
    return (
      <div className="border-t border-dashed border-amber-200 bg-amber-50/30 px-3 pt-2 pb-3">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Validation — CF Report as Destination Proxy</p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="text-xs font-semibold text-indigo-700 mb-1.5">CloudFuze Report</p>
            <div className="rounded-lg border border-indigo-200 bg-indigo-50/50 p-3 space-y-1">
              <p className="text-xs text-gray-600">Messages picked: <strong className="text-indigo-800">{firstEv.cfPickedCount ?? '?'}</strong></p>
              <p className="text-xs text-gray-600">Messages processed: <strong className="text-indigo-800">{firstEv.cfProcessedCount ?? '?'}</strong></p>
              {firstEv.cfNotProcessed > 0 && (
                <p className="text-xs text-red-600">Not processed: {firstEv.cfNotProcessed}</p>
              )}
              <div className="flex items-center gap-1 pt-1">
                <span className="inline-block w-2 h-2 rounded-full bg-green-500 shrink-0" />
                <span className="text-xs text-green-700 font-semibold">Migration completed per CF ✓</span>
              </div>
            </div>
          </div>
          <div>
            <p className="text-xs font-semibold text-amber-700 mb-1.5">Teams (Direct Read)</p>
            <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-3 space-y-1">
              <p className="text-xs font-bold text-amber-700">HTTP 403 — Access Denied</p>
              {firstEv.teamName && firstEv.channelName && (
                <p className="text-xs text-gray-600 font-medium">{firstEv.teamName} › {firstEv.channelName}</p>
              )}
              <p className="text-xs text-gray-500 mt-1">ChannelMessage.Read.All permission not granted in Azure app registration. Grant it to enable direct message count verification.</p>
              <div className="flex items-center gap-1 pt-1">
                <span className="inline-block w-2 h-2 rounded-full bg-amber-500 shrink-0" />
                <span className="text-xs text-amber-700 font-semibold">Using CF report as count proxy</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Channel not found — lookup evidence
  if (firstEv.type === 'channel_not_found') {
    return (
      <div className="border-t border-dashed border-purple-200 bg-purple-50/30 px-3 pt-2 pb-3">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Evidence — Channel Lookup</p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="text-xs font-semibold text-purple-700 mb-1.5">Source (Slack)</p>
            <div className="rounded-lg border border-purple-200 bg-purple-50/50 p-3 space-y-1">
              <p className="text-xs font-bold text-purple-800">{firstEv.slackChannelName?.startsWith('#') ? firstEv.slackChannelName : `#${firstEv.slackChannelName}`}</p>
              <p className="text-xs text-gray-600">Messages: {firstEv.slackMsgCount ?? '?'}</p>
              {firstEv.slackReplyCount != null && <p className="text-xs text-gray-600">Thread replies: {firstEv.slackReplyCount}</p>}
              <div className="flex items-center gap-1 pt-1">
                <span className="inline-block w-2 h-2 rounded-full bg-green-500 shrink-0" />
                <span className="text-xs text-green-700 font-semibold">Channel exists in Slack ✓</span>
              </div>
            </div>
          </div>
          <div>
            <p className="text-xs font-semibold text-blue-700 mb-1.5">Destination (Teams)</p>
            <div className="rounded-lg border border-purple-200 bg-purple-50/60 p-3 space-y-1">
              <p className="text-xs font-bold text-purple-700">⚠ Channel not accessible</p>
              {(firstEv.cfPickedCount != null || firstEv.cfProcessedCount != null) && (
                <p className="text-xs text-gray-600">CF picked {firstEv.cfPickedCount ?? '?'} / processed {firstEv.cfProcessedCount ?? '?'} msgs</p>
              )}
              <p className="text-xs text-gray-500 break-words mt-1">{firstEv.searchNote || `Searched all joined Teams for "${firstEv.slackChannelName}" — no match found. Channel may exist under a different name or team.`}</p>
              <div className="flex items-center gap-1 pt-1">
                <span className="inline-block w-2 h-2 rounded-full bg-purple-400 shrink-0" />
                <span className="text-xs text-purple-600 font-semibold">Lookup issue — not confirmed migration failure</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Pinned messages evidence
  if (firstEv.type === 'pinned_slack') {
    return (
      <div className={`${headerCls} px-3 pt-2 pb-3`}>
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">📸 Evidence — Pinned Messages</p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="text-xs font-semibold text-purple-700 mb-1.5">Source (Slack) — Pinned 📌</p>
            <div className="space-y-2">
              {ev.map((e, i) => (
                <SlackMsgCard key={i} text={e.text} ts={e.ts} userId={e.userId} hasFiles={e.hasFiles} />
              ))}
            </div>
          </div>
          <div>
            <p className="text-xs font-semibold text-blue-700 mb-1.5">Destination (Teams)</p>
            <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-3">
              <p className="text-xs font-bold text-amber-700">⚠ Pins not migrated</p>
              <p className="text-xs text-gray-600 mt-1">
                The messages are present in Teams but are <strong>not pinned</strong>.
                CF does not migrate Slack pins — they must be manually pinned again in Teams.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Missing / content-changed messages evidence
  const isMissing = ev.some(e => e.status === 'MISSING');
  const evidenceLabel = isMissing ? 'Missing Messages' : 'Reformatted Messages';

  return (
    <div className={`${headerCls} px-3 pt-2 pb-3`}>
      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
        📸 Evidence — {evidenceLabel} ({ev.length} shown)
      </p>
      <div className="space-y-4">
        {ev.map((msg, i) => (
          <div key={i}>
            <p className="text-xs text-gray-400 mb-1.5 font-mono">Message {i + 1}</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                {i === 0 && <p className="text-xs font-semibold text-purple-700 mb-1">Source (Slack)</p>}
                <SlackMsgCard
                  text={msg.srcText}
                  ts={msg.slackTs}
                  hasFiles={msg.srcFiles > 0}
                  highlight={msg.status === 'MISSING'}
                />
              </div>
              <div>
                {i === 0 && <p className="text-xs font-semibold text-blue-700 mb-1">Destination (Teams)</p>}
                <TeamsMsgCard
                  text={msg.dstText}
                  ts={msg.teamsTs}
                  senderName={msg.senderName}
                  status={msg.status}
                />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function MetricCard({ label, value, sub, color = 'gray' }) {
  const colorMap = {
    blue:   'bg-blue-50 border-blue-200 text-blue-700',
    indigo: 'bg-indigo-50 border-indigo-200 text-indigo-700',
    green:  'bg-green-50 border-green-200 text-green-700',
    orange: 'bg-orange-50 border-orange-200 text-orange-700',
    red:    'bg-red-50 border-red-200 text-red-700',
    gray:   'bg-gray-50 border-gray-200 text-gray-700',
  };
  return (
    <div className={`rounded-lg border p-3 ${colorMap[color] || colorMap.gray}`}>
      <p className="text-xs font-medium opacity-75 uppercase tracking-wider">{label}</p>
      <p className="text-2xl font-bold mt-0.5 tabular-nums">{value ?? '—'}</p>
      {sub && <p className="text-xs opacity-60 mt-0.5">{sub}</p>}
    </div>
  );
}

function SeverityBadge({ severity }) {
  const map = {
    CRITICAL: 'bg-red-100 text-red-700',
    HIGH:     'bg-orange-100 text-orange-700',
    MEDIUM:   'bg-amber-100 text-amber-700',
    LOW:      'bg-gray-100 text-gray-600',
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded font-semibold ${map[severity] || map.LOW}`}>
      {severity}
    </span>
  );
}

function ValidationStatusBadge({ status }) {
  const map = {
    PASS:       'bg-green-100 text-green-700',
    PARTIAL:    'bg-amber-100 text-amber-700',
    FAIL:       'bg-red-100 text-red-700',
    PENDING:    'bg-blue-100 text-blue-700',
    INCOMPLETE: 'bg-purple-100 text-purple-700',
    SKIPPED:    'bg-gray-100 text-gray-500',
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded font-semibold ${map[status] || map.SKIPPED}`}>
      {status}
    </span>
  );
}

function JobStatusBadge({ status }) {
  const s = String(status || '').toUpperCase();
  const map = {
    COMPLETED: 'bg-green-100 text-green-700',
    PROCESSED: 'bg-green-100 text-green-700',
    PARTIAL:   'bg-amber-100 text-amber-700',
    IN_PROGRESS: 'bg-blue-100 text-blue-700',
    FAILED:    'bg-red-100 text-red-700',
    PENDING:   'bg-gray-100 text-gray-500',
  };
  const colorClass = map[s] || (s.includes('COMPLET') || s.includes('PROCESS') ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500');
  return (
    <span className={`text-xs px-2 py-0.5 rounded font-medium ${colorClass}`}>
      {String(status || 'N/A').replace(/_/g, ' ')}
    </span>
  );
}

function FeatureStat({ label, src, dst, cf, graphBlocked }) {
  const hasDest = dst != null;
  const match = hasDest && src != null && Math.abs(dst - src) <= Math.max(1, Math.ceil(src * 0.02));
  return (
    <div className="bg-gray-50 rounded-lg p-3 border border-gray-200">
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <div className="space-y-0.5">
        <div className="flex justify-between text-xs">
          <span className="text-gray-400">Source</span>
          <span className="font-semibold text-gray-800 tabular-nums">{src ?? '—'}</span>
        </div>
        {cf != null && (
          <div className="flex justify-between text-xs">
            <span className="text-gray-400">CF Picked</span>
            <span className="font-semibold text-indigo-700 tabular-nums">{cf}</span>
          </div>
        )}
        <div className="flex justify-between text-xs">
          <span className="text-gray-400">Dest</span>
          <span className={`font-semibold tabular-nums ${graphBlocked ? 'text-amber-600' : hasDest ? (match ? 'text-green-700' : 'text-red-600') : 'text-gray-400'}`}>
            {graphBlocked ? '403' : hasDest ? dst : 'N/A'}
          </span>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers (used by both email and message views)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run metadata card — Execution ID, Status, Created, and the Direction (single pair) or a full
 * "Direction · N pairs" list (bulk runs). Rendered both in the empty state and above the validation
 * results so the pair context (esp. all bulk pairs) stays visible after validation completes.
 */
function RunInfoCard({ exec, ctx }) {
  const mappings = Array.isArray(ctx.userEmailMappings) && ctx.userEmailMappings.length > 1
    ? ctx.userEmailMappings : null;
  const combo = combinationLabel(ctx);
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <div className={`grid gap-3 text-sm ${mappings ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-2 sm:grid-cols-5'}`}>
        <Mini label="Execution ID" value={<span className="font-mono text-xs break-all">{exec.executionId}</span>} />
        <Mini label="Status" value={<StatusBadge status={exec.status} />} />
        {combo && <Mini label="Combination" value={<span className="text-xs">{combo}</span>} />}
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

/**
 * Source vs Destination for CONTENT runs — the mail equivalent of ComparisonTable.
 *
 * Mail shows a side-by-side count per folder ("INBOX -> Inbox  5  5  Match") and content showed
 * nothing, so there was no at-a-glance answer to "did the data arrive?". Content has no labels, so
 * the rows are the top-level folders of the migrated tree, counting how many of each folder's items
 * were found at the destination. Derived from perUser[].items, which carries { path, name, type,
 * found } for every item the validator walked.
 */
function ContentComparison({ perUser }) {
  const units = Array.isArray(perUser) ? perUser : [];
  if (units.length === 0) return null;

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-gray-900">Source vs Destination Comparison</h2>
      {units.map((u, ui) => {
        const items = Array.isArray(u.items) ? u.items : [];
        const fs2 = u.folderStructure || {};

        // Group by the first path segment. Depth-0 items (the migrated root itself) sit in "(root)".
        const groups = new Map();
        for (const it of items) {
          const segs = String(it.path || '').split('/').filter(Boolean);
          const key = segs.length === 0 ? '(root level)' : segs[0];
          if (!groups.has(key)) groups.set(key, { total: 0, found: 0 });
          const g = groups.get(key);
          g.total += 1;
          if (it.found) g.found += 1;
        }
        const rows = [...groups.entries()]
          .map(([label, g]) => ({ label, srcCount: g.total, destCount: g.found, match: g.found === g.total }))
          .sort((a, b) => (a.match === b.match ? b.srcCount - a.srcCount : a.match ? 1 : -1));

        const totalItems = items.length;
        const foundItems = items.filter((i) => i.found).length;
        const structureOk = Array.isArray(fs2.missing) ? fs2.missing.length === 0 : null;

        // A Match/Mismatch column alone does not say WHAT differs, which is the first thing a
        // reviewer asks. Split the difference into its four kinds. Three are problems; the fourth is
        // the destination legitimately renaming things, shown as proof the rename rules worked
        // rather than hidden.
        const notFound = items.filter((i) => !i.found);
        const extraItems = Array.isArray(fs2.extra) ? fs2.extra : [];
        const misplacedItems = Array.isArray(fs2.misplaced) ? fs2.misplaced : [];
        const renamed = items.filter((i) => i.found && i.destName && i.destName !== i.name);
        const issueCount = notFound.length + extraItems.length + misplacedItems.length;
        const elide = (v, keepStart, keepEnd) => {
          const x = String(v == null ? "" : v);
          return x.length > keepStart + keepEnd + 10 ? x.slice(0, keepStart) + " … " + x.slice(-keepEnd) : x;
        };

        return (
          <div key={ui} className="space-y-4">
            {units.length > 1 && (
              <p className="text-sm font-medium text-gray-700">{u.sourceEmail} → {u.destinationEmail}</p>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <MatchCard label="All items reached destination" ok={foundItems === totalItems} />
              <MatchCard label="Nothing missing" ok={structureOk !== false} />
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <ResultCard label="Source Items" value={totalItems} />
              <ResultCard label="Found at Destination" value={foundItems} />
              <ResultCard label="Missing" value={Array.isArray(fs2.missing) ? fs2.missing.length : 0} />
              <ResultCard label="Folders Compared" value={rows.length} />
            </div>
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <div className="px-5 py-3 border-b border-gray-100">
                <h3 className="text-sm font-semibold text-gray-900">
                  Folders ({rows.length}) — items found at the destination
                </h3>
              </div>
              <table className="w-full text-sm">
                <thead><tr className="bg-gray-50">
                  <th className="px-5 py-2.5 text-left text-xs font-medium text-gray-500 uppercase">Folder</th>
                  <th className="px-5 py-2.5 text-right text-xs font-medium text-gray-500 uppercase">Source</th>
                  <th className="px-5 py-2.5 text-right text-xs font-medium text-gray-500 uppercase">Destination</th>
                  <th className="px-5 py-2.5 text-right text-xs font-medium text-gray-500 uppercase">Status</th>
                </tr></thead>
                <tbody className="divide-y divide-gray-100">
                  {rows.map((r, idx) => (
                    <tr key={idx} className={r.match ? 'bg-green-50/50' : 'bg-red-50/50'}>
                      <td className="px-5 py-2.5 font-medium text-gray-900 break-all">
                        {r.label.length > 70 ? `${r.label.slice(0, 40)} … ${r.label.slice(-12)}` : r.label}
                      </td>
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

            {(issueCount > 0 || renamed.length > 0) && (
              <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
                <h3 className="text-sm font-semibold text-gray-900">
                  Differences — {issueCount} issue{issueCount === 1 ? "" : "s"}
                  {renamed.length > 0 ? ", " + renamed.length + " expected rename" + (renamed.length === 1 ? "" : "s") : ""}
                </h3>

                {notFound.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-red-700 uppercase tracking-wider mb-1.5">
                      Not found at destination ({notFound.length})
                    </p>
                    <ul className="space-y-1">
                      {notFound.slice(0, 10).map((i, k) => (
                        <li key={k} className="text-sm text-gray-700 bg-red-50 rounded px-2 py-1 break-all">
                          <span className="text-xs text-red-600 font-medium mr-2">{i.type}</span>
                          {elide(i.path, 60, 40)}
                        </li>
                      ))}
                      {notFound.length > 10 && (
                        <li className="text-xs text-gray-500">+ {notFound.length - 10} more</li>
                      )}
                    </ul>
                  </div>
                )}

                {extraItems.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-amber-700 uppercase tracking-wider mb-1.5">
                      Extra at destination, no source counterpart ({extraItems.length})
                    </p>
                    <ul className="space-y-1">
                      {extraItems.slice(0, 10).map((x, k) => (
                        <li key={k} className="text-sm text-gray-700 bg-amber-50 rounded px-2 py-1 break-all">
                          {elide(x, 60, 40)}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {misplacedItems.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-amber-700 uppercase tracking-wider mb-1.5">
                      Arrived in a different folder ({misplacedItems.length})
                    </p>
                    <ul className="space-y-1">
                      {misplacedItems.slice(0, 10).map((m2, k) => (
                        <li key={k} className="text-sm text-gray-700 bg-amber-50 rounded px-2 py-1 break-all">
                          {elide(m2 && m2.name, 40, 12)}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {renamed.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-blue-700 uppercase tracking-wider mb-1.5">
                      Renamed by the destination, expected ({renamed.length})
                    </p>
                    <ul className="space-y-1">
                      {renamed.slice(0, 10).map((i, k) => (
                        <li key={k} className="text-sm text-gray-700 bg-blue-50 rounded px-2 py-1 break-all">
                          {elide(i.name, 34, 10)}
                          <span className="text-gray-400 mx-2">→</span>
                          {elide(i.destName, 34, 10)}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
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