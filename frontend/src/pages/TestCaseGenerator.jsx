import { useState, useEffect, useCallback, useRef } from 'react';
import {
  generateTestCases,
  getCustomTestCases,
  addCustomTestCase,
  addBulkTestCases,
  deleteCustomTestCase,
} from '../services/api';
import { useToast } from '../context/ToastContext';
import usePersistedState from '../hooks/usePersistedState';

/* ─── Product / combination catalogue ─────────────────────────────────────── */
const PRODUCT_COMBOS = {
  Mail: [
    'Gmail → Outlook',
    'Gmail → Gmail',
    'Outlook → Outlook',
    'Outlook → Gmail',
  ],
  Message: [
    'Slack → Google Chat',
    'Slack → Microsoft Teams',
    'Teams → Google Chat',
    'Teams → Teams',
    'Teams → Slack',
    'Chat → Teams',
    'Chat → Chat',
    'Chat → Slack',
  ],
  Content: [], // user will supply combinations later
};

const MAIL_FOLDER_OPTIONS = [
  'Inbox', 'Sent', 'Draft', 'Spam', 'Trash', 'Labels', 'Starred',
  'Attachments', 'Calendar Events', 'Contacts', 'Groups',
  'Negative Test Cases', 'Delta Inbox', 'Delta Sent', 'Delta Draft',
  'Delta Spam', 'Delta Trash', 'Cloud Adding',
];

const MESSAGE_FOLDER_OPTIONS = [
  'Channels', 'Direct Messages', 'Group Messages', 'Threads',
  'Attachments', 'Reactions', 'Pinned Messages', 'Archived Channels',
  'Negative Test Cases',
];

/* ─── Small shared UI pieces ───────────────────────────────────────────────── */
const LABEL_META = {
  INBOX:               { label: 'Inbox',      color: 'bg-blue-100 text-blue-700' },
  SENT:                { label: 'Sent',       color: 'bg-gray-100 text-gray-700' },
  SPAM:                { label: 'Spam',       color: 'bg-red-100 text-red-700' },
  TRASH:               { label: 'Trash',      color: 'bg-red-100 text-red-600' },
  STARRED:             { label: 'Starred',    color: 'bg-yellow-100 text-yellow-700' },
  IMPORTANT:           { label: 'Important',  color: 'bg-orange-100 text-orange-700' },
  CATEGORY_SOCIAL:     { label: 'Social',     color: 'bg-purple-100 text-purple-700' },
  CATEGORY_FORUMS:     { label: 'Forums',     color: 'bg-purple-100 text-purple-700' },
  CATEGORY_PROMOTIONS: { label: 'Promotions', color: 'bg-purple-100 text-purple-700' },
  CATEGORY_UPDATES:    { label: 'Updates',    color: 'bg-purple-100 text-purple-700' },
};

