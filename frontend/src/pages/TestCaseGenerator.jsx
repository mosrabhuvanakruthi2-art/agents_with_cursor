import { useState, useEffect, useCallback } from 'react';
import {
  getCustomTestCases,
  addCustomTestCase,
  deleteCustomTestCase,
} from '../services/api';
import { useToast } from '../context/ToastContext';
import { MESSAGE_MIGRATION_COMBINATIONS } from '../constants/messageCombinations';

const PRODUCT_TYPES = ['Mail', 'Message', 'Content'];

const PRODUCT_COMBOS = {
  Mail:    ['Gmail → Outlook', 'Gmail → Gmail', 'Outlook → Outlook', 'Outlook → Gmail'],
  Message: MESSAGE_MIGRATION_COMBINATIONS,
  Content: [],
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

const TH = 'px-4 py-3 text-left text-sm font-semibold text-black bg-[#eef1fb] border-b border-r border-[#c5cef5] whitespace-nowrap sticky top-0 z-10';
const TD = 'px-4 py-3 text-sm text-black border-b border-r border-[#c5cef5] align-top';

const EMPTY_FORM = {
  productType:  'Message',
  combination:  MESSAGE_MIGRATION_COMBINATIONS[0] || '',
  customCombo:  '',
  folder:       '',
  summary:      '',
  testData:     '',
  messageCount: '',
};

export default function TestCaseGenerator() {
  const toast = useToast();

  const [form, setForm]         = useState(EMPTY_FORM);
  const [saving, setSaving]     = useState(false);
  const [savedCases, setSavedCases] = useState([]);
  const [deletingId, setDeletingId] = useState(null);

  const combos        = PRODUCT_COMBOS[form.productType] || [];
  const isContent     = form.productType === 'Content';
  const folderOptions = form.productType === 'Message' ? MESSAGE_FOLDER_OPTIONS : MAIL_FOLDER_OPTIONS;
  const effectiveCombo = isContent ? form.customCombo : form.combination;

  function setField(key) {
    return (e) => setForm(p => ({ ...p, [key]: e.target.value }));
  }

  function handleProductChange(pt) {
    const combos = PRODUCT_COMBOS[pt] || [];
    setForm(p => ({
      ...p,
      productType: pt,
      combination: combos[0] || '',
      customCombo: '',
      folder: '',
    }));
  }

  const loadSaved = useCallback(async () => {
    try {
      const { data } = await getCustomTestCases();
      setSavedCases(Array.isArray(data.scenarios) ? data.scenarios : []);
    } catch { /* non-fatal */ }
  }, []);

  useEffect(() => { loadSaved(); }, [loadSaved]);

  async function handleSave(e) {
    e.preventDefault();
    const summary = form.summary.trim();
    const testData = form.testData.trim();
    if (!summary || !effectiveCombo.trim()) {
      toast.warning('Missing fields', 'Summary and Migration Combination are required.');
      return;
    }
    setSaving(true);
    try {
      const tc = {
        summary,
        testData,
        productType: form.productType,
        combination: effectiveCombo,
        folder:      form.folder || '',
        messageCount: form.messageCount ? parseInt(form.messageCount, 10) || 0 : 0,
      };
      await addCustomTestCase(tc);
      setForm(p => ({ ...p, summary: '', testData: '', messageCount: '' }));
      await loadSaved();
      toast.success('Scenario saved', `"${summary}" added to library.`);
    } catch (err) {
      toast.error('Failed to save', err.response?.data?.error || err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id) {
    setDeletingId(id);
    try {
      await deleteCustomTestCase(id);
      loadSaved();
      toast.info('Scenario removed');
    } catch (err) {
      toast.error('Failed to remove', err.response?.data?.error || err.message);
    } finally {
      setDeletingId(null);
    }
  }

  const canSave = form.summary.trim() && effectiveCombo.trim();

  return (
    <div className="page-wrap">
      {/* ── Page Header ── */}
      <div style={{ borderRadius: 16, overflow: 'hidden', background: 'linear-gradient(135deg, #020c6b 0%, #0129ac 60%, #1845d4 100%)', boxShadow: '0 6px 32px rgba(1,41,172,0.22)', marginBottom: 24 }}>
        <div style={{ padding: '24px 28px', display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.12)', border: '1.5px solid rgba(255,255,255,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>
            </svg>
          </div>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 800, color: '#fff', margin: 0 }}>Test Scenarios</h1>
            <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.65)', margin: '3px 0 0' }}>
              Create and manage test scenarios · Used in Message Agent to post test data into channels &amp; DMs
            </p>
          </div>
        </div>
      </div>

      {/* ── Add Scenario Form ── */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ padding: '18px 22px', backgroundColor: '#f8fafc', borderBottom: '1px solid #e4e9f5', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ width: 28, height: 28, borderRadius: '50%', backgroundColor: '#0129ac', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 800, flexShrink: 0 }}>+</span>
          <div>
            <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: '#0f172a' }}>Add Test Scenario</p>
            <p style={{ margin: '1px 0 0', fontSize: 12, color: '#6b7280' }}>Fill in the fields below and save to your scenario library</p>
          </div>
        </div>
        <form onSubmit={handleSave} style={{ padding: '22px 24px', display: 'flex', flexDirection: 'column', gap: 20 }}>

          {/* Row 1: Product Type + Combination + Folder */}
          <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr 1fr', gap: 20, alignItems: 'start' }}>

            {/* Product Type */}
            <div>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#0129ac', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Product Type
              </label>
              <div style={{ display: 'flex', gap: 8 }}>
                {PRODUCT_TYPES.map(p => (
                  <button key={p} type="button" onClick={() => handleProductChange(p)}
                    style={{
                      padding: '9px 20px', borderRadius: 9, fontSize: 13, fontWeight: 700, border: '2px solid', cursor: 'pointer',
                      borderColor: form.productType === p ? '#0129ac' : '#e5e7eb',
                      backgroundColor: form.productType === p ? '#0129ac' : '#fff',
                      color: form.productType === p ? '#fff' : '#374151',
                    }}>
                    {p}
                  </button>
                ))}
              </div>
            </div>

            {/* Migration Combination */}
            <div>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#0129ac', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Migration Combination
              </label>
              {isContent ? (
                <input type="text" value={form.customCombo} onChange={setField('customCombo')}
                  placeholder="e.g. SharePoint → Google Drive"
                  style={{ width: '100%', padding: '10px 14px', borderRadius: 8, border: '1.5px solid #e5e7eb', fontSize: 13, outline: 'none', boxSizing: 'border-box' }} />
              ) : (
                <select value={form.combination} onChange={setField('combination')}
                  style={{ width: '100%', padding: '10px 14px', borderRadius: 8, border: '1.5px solid #e5e7eb', fontSize: 13, outline: 'none', backgroundColor: '#fff', boxSizing: 'border-box' }}>
                  {combos.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              )}
            </div>

            {/* Folder / Feature */}
            <div>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#0129ac', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Folder / Feature
                <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 400, color: '#9ca3af' }}>(optional)</span>
              </label>
              <div style={{ display: 'flex', gap: 8 }}>
                <select value={folderOptions.includes(form.folder) ? form.folder : ''}
                  onChange={setField('folder')}
                  style={{ flex: 1, padding: '10px 14px', borderRadius: 8, border: '1.5px solid #e5e7eb', fontSize: 13, outline: 'none', backgroundColor: '#fff' }}>
                  <option value="">— none —</option>
                  {folderOptions.map(f => <option key={f} value={f}>{f}</option>)}
                </select>
                {form.folder && (
                  <button type="button" onClick={() => setForm(p => ({ ...p, folder: '' }))}
                    style={{ padding: '8px 12px', borderRadius: 8, border: '1.5px solid #e5e7eb', color: '#6b7280', backgroundColor: '#fff', cursor: 'pointer', fontSize: 13 }}>✕</button>
                )}
              </div>
            </div>
          </div>

          {/* Row 2: Summary + Message Count */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 20, alignItems: 'start' }}>
            <div>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#0129ac', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Summary
                <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 400, color: '#dc2626', textTransform: 'none' }}>*required</span>
              </label>
              <input type="text" value={form.summary} onChange={setField('summary')}
                placeholder="e.g. Verify channel messages with attachments migrate correctly"
                style={{ width: '100%', padding: '10px 14px', borderRadius: 8, border: '1.5px solid #e5e7eb', fontSize: 13, outline: 'none', boxSizing: 'border-box' }} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#0129ac', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Message Count
              </label>
              <input type="number" min={1} value={form.messageCount} onChange={setField('messageCount')}
                placeholder="e.g. 100"
                style={{ width: 120, padding: '10px 14px', borderRadius: 8, border: '1.5px solid #e5e7eb', fontSize: 13, outline: 'none', boxSizing: 'border-box' }} />
            </div>
          </div>

          {/* Row 3: Message Content / Test Data */}
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#0129ac', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Message Content / Test Data
            </label>
            <textarea rows={4} value={form.testData} onChange={setField('testData')}
              placeholder={form.productType === 'Message'
                ? 'Describe the message content to post — e.g. "100 plain text messages, 20 with file attachments, 10 threaded replies"'
                : 'Describe the test data — e.g. "Plain text emails with PDF attachments, HTML emails, starred messages"'}
              style={{ width: '100%', padding: '12px 14px', borderRadius: 8, border: '1.5px solid #e5e7eb', fontSize: 13, outline: 'none', resize: 'none', boxSizing: 'border-box', color: '#111827' }} />
          </div>

          {/* Context pill + Save button */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
            {effectiveCombo && (
              <span style={{ padding: '4px 14px', borderRadius: 20, backgroundColor: '#eef1fd', border: '1px solid #c5cef5', color: '#0129ac', fontWeight: 600, fontSize: 12 }}>
                {form.productType} · {effectiveCombo}{form.folder ? ` · ${form.folder}` : ''}
              </span>
            )}
            <button type="submit" disabled={saving || !canSave}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '11px 28px', borderRadius: 9, fontSize: 14, fontWeight: 700, backgroundColor: '#059669', color: '#fff', border: 'none', cursor: (!canSave || saving) ? 'not-allowed' : 'pointer', opacity: (!canSave || saving) ? 0.5 : 1 }}>
              {saving ? (
                <><svg style={{ width: 14, height: 14, animation: 'spin 1s linear infinite' }} viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" opacity="0.25"/><path fill="currentColor" opacity="0.75" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>Saving…</>
              ) : (
                <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>Save Scenario</>
              )}
            </button>
          </div>
        </form>
      </div>

      {/* ── Saved Scenarios Library ── */}
      <div className="card" style={{ overflow: 'hidden' }}>
        <div style={{ padding: '16px 20px', backgroundColor: '#0129ac', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h2 style={{ fontSize: 14, fontWeight: 700, color: '#fff', margin: 0 }}>Saved Test Scenarios</h2>
            <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.65)', margin: '2px 0 0' }}>
              Select a scenario in Message Agent → Section 5 to post test data into channels &amp; DMs
            </p>
          </div>
          <span style={{ fontSize: 12, fontWeight: 700, padding: '4px 14px', borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.15)', color: '#fff' }}>
            {savedCases.length} scenario{savedCases.length !== 1 ? 's' : ''}
          </span>
        </div>

        {savedCases.length === 0 ? (
          <div style={{ padding: '40px 20px', textAlign: 'center' }}>
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#c5cef5" strokeWidth="1.5" style={{ margin: '0 auto 12px' }}>
              <path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>
            </svg>
            <p style={{ fontSize: 14, color: '#6b7280', margin: 0 }}>No scenarios saved yet. Add one using the form above.</p>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 800 }}>
              <thead>
                <tr>
                  <th className={TH} style={{ minWidth: 130 }}>Scenario ID</th>
                  <th className={TH} style={{ minWidth: 200 }}>Summary</th>
                  <th className={TH} style={{ minWidth: 100 }}>Product</th>
                  <th className={TH} style={{ minWidth: 160 }}>Combination</th>
                  <th className={TH} style={{ minWidth: 110 }}>Folder</th>
                  <th className={TH} style={{ minWidth: 80 }}>Msg Count</th>
                  <th className={TH} style={{ minWidth: 200 }}>Test Data</th>
                  <th className={TH} style={{ minWidth: 60, borderRight: 'none' }}></th>
                </tr>
              </thead>
              <tbody>
                {savedCases.map(tc => (
                  <tr key={tc.id} style={{ backgroundColor: '#fff' }}>
                    <td className={TD}>
                      <span style={{ fontFamily: 'monospace', fontSize: 11, fontWeight: 700, color: '#0129ac', backgroundColor: '#eef1fd', padding: '2px 8px', borderRadius: 6, border: '1px solid #c5cef5' }}>
                        {tc.testCaseId || tc.id}
                      </span>
                    </td>
                    <td className={TD} style={{ fontWeight: 600 }}>{tc.summary || tc.subject || '—'}</td>
                    <td className={TD}>
                      <span style={{ padding: '2px 10px', borderRadius: 12, backgroundColor: '#eef1fd', color: '#0129ac', fontSize: 12, fontWeight: 700 }}>
                        {tc.productType || '—'}
                      </span>
                    </td>
                    <td className={TD} style={{ fontSize: 12 }}>{tc.combination || '—'}</td>
                    <td className={TD} style={{ fontSize: 12 }}>{tc.folder || <span style={{ color: '#ccc' }}>—</span>}</td>
                    <td className={TD} style={{ textAlign: 'center' }}>
                      {tc.messageCount
                        ? <span style={{ padding: '2px 10px', borderRadius: 12, backgroundColor: '#0129ac', color: '#fff', fontSize: 12, fontWeight: 700 }}>{tc.messageCount.toLocaleString()}</span>
                        : <span style={{ color: '#ccc' }}>—</span>}
                    </td>
                    <td className={TD} style={{ fontSize: 12 }}>{tc.testData || <span style={{ color: '#ccc' }}>—</span>}</td>
                    <td className={TD} style={{ textAlign: 'center', borderRight: 'none' }}>
                      <button type="button" disabled={deletingId === tc.id} onClick={() => handleDelete(tc.id)}
                        title="Remove"
                        style={{ padding: '4px 8px', borderRadius: 6, border: 'none', backgroundColor: 'transparent', cursor: 'pointer', color: '#9ca3af' }}>
                        {deletingId === tc.id
                          ? <svg style={{ width: 14, height: 14, animation: 'spin 1s linear infinite' }} viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" opacity="0.25"/><path fill="currentColor" opacity="0.75" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                          : <svg width="14" height="14" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" /></svg>}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
