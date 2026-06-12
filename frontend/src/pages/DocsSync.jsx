import { useState, useEffect } from 'react';
import { runDocsSync, getDocsSyncStatus, markFeatureImplemented } from '../services/api';

export default function DocsSync() {
  const [syncing, setSyncing] = useState(false);
  const [status, setStatus] = useState(null); // { lastSyncAt, newInscope, newOutscope, snapshot }
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [error, setError] = useState(null);
  const [snapshotOpen, setSnapshotOpen] = useState(false);
  const [markingId, setMarkingId] = useState(null);

  useEffect(() => {
    loadStatus();
  }, []);

  async function loadStatus() {
    setLoadingStatus(true);
    try {
      const { data } = await getDocsSyncStatus();
      setStatus(data);
    } catch {
      // Backend may not have the endpoint yet — fail silently
    } finally {
      setLoadingStatus(false);
    }
  }

  async function handleSync() {
    setSyncing(true);
    setError(null);
    try {
      const { data } = await runDocsSync();
      setStatus(data);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Sync failed. Please try again.');
    } finally {
      setSyncing(false);
    }
  }

  async function handleMarkImplemented(featureId) {
    setMarkingId(featureId);
    try {
      await markFeatureImplemented(featureId);
      // Optimistically update local state
      setStatus((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          newInscope: prev.newInscope?.map((f) =>
            f.id === featureId ? { ...f, status: 'implemented' } : f
          ),
        };
      });
    } catch (err) {
      alert('Failed to update status: ' + (err.response?.data?.error || err.message));
    } finally {
      setMarkingId(null);
    }
  }

  const newInscope = status?.newInscope || [];
  const newOutscope = status?.newOutscope || [];
  const snapshot = status?.snapshot || {};
  const snapshotCombinations = Object.keys(snapshot);

  const hasChanges = newInscope.length > 0 || newOutscope.length > 0;

  return (
    <div className="space-y-8">
      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Docs Sync</h1>
          <p className="text-sm text-gray-500 mt-1">
            Sync CloudFuze documentation and detect new in-scope / out-of-scope features
          </p>
        </div>
        <button
          onClick={handleSync}
          disabled={syncing}
          className="flex items-center gap-2 px-5 py-2.5 bg-indigo-600 text-white text-sm font-semibold rounded-lg hover:bg-indigo-700 disabled:opacity-60 transition-colors"
        >
          {syncing ? (
            <>
              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Syncing…
            </>
          ) : (
            <>
              <SyncIcon className="w-4 h-4" />
              Sync Documentation
            </>
          )}
        </button>
      </div>

      {/* Error Banner */}
      {error && (
        <div className="flex items-start gap-3 bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-700">
          <svg className="w-5 h-5 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
          </svg>
          <div>
            <p className="font-semibold">Sync failed</p>
            <p className="mt-0.5 text-red-600">{error}</p>
          </div>
          <button
            onClick={() => setError(null)}
            className="ml-auto text-red-400 hover:text-red-600 shrink-0"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* Status Card */}
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <div className="flex flex-wrap items-center gap-6">
          {/* Last Sync */}
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-gray-100 flex items-center justify-center">
              <ClockIcon className="w-5 h-5 text-gray-500" />
            </div>
            <div>
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Last Synced</p>
              <p className="text-sm font-semibold text-gray-900 mt-0.5">
                {loadingStatus
                  ? 'Loading…'
                  : status?.lastSyncAt
                  ? new Date(status.lastSyncAt).toLocaleString()
                  : 'Never'}
              </p>
            </div>
          </div>

          <div className="h-10 w-px bg-gray-200 hidden sm:block" />

          {/* Change Summary Badges */}
          {loadingStatus ? (
            <p className="text-sm text-gray-400">Loading status…</p>
          ) : !status ? (
            <p className="text-sm text-gray-400">Run a sync to see results.</p>
          ) : !hasChanges ? (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium bg-gray-100 text-gray-600">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
              </svg>
              No changes detected
            </span>
          ) : (
            <div className="flex flex-wrap gap-3">
              {newInscope.length > 0 && (
                <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium bg-green-100 text-green-700">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                  </svg>
                  {newInscope.length} new in-scope feature{newInscope.length !== 1 ? 's' : ''} detected
                </span>
              )}
              {newOutscope.length > 0 && (
                <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium bg-blue-100 text-blue-700">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                  </svg>
                  {newOutscope.length} new out-of-scope feature{newOutscope.length !== 1 ? 's' : ''} auto-added
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* New In-Scope Features */}
      {newInscope.length > 0 && (
        <section className="space-y-4">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold text-gray-900">New In-Scope Features</h2>
            <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-green-100 text-green-700">
              {newInscope.length}
            </span>
          </div>

          <div className="space-y-4">
            {newInscope.map((feature) => (
              <InScopeCard
                key={feature.id}
                feature={feature}
                onMarkImplemented={handleMarkImplemented}
                marking={markingId === feature.id}
              />
            ))}
          </div>
        </section>
      )}

      {/* New Out-of-Scope Features */}
      {newOutscope.length > 0 && (
        <section className="space-y-4">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold text-gray-900">New Out-of-Scope Features</h2>
            <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-blue-100 text-blue-700">
              {newOutscope.length}
            </span>
          </div>

          <div className="space-y-4">
            {newOutscope.map((feature) => (
              <OutScopeCard key={feature.id} feature={feature} />
            ))}
          </div>
        </section>
      )}

      {/* Full Feature Snapshot */}
      {snapshotCombinations.length > 0 && (
        <section className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <button
            onClick={() => setSnapshotOpen((v) => !v)}
            className="w-full flex items-center justify-between px-6 py-4 hover:bg-gray-50 transition-colors"
          >
            <div className="flex items-center gap-3">
              <h2 className="text-sm font-semibold text-gray-900">Full Feature Snapshot</h2>
              <span className="px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600">
                {snapshotCombinations.length} combination{snapshotCombinations.length !== 1 ? 's' : ''}
              </span>
            </div>
            <svg
              className={`w-5 h-5 text-gray-400 transition-transform duration-200 ${snapshotOpen ? 'rotate-180' : ''}`}
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2}
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
            </svg>
          </button>

          {snapshotOpen && (
            <div className="border-t border-gray-100 divide-y divide-gray-100">
              {snapshotCombinations.map((combo) => {
                const features = snapshot[combo] || [];
                return (
                  <div key={combo} className="px-6 py-4">
                    <h3 className="text-sm font-semibold text-gray-800 mb-3 flex items-center gap-2">
                      <ComboBadge label={combo} />
                      <span className="text-xs font-normal text-gray-500">
                        {features.length} feature{features.length !== 1 ? 's' : ''}
                      </span>
                    </h3>
                    <div className="space-y-2">
                      {features.map((f, idx) => (
                        <div key={idx} className="flex items-start gap-3 text-sm">
                          <span className={`mt-0.5 shrink-0 w-2 h-2 rounded-full ${f.scope === 'inscope' ? 'bg-green-400' : 'bg-gray-300'}`} />
                          <div>
                            <span className="font-medium text-gray-900">{f.name}</span>
                            {f.description && (
                              <p className="text-gray-500 text-xs mt-0.5">{f.description}</p>
                            )}
                          </div>
                          {f.scope === 'outscope' && (
                            <span className="ml-auto shrink-0 text-xs text-gray-400 italic">out-of-scope</span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* Empty state — status loaded but nothing to show */}
      {!loadingStatus && !status && !error && (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
          <div className="w-12 h-12 rounded-full bg-indigo-50 flex items-center justify-center mx-auto mb-4">
            <SyncIcon className="w-6 h-6 text-indigo-400" />
          </div>
          <p className="text-sm font-medium text-gray-700">No sync data yet</p>
          <p className="text-sm text-gray-400 mt-1">Click "Sync Documentation" to pull the latest feature list from the docs.</p>
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────────

function InScopeCard({ feature, onMarkImplemented, marking }) {
  const implemented = feature.status === 'implemented';

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      {/* Card Header */}
      <div className="px-6 py-4 border-b border-gray-100 flex flex-wrap items-center gap-3">
        <h3 className="text-sm font-semibold text-gray-900 flex-1 min-w-0">{feature.name}</h3>
        {feature.combination && <ComboBadge label={feature.combination} />}
        {implemented ? (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-green-100 text-green-700">
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
            </svg>
            Implemented
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-orange-100 text-orange-700">
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
            </svg>
            Pending Implementation
          </span>
        )}
      </div>

      {/* Card Body */}
      <div className="px-6 py-4 space-y-4">
        {/* Description */}
        {feature.description && (
          <div>
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">Description</p>
            <p className="text-sm text-gray-700">{feature.description}</p>
          </div>
        )}

        {/* AI-generated test case suggestion */}
        {feature.testSuggestion && (
          <div className="bg-indigo-50 border border-indigo-100 rounded-lg p-4 space-y-3">
            <div className="flex items-center gap-2">
              <svg className="w-4 h-4 text-indigo-500" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456Z" />
              </svg>
              <p className="text-xs font-semibold text-indigo-700 uppercase tracking-wider">AI-Generated Test Suggestion</p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {feature.testSuggestion.subject && (
                <div className="bg-white rounded-lg p-3 border border-indigo-100">
                  <p className="text-xs font-medium text-indigo-600 mb-1">Subject</p>
                  <p className="text-sm text-gray-800">{feature.testSuggestion.subject}</p>
                </div>
              )}
              {feature.testSuggestion.seed && (
                <div className="bg-white rounded-lg p-3 border border-indigo-100">
                  <p className="text-xs font-medium text-indigo-600 mb-1">What to Seed</p>
                  <p className="text-sm text-gray-800">{feature.testSuggestion.seed}</p>
                </div>
              )}
              {feature.testSuggestion.validate && (
                <div className="bg-white rounded-lg p-3 border border-indigo-100">
                  <p className="text-xs font-medium text-indigo-600 mb-1">What to Validate</p>
                  <p className="text-sm text-gray-800">{feature.testSuggestion.validate}</p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Card Footer */}
      {!implemented && (
        <div className="px-6 py-3 bg-gray-50 border-t border-gray-100 flex justify-end">
          <button
            onClick={() => onMarkImplemented(feature.id)}
            disabled={marking}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-green-700 bg-green-100 hover:bg-green-200 rounded-lg transition-colors disabled:opacity-60"
          >
            {marking ? (
              <>
                <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Updating…
              </>
            ) : (
              <>
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                </svg>
                Mark as Implemented
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}

function OutScopeCard({ feature }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-100 flex flex-wrap items-center gap-3">
        <h3 className="text-sm font-semibold text-gray-900 flex-1 min-w-0">{feature.name}</h3>
        {feature.combination && <ComboBadge label={feature.combination} />}
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-green-100 text-green-700">
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
          </svg>
          Auto-added to known limitations
        </span>
      </div>

      {feature.description && (
        <div className="px-6 py-4">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">Description</p>
          <p className="text-sm text-gray-700">{feature.description}</p>
        </div>
      )}
    </div>
  );
}

function ComboBadge({ label }) {
  return (
    <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold bg-indigo-50 text-indigo-700 border border-indigo-100">
      {label}
    </span>
  );
}

// ─── Icons ─────────────────────────────────────────────────────────────────────

function SyncIcon(props) {
  return (
    <svg {...props} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99"
      />
    </svg>
  );
}

function ClockIcon(props) {
  return (
    <svg {...props} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
    </svg>
  );
}