function LabelBadge({ labelId }) {
  const meta = LABEL_META[labelId] || { label: labelId, color: 'bg-gray-100 text-gray-600' };
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${meta.color}`}>
      {meta.label}
    </span>
  );
}

const TH = 'px-3 py-2.5 text-left text-xs font-semibold text-gray-600 bg-gray-50 border-b border-r border-gray-200 whitespace-nowrap sticky top-0 z-10';
const TD = 'px-3 py-2.5 text-xs text-gray-800 border-b border-r border-gray-100 align-top';

const COLS = {
  id:       'min-w-[120px] w-[120px]',
  summary:  'min-w-[200px] w-[200px]',
  action:   'min-w-[180px] w-[180px]',
  testType: 'min-w-[90px]  w-[90px]',
  testData: 'min-w-[170px] w-[170px]',
  steps:    'min-w-[230px] w-[230px]',
  expected: 'min-w-[200px] w-[200px]',
  combo:    'min-w-[160px] w-[160px]',
  product:  'min-w-[100px] w-[100px]',
  folder:   'min-w-[130px] w-[130px]',
};

function StepsCell({ steps }) {
  if (!Array.isArray(steps) || steps.length === 0) return <span className="text-gray-300">—</span>;
  return (
    <ol className="space-y-0.5 list-none m-0 p-0">
      {steps.map((s, i) => (
        <li key={i} className="flex gap-1">
          <span className="text-gray-400 font-medium flex-shrink-0">{i + 1}.</span>
          <span className="leading-snug">{s}</span>
        </li>
      ))}
    </ol>
  );
}

function AddOneButton({ label, stateKey, savingState, color, onClick }) {
  const state = savingState[stateKey];
  const colorMap = {
    amber: { base: 'border-amber-300 text-amber-700 hover:bg-amber-50', loading: 'border-amber-200 text-amber-400', done: 'border-green-300 bg-green-50 text-green-700' },
    blue:  { base: 'border-blue-300 text-blue-700 hover:bg-blue-50',   loading: 'border-blue-200 text-blue-400',   done: 'border-green-300 bg-green-50 text-green-700' },
  };
  const c = colorMap[color];
  const cls = state === 'done' ? c.done : state === 'loading' ? c.loading : c.base;
  return (
    <button type="button" disabled={!!state} onClick={onClick}
      className={`flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium border transition-colors disabled:cursor-not-allowed ${cls}`}>
      {state === 'loading' ? (
        <><svg className="animate-spin h-3 w-3" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>Saving…</>
      ) : state === 'done' ? (
        <><svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" /></svg>Added</>
      ) : label}
    </button>
  );
}

function Checkbox({ checked, indeterminate, onChange, title }) {
  return (
    <input
      type="checkbox"
      title={title}
      ref={(el) => { if (el) el.indeterminate = !!indeterminate; }}
      checked={checked}
      onChange={onChange}
      className="w-4 h-4 rounded border-gray-300 text-indigo-600 cursor-pointer accent-indigo-600"
    />
  );
}

function TableHead({ showCheckbox, allChecked, someChecked, onToggleAll, extraCol }) {
  return (
    <thead>
      <tr>
        {showCheckbox && (
          <th className={`${TH} w-10 text-center`}>
            <Checkbox checked={allChecked} indeterminate={!allChecked && someChecked} onChange={onToggleAll} title="Select / deselect all" />
          </th>
        )}
        <th className={`${TH} ${COLS.id}`}>Test Case ID</th>
        <th className={`${TH} ${COLS.summary}`}>Summary</th>
        <th className={`${TH} ${COLS.action}`}>Action</th>
        <th className={`${TH} ${COLS.testType}`}>Test Type</th>
        <th className={`${TH} ${COLS.testData}`}>Test Data</th>
        <th className={`${TH} ${COLS.steps}`}>Test Steps</th>
        <th className={`${TH} ${COLS.expected}`}>Expected Result</th>
        <th className={`${TH} ${COLS.combo}`}>Combination</th>
        <th className={`${TH} ${COLS.product}`}>Product Type</th>
        <th className={`${TH} ${COLS.folder}`}>Folder</th>
        {extraCol !== undefined && <th className={`${TH} border-r-0`}>{extraCol}</th>}
      </tr>
    </thead>
  );
}

function GeneratedTable({ cases, selected, onToggle, onToggleAll, savingState, onAdd }) {
  const allChecked  = cases.length > 0 && selected.size === cases.length;
  const someChecked = selected.size > 0 && selected.size < cases.length;
  return (
    <div className="rounded-xl border border-gray-200 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="border-collapse w-max min-w-full">
          <TableHead showCheckbox allChecked={allChecked} someChecked={someChecked} onToggleAll={onToggleAll} extraCol="Actions" />
          <tbody>
            {cases.map((tc, idx) => {
              const isSelected = selected.has(idx);
              return (
                <tr key={idx} className={`transition-colors cursor-pointer ${isSelected ? 'bg-indigo-50' : 'hover:bg-gray-50'}`} onClick={() => onToggle(idx)}>
                  <td className={`${TD} w-10 text-center`} onClick={(e) => e.stopPropagation()}>
                    <Checkbox checked={isSelected} onChange={() => onToggle(idx)} />
                  </td>
                  <td className={`${TD} ${COLS.id} text-gray-400 italic text-[11px]`}>On save</td>
                  <td className={`${TD} ${COLS.summary} font-medium text-gray-900`}>{tc.summary || tc.subject || '—'}</td>
                  <td className={`${TD} ${COLS.action}`}>{tc.action || <span className="text-gray-300">—</span>}</td>
                  <td className={`${TD} ${COLS.testType} text-gray-400 italic text-[11px]`}>On save</td>
                  <td className={`${TD} ${COLS.testData}`}>{tc.testData || <span className="text-gray-300">—</span>}</td>
                  <td className={`${TD} ${COLS.steps}`}><StepsCell steps={tc.testSteps} /></td>
                  <td className={`${TD} ${COLS.expected}`}>{tc.expectedResult || <span className="text-gray-300">—</span>}</td>
                  <td className={`${TD} ${COLS.combo}`}>{tc.combination || <span className="text-gray-300">—</span>}</td>
                  <td className={`${TD} ${COLS.product}`}>
                    {tc.productType
                      ? <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-700">{tc.productType}</span>
                      : <span className="text-gray-300">—</span>}
                  </td>
                  <td className={`${TD} ${COLS.folder}`}>{tc.folder || <span className="text-gray-300">—</span>}</td>
                  <td className={`${TD} border-r-0 min-w-[160px]`} onClick={(e) => e.stopPropagation()}>
                    <div className="flex flex-col gap-1.5">
                      <AddOneButton label="Add to Smoke"  stateKey={`${idx}-smoke`}  savingState={savingState} color="amber" onClick={() => onAdd(tc, 'smoke',  idx)} />
                      <AddOneButton label="Add to Sanity" stateKey={`${idx}-sanity`} savingState={savingState} color="blue"  onClick={() => onAdd(tc, 'sanity', idx)} />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SavedTable({ cases, activeTab, deletingId, onDelete }) {
  return (
    <div className="overflow-x-auto">
      <table className="border-collapse w-max min-w-full">
        <TableHead showCheckbox={false} extraCol="" />
        <tbody>
          {cases.map((tc) => (
            <tr key={tc.id} className="hover:bg-indigo-50/30 transition-colors">
              <td className={`${TD} ${COLS.id}`}>
                <span className="font-mono font-semibold text-indigo-700 bg-indigo-50 px-1.5 py-0.5 rounded border border-indigo-100 text-[11px]">
                  {tc.testCaseId || tc.id}
                </span>
              </td>
              <td className={`${TD} ${COLS.summary} font-medium text-gray-900`}>{tc.summary || tc.subject || '—'}</td>
              <td className={`${TD} ${COLS.action}`}>{tc.action || <span className="text-gray-300">—</span>}</td>
              <td className={`${TD} ${COLS.testType}`}>
                <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${tc.testType === 'smoke' ? 'bg-amber-50 text-amber-700' : 'bg-blue-50 text-blue-700'}`}>
                  {tc.testType ? tc.testType.charAt(0).toUpperCase() + tc.testType.slice(1) : activeTab.charAt(0).toUpperCase() + activeTab.slice(1)}
                </span>
              </td>
              <td className={`${TD} ${COLS.testData}`}>{tc.testData || <span className="text-gray-300">—</span>}</td>
              <td className={`${TD} ${COLS.steps}`}><StepsCell steps={tc.testSteps} /></td>
              <td className={`${TD} ${COLS.expected}`}>{tc.expectedResult || <span className="text-gray-300">—</span>}</td>
              <td className={`${TD} ${COLS.combo}`}>{tc.combination || <span className="text-gray-300">—</span>}</td>
              <td className={`${TD} ${COLS.product}`}>{tc.productType || <span className="text-gray-300">—</span>}</td>
              <td className={`${TD} ${COLS.folder}`}>{tc.folder || <span className="text-gray-300">—</span>}</td>
              <td className={`${TD} border-r-0 w-10 text-center`}>
                <button type="button" disabled={deletingId === tc.id} onClick={() => onDelete(tc.id, activeTab)}
                  className="p-1 rounded text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors disabled:opacity-50" title="Remove">
                  {deletingId === tc.id
                    ? <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                    : <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" /></svg>
                  }
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ─── Main page ─────────────────────────────────────────────────────────────── */
export default function TestCaseGenerator() {
  const toast = useToast();

  const [scenarioText, setScenarioText] = usePersistedState('tcg-scenario', '');
  const [count, setCount]               = usePersistedState('tcg-count', 5);
  const [productType, setProductType]   = usePersistedState('tcg-product', 'Mail');
  const [combination, setCombination]   = usePersistedState('tcg-combo', 'Gmail → Outlook');
  const [customCombo, setCustomCombo]   = usePersistedState('tcg-custom-combo', '');
  const [folder, setFolder]             = usePersistedState('tcg-folder', '');
  const [generatedCases, setGeneratedCases] = usePersistedState('tcg-cases', []);
  const [savingState, setSavingState]   = usePersistedState('tcg-saving', {});
  const [selected, setSelected]         = usePersistedState('tcg-selected', new Set());

  const abortControllerRef = useRef(null);

  const [generating, setGenerating]   = useState(false);
  const [generateError, setGenerateError] = useState(null);
  const [bulkSaving, setBulkSaving]   = useState({ smoke: false, sanity: false });
  const [savedCases, setSavedCases]   = useState({ smoke: [], sanity: [] });
  const [activeTab, setActiveTab]     = useState('smoke');
  const [deletingId, setDeletingId]   = useState(null);

  /* When product changes, reset combination to first option */
  function handleProductChange(p) {
    setProductType(p);
    const combos = PRODUCT_COMBOS[p] || [];
    setCombination(combos[0] || '');
    setCustomCombo('');
    setFolder('');
  }

  const combos         = PRODUCT_COMBOS[productType] || [];
  const folderOptions  = productType === 'Message' ? MESSAGE_FOLDER_OPTIONS : MAIL_FOLDER_OPTIONS;
  const isContentType  = productType === 'Content';
  const effectiveCombo = isContentType ? customCombo : combination;

  const loadSaved = useCallback(async () => {
    try {
      const { data } = await getCustomTestCases();
      setSavedCases(data);
    } catch { /* non-fatal */ }
  }, []);

  useEffect(() => { loadSaved(); }, [loadSaved]);

  function parseScenarios(text) {
    return text
      .split(/\n{2,}|\n(?=\d+[\.\)]\s)/)
      .map((s) => s.replace(/^\d+[\.\)]\s*/, '').trim())
      .filter(Boolean);
  }

  function handleStop() {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  }

  async function handleGenerate(e) {
    e.preventDefault();
    const scenarios = parseScenarios(scenarioText);
    if (scenarios.length === 0) return;

    const controller = new AbortController();
    abortControllerRef.current = controller;

    setGenerating(true);
    setGenerateError(null);
    setGeneratedCases([]);
    setSelected(new Set());
    setSavingState({});
    try {
      const { data } = await generateTestCases(
        { scenarios, count, productType, combination: effectiveCombo, folder },
        controller.signal,
      );
      const cases = data.testCases || [];
      setGeneratedCases(cases);
      toast.success(
        `${cases.length} test case${cases.length !== 1 ? 's' : ''} generated`,
        `From ${scenarios.length} scenario${scenarios.length !== 1 ? 's' : ''}. Review and add to Smoke or Sanity.`
      );
    } catch (err) {
      if (err.code === 'ERR_CANCELED' || err.name === 'CanceledError' || err.name === 'AbortError') {
        toast.info('Generation stopped', 'The request was cancelled.');
        return;
      }
      const msg = err.response?.data?.error || err.message || 'Generation failed';
      setGenerateError(msg);
      toast.error('Generation failed', msg);
    } finally {
      abortControllerRef.current = null;
      setGenerating(false);
    }
  }

  function removeFromGenerated(indicesToRemove) {
    const idxSet = new Set(indicesToRemove);
    setGeneratedCases((prev) => prev.filter((_, i) => !idxSet.has(i)));
    setSelected((prev) => {
      const next = new Set();
      for (const i of prev) {
        if (idxSet.has(i)) continue;
        const shift = indicesToRemove.filter((r) => r < i).length;
        next.add(i - shift);
      }
      return next;
    });
    setSavingState((prev) => {
      const next = {};
      for (const [key, val] of Object.entries(prev)) {
        const [idxStr, type] = key.split('-');
        const i = parseInt(idxStr, 10);
        if (idxSet.has(i)) continue;
        const shift = indicesToRemove.filter((r) => r < i).length;
        next[`${i - shift}-${type}`] = val;
      }
      return next;
    });
  }

  function handleToggleRow(idx) {
    setSelected((prev) => { const n = new Set(prev); n.has(idx) ? n.delete(idx) : n.add(idx); return n; });
  }

  function handleToggleAll() {
    if (selected.size === generatedCases.length) setSelected(new Set());
    else setSelected(new Set(generatedCases.map((_, i) => i)));
  }

  async function handleAddOne(tc, type, idx) {
    const key = `${idx}-${type}`;
    setSavingState((prev) => ({ ...prev, [key]: 'loading' }));
    try {
      await addCustomTestCase({ testType: type, testCase: tc });
      loadSaved();
      toast.success(`Added to ${type.charAt(0).toUpperCase() + type.slice(1)}`, tc.summary || tc.subject);
      setTimeout(() => removeFromGenerated([idx]), 600);
    } catch (err) {
      setSavingState((prev) => ({ ...prev, [key]: undefined }));
      if (err.response?.status === 409) toast.warning('Duplicate skipped', err.response.data.message);
      else toast.error('Failed to save', err.response?.data?.error || err.message);
    }
  }

  async function handleAddSelected(type) {
    const indices = selected.size > 0 ? [...selected] : generatedCases.map((_, i) => i);
    const cases = indices.map((i) => generatedCases[i]);
    if (cases.length === 0) return;
    setBulkSaving((prev) => ({ ...prev, [type]: true }));
    const label = type.charAt(0).toUpperCase() + type.slice(1);
    try {
      const { data: result } = await addBulkTestCases(type, cases);
      loadSaved();
      const added = result.added ?? cases.length, skipped = result.skipped ?? 0;
      if (added > 0 && skipped === 0)      toast.success(`${added} test case${added !== 1 ? 's' : ''} added to ${label}`, `They will run in the next ${label} test execution.`);
      else if (added > 0 && skipped > 0)   toast.success(`${added} added, ${skipped} duplicate${skipped !== 1 ? 's' : ''} skipped`, `${skipped} already exist in ${label}.`);
      else                                 toast.warning('All duplicates — nothing added', `All selected test cases already exist in ${label}.`);
      const savedIndices = indices.filter((i) => {
        const tc = generatedCases[i];
        const norm = (s) => (s || '').trim().toLowerCase();
        return !(result.skippedNames || []).some((name) => norm(name) === norm(tc?.summary || tc?.subject));
      });
      if (savedIndices.length > 0) setTimeout(() => removeFromGenerated(savedIndices), 600);
    } catch (err) {
      toast.error(`Failed to add to ${label}`, err.response?.data?.error || err.message);
    } finally {
      setBulkSaving((prev) => ({ ...prev, [type]: false }));
    }
  }

  async function handleDelete(id, type) {
    setDeletingId(id);
    try {
      await deleteCustomTestCase(id, type);
      loadSaved();
      toast.info('Test case removed', `Removed from ${type.charAt(0).toUpperCase() + type.slice(1)} test suite.`);
    } catch (err) {
      toast.error('Failed to remove', err.response?.data?.error || err.message);
    } finally {
      setDeletingId(null);
    }
  }

  const currentSaved  = savedCases[activeTab] || [];
  const scenarioCount = parseScenarios(scenarioText).length;
  const canGenerate   = scenarioText.trim() && effectiveCombo.trim();

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Test Case Generator</h1>
        <p className="text-sm text-gray-500 mt-1">
          Select the product type and migration combination, then describe your scenarios to generate accurate test cases.
        </p>
      </div>

      {/* Input card */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-6">
        <form onSubmit={handleGenerate} className="space-y-6">

          {/* ── Row 1: Product Type + Combination + Folder ── */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">

            {/* Product Type */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Product Type</label>
              <div className="flex gap-2 flex-wrap">
                {Object.keys(PRODUCT_COMBOS).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => handleProductChange(p)}
                    className={`px-4 py-2 rounded-lg text-sm font-medium border transition-all ${
                      productType === p
                        ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
                        : 'bg-white text-gray-600 border-gray-300 hover:border-indigo-400 hover:text-indigo-600'
                    }`}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>

            {/* Combination */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Migration Combination
                {isContentType && <span className="ml-1 text-xs font-normal text-gray-400">(type manually)</span>}
              </label>
              {isContentType ? (
                <input
                  type="text"
                  value={customCombo}
                  onChange={(e) => setCustomCombo(e.target.value)}
                  placeholder="e.g. SharePoint → Google Drive"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
                />
              ) : (
                <select
                  value={combination}
                  onChange={(e) => setCombination(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none bg-white"
                >
                  {combos.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              )}
            </div>

            {/* Folder / Feature */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Folder / Feature
                <span className="ml-1 text-xs font-normal text-gray-400">(optional)</span>
              </label>
              <div className="flex gap-2">
                <select
                  value={folderOptions.includes(folder) ? folder : ''}
                  onChange={(e) => setFolder(e.target.value)}
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none bg-white"
                >
                  <option value="">— auto-detect —</option>
                  {folderOptions.map((f) => (
                    <option key={f} value={f}>{f}</option>
                  ))}
                </select>
                {folder && (
                  <button type="button" onClick={() => setFolder('')}
                    className="px-2 text-gray-400 hover:text-gray-600 border border-gray-300 rounded-lg text-sm">
                    ✕
                  </button>
                )}
              </div>
              {/* Also allow free text if not in the list */}
              {folder && !folderOptions.includes(folder) && (
                <input
                  type="text"
                  value={folder}
                  onChange={(e) => setFolder(e.target.value)}
                  placeholder="Custom folder name"
                  className="mt-2 w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
                />
              )}
            </div>
          </div>

          {/* Context pill showing current selection */}
          {effectiveCombo && (
            <div className="flex items-center gap-2 text-xs text-gray-500">
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-indigo-50 border border-indigo-100 text-indigo-700 font-medium">
                <span>{productType}</span>
                <span className="text-indigo-400">·</span>
                <span>{effectiveCombo}</span>
                {folder && <><span className="text-indigo-400">·</span><span>{folder}</span></>}
              </span>
              <span className="text-gray-400">will be applied to all generated test cases</span>
            </div>
          )}

          {/* Scenario textarea */}
          <div>
            <label htmlFor="scenario" className="block text-sm font-medium text-gray-700 mb-1">
              Test Scenarios
              <span className="ml-1.5 text-xs font-normal text-gray-400">— one per paragraph, or numbered (1. … 2. …)</span>
            </label>
            <textarea
              id="scenario"
              rows={5}
              value={scenarioText}
              onChange={(e) => setScenarioText(e.target.value)}
              placeholder={
                productType === 'Message'
                  ? `1. Verify direct messages migrate from ${effectiveCombo || 'source → destination'} with timestamps intact.\n\n2. Verify channel messages with attachments migrate correctly.\n\n3. Verify threaded replies are preserved after migration.`
                  : `1. Verify plain-text emails migrate from ${effectiveCombo || 'source → destination'} with all headers intact.\n\n2. Verify HTML emails with PDF attachments migrate correctly.\n\n3. Verify starred emails appear as flagged in destination.`
              }
              className="w-full px-4 py-3 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-shadow resize-none font-mono"
            />
            {scenarioCount > 0 && (
              <p className="text-xs text-indigo-600 mt-1">
                {scenarioCount} scenario{scenarioCount > 1 ? 's' : ''} detected
              </p>
            )}
          </div>

          {/* Count + Generate row */}
          <div className="flex items-end gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Test cases to generate</label>
              <div className="flex items-center gap-2">
                <input
                  type="number" min={1} max={20} value={count}
                  onChange={(e) => setCount(Math.min(20, Math.max(1, parseInt(e.target.value) || 1)))}
                  className="w-20 px-3 py-2 border border-gray-300 rounded-lg text-sm text-center focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
                />
                <span className="text-xs text-gray-400">total (max 20)</span>
              </div>
            </div>

            <button
              type="submit"
              disabled={generating || !canGenerate}
              className="flex items-center gap-2 px-6 py-2.5 bg-indigo-600 text-white text-sm font-semibold rounded-lg hover:bg-indigo-700 focus:ring-4 focus:ring-indigo-200 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            >
              {generating ? (
                <><svg className="animate-spin h-4 w-4" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>Generating…</>
              ) : (
                <><SparklesIcon className="w-4 h-4" />Generate Test Cases</>
              )}
            </button>

            {generating && (
              <button
                type="button"
                onClick={handleStop}
                className="flex items-center gap-2 px-4 py-2.5 bg-red-600 text-white text-sm font-semibold rounded-lg hover:bg-red-700 focus:ring-4 focus:ring-red-200 transition-all"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" />
                </svg>
                Stop
              </button>
            )}

            {!effectiveCombo && (
              <p className="text-xs text-amber-600">Enter a migration combination to enable generation.</p>
            )}
          </div>
        </form>

        {generateError && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3">
            <p className="text-sm text-red-700">{generateError}</p>
          </div>
        )}
      </div>

      {/* Generated cases */}
      {generatedCases.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <h2 className="text-base font-semibold text-gray-900">
                Generated Test Cases
                <span className="ml-2 text-sm font-normal text-gray-500">({generatedCases.length})</span>
              </h2>
              <p className="text-xs text-gray-400 mt-0.5">
                {selected.size > 0
                  ? <><span className="text-indigo-600 font-medium">{selected.size} selected</span> — add them to Smoke or Sanity, or pick individual rows.</>
                  : 'Check rows to select, or use the header checkbox to select all, then add to Smoke or Sanity.'}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button type="button" disabled={bulkSaving.smoke} onClick={() => handleAddSelected('smoke')}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold border transition-all border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100 disabled:opacity-50 disabled:cursor-not-allowed">
                {bulkSaving.smoke
                  ? <><svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>Saving…</>
                  : <>{selected.size > 0 ? `Add ${selected.size} Selected` : 'Add All'} → Smoke</>}
              </button>
              <button type="button" disabled={bulkSaving.sanity} onClick={() => handleAddSelected('sanity')}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold border transition-all border-blue-300 bg-blue-50 text-blue-800 hover:bg-blue-100 disabled:opacity-50 disabled:cursor-not-allowed">
                {bulkSaving.sanity
                  ? <><svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>Saving…</>
                  : <>{selected.size > 0 ? `Add ${selected.size} Selected` : 'Add All'} → Sanity</>}
              </button>
            </div>
          </div>
          <GeneratedTable cases={generatedCases} selected={selected} onToggle={handleToggleRow} onToggleAll={handleToggleAll} savingState={savingState} onAdd={handleAddOne} />
        </div>
      )}

      {/* Saved cases */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-900">Saved Custom Test Cases</h2>
          <div className="flex rounded-lg border border-gray-200 overflow-hidden text-sm">
            {['smoke', 'sanity'].map((tab) => (
              <button key={tab} type="button" onClick={() => setActiveTab(tab)}
                className={`px-4 py-1.5 font-medium capitalize transition-colors ${activeTab === tab ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}>
                {tab}
                <span className={`ml-1.5 text-xs ${activeTab === tab ? 'text-indigo-200' : 'text-gray-400'}`}>
                  ({(savedCases[tab] || []).length})
                </span>
              </button>
            ))}
          </div>
        </div>
        {currentSaved.length === 0 ? (
          <div className="px-6 py-10 text-center text-sm text-gray-400">
            No custom test cases saved for {activeTab} testing yet.
          </div>
        ) : (
          <SavedTable cases={currentSaved} activeTab={activeTab} deletingId={deletingId} onDelete={handleDelete} />
        )}
      </div>
    </div>
  );
}

function SparklesIcon(props) {
  return (
    <svg {...props} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456ZM16.894 20.567 16.5 21.75l-.394-1.183a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394-1.183.394a2.25 2.25 0 0 0-1.423 1.423Z" />
    </svg>
  );
}
