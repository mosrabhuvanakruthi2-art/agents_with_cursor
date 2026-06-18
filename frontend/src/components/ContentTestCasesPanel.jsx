import { useState, useEffect, useRef } from 'react';
import { getCustomTestCases } from '../services/api';

const CONTENT_COMBINATIONS = [
  'Box → SharePoint Online',
  'Box → OneDrive',
  'Box → MyDrive',
  'Box → Shared Drive',
  'Dropbox → SharePoint Online',
  'Dropbox → OneDrive',
  'Dropbox → MyDrive',
  'Dropbox → Shared Drive',
  'OneDrive → OneDrive',
  'SharePoint → SharePoint',
  'MyDrive → OneDrive',
  'MyDrive → MyDrive',
  'Shared Drive → SharePoint Online',
  'Shared Drive → Shared Drive',
  'Egnyte → SharePoint Online',
  'Egnyte → OneDrive',
  'Egnyte → MyDrive',
  'Egnyte → Shared Drive',
  'SharePoint Online → Shared Drive',
  'OneDrive → MyDrive',
  'ShareFile → SharePoint Online',
  'ShareFile → OneDrive',
  'ShareFile → MyDrive',
  'ShareFile → Shared Drive',
];

export default function ContentTestCasesPanel() {
  const [open, setOpen] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [selectedCombination, setSelectedCombination] = useState(null);
  const [allCases, setAllCases] = useState({ smoke: [], sanity: [] });
  const [loading, setLoading] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [activeType, setActiveType] = useState('sanity');
  const dropdownRef = useRef(null);

  useEffect(() => {
    function handleClickOutside(e) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  async function loadCases() {
    if (allCases.sanity.length > 0) return;
    setLoading(true);
    try {
      const res = await getCustomTestCases();
      setAllCases(res.data || { smoke: [], sanity: [] });
    } catch {
      setAllCases({ smoke: [], sanity: [] });
    } finally {
      setLoading(false);
    }
  }

  function handleSelectCombination(combo) {
    setSelectedCombination(combo);
    setDropdownOpen(false);
    setExpandedId(null);
    if (!open) setOpen(true);
    loadCases();
  }

  function handleOpenPanel() {
    setDropdownOpen((v) => !v);
    loadCases();
  }

  const [folderFilter, setFolderFilter] = useState('all');

  const filteredCases = (allCases[activeType] || []).filter(
    (tc) => tc.combination === selectedCombination && tc.productType === 'Content' &&
      (folderFilter === 'all' || tc.folder === folderFilter)
  );

  const folderCounts = (() => {
    const all = (allCases[activeType] || []).filter(
      (tc) => tc.combination === selectedCombination && tc.productType === 'Content'
    );
    return {
      all: all.length,
      positive: all.filter((tc) => tc.folder === '/Sanity Cases').length,
      edge: all.filter((tc) => tc.folder === '/Edge & Negative Cases').length,
    };
  })();

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Trigger Button */}
      <button
        type="button"
        onClick={handleOpenPanel}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-blue-200 bg-blue-50 text-blue-700 text-sm font-semibold hover:bg-blue-100 transition-colors"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
        </svg>
        Test Cases
        <svg className={`w-3.5 h-3.5 transition-transform ${dropdownOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Combination Dropdown */}
      {dropdownOpen && (
        <div className="absolute right-0 mt-2 w-72 bg-white border border-gray-200 rounded-xl shadow-lg z-50 overflow-hidden">
          <div className="px-3 py-2 border-b border-gray-100 bg-gray-50">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Content Migration Combinations</p>
          </div>
          <div className="max-h-72 overflow-y-auto">
            {CONTENT_COMBINATIONS.map((combo) => {
              const count = (allCases.sanity || []).filter(
                (tc) => tc.combination === combo && tc.productType === 'Content'
              ).length;
              return (
                <button
                  key={combo}
                  type="button"
                  onClick={() => handleSelectCombination(combo)}
                  className={`w-full flex items-center justify-between px-3 py-2 text-sm text-left hover:bg-blue-50 transition-colors ${
                    selectedCombination === combo ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-700'
                  }`}
                >
                  <span>{combo}</span>
                  {count > 0 && (
                    <span className="ml-2 flex-shrink-0 text-xs bg-blue-100 text-blue-700 rounded-full px-2 py-0.5 font-medium">{count}</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Test Cases Panel */}
      {open && selectedCombination && (
        <div className="fixed inset-0 bg-black/30 z-40 flex items-start justify-end" onClick={() => setOpen(false)}>
          <div
            className="h-full w-full max-w-2xl bg-white shadow-2xl flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Panel Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 bg-blue-50">
              <div>
                <h2 className="text-sm font-bold text-gray-900">Sanity Test Cases</h2>
                <p className="text-xs text-blue-700 font-medium mt-0.5">{selectedCombination}</p>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs bg-blue-100 text-blue-700 rounded-full px-2.5 py-1 font-semibold">
                  {filteredCases.length} cases
                </span>
                <button type="button" onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-600 transition-colors">
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Type Tabs */}
            <div className="flex gap-1 px-4 pt-3 pb-2 border-b border-gray-100">
              {['sanity', 'smoke'].map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => { setActiveType(t); setFolderFilter('all'); }}
                  className={`px-4 py-1.5 rounded-lg text-xs font-semibold capitalize transition-all ${
                    activeType === t ? 'bg-blue-600 text-white' : 'text-gray-500 hover:bg-gray-100'
                  }`}
                >
                  {t}
                  <span className={`ml-1.5 text-xs rounded-full px-1.5 ${activeType === t ? 'bg-blue-500 text-white' : 'bg-gray-100 text-gray-500'}`}>
                    {(allCases[t] || []).filter((tc) => tc.combination === selectedCombination && tc.productType === 'Content').length}
                  </span>
                </button>
              ))}
            </div>

            {/* Category Filter Pills */}
            <div className="flex gap-2 px-4 py-2 border-b border-gray-100 bg-gray-50/50 flex-wrap">
              {[
                { key: 'all', label: 'All', count: folderCounts.all, color: 'blue' },
                { key: '/Sanity Cases', label: 'Positive', count: folderCounts.positive, color: 'green' },
                { key: '/Edge & Negative Cases', label: 'Edge & Negative', count: folderCounts.edge, color: 'red' },
              ].map((f) => (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => setFolderFilter(f.key)}
                  className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium transition-all ${
                    folderFilter === f.key
                      ? f.color === 'green' ? 'bg-green-600 text-white' : f.color === 'red' ? 'bg-red-600 text-white' : 'bg-blue-600 text-white'
                      : 'bg-white border border-gray-200 text-gray-600 hover:border-gray-300'
                  }`}
                >
                  {f.label}
                  <span className={`text-xs rounded-full px-1.5 ${
                    folderFilter === f.key ? 'bg-white/20 text-white' : 'bg-gray-100 text-gray-500'
                  }`}>{f.count}</span>
                </button>
              ))}
            </div>

            {/* Cases List */}
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
              {loading && (
                <div className="text-center py-8 text-gray-400 text-sm">Loading test cases…</div>
              )}
              {!loading && filteredCases.length === 0 && (
                <div className="text-center py-12 text-gray-400">
                  <svg className="w-10 h-10 mx-auto mb-3 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                  </svg>
                  <p className="text-sm font-medium text-gray-500">No {activeType} test cases for this combination</p>
                </div>
              )}
              {!loading && filteredCases.map((tc, idx) => {
                const isNeg = tc.subject?.includes('NEG');
                const isEdge = tc.subject?.includes('EDGE');
                const badgeColor = isNeg ? 'bg-red-100 text-red-700' : isEdge ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700';
                const badgeLabel = isNeg ? 'Negative' : isEdge ? 'Edge' : 'Positive';
                return (
                  <div key={tc.id} className="border border-gray-200 rounded-xl overflow-hidden">
                  <button
                    type="button"
                    className="w-full flex items-start gap-3 px-4 py-3 text-left hover:bg-gray-50 transition-colors"
                    onClick={() => setExpandedId(expandedId === tc.id ? null : tc.id)}
                  >
                    <span className={`flex-shrink-0 w-7 h-7 rounded-full text-xs font-bold flex items-center justify-center mt-0.5 ${badgeColor}`}>
                      {idx + 1}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${badgeColor}`}>{badgeLabel}</span>
                      </div>
                      <p className="text-sm font-semibold text-gray-900 leading-snug">{tc.summary}</p>
                      <p className="text-xs text-gray-500 mt-0.5 font-mono">{tc.testCaseId}</p>
                    </div>
                    <svg
                      className={`w-4 h-4 text-gray-400 flex-shrink-0 mt-1 transition-transform ${expandedId === tc.id ? 'rotate-180' : ''}`}
                      fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>

                  {expandedId === tc.id && (
                    <div className="px-4 pb-4 space-y-3 bg-gray-50 border-t border-gray-100">
                      {tc.action && (
                        <div>
                          <p className="text-xs font-semibold text-gray-500 uppercase mt-3 mb-1">Action</p>
                          <p className="text-xs text-gray-700 leading-relaxed">{tc.action}</p>
                        </div>
                      )}
                      {tc.testData && (
                        <div>
                          <p className="text-xs font-semibold text-gray-500 uppercase mb-1">Test Data</p>
                          <p className="text-xs text-gray-700 leading-relaxed bg-white border border-gray-200 rounded-lg px-3 py-2">{tc.testData}</p>
                        </div>
                      )}
                      {tc.testSteps?.length > 0 && (
                        <div>
                          <p className="text-xs font-semibold text-gray-500 uppercase mb-1">Steps</p>
                          <ol className="space-y-1">
                            {tc.testSteps.map((step, si) => (
                              <li key={si} className="flex gap-2 text-xs text-gray-700">
                                <span className="flex-shrink-0 w-4 h-4 rounded-full bg-blue-100 text-blue-700 text-xs font-bold flex items-center justify-center">{si + 1}</span>
                                <span className="leading-relaxed">{step}</span>
                              </li>
                            ))}
                          </ol>
                        </div>
                      )}
                      {tc.expectedResult && (
                        <div className="bg-green-50 border border-green-100 rounded-lg px-3 py-2">
                          <p className="text-xs font-semibold text-green-700 mb-1">Expected Result</p>
                          <p className="text-xs text-green-800 leading-relaxed">{tc.expectedResult}</p>
                        </div>
                      )}
                    </div>
                  )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
