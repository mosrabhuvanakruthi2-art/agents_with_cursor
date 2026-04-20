import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  getTestRepositoryData,
  getTestRepositoryTestDetail,
  getLocalRepoData,
  createLocalFolder,
  deleteLocalFolder,
  createLocalTest,
  deleteLocalTest,
} from '../services/api';

// ─── helpers ────────────────────────────────────────────────────────────────

function folderKey(node) {
  return String(node?.id ?? node?.path ?? '');
}

function normPath(p) {
  const s = String(p ?? '').trim();
  return s === '/' ? '' : s;
}

function testBelongsToSelectedFolder(t, selectedFolderId) {
  const fp = String(t.folderPath ?? t.folderId ?? '');
  const sel = String(selectedFolderId ?? '/');
  if (fp === sel) return true;
  if (sel === '/' || sel === '') return fp === '/' || fp === '';
  return fp.startsWith(`${sel}/`);
}

function totalTestsInNode(node, localTestsByFolderPath) {
  if (node == null) return 0;
  // Xray nodes use testsCount; local nodes have no Xray tests
  const xrayCount = node._local ? 0 : (node.testsCount ?? 0);
  // Always add local tests created in this folder (works for both Xray and local folder nodes)
  const localCount = localTestsByFolderPath ? (localTestsByFolderPath[normPath(node.path)] ?? 0) : 0;
  let total = xrayCount + localCount;
  for (const child of node.folders || []) total += totalTestsInNode(child, localTestsByFolderPath);
  return total;
}

function breadcrumbFromPath(path, projectLabel) {
  const parts = String(path || '/').split('/').filter(Boolean);
  const crumbs = [{ label: 'Test Repository', path: '/' }];
  let acc = '';
  for (const p of parts) { acc += `/${p}`; crumbs.push({ label: p, path: acc }); }
  if (projectLabel) return [{ label: projectLabel, path: null }, ...crumbs];
  return crumbs;
}

// Build a parent-path → [localFolderNode, ...] map for efficient tree merge
function buildLocalFolderMap(localFolders) {
  const map = {};
  for (const lf of localFolders) {
    const parent = normPath(lf.parentPath);
    if (!map[parent]) map[parent] = [];
    map[parent].push({
      id: lf.path,       // use path as id (consistent with Xray convention)
      _localId: lf._id,  // MongoDB _id for deletion
      name: lf.name,
      path: lf.path,
      parentPath: lf.parentPath,
      folders: [],
      testsCount: 0,
      _local: true,
    });
  }
  return map;
}

function mergeLocalFoldersIntoTree(node, localFolderMap) {
  if (!node) return node;
  const nodePath = normPath(node.path);
  const localKids = (localFolderMap[nodePath] || []).map(lf =>
    mergeLocalFoldersIntoTree(lf, localFolderMap)
  );
  return {
    ...node,
    folders: [
      ...(node.folders || []).map(f => mergeLocalFoldersIntoTree(f, localFolderMap)),
      ...localKids,
    ],
  };
}

// ─── shared UI ──────────────────────────────────────────────────────────────

