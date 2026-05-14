import { useState, useRef, useLayoutEffect } from 'react';

/**
 * CloudFuze-style Permission Mapping: source users ↔ destination users for To/Cc/Bcc rewrite expectations
 * after migration (QA validation). CSV import/export compatible with Mapped Permissions workflows.
 */

function parsePermissionCsv(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const rows = [];
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.startsWith('source') || lower.includes('destination')) continue;
    let source = '';
    let dest = '';
    if (line.includes(',')) {
      const parts = line.split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
      source = parts[0] || '';
      dest = parts[1] || '';
    } else if (line.includes(';')) {
      const parts = line.split(';').map((s) => s.trim());
      source = parts[0] || '';
      dest = parts[1] || '';
    }
    if (source && dest) rows.push({ sourceEmail: source, destinationEmail: dest });
  }
  return rows;
}

export default function PermissionMapping({
  rows,
  onChange,
  disabled,
  showNamingConventionActions = false,
  onApplyNamingConvention,
}) {
  const fileRef = useRef(null);
  const [selectedIndices, setSelectedIndices] = useState(() => new Set());

  /** All rows selected by default whenever the table length changes (add/remove/import); bulk replace uses parent key remount. */
  useLayoutEffect(() => {
    setSelectedIndices(new Set(rows.map((_, i) => i)));
  }, [rows.length]);

  function toggleRow(idx) {
    setSelectedIndices((s) => {
      const next = new Set(s);
      next.has(idx) ? next.delete(idx) : next.add(idx);
      return next;
    });
  }

  function toggleAll(e) {
    const checked = e.target.checked;
    setSelectedIndices(checked ? new Set(rows.map((_, i) => i)) : new Set());
  }

  function updateRow(index, field, value) {
    const next = rows.map((r, i) => (i === index ? { ...r, [field]: value } : r));
    onChange(next);
  }

  function removeRow(index) {
    setSelectedIndices((s) => {
      const next = new Set();
      s.forEach((i) => {
        if (i < index) next.add(i);
        else if (i > index) next.add(i - 1);
      });
      return next;
    });
    onChange(rows.filter((_, i) => i !== index));
  }

  function deleteSelected() {
    if (selectedIndices.size === 0) return;
    const keep = rows.filter((_, i) => !selectedIndices.has(i));
    setSelectedIndices(new Set());
    onChange(keep);
  }

  function addRow() {
    onChange([...rows, { sourceEmail: '', destinationEmail: '' }]);
  }

  function downloadCsv() {
    const header = 'Source users,Destination users';
    const body = rows
      .filter((r) => String(r.sourceEmail || '').trim() || String(r.destinationEmail || '').trim())
      .map((r) => {
        const s = `"${String(r.sourceEmail || '').replace(/"/g, '""')}"`;
        const d = `"${String(r.destinationEmail || '').replace(/"/g, '""')}"`;
        return `${s},${d}`;
      })
      .join('\n');
    const blob = new Blob([`${header}\n${body}\n`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'permission-mapping.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  function onCsvFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const imported = parsePermissionCsv(reader.result);
      if (imported.length === 0) return;
      const merged =
        rows.length === 0 || rows.every((r) => !String(r.sourceEmail).trim() && !String(r.destinationEmail).trim())
          ? imported
          : [...rows.filter((r) => String(r.sourceEmail || '').trim()), ...imported];
      const next = merged.map((r) => ({ sourceEmail: r.sourceEmail, destinationEmail: r.destinationEmail }));
      onChange(next);
      setSelectedIndices(new Set(next.map((_, i) => i)));
    };
    reader.readAsText(file, 'UTF-8');
  }

  const allSelected = rows.length > 0 && selectedIndices.size === rows.length;
  const indeterminate = selectedIndices.size > 0 && selectedIndices.size < rows.length;

  return (
    <div className="rounded-lg overflow-hidden border border-gray-200 shadow-sm bg-white">
      {/* CloudFuze-style purple header */}
      <div
        className="px-4 py-3 flex items-center justify-between gap-3"
        style={{ background: 'linear-gradient(90deg, #5b21b6 0%, #6d28d9 50%, #7c3aed 100%)' }}
      >
        <h3 className="text-sm font-semibold text-white tracking-tight">Mapped Permissions</h3>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={downloadCsv}
            disabled={disabled || rows.length === 0}
            title="Download CSV"
            className="p-2 rounded-lg text-white/90 hover:bg-white/15 disabled:opacity-40 transition-colors"
          >
            <CsvDownloadIcon />
          </button>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={disabled}
            title="Upload CSV"
            className="p-2 rounded-lg text-white/90 hover:bg-white/15 disabled:opacity-40 transition-colors"
          >
            <CsvUploadIcon />
          </button>
          <button
            type="button"
            onClick={deleteSelected}
            disabled={disabled || selectedIndices.size === 0}
            title="Delete selected rows"
            className="p-2 rounded-lg text-white/90 hover:bg-white/15 disabled:opacity-40 transition-colors"
          >
            <TrashIcon />
          </button>
          <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={onCsvFile} />
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-100 border-b border-gray-200 text-left text-xs font-semibold text-gray-700">
              <th className="pl-4 pr-2 py-2.5 w-10">
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = indeterminate;
                  }}
                  onChange={toggleAll}
                  disabled={disabled || rows.length === 0}
                  className="w-4 h-4 rounded border-gray-300 text-violet-600 focus:ring-violet-500"
                />
              </th>
              <th className="px-2 py-2.5 w-[42%]">Source users</th>
              <th className="px-1 py-2.5 w-8 text-center text-gray-400" aria-hidden>
                →
              </th>
              <th className="px-2 py-2.5 w-[42%]">Destination users</th>
              <th className="w-10 pr-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-gray-500 text-sm">
                  No rows yet. Upload a CSV, click <strong>Add row</strong> below, or complete Auto-Map to pre-fill.
                </td>
              </tr>
            )}
            {rows.map((row, idx) => (
              <tr key={idx} className={selectedIndices.has(idx) ? 'bg-violet-50/60' : 'hover:bg-gray-50/80'}>
                <td className="pl-4 pr-2 py-2 align-middle">
                  <input
                    type="checkbox"
                    checked={selectedIndices.has(idx)}
                    onChange={() => toggleRow(idx)}
                    disabled={disabled}
                    className="w-4 h-4 rounded border-gray-300 text-violet-600 focus:ring-violet-500"
                  />
                </td>
                <td className="px-2 py-2">
                  <div className="flex items-center gap-2">
                    <GoogleMini />
                    <input
                      type="email"
                      value={row.sourceEmail}
                      onChange={(e) => updateRow(idx, 'sourceEmail', e.target.value)}
                      disabled={disabled}
                      placeholder="source.user@domain.com"
                      className="flex-1 min-w-0 px-3 py-2 border border-gray-200 rounded-md text-sm focus:ring-2 focus:ring-violet-500 focus:border-violet-500 outline-none disabled:bg-gray-50"
                    />
                  </div>
                </td>
                <td className="px-1 text-center text-gray-300">→</td>
                <td className="px-2 py-2">
                  <div className="flex items-center gap-2">
                    <MicrosoftMini />
                    <input
                      type="email"
                      value={row.destinationEmail}
                      onChange={(e) => updateRow(idx, 'destinationEmail', e.target.value)}
                      disabled={disabled}
                      placeholder="dest.user@domain.com"
                      className="flex-1 min-w-0 px-3 py-2 border border-gray-200 rounded-md text-sm focus:ring-2 focus:ring-violet-500 focus:border-violet-500 outline-none disabled:bg-gray-50"
                    />
                  </div>
                </td>
                <td className="pr-2 py-2 align-middle">
                  <button
                    type="button"
                    onClick={() => removeRow(idx)}
                    disabled={disabled}
                    title="Remove row"
                    className="p-1.5 rounded-full text-gray-400 hover:text-red-600 hover:bg-red-50 disabled:opacity-30"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                    </svg>
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-2 px-4 py-3 bg-gray-50 border-t border-gray-100">
        <button
          type="button"
          onClick={addRow}
          disabled={disabled}
          className="text-sm font-medium text-violet-700 hover:text-violet-900 disabled:opacity-40"
        >
          + Add row
        </button>
        {showNamingConventionActions && typeof onApplyNamingConvention === 'function' && (
          <button
            type="button"
            onClick={onApplyNamingConvention}
            disabled={disabled}
            title="Rebuild rows from mapped pairs + directory: first-name match, then same email local-part across domains"
            className="text-sm font-semibold px-3 py-1.5 rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-40 shadow-sm"
          >
            Auto-fill naming convention
          </button>
        )}
      </div>
    </div>
  );
}

function CsvDownloadIcon() {
  return (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 18H9a2.25 2.25 0 0 1-2.25-2.25V6.75m12 9V18a2.25 2.25 0 0 1-2.25 2.25H15M9 12l3 3m0 0 3-3m-3 3V2.25" />
    </svg>
  );
}

function CsvUploadIcon() {
  return (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
    </svg>
  );
}

function GoogleMini() {
  return (
    <svg viewBox="0 0 48 48" className="w-5 h-5 flex-shrink-0">
      <path fill="#4285F4" d="M46.145 24.504c0-1.613-.134-3.167-.389-4.658H24v8.814h12.449c-.537 2.895-2.168 5.348-4.62 6.994v5.816h7.48c4.376-4.03 6.836-9.968 6.836-16.966z" />
      <path fill="#34A853" d="M24 48c6.24 0 11.473-2.065 15.298-5.597l-7.48-5.816c-2.072 1.39-4.724 2.21-7.818 2.21-6.012 0-11.1-4.062-12.921-9.516H3.324v6.009A23.998 23.998 0 0024 48z" />
      <path fill="#FBBC05" d="M11.079 29.281A14.416 14.416 0 0110.25 24c0-1.837.316-3.619.829-5.281v-6.009H3.324A23.998 23.998 0 000 24c0 3.867.927 7.53 2.563 10.71l8.516-5.429z" />
      <path fill="#EA4335" d="M24 9.503c3.387 0 6.428 1.164 8.82 3.451l6.615-6.615C35.469 2.378 30.24 0 24 0A23.998 23.998 0 002.563 13.29l8.516 6.429C12.9 13.565 17.988 9.503 24 9.503z" />
    </svg>
  );
}

function MicrosoftMini() {
  return (
    <svg viewBox="0 0 23 23" className="w-5 h-5 flex-shrink-0">
      <rect x="1" y="1" width="10" height="10" fill="#F25022" />
      <rect x="12" y="1" width="10" height="10" fill="#7FBA00" />
      <rect x="1" y="12" width="10" height="10" fill="#00A4EF" />
      <rect x="12" y="12" width="10" height="10" fill="#FFB900" />
    </svg>
  );
}
