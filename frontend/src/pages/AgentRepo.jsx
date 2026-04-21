import { useState, useEffect, useMemo, useRef } from 'react';
import * as XLSX from 'xlsx';
import { getCustomTestCases, updateCustomTestCase } from '../services/api';
import { useToast } from '../context/ToastContext';

/* ── Table style constants (identical to TestCaseGenerator) ── */
const TH = 'px-3 py-2.5 text-left text-xs font-semibold text-black bg-[#eef1fb] border-b border-r border-[#c5cef5] whitespace-nowrap sticky top-0 z-10';
const TD = 'px-3 py-2.5 text-xs text-black border-b border-r border-[#c5cef5] align-top';

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
  actions:  'min-w-[80px]  w-[80px]',
};

/* shared input / textarea styles */
const INPUT_CLS  = 'w-full px-2 py-1 text-xs border border-[#0129ac] rounded focus:ring-1 focus:ring-[#0129ac] outline-none bg-white resize-none';
const SELECT_CLS = 'w-full px-2 py-1 text-xs border border-[#0129ac] rounded focus:ring-1 focus:ring-[#0129ac] outline-none bg-white';

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

/* ── Editable row ── */
function EditableRow({ tc, testType, onSave, onCancel, saving }) {
  const [vals, setVals] = useState({
    summary:        tc.summary || '',
    action:         tc.action || '',
    testType:       tc.testType || testType,
    testData:       tc.testData || '',
    testSteps:      (tc.testSteps || []).join('\n'),
    expectedResult: tc.expectedResult || '',
    combination:    tc.combination || '',
    productType:    tc.productType || '',
    folder:         (tc.folder || '').replace(/^\/+/, ''),
  });

  const set = (k) => (e) => setVals((p) => ({ ...p, [k]: e.target.value }));

  function handleSave() {
    const updates = {
      ...vals,
      testSteps: vals.testSteps.split('\n').map((s) => s.trim()).filter(Boolean),
      folder: vals.folder,
    };
    onSave(updates);
  }

  return (
    <tr className="bg-[#eef1fb]/40">
      <td className={`${TD} ${COLS.id}`}>
        <span className="font-mono font-semibold text-[#0129ac] bg-[#eef1fb] px-1.5 py-0.5 rounded border border-[#c5cef5] text-[11px]">
          {tc.testCaseId || tc.id}
        </span>
      </td>
      <td className={`${TD} ${COLS.summary}`}>
        <textarea rows={3} className={INPUT_CLS} value={vals.summary} onChange={set('summary')} />
      </td>
      <td className={`${TD} ${COLS.action}`}>
        <textarea rows={3} className={INPUT_CLS} value={vals.action} onChange={set('action')} />
      </td>
      <td className={`${TD} ${COLS.testType}`}>
        <select className={SELECT_CLS} value={vals.testType} onChange={set('testType')}>
          <option value="smoke">Smoke</option>
          <option value="sanity">Sanity</option>
        </select>
      </td>
      <td className={`${TD} ${COLS.testData}`}>
        <textarea rows={3} className={INPUT_CLS} value={vals.testData} onChange={set('testData')} />
      </td>
      <td className={`${TD} ${COLS.steps}`}>
        <textarea
          rows={5}
          className={INPUT_CLS}
          value={vals.testSteps}
          onChange={set('testSteps')}
          placeholder="One step per line"
        />
        <p className="text-[10px] text-gray-400 mt-0.5">One step per line</p>
      </td>
      <td className={`${TD} ${COLS.expected}`}>
        <textarea rows={3} className={INPUT_CLS} value={vals.expectedResult} onChange={set('expectedResult')} />
      </td>
      <td className={`${TD} ${COLS.combo}`}>
        <input type="text" className={INPUT_CLS} value={vals.combination} onChange={set('combination')} />
      </td>
      <td className={`${TD} ${COLS.product}`}>
        <select className={SELECT_CLS} value={vals.productType} onChange={set('productType')}>
          {['Mail', 'Calendar', 'Contacts', 'Drive', 'Message', 'Content'].map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
      </td>
      <td className={`${TD} ${COLS.folder}`}>
        <input type="text" className={INPUT_CLS} value={vals.folder} onChange={set('folder')} />
      </td>
      <td className={`${TD} ${COLS.actions} border-r-0`}>
        <div className="flex flex-col gap-1">
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center justify-center gap-1 px-2 py-1 bg-[#0129ac] hover:bg-[#011e8a] text-white text-[11px] font-semibold rounded transition-colors disabled:opacity-50"
          >
            {saving ? (
              <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            ) : (
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
              </svg>
            )}
            Save
          </button>
          <button
            onClick={onCancel}
            disabled={saving}
            className="flex items-center justify-center gap-1 px-2 py-1 border border-[#c5cef5] text-black hover:bg-[#eef1fb] text-[11px] font-medium rounded transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </td>
    </tr>
  );
}

/* ── Read-only row ── */
function ReadRow({ tc, testType, onEdit }) {
  return (
    <tr className="hover:bg-[#eef1fb]/40 transition-colors group">
      <td className={`${TD} ${COLS.id}`}>
        <span className="font-mono font-semibold text-[#0129ac] bg-[#eef1fb] px-1.5 py-0.5 rounded border border-[#c5cef5] text-[11px]">
          {tc.testCaseId || tc.id}
        </span>
      </td>
      <td className={`${TD} ${COLS.summary} font-medium text-black`}>{tc.summary || <span className="text-gray-400">—</span>}</td>
      <td className={`${TD} ${COLS.action}`}>{tc.action || <span className="text-gray-300">—</span>}</td>
      <td className={`${TD} ${COLS.testType}`}>
        <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${
          'bg-[#eef1fb] text-[#0129ac]'
        }`}>
          {((tc.testType || testType).charAt(0).toUpperCase() + (tc.testType || testType).slice(1))}
        </span>
      </td>
      <td className={`${TD} ${COLS.testData}`}>{tc.testData || <span className="text-gray-300">—</span>}</td>
      <td className={`${TD} ${COLS.steps}`}><StepsCell steps={tc.testSteps} /></td>
      <td className={`${TD} ${COLS.expected}`}>{tc.expectedResult || <span className="text-gray-300">—</span>}</td>
      <td className={`${TD} ${COLS.combo}`}>{tc.combination || <span className="text-gray-300">—</span>}</td>
      <td className={`${TD} ${COLS.product}`}>{tc.productType || <span className="text-gray-300">—</span>}</td>
      <td className={`${TD} ${COLS.folder}`}>{tc.folder || <span className="text-gray-300">—</span>}</td>
      <td className={`${TD} ${COLS.actions} border-r-0`}>
        <button
          onClick={() => onEdit(tc.id)}
          className="opacity-0 group-hover:opacity-100 flex items-center gap-1 px-2 py-1 border border-[#c5cef5] text-black hover:border-[#0129ac] hover:text-[#0129ac] hover:bg-[#eef1fb] text-[11px] font-medium rounded transition-all"
          title="Edit this test case"
        >
          <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L6.832 19.82a4.5 4.5 0 0 1-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 0 1 1.13-1.897L16.863 4.487Zm0 0L19.5 7.125" />
          </svg>
          Edit
        </button>
      </td>
    </tr>
  );
}

/* ── Table wrapper ── */
function RepoTable({ cases, testType, editingId, savingId, onEdit, onSave, onCancel }) {
  return (
    <div className="overflow-x-auto">
      <table className="border-collapse w-max min-w-full">
        <thead>
          <tr>
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
            <th className={`${TH} ${COLS.actions} border-r-0`}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {cases.map((tc) =>
            editingId === tc.id ? (
              <EditableRow
                key={tc.id}
                tc={tc}
                testType={testType}
                saving={savingId === tc.id}
                onSave={(updates) => onSave(tc.id, tc.testType || testType, updates)}
                onCancel={onCancel}
              />
            ) : (
              <ReadRow
                key={tc.id}
                tc={tc}
                testType={testType}
                onEdit={onEdit}
              />
            )
          )}
        </tbody>
      </table>
    </div>
  );
}

/* ── helpers ── */
function cleanFolder(f) {
  return (f || 'General').replace(/^\/+/, '').trim() || 'General';
}

function buildTree(cases) {
  const tree = {};
  for (const tc of cases) {
    const pt    = (tc.productType || 'Other').trim();
    const combo = (tc.combination || 'Unknown').trim();
    const fld   = cleanFolder(tc.folder);
    tree[pt]              ??= {};
    tree[pt][combo]       ??= {};
    tree[pt][combo][fld]  ??= [];
    tree[pt][combo][fld].push(tc);
  }
  return tree;
}

const PRODUCT_ICONS = {
  Mail:     MailIcon,
  Message:  MessageIcon,
  Content:  ContentIcon,
  Calendar: CalendarIcon,
  Contacts: ContactsIcon,
};

function exportToExcel(cases, label) {
  const rows = cases.map((tc) => ({
    'Test Case ID':    tc.testCaseId || tc.id || '',
    'Summary':         tc.summary || '',
    'Action':          tc.action || '',
    'Test Type':       tc.testType ? tc.testType.charAt(0).toUpperCase() + tc.testType.slice(1) : '',
    'Test Data':       tc.testData || '',
    'Test Steps':      Array.isArray(tc.testSteps) ? tc.testSteps.map((s, i) => `${i + 1}. ${s}`).join('\n') : '',
    'Expected Result': tc.expectedResult || '',
    'Combination':     tc.combination || '',
    'Product Type':    tc.productType || '',
    'Folder':          (tc.folder || '').replace(/^\/+/, ''),
  }));

  const ws = XLSX.utils.json_to_sheet(rows);

  // Column widths
  ws['!cols'] = [
    { wch: 16 }, { wch: 36 }, { wch: 36 }, { wch: 10 },
    { wch: 28 }, { wch: 48 }, { wch: 36 },
    { wch: 22 }, { wch: 14 }, { wch: 16 },
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, label.slice(0, 31));
  XLSX.writeFile(wb, `agent-repo-${label.toLowerCase()}.xlsx`);
}

/* ── main page ── */
export default function AgentRepo() {
  const toast = useToast();
  const [allCases, setAllCases]             = useState({ smoke: [], sanity: [] });
  const [loading, setLoading]               = useState(true);
  const [testType, setTestType]             = useState('smoke');
  const [expandedPT, setExpandedPT]         = useState(new Set());
  const [expandedCombos, setExpandedCombos] = useState(new Set());
  const [selected, setSelected]             = useState(null);
  const [editingId, setEditingId]           = useState(null);
  const [savingId, setSavingId]             = useState(null);

  function load() {
    return getCustomTestCases()
      .then(({ data }) => setAllCases(data))
      .catch(() => {});
  }

  useEffect(() => {
    load()
      .then(() => {
        const t = buildTree(allCases.smoke || []);
        const firstPT = Object.keys(t)[0];
        if (firstPT) {
          setExpandedPT(new Set([firstPT]));
          const firstCombo = Object.keys(t[firstPT] || {})[0];
          if (firstCombo) setExpandedCombos(new Set([`${firstPT}::${firstCombo}`]));
        }
      })
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line

  const activeCases = allCases[testType] || [];
  const tree = useMemo(() => buildTree(activeCases), [activeCases]);

  useEffect(() => {
    setSelected(null);
    setEditingId(null);
  }, [testType]);

  function togglePT(pt) {
    setExpandedPT((prev) => {
      const next = new Set(prev);
      next.has(pt) ? next.delete(pt) : next.add(pt);
      return next;
    });
  }

  function toggleCombo(pt, combo) {
    const key = `${pt}::${combo}`;
    setExpandedCombos((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
    setSelected({ productType: pt, combination: combo, folder: null });
    setEditingId(null);
  }

  function selectFolder(pt, combo, folder) {
    setSelected({ productType: pt, combination: combo, folder });
    setEditingId(null);
  }

  const rightCases = useMemo(() => {
    if (!selected) return [];
    const comboData = tree[selected.productType]?.[selected.combination] || {};
    if (!selected.folder) return Object.values(comboData).flat();
    return comboData[selected.folder] || [];
  }, [selected, tree]);

  function comboCount(pt, combo) {
    return Object.values(tree[pt]?.[combo] || {}).flat().length;
  }

  async function handleSave(id, type, updates) {
    setSavingId(id);
    try {
      await updateCustomTestCase(id, type, updates);
      await load();
      setEditingId(null);
      toast.success('Test case updated', 'Changes saved successfully.');
    } catch (err) {
      toast.error('Save failed', err.response?.data?.error || err.message);
    } finally {
      setSavingId(null);
    }
  }

  const panelTitle = selected
    ? selected.folder
      ? `${selected.combination} / ${selected.folder}`
      : selected.combination
    : null;

  return (
    <div className="-mx-6 -my-8 flex flex-col h-screen overflow-hidden">

      {/* ── Top bar ── */}
      <div className="flex items-center justify-between px-6 py-3 bg-white border-b border-[#c5cef5] flex-shrink-0">
        <div>
          <h1 className="text-lg font-bold text-black">Agent Repository</h1>
          <p className="text-xs text-black">Browse and edit saved test cases by product, combination and folder</p>
        </div>
        <div className="flex rounded-lg border border-[#c5cef5] overflow-hidden text-sm">
          {['smoke', 'sanity'].map((type) => {
            const count = (allCases[type] || []).length;
            const isActive = testType === type;
            return (
              <button key={type} onClick={() => setTestType(type)}
                className={`px-5 py-2 font-medium capitalize transition-colors ${
                  isActive
                    ? 'bg-[#0129ac] text-white'
                    : 'text-black hover:bg-[#eef1fb]'
                }`}>
                {type}
                <span className={`ml-1.5 text-xs ${isActive ? 'text-white/70' : 'text-black'}`}>({count})</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Body ── */}
      <div className="flex flex-1 overflow-hidden">

        {/* Left 3-level tree */}
        <aside className="w-64 flex-shrink-0 bg-white border-r border-[#c5cef5] overflow-y-auto">
          <p className="px-4 pt-4 pb-2 text-[10px] font-bold tracking-widest text-black uppercase select-none">
            Product Types
          </p>
          {loading && <p className="px-4 py-3 text-xs text-black">Loading…</p>}
          {!loading && Object.keys(tree).length === 0 && (
            <p className="px-4 py-3 text-xs text-black">No {testType} test cases saved yet.</p>
          )}

          {Object.keys(tree).sort().map((pt) => {
            const Icon = PRODUCT_ICONS[pt] || ContentIcon;
            const ptExpanded = expandedPT.has(pt);
            return (
              <div key={pt}>
                {/* Level 1 — Product Type */}
                <button onClick={() => togglePT(pt)}
                  className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm font-semibold text-black hover:bg-[#eef1fb] transition-colors">
                  <Icon className="w-4 h-4 text-[#0129ac] flex-shrink-0" />
                  <span className="flex-1 text-left">{pt}</span>
                  <svg className={`w-3.5 h-3.5 text-black transition-transform ${ptExpanded ? 'rotate-180' : ''}`}
                    fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
                  </svg>
                </button>

                {ptExpanded && Object.keys(tree[pt]).map((combo) => {
                  const comboKey = `${pt}::${combo}`;
                  const comboExpanded = expandedCombos.has(comboKey);
                  const isComboActive = selected?.productType === pt && selected?.combination === combo && !selected?.folder;
                  const folders = Object.keys(tree[pt][combo]);
                  return (
                    <div key={combo}>
                      {/* Level 2 — Combination */}
                      <button onClick={() => toggleCombo(pt, combo)}
                        className={`w-full flex items-center gap-1.5 pl-8 pr-3 py-2 text-xs transition-colors text-left border-l-2
                          ${isComboActive
                            ? 'bg-[#eef1fb] text-[#0129ac] font-semibold border-[#0129ac]'
                            : 'text-black font-medium hover:bg-[#eef1fb] hover:text-[#0129ac] border-transparent'
                          }`}>
                        <svg className={`w-3 h-3 flex-shrink-0 transition-transform ${comboExpanded ? 'rotate-90' : ''}`}
                          fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
                        </svg>
                        <span className="flex-1 truncate">{combo}</span>
                        <span className={`flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded-full font-medium
                          ${isComboActive ? 'bg-[#0129ac] text-white' : 'bg-[#eef1fb] text-[#0129ac]'}`}>
                          {comboCount(pt, combo)}
                        </span>
                      </button>

                      {/* Level 3 — Folders */}
                      {comboExpanded && folders.map((folder) => {
                        const isFolderActive = selected?.productType === pt && selected?.combination === combo && selected?.folder === folder;
                        return (
                          <button key={folder} onClick={() => selectFolder(pt, combo, folder)}
                            className={`w-full flex items-center justify-between gap-2 pl-14 pr-3 py-1.5 text-xs transition-colors text-left border-l-2
                              ${isFolderActive
                                ? 'bg-[#eef1fb] text-[#0129ac] font-semibold border-[#0129ac]'
                                : 'text-black hover:bg-[#eef1fb] hover:text-[#0129ac] border-transparent'
                              }`}>
                            <span className="truncate">{folder}</span>
                            <span className={`flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded-full font-medium
                              ${isFolderActive ? 'bg-[#0129ac] text-white' : 'bg-[#eef1fb] text-[#0129ac]'}`}>
                              {(tree[pt][combo][folder] || []).length}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </aside>

        {/* Right panel */}
        <main className="flex-1 overflow-auto bg-white">
          {!selected ? (
            <div className="flex flex-col items-center justify-center h-full text-center text-black gap-3">
              <div className="w-16 h-16 rounded-2xl bg-[#eef1fb] flex items-center justify-center">
                <svg className="w-8 h-8 text-[#0129ac]" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 9.776c.112-.017.227-.026.344-.026h15.812c.117 0 .232.009.344.026m-16.5 0a2.25 2.25 0 0 0-1.883 2.542l.857 6a2.25 2.25 0 0 0 2.227 1.932H19.05a2.25 2.25 0 0 0 2.227-1.932l.857-6a2.25 2.25 0 0 0-1.883-2.542m-16.5 0V6A2.25 2.25 0 0 1 6 3.75h3.879a1.5 1.5 0 0 1 1.06.44l2.122 2.12a1.5 1.5 0 0 0 1.06.44H18A2.25 2.25 0 0 1 20.25 9v.776" />
                </svg>
              </div>
              <div>
                <p className="text-sm font-semibold text-black">Select a combination or folder</p>
                <p className="text-xs text-black mt-0.5">Expand a product type in the left panel to browse</p>
              </div>
            </div>
          ) : (
            <div>
              {/* Panel header */}
              <div className="px-6 py-4 border-b border-[#c5cef5] flex items-center justify-between flex-shrink-0 bg-white sticky top-0 z-20">
                <div>
                  <p className="text-xs text-black mb-0.5">
                    {selected.productType} / {selected.combination}
                    {selected.folder && <> / <span className="font-medium text-black">{selected.folder}</span></>}
                  </p>
                  <h2 className="text-base font-semibold text-black">{panelTitle}</h2>
                </div>
                <div className="flex items-center gap-3">
                  {editingId && (
                    <span className="text-xs text-[#0129ac] font-medium bg-[#eef1fb] px-2 py-1 rounded-full border border-[#c5cef5]">
                      Editing 1 row
                    </span>
                  )}
                  <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-[#0129ac] text-white">
                    {rightCases.length} case{rightCases.length !== 1 ? 's' : ''}
                  </span>
                  {rightCases.length > 0 && (
                    <button
                      type="button"
                      onClick={() => exportToExcel(rightCases, panelTitle || testType)}
                      className="flex items-center gap-1.5 px-3 py-1.5 border border-[#c5cef5] text-black hover:border-[#0129ac] hover:text-[#0129ac] hover:bg-[#eef1fb] text-xs font-medium rounded-lg transition-colors"
                      title="Download as Excel"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
                      </svg>
                      Excel
                    </button>
                  )}
                </div>
              </div>

              {rightCases.length === 0 ? (
                <div className="px-6 py-16 text-center text-sm text-black">
                  No {testType} test cases found here.
                </div>
              ) : (
                <RepoTable
                  cases={rightCases}
                  testType={testType}
                  editingId={editingId}
                  savingId={savingId}
                  onEdit={setEditingId}
                  onSave={handleSave}
                  onCancel={() => setEditingId(null)}
                />
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

/* ── Icons ── */
function MailIcon(props) {
  return (
    <svg {...props} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 0 1-2.25 2.25h-15a2.25 2.25 0 0 1-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25m19.5 0v.243a2.25 2.25 0 0 1-1.07 1.916l-7.5 4.615a2.25 2.25 0 0 1-2.36 0L3.32 8.91a2.25 2.25 0 0 1-1.07-1.916V6.75" />
    </svg>
  );
}
function MessageIcon(props) {
  return (
    <svg {...props} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.76c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.076-4.076a1.526 1.526 0 0 1 1.037-.443 48.282 48.282 0 0 0 5.68-.494c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z" />
    </svg>
  );
}
function ContentIcon(props) {
  return (
    <svg {...props} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
    </svg>
  );
}
function CalendarIcon(props) {
  return (
    <svg {...props} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5" />
    </svg>
  );
}
function ContactsIcon(props) {
  return (
    <svg {...props} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z" />
    </svg>
  );
}