function Badge({ children, tone = 'neutral' }) {
  const tones = {
    neutral: 'bg-slate-100 text-slate-700',
    primary: 'bg-sky-100 text-sky-800',
    muted: 'bg-slate-200 text-slate-600',
    green: 'bg-emerald-100 text-emerald-800',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold uppercase tracking-wide ${tones[tone] || tones.neutral}`}>
      {children}
    </span>
  );
}

// ─── FolderTreeNode ──────────────────────────────────────────────────────────

function FolderTreeNode({ node, selectedId, onSelect, expanded, toggleExpand,
  onCreateSubfolder, onAddTest, onDeleteFolder, localTestsByFolderPath, depth = 0 }) {
  const [hovered, setHovered] = useState(false);
  if (node == null) return null;
  const id = folderKey(node);
  const name = node.name != null ? String(node.name) : 'Folder';
  const children = node.folders || [];
  const hasKids = children.length > 0;
  const isOpen = expanded.has(id);
  const total = totalTestsInNode(node, localTestsByFolderPath);

  return (
    <div className={depth > 0 ? 'mt-0.5' : ''}>
      <div
        className={`group flex items-center gap-0.5 rounded-r-md text-sm border-l-[3px] ${
          selectedId === id
            ? 'border-[#0052CC] bg-[#DEEBFF] text-[#172B4D]'
            : node._local
            ? 'border-emerald-300 text-slate-700 hover:bg-emerald-50'
            : 'border-transparent text-slate-700 hover:bg-slate-100'
        }`}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {hasKids ? (
          <button type="button" aria-expanded={isOpen}
            onClick={e => { e.stopPropagation(); toggleExpand(id); }}
            className="flex-shrink-0 w-6 h-7 flex items-center justify-center text-slate-500 hover:text-slate-800">
            <span className="text-[10px]">{isOpen ? '▼' : '▶'}</span>
          </button>
        ) : (
          <span className="w-6 flex-shrink-0" />
        )}

        <button type="button" onClick={() => onSelect(id)}
          className="flex-1 text-left py-1.5 min-w-0 flex items-baseline justify-between gap-1">
          <span className="truncate font-medium flex items-center gap-1">
            {node._local && (
              <span className="text-[9px] font-bold text-emerald-600 bg-emerald-100 rounded px-1 flex-shrink-0">LOCAL</span>
            )}
            {name}
          </span>
          <span className="flex-shrink-0 text-xs text-slate-400 tabular-nums pr-1">({total})</span>
        </button>

        {/* Action buttons – visible on hover */}
        {hovered && (
          <div className="flex items-center gap-0.5 flex-shrink-0 pr-1">
            <button type="button" title="Create subfolder"
              onClick={e => { e.stopPropagation(); onCreateSubfolder(node); }}
              className="w-5 h-5 rounded flex items-center justify-center text-slate-400 hover:text-[#0052CC] hover:bg-blue-50 text-xs font-bold">
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                <path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h3.879a1.5 1.5 0 0 1 1.06.44l.122.12A1.5 1.5 0 0 0 8.62 3H13.5A1.5 1.5 0 0 1 15 4.5v1H1v-2zM1 6v6.5A1.5 1.5 0 0 0 2.5 14h11a1.5 1.5 0 0 0 1.5-1.5V6H1z"/>
              </svg>
            </button>
            <button type="button" title="Add test case"
              onClick={e => { e.stopPropagation(); onAddTest(node); }}
              className="w-5 h-5 rounded flex items-center justify-center text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 text-xs font-bold">
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                <path d="M8 2a.5.5 0 0 1 .5.5v5h5a.5.5 0 0 1 0 1h-5v5a.5.5 0 0 1-1 0v-5h-5a.5.5 0 0 1 0-1h5v-5A.5.5 0 0 1 8 2z"/>
              </svg>
            </button>
            {node._local && (
              <button type="button" title="Delete folder"
                onClick={e => { e.stopPropagation(); onDeleteFolder(node); }}
                className="w-5 h-5 rounded flex items-center justify-center text-slate-400 hover:text-red-600 hover:bg-red-50">
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                  <path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/>
                  <path fillRule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1 0-2h3.5l1-1h3l1 1h3.5a1 1 0 0 1 1 1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118z"/>
                </svg>
              </button>
            )}
          </div>
        )}
      </div>

      {hasKids && isOpen && (
        <div className="ml-2 border-l border-slate-200 pl-2">
          {children.map((child, i) => (
            <FolderTreeNode key={`${folderKey(child)}-${i}`}
              node={child} selectedId={selectedId} onSelect={onSelect}
              expanded={expanded} toggleExpand={toggleExpand}
              onCreateSubfolder={onCreateSubfolder} onAddTest={onAddTest}
              onDeleteFolder={onDeleteFolder}
              localTestsByFolderPath={localTestsByFolderPath}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Create Folder Modal ─────────────────────────────────────────────────────

function CreateFolderModal({ open, parentPath, parentName, onClose, onCreated }) {
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) { setName(''); setError(''); setSaving(false); setTimeout(() => inputRef.current?.focus(), 50); }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const h = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);

  if (!open) return null;

  const handleSubmit = async e => {
    e.preventDefault();
    const n = name.trim();
    if (!n) { setError('Folder name is required'); return; }
    setSaving(true); setError('');
    try {
      const { data } = await createLocalFolder({ name: n, parentPath: parentPath ?? '' });
      onCreated(data.folder);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to create folder');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl border border-slate-200 w-full max-w-md" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-slate-200 bg-[#FAFBFC]">
          <h2 className="text-base font-semibold text-slate-900">Create Folder</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Under: <span className="font-medium">{parentName || 'Test Repository (root)'}</span>
          </p>
        </div>
        <form onSubmit={handleSubmit} className="px-5 py-4 space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Folder name <span className="text-red-500">*</span></label>
            <input ref={inputRef} type="text" value={name} onChange={e => setName(e.target.value)}
              placeholder="e.g. Regression Tests"
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0052CC]/40 focus:border-[#0052CC]" />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose}
              className="px-4 py-2 rounded-md border border-slate-300 text-sm text-slate-700 hover:bg-slate-50">Cancel</button>
            <button type="submit" disabled={saving}
              className="px-4 py-2 rounded-md bg-[#0052CC] text-white text-sm font-medium hover:bg-[#0747A6] disabled:opacity-60">
              {saving ? 'Creating…' : 'Create Folder'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Create Test Modal ───────────────────────────────────────────────────────

const EMPTY_STEP = () => ({ action: '', data: '', testSteps: '', result: '' });

function CreateTestModal({ open, folderPath, folderName, onClose, onCreated }) {
  const [summary, setSummary] = useState('');
  const [testType, setTestType] = useState('Manual');
  const [description, setDescription] = useState('');
  const [steps, setSteps] = useState([EMPTY_STEP()]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) { setSummary(''); setTestType('Manual'); setDescription(''); setSteps([EMPTY_STEP()]); setError(''); setSaving(false); }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const h = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);

  if (!open) return null;

  const updateStep = (idx, field, val) =>
    setSteps(prev => prev.map((s, i) => i === idx ? { ...s, [field]: val } : s));

  const addStep = () => setSteps(prev => [...prev, EMPTY_STEP()]);
  const removeStep = idx => setSteps(prev => prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev);

  const handleSubmit = async e => {
    e.preventDefault();
    const s = summary.trim();
    if (!s) { setError('Summary is required'); return; }
    setSaving(true); setError('');
    try {
      const normalizedSteps = steps
        .filter(st => st.action.trim() || st.data.trim() || st.testSteps.trim() || st.result.trim())
        .map((st, idx) => ({
          stepNumber: idx + 1,
          action: st.action.trim(),
          data: st.data.trim(),
          testSteps: st.testSteps.trim(),
          result: st.result.trim(),
        }));
      const { data } = await createLocalTest({
        summary: s,
        folderPath: folderPath || '/',
        testType,
        description: description.trim(),
        steps: normalizedSteps,
      });
      onCreated(data.test);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to create test');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4" onClick={onClose}>
      <div className="my-6 bg-white rounded-lg shadow-xl border border-slate-200 w-full max-w-4xl" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-slate-200 bg-[#FAFBFC] flex justify-between items-start">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Create Test Case</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              In folder: <span className="font-medium">{folderName || folderPath || 'Test Repository'}</span>
            </p>
          </div>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl leading-none">&times;</button>
        </div>

        <form onSubmit={handleSubmit} className="px-5 py-5 space-y-5">
          {/* Summary + Type row */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1">Summary <span className="text-red-500">*</span></label>
              <input type="text" value={summary} onChange={e => setSummary(e.target.value)}
                placeholder="One-line description of what this test verifies"
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0052CC]/40 focus:border-[#0052CC]" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Test Type</label>
              <select value={testType} onChange={e => setTestType(e.target.value)}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#0052CC]/40 focus:border-[#0052CC]">
                <option>Manual</option>
                <option>Automated</option>
                <option>BDD/Cucumber</option>
              </select>
            </div>
          </div>

          {/* Description */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Description</label>
            <textarea value={description} onChange={e => setDescription(e.target.value)} rows={2}
              placeholder="Optional description or preconditions"
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-[#0052CC]/40 focus:border-[#0052CC]" />
          </div>

          {/* Steps */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-semibold text-slate-700">Test Steps</label>
              <button type="button" onClick={addStep}
                className="text-xs text-[#0052CC] hover:underline font-medium flex items-center gap-1">
                <span className="text-base leading-none">+</span> Add Step
              </button>
            </div>
            <div className="rounded border border-slate-200 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs font-semibold text-slate-600">
                  <tr>
                    <th className="px-2 py-2 w-8">#</th>
                    <th className="px-3 py-2">Action</th>
                    <th className="px-3 py-2">Data</th>
                    <th className="px-3 py-2">Test Steps</th>
                    <th className="px-3 py-2">Expected Result</th>
                    <th className="px-2 py-2 w-8"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {steps.map((st, idx) => (
                    <tr key={idx} className="align-top">
                      <td className="px-2 py-2 text-slate-400 tabular-nums text-center">{idx + 1}</td>
                      {['action', 'data', 'testSteps', 'result'].map(field => (
                        <td key={field} className="px-1 py-1">
                          <textarea value={st[field]} onChange={e => updateStep(idx, field, e.target.value)}
                            rows={2} placeholder="—"
                            className="w-full rounded border border-slate-200 px-2 py-1 text-xs resize-none focus:outline-none focus:ring-1 focus:ring-[#0052CC]/40" />
                        </td>
                      ))}
                      <td className="px-2 py-2 text-center">
                        {steps.length > 1 && (
                          <button type="button" onClick={() => removeStep(idx)}
                            className="text-slate-300 hover:text-red-500 text-base leading-none">&times;</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <div className="flex justify-end gap-2 pt-1 border-t border-slate-100">
            <button type="button" onClick={onClose}
              className="px-4 py-2 rounded-md border border-slate-300 text-sm text-slate-700 hover:bg-slate-50">Cancel</button>
            <button type="submit" disabled={saving}
              className="px-4 py-2 rounded-md bg-[#0052CC] text-white text-sm font-medium hover:bg-[#0747A6] disabled:opacity-60">
              {saving ? 'Creating…' : 'Create Test Case'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Delete Confirm Modal ────────────────────────────────────────────────────

function DeleteConfirmModal({ open, type, name, onClose, onConfirm, deleting }) {
  useEffect(() => {
    if (!open) return;
    const h = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl border border-slate-200 w-full max-w-sm" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-slate-200 bg-[#FAFBFC]">
          <h2 className="text-base font-semibold text-slate-900">Delete {type === 'folder' ? 'Folder' : 'Test Case'}</h2>
        </div>
        <div className="px-5 py-4">
          <p className="text-sm text-slate-700">
            Are you sure you want to delete <span className="font-semibold">"{name}"</span>?
          </p>
          {type === 'folder' && (
            <p className="text-xs text-slate-500 mt-1">This will also delete all local test cases created in this folder.</p>
          )}
        </div>
        <div className="flex justify-end gap-2 px-5 pb-4">
          <button type="button" onClick={onClose}
            className="px-4 py-2 rounded-md border border-slate-300 text-sm text-slate-700 hover:bg-slate-50">Cancel</button>
          <button type="button" onClick={onConfirm} disabled={deleting}
            className="px-4 py-2 rounded-md bg-red-600 text-white text-sm font-medium hover:bg-red-700 disabled:opacity-60">
            {deleting ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Test Detail helpers ─────────────────────────────────────────────────────

function jiraDescriptionToText(desc) {
  if (desc == null || desc === '') return null;
  if (typeof desc === 'string') return desc.trim() || null;
  if (typeof desc === 'object' && desc.type === 'doc' && Array.isArray(desc.content)) {
    const walk = nodes => {
      if (!Array.isArray(nodes)) return '';
      return nodes.map(n => {
        if (n.type === 'text' && n.text) return n.text;
        if (n.content) return `${walk(n.content)}\n`;
        return '';
      }).join('').trim();
    };
    return walk(desc.content) || null;
  }
  return null;
}

function MetaRow({ label, value }) {
  if (value == null || value === '') return null;
  return (
    <div className="py-2 border-b border-slate-100 last:border-0 text-sm">
      <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">{label}</p>
      <p className="text-slate-800 mt-0.5 break-words">{String(value)}</p>
    </div>
  );
}

function SidebarRow({ label, value }) {
  const empty = value == null || value === '' || (Array.isArray(value) && !value.length);
  return (
    <div className="py-2 border-b border-slate-100 last:border-0 text-sm">
      <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">{label}</p>
      <p className={`mt-0.5 break-words ${empty ? 'text-slate-400' : 'text-slate-800'}`}>{empty ? 'None' : String(value)}</p>
    </div>
  );
}

function formatJiraExtraValue(v) {
  if (v == null) return 'None';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(x => formatJiraExtraValue(x)).join(', ') || 'None';
  if (typeof v === 'object') { if (v.name != null) return String(v.name); try { return JSON.stringify(v); } catch { return String(v); } }
  return String(v);
}

// ─── Test Detail Modal ───────────────────────────────────────────────────────

function TestDetailModal({ open, onClose, issueId, jiraKey, initialData, jiraBrowseBaseUrl }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) { setDetail(null); setError(null); return; }

    // Local test: show directly without API call
    if (initialData?._local) {
      setDetail({
        ...initialData,
        steps: Array.isArray(initialData.steps) ? initialData.steps.map((s, i) => ({ ...s, stepNumber: i + 1 })) : [],
        hideJiraSidebar: true,
        source: 'local',
      });
      setLoading(false);
      return;
    }

    const params = {};
    if (issueId) params.issueId = issueId;
    else if (jiraKey) params.key = jiraKey;
    else { setError('This row has no issue id or key — re-run import to refresh.'); return; }

    let cancelled = false;
    (async () => {
      setLoading(true); setError(null);
      try {
        const { data: d } = await getTestRepositoryTestDetail(params);
        if (!cancelled) setDetail(d);
      } catch (e) {
        if (!cancelled) setError(e.response?.data?.error || e.message || 'Failed to load test');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, issueId, jiraKey, initialData]);

  useEffect(() => {
    if (!open) return;
    const h = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);

  if (!open) return null;

  const display = detail ?? initialData ?? {};
  const displayKey = display.jiraKey || jiraKey || '…';
  const isLocal = !!display._local;

  const browse = !isLocal && jiraBrowseBaseUrl && displayKey && displayKey !== '…'
    ? `${String(jiraBrowseBaseUrl).replace(/\/+$/, '')}/browse/${encodeURIComponent(displayKey)}`
    : null;

  const descText = detail ? jiraDescriptionToText(detail.description) : null;
  const folderBreadcrumb =
    detail?.folder?.path != null
      ? ['Test Repository', ...String(detail.folder.path).split('/').filter(Boolean)].join(' / ')
      : initialData?.folderPath
      ? ['Test Repository', ...String(initialData.folderPath).split('/').filter(Boolean)].join(' / ')
      : null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/45 p-4 sm:p-6" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby="test-detail-title"
        className="relative my-6 w-full max-w-5xl rounded-lg border border-slate-200 bg-white shadow-2xl"
        onClick={e => e.stopPropagation()}>
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 px-5 py-4 bg-[#FAFBFC]">
          <div className="min-w-0">
            {isLocal ? (
              <p className="text-xs font-bold text-emerald-600 flex items-center gap-1">
                <span className="bg-emerald-100 px-1.5 py-0.5 rounded">LOCAL TEST CASE</span>
              </p>
            ) : (
              <p className="font-mono text-sm font-bold text-[#0052CC]">{displayKey}</p>
            )}
            <h2 id="test-detail-title" className="text-lg font-semibold text-slate-900 mt-1 leading-snug">
              {display.summary || '—'}
            </h2>
            {(display.testType || display.status) && (
              <p className="text-sm flex flex-wrap items-center gap-2 mt-1">
                {display.testType && <Badge tone="primary">{String(display.testType)}</Badge>}
                {display.status && <Badge tone="muted">{String(display.status)}</Badge>}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {browse && (
              <a href={browse} target="_blank" rel="noreferrer"
                className="text-sm text-[#0052CC] font-medium hover:underline">Open in Jira ↗</a>
            )}
            <button type="button" onClick={onClose}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50">
              Close
            </button>
          </div>
        </header>

        <div className="max-h-[calc(100vh-8rem)] overflow-y-auto">
          {error && <p className="p-6 text-sm text-red-600 whitespace-pre-wrap" role="alert">{error}</p>}
          {!error && loading && !detail && (
            <div className="p-5 space-y-4">
              {folderBreadcrumb && <nav className="text-xs text-slate-500">{folderBreadcrumb}</nav>}
              <p className="text-sm text-slate-400 animate-pulse">Loading steps…</p>
            </div>
          )}
          {!error && detail && (
            <div className={`grid grid-cols-1 gap-0 ${detail.hideJiraSidebar === false ? 'lg:grid-cols-3' : ''}`}>
              <div className={`p-5 space-y-5 border-b border-slate-100 ${detail.hideJiraSidebar === false ? 'lg:col-span-2 lg:border-r' : ''}`}>
                {detail.partial && (
                  <p className="text-sm rounded-md border border-amber-200 bg-amber-50 text-amber-900 px-3 py-2">
                    Summary-only view — steps not cached yet.
                  </p>
                )}
                {folderBreadcrumb && <nav className="text-xs text-slate-500">{folderBreadcrumb}</nav>}
                {(detail.testType || detail.status || detail.xrayTestStatus) && (
                  <p className="text-sm flex flex-wrap items-center gap-2">
                    {detail.testType && <><span className="font-semibold text-slate-600">Test type:</span><Badge tone="primary">{String(detail.testType)}</Badge></>}
                    {detail.status && <Badge tone="muted">Jira: {String(detail.status)}</Badge>}
                    {detail.xrayTestStatus && <Badge tone="neutral">Xray status: {String(detail.xrayTestStatus)}</Badge>}
                  </p>
                )}
                {descText && (
                  <section>
                    <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-2">Description</h3>
                    <p className="text-sm text-slate-800 whitespace-pre-wrap">{descText}</p>
                  </section>
                )}
                <section>
                  <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-3">Test details — Steps</h3>
                  {detail.steps?.length > 0 ? (
                    <div className="overflow-x-auto rounded border border-slate-200">
                      <table className="w-full text-sm">
                        <thead className="bg-slate-50 text-left text-xs font-semibold text-slate-600">
                          <tr>
                            <th className="px-3 py-2 w-10">#</th>
                            <th className="px-3 py-2">Action</th>
                            <th className="px-3 py-2">Data</th>
                            <th className="px-3 py-2 min-w-[200px]">Test steps</th>
                            <th className="px-3 py-2">Expected result</th>
                            <th className="px-3 py-2">Comments</th>
                            <th className="px-3 py-2">Attachments</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {detail.steps.map(s => {
                            const atts = Array.isArray(s.attachments) ? s.attachments : [];
                            const attLabel = atts.length === 0 ? '(0)' : `(${atts.length}) ${atts.map(a => a.filename || a.id || '?').join(', ')}`;
                            const callRef = s.calledTestIssueId || s.libStepId;
                            return (
                              <tr key={s.id || s.stepNumber}>
                                <td className="px-3 py-2 text-slate-500 tabular-nums align-top">{s.stepNumber}</td>
                                <td className="px-3 py-2 text-slate-800 align-top whitespace-pre-wrap">
                                  {s.action || '—'}
                                  {callRef && <p className="mt-1 text-xs text-slate-500">Call / lib: {String(callRef)}{s.parentTestIssueId ? ` · parent ${s.parentTestIssueId}` : ''}</p>}
                                </td>
                                <td className="px-3 py-2 text-slate-700 align-top whitespace-pre-wrap">{s.data || '—'}</td>
                                <td className="px-3 py-2 text-slate-700 align-top whitespace-pre-wrap text-sm">{s.testSteps ? s.testSteps : '—'}</td>
                                <td className="px-3 py-2 text-slate-700 align-top whitespace-pre-wrap">{s.result ?? s.expectedResult ?? '—'}</td>
                                <td className="px-3 py-2 text-slate-600 align-top whitespace-pre-wrap text-sm">{s.comment != null && s.comment !== '' ? s.comment : 'None'}</td>
                                <td className="px-3 py-2 text-slate-600 align-top text-sm tabular-nums">{attLabel}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="text-sm text-slate-500">No structured steps for this test.</p>
                  )}
                </section>
                {detail.warnings?.length > 0 && (
                  <section className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                    <p className="font-semibold">Warnings</p>
                    <ul className="list-disc pl-5 mt-1 space-y-1">
                      {detail.warnings.map((w, i) => <li key={i}>{typeof w === 'string' ? w : JSON.stringify(w)}</li>)}
                    </ul>
                  </section>
                )}
              </div>
              {detail.hideJiraSidebar === false && (
                <aside className="p-5 bg-slate-50/80 lg:bg-white lg:border-l border-slate-100">
                  <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-2">Details</h3>
                  <SidebarRow label="Status" value={detail.status} />
                  <SidebarRow label="Assignee" value={detail.assignee} />
                  <SidebarRow label="Reporter" value={detail.reporter} />
                  <SidebarRow label="Labels" value={detail.labels} />
                  <SidebarRow label="Priority" value={detail.priority} />
                  <SidebarRow label="Test status" value={detail.xrayTestStatus} />
                  <SidebarRow label="Issue type" value={detail.issueType} />
                  <SidebarRow label="Components" value={detail.components} />
                  <SidebarRow label="Fix versions" value={detail.fixVersions} />
                  <SidebarRow label="Creator" value={detail.creator} />
                  <SidebarRow label="Created" value={detail.created} />
                  <SidebarRow label="Updated" value={detail.updated} />
                  {detail.jiraExtras && typeof detail.jiraExtras === 'object' && (
                    <div className="pt-2 mt-2 border-t border-slate-200">
                      <p className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-2">Additional Jira fields</p>
                      {Object.entries(detail.jiraExtras).map(([k, v]) => (
                        <SidebarRow key={k} label={k} value={formatJiraExtraValue(v)} />
                      ))}
                    </div>
                  )}
                </aside>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ───────────────────────────────────────────────────────────────

export default function TestRepository() {
  // Xray snapshot data
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [loading, setLoading] = useState(true);

  // Local (user-created) folders and tests
  const [localFolders, setLocalFolders] = useState([]);
  const [localTests, setLocalTests] = useState([]);

  // UI state
  const [selectedFolderId, setSelectedFolderId] = useState('');
  const [testSearch, setTestSearch] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [expanded, setExpanded] = useState(() => new Set());
  const [detailTarget, setDetailTarget] = useState(null);
  const testListRef = useRef(null);

  // Modal state
  const [createFolderModal, setCreateFolderModal] = useState(null); // { parentPath, parentName }
  const [createTestModal, setCreateTestModal] = useState(null);     // { folderPath, folderName }
  const [deleteConfirm, setDeleteConfirm] = useState(null);         // { type, id, name }
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState('');

  // ── load data ──

  const loadLocalData = useCallback(async () => {
    try {
      const { data: d } = await getLocalRepoData();
      setLocalFolders(d.folders || []);
      setLocalTests(d.tests || []);
    } catch { /* non-fatal */ }
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true); setLoadError(null);
    try {
      const [{ data: doc }] = await Promise.all([getTestRepositoryData(), loadLocalData()]);
      setData(doc);
    } catch (e) {
      if (e.response?.status === 404) setData(null);
      else setLoadError(e.response?.data?.error || e.message || 'Failed to load Test Repository');
    } finally {
      setLoading(false);
    }
  }, [loadLocalData]);

  useEffect(() => { loadData(); }, [loadData]);

  // Auto-select first folder
  useEffect(() => {
    if (!data?.folders?.length) return;
    setSelectedFolderId(prev => {
      if (prev && data.folders.some(f => String(f.id) === String(prev))) return prev;
      return String(data.folders[0].id);
    });
  }, [data]);

  // Auto-expand root
  useEffect(() => {
    if (!data?.folderTreeRoot) return;
    const rootId = folderKey(data.folderTreeRoot);
    setExpanded(prev => prev.size > 0 ? prev : new Set([rootId]));
  }, [data]);

  const toggleExpand = useCallback(id => {
    setExpanded(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }, []);

  // ── merged tree + tests ──

  const localFolderMap = useMemo(() => buildLocalFolderMap(localFolders), [localFolders]);

  const mergedTree = useMemo(() => {
    if (!data?.folderTreeRoot) return null;
    return mergeLocalFoldersIntoTree(data.folderTreeRoot, localFolderMap);
  }, [data?.folderTreeRoot, localFolderMap]);

  // count local tests per folder path for tree badges (normalized so they match node.path)
  const localTestsByFolderPath = useMemo(() => {
    const map = {};
    for (const lt of localTests) {
      const fp = normPath(lt.folderPath || '/');
      map[fp] = (map[fp] || 0) + 1;
    }
    return map;
  }, [localTests]);

  const allTests = useMemo(() => [
    ...(data?.tests || []),
    ...localTests.map(lt => ({ ...lt, issueId: lt._id, jiraKey: null })),
  ], [data?.tests, localTests]);

  // ── selected folder path (for test creation) ──

  const getSelectedFolderPath = useCallback(() => {
    const meta = data?.folders?.find(f => String(f.id) === String(selectedFolderId));
    return meta?.path || String(selectedFolderId);
  }, [data?.folders, selectedFolderId]);

  const getSelectedFolderName = useCallback(() => {
    const meta = data?.folders?.find(f => String(f.id) === String(selectedFolderId));
    if (meta?.name) return meta.name;
    // local folder: find by path = selectedFolderId
    const lf = localFolders.find(f => f.path === selectedFolderId);
    return lf?.name || selectedFolderId;
  }, [data?.folders, selectedFolderId, localFolders]);

  // ── actions ──

  const handleCreateSubfolder = useCallback(node => {
    setActionError('');
    setCreateFolderModal({ parentPath: node.path || '', parentName: node.name });
  }, []);

  const handleAddTest = useCallback(node => {
    setActionError('');
    setCreateTestModal({ folderPath: node.path || getSelectedFolderPath(), folderName: node.name });
  }, [getSelectedFolderPath]);

  const handleDeleteFolder = useCallback(node => {
    setActionError('');
    setDeleteConfirm({ type: 'folder', id: node._localId || node.id, name: node.name });
  }, []);

  const handleDeleteTest = useCallback(t => {
    setActionError('');
    setDeleteConfirm({ type: 'test', id: t._id, name: t.summary });
  }, []);

  const handleFolderCreated = useCallback(folder => {
    setLocalFolders(prev => [...prev, folder]);
    setCreateFolderModal(null);
    // Auto-expand parent so new folder is visible
    const parentId = normPath(folder.parentPath) || folderKey(data?.folderTreeRoot);
    setExpanded(prev => { const n = new Set(prev); n.add(parentId || ''); n.add(folder.path); return n; });
    setSelectedFolderId(folder.path);
  }, [data?.folderTreeRoot]);

  const handleTestCreated = useCallback(test => {
    setLocalTests(prev => [...prev, test]);
    setCreateTestModal(null);
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteConfirm) return;
    setDeleting(true); setActionError('');
    try {
      if (deleteConfirm.type === 'folder') {
        await deleteLocalFolder(deleteConfirm.id);
        setLocalFolders(prev => prev.filter(f => f._id !== deleteConfirm.id && !f.path.startsWith(deleteConfirm.id)));
        setLocalTests(prev => {
          const deletedFolder = localFolders.find(f => f._id === deleteConfirm.id);
          if (!deletedFolder) return prev;
          const re = new RegExp(`^${deletedFolder.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(/|$)`);
          return prev.filter(t => !re.test(t.folderPath));
        });
        if (selectedFolderId === deleteConfirm.id || localFolders.find(f => f._id === deleteConfirm.id)?.path === selectedFolderId) {
          setSelectedFolderId(data?.folders?.[0] ? String(data.folders[0].id) : '');
        }
      } else {
        await deleteLocalTest(deleteConfirm.id);
        setLocalTests(prev => prev.filter(t => t._id !== deleteConfirm.id));
      }
      setDeleteConfirm(null);
    } catch (err) {
      setActionError(err.response?.data?.error || err.message || 'Delete failed');
    } finally {
      setDeleting(false);
    }
  }, [deleteConfirm, localFolders, selectedFolderId, data?.folders]);

  // ── test list ──

  const openTestDetail = useCallback(t => {
    setDetailTarget({
      issueId: t.issueId ? String(t.issueId) : undefined,
      jiraKey: t.jiraKey ? String(t.jiraKey) : undefined,
      summary: t.summary, testType: t.testType, status: t.status,
      folderPath: t.folderPath ?? t.folderId,
      _local: t._local || false,
      steps: t.steps,
      description: t.description,
    });
  }, []);

  const selectedFolderMeta = useMemo(() => {
    const xrayMeta = data?.folders?.find(f => String(f.id) === String(selectedFolderId));
    if (xrayMeta) return xrayMeta;
    const lf = localFolders.find(f => f.path === selectedFolderId);
    return lf ? { id: lf.path, path: lf.path, name: lf.name } : null;
  }, [data?.folders, selectedFolderId, localFolders]);

  const testsRaw = useMemo(
    () => allTests.filter(t => testBelongsToSelectedFolder(t, selectedFolderId)),
    [allTests, selectedFolderId]
  );

  const testsFiltered = useMemo(() => {
    const q = testSearch.trim().toLowerCase();
    if (!q) return testsRaw;
    return testsRaw.filter(t =>
      String(t.jiraKey || '').toLowerCase().includes(q) ||
      String(t.summary || '').toLowerCase().includes(q)
    );
  }, [testsRaw, testSearch]);

  useEffect(() => {
    setCurrentPage(1);
    if (testListRef.current) testListRef.current.scrollTop = 0;
  }, [selectedFolderId, testSearch, pageSize]);

  useEffect(() => { if (testListRef.current) testListRef.current.scrollTop = 0; }, [currentPage]);

  const totalPages = useMemo(() => Math.max(1, Math.ceil(testsFiltered.length / pageSize)), [testsFiltered.length, pageSize]);
  const testsVisible = useMemo(() => testsFiltered.slice((currentPage - 1) * pageSize, currentPage * pageSize), [testsFiltered, currentPage, pageSize]);
  const pageOptions = useMemo(() => Array.from({ length: totalPages }, (_, i) => i + 1), [totalPages]);

  const titleProject = data?.projectName || data?.projectKey || 'QA Projects';
  const crumbs = useMemo(() => breadcrumbFromPath(selectedFolderMeta?.path, titleProject), [selectedFolderMeta?.path, titleProject]);
  const jiraBase = (data?.jiraBrowseBaseUrl || '').replace(/\/+$/, '');
  const jiraTestRepoUrl = jiraBase && data?.projectKey
    ? `${jiraBase}/projects/${encodeURIComponent(data.projectKey)}?selectedItem=com.atlassian.plugins.atlassian-connect-plugin%3Acom.xpandit.plugins.xray__testing-board`
    : null;

  const rootFolderPath = useMemo(() => normPath(data?.folderTreeRoot?.path), [data?.folderTreeRoot]);

  // ── render ──

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div>
          <p className="text-xs text-slate-500 uppercase tracking-wide font-semibold">
            Projects / {data?.projectKey || '…'} / Test Repository
          </p>
          <h1 className="text-xl sm:text-2xl font-bold text-slate-900 mt-1">
            Test Repository{data ? ` for project ${titleProject}` : ''}
          </h1>
          {data?.importedAt && (
            <p className="text-xs text-slate-400 mt-1">
              Last import {new Date(data.importedAt).toLocaleString()} · {data.apiKind}
              {data.projectResolveVia && ` · ${data.projectResolveVia}`}
              {data.importRootPath && data.importRootPath !== '/' && <> · folder {data.importRootPath}</>}
            </p>
          )}
        </div>
        {data?.projectKey && jiraTestRepoUrl && (
          <a href={jiraTestRepoUrl} target="_blank" rel="noreferrer"
            className="text-sm text-sky-700 hover:underline whitespace-nowrap">Open in Jira ↗</a>
        )}
      </div>

      {actionError && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">{actionError}
          <button className="ml-2 text-red-400 hover:text-red-600" onClick={() => setActionError('')}>×</button>
        </p>
      )}

      {loading && <p className="text-sm text-slate-500">Loading…</p>}
      {loadError && <p className="text-sm text-red-600">{loadError}</p>}

      {!loading && !data && !loadError && (
        <div className="rounded-lg border-2 border-dashed border-slate-200 p-10 text-center text-slate-600 text-sm bg-slate-50/50">
          <p className="font-medium text-slate-800 mb-1">No Test Repository data found</p>
          <p>The repository snapshot could not be loaded. Check that MongoDB is connected and the snapshot exists.</p>
        </div>
      )}

      {data && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-0 rounded-lg border border-slate-200 bg-[#FAFBFC] shadow-sm overflow-hidden min-h-[520px]">

          {/* ── Folder Sidebar ── */}
          <aside className="lg:col-span-4 border-b lg:border-b-0 lg:border-r border-slate-200 bg-white flex flex-col max-h-[75vh] lg:max-h-[80vh]">
            <div className="flex border-b border-slate-200 bg-[#FAFBFC]">
              <span className="flex-1 text-center text-[11px] font-bold text-[#0052CC] py-2.5 border-b-2 border-[#0052CC] tracking-wide">FOLDERS</span>
              <span className="flex-1 text-center text-[11px] font-semibold text-slate-400 py-2.5 cursor-not-allowed tracking-wide">TEST SETS</span>
            </div>

            {/* New root folder button */}
            <div className="px-3 pt-2 pb-1 border-b border-slate-100">
              <button type="button"
                onClick={() => setCreateFolderModal({ parentPath: rootFolderPath, parentName: 'Test Repository (root)' })}
                className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md border border-dashed border-slate-300 text-xs text-slate-500 hover:border-[#0052CC] hover:text-[#0052CC] hover:bg-blue-50 transition-colors">
                <span className="text-base leading-none font-bold">+</span> New Folder
              </button>
            </div>

            <div className="p-3 overflow-y-auto flex-1 text-sm">
              {mergedTree ? (
                <FolderTreeNode
                  node={mergedTree}
                  selectedId={selectedFolderId}
                  onSelect={setSelectedFolderId}
                  expanded={expanded}
                  toggleExpand={toggleExpand}
                  onCreateSubfolder={handleCreateSubfolder}
                  onAddTest={handleAddTest}
                  onDeleteFolder={handleDeleteFolder}
                  localTestsByFolderPath={localTestsByFolderPath}
                />
              ) : (
                <ul className="space-y-1">
                  {data.folders?.map(f => (
                    <li key={f.id}>
                      <button type="button" onClick={() => setSelectedFolderId(String(f.id))}
                        className={`w-full text-left px-2 py-1.5 rounded-r-md text-sm truncate border-l-[3px] ${
                          selectedFolderId === String(f.id)
                            ? 'border-[#0052CC] bg-[#DEEBFF] font-medium text-[#172B4D]'
                            : 'border-transparent hover:bg-slate-50'
                        }`}>
                        {f.path} <span className="text-slate-400">({f.testsCount ?? 0})</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </aside>

          {/* ── Test List ── */}
          <section className="lg:col-span-8 flex flex-col max-h-[75vh] lg:max-h-[80vh]">
            <div className="px-4 py-3 border-b border-slate-100 bg-white space-y-2">
              <nav className="text-xs text-slate-500 flex flex-wrap items-center gap-x-1 gap-y-0.5">
                {crumbs.map((c, i) => (
                  <span key={c.path ?? `p-${i}`} className="flex items-center gap-1">
                    {i > 0 && <span className="text-slate-300">/</span>}
                    <span className={i === crumbs.length - 1 ? 'text-slate-800 font-medium' : ''}>{c.label}</span>
                  </span>
                ))}
              </nav>
              <div className="flex flex-wrap gap-2 items-center">
                <input type="search" placeholder="Search tests in this folder…"
                  value={testSearch} onChange={e => setTestSearch(e.target.value)}
                  className="flex-1 min-w-[180px] rounded-md border border-slate-300 px-3 py-2 text-sm" />
                <button type="button"
                  onClick={() => setCreateTestModal({ folderPath: getSelectedFolderPath(), folderName: getSelectedFolderName() })}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-md bg-[#0052CC] text-white text-sm font-medium hover:bg-[#0747A6]">
                  <span className="text-base leading-none">+</span> New Test
                </button>
              </div>
              <p className="text-xs text-slate-500">
                Total Tests: <span className="font-semibold text-slate-700">{testsFiltered.length}</span>
                {testsRaw.length !== testsFiltered.length && <> &middot; {testsRaw.length} in folder</>}
                {selectedFolderId && selectedFolderId !== '/' && ' (includes subfolders)'}
              </p>
            </div>

            <div ref={testListRef} className="overflow-y-auto flex-1">
              {testsVisible.length === 0 ? (
                <div className="p-10 text-center text-slate-500 text-sm">
                  No tests in this folder{testSearch ? ' matching search' : ''}.
                </div>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {testsVisible.map((t, idx) => (
                    <li key={`${t.jiraKey || t._id || idx}-${t.folderId || idx}`}
                      className={t._local ? 'border-l-2 border-emerald-300' : ''}>
                      <div className="w-full text-left px-4 py-3 hover:bg-slate-50/80 flex gap-3 items-start transition-colors">
                        <button type="button" onClick={() => openTestDetail(t)}
                          className="flex gap-3 items-start flex-1 min-w-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0052CC]/40">
                          <span className={`mt-0.5 flex-shrink-0 w-7 h-7 rounded text-white text-[10px] font-bold flex items-center justify-center ${t._local ? 'bg-emerald-500' : 'bg-[#0052CC]'}`}
                            title={t._local ? 'Local Test' : 'Test'} aria-hidden>
                            {t._local ? '✎' : '='}
                          </span>
                          <div className="flex-1 min-w-0">
                            <div className="flex flex-wrap items-center gap-2 gap-y-1">
                              {t.jiraKey ? (
                                <span className="font-mono text-sm font-semibold text-[#0052CC]">{t.jiraKey}</span>
                              ) : (
                                <Badge tone="green">LOCAL</Badge>
                              )}
                              {t.testType && <Badge tone="primary">{String(t.testType)}</Badge>}
                              {t.status && <Badge tone="muted">{String(t.status)}</Badge>}
                            </div>
                            <p className="text-sm text-slate-800 mt-1 leading-snug">{t.summary || '—'}</p>
                            <p className="text-[11px] text-slate-400 mt-1">Click to view full test details</p>
                          </div>
                        </button>
                        {/* Delete button for local tests */}
                        {t._local && (
                          <button type="button" onClick={() => handleDeleteTest(t)} title="Delete local test"
                            className="flex-shrink-0 mt-1 w-7 h-7 rounded flex items-center justify-center text-slate-300 hover:text-red-500 hover:bg-red-50">
                            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                              <path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/>
                              <path fillRule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1 0-2h3.5l1-1h3l1 1h3.5a1 1 0 0 1 1 1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118z"/>
                            </svg>
                          </button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {testsFiltered.length > 0 && (
                <div className="px-4 py-3 border-t border-slate-100 bg-white flex flex-wrap items-center justify-between gap-3 text-sm text-slate-600">
                  <span className="font-medium text-slate-700">Total Tests : {testsFiltered.length}</span>
                  <div className="flex flex-wrap items-center gap-4">
                    <span className="text-slate-500">Showing {currentPage} of {totalPages} Page</span>
                    <label className="flex items-center gap-1.5 text-slate-500">
                      Showing :
                      <select value={pageSize} onChange={e => setPageSize(Number(e.target.value))}
                        className="rounded border border-slate-300 px-2 py-1 text-sm text-slate-700 bg-white focus:outline-none focus:ring-1 focus:ring-[#0052CC]">
                        {[50, 100, 150, 200].map(n => <option key={n} value={n}>{n}</option>)}
                      </select>
                      Rows
                    </label>
                    <label className="flex items-center gap-1.5 text-slate-500">
                      Go to :
                      <select value={currentPage} onChange={e => setCurrentPage(Number(e.target.value))}
                        className="rounded border border-slate-300 px-2 py-1 text-sm text-slate-700 bg-white focus:outline-none focus:ring-1 focus:ring-[#0052CC]">
                        {pageOptions.map(p => <option key={p} value={p}>{p}</option>)}
                      </select>
                    </label>
                  </div>
                </div>
              )}
            </div>
          </section>
        </div>
      )}

      {/* ── Modals ── */}
      <CreateFolderModal
        open={!!createFolderModal}
        parentPath={createFolderModal?.parentPath}
        parentName={createFolderModal?.parentName}
        onClose={() => setCreateFolderModal(null)}
        onCreated={handleFolderCreated}
      />
      <CreateTestModal
        open={!!createTestModal}
        folderPath={createTestModal?.folderPath}
        folderName={createTestModal?.folderName}
        onClose={() => setCreateTestModal(null)}
        onCreated={handleTestCreated}
      />
      <DeleteConfirmModal
        open={!!deleteConfirm}
        type={deleteConfirm?.type}
        name={deleteConfirm?.name}
        onClose={() => { setDeleteConfirm(null); setActionError(''); }}
        onConfirm={handleConfirmDelete}
        deleting={deleting}
      />
      <TestDetailModal
        open={detailTarget != null}
        onClose={() => setDetailTarget(null)}
        issueId={detailTarget?.issueId}
        jiraKey={detailTarget?.jiraKey}
        initialData={detailTarget}
        jiraBrowseBaseUrl={data?.jiraBrowseBaseUrl}
      />
    </div>
  );
}
