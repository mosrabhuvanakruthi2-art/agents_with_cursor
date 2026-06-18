import { useEffect, useState, useCallback, useRef } from 'react';
import {
  getConnectedAccounts, addDwdAccount, getMicrosoftAdminConsentUrl, getBoxOAuthUrl,
  signOutGoogle, signOutMicrosoft, signOutBox,
} from '../services/api';

const POPUP_KEY = 'cf_oauth_result';

// Cloud catalog grouped by migration domain. `account` = the backing connect flow
// (google | microsoft | box). Clouds without one are not implemented yet.
const CATALOG = {
  mail: [
    { key: 'google', name: 'Google Workspace', account: 'google' },
    { key: 'microsoft', name: 'Microsoft 365', account: 'microsoft' },
  ],
  content: [
    { key: 'box', name: 'Box', account: 'box' },
    { key: 'googledrive', name: 'Google Drive', account: 'google' },
    { key: 'onedrive', name: 'OneDrive', account: 'microsoft' },
    { key: 'sharepoint', name: 'SharePoint', account: 'microsoft' },
  ],
  message: [
    { key: 'slack', name: 'Slack' },
    { key: 'teams', name: 'Microsoft Teams' },
    { key: 'googlechat', name: 'Google Chat' },
    { key: 'webex', name: 'Webex' },
    { key: 'workplace', name: 'Meta Workplace' },
    { key: 'viva', name: 'Viva Engage' },
  ],
};

const DOMAIN_TABS = [
  { key: 'mail', label: 'Mail' },
  { key: 'content', label: 'Content' },
  { key: 'message', label: 'Message' },
];

const ACCOUNT_NAME = { google: 'Google', microsoft: 'Microsoft', box: 'Box' };

function openPopup(url) {
  const w = 520, h = 680;
  const left = Math.round(window.screenX + (window.outerWidth - w) / 2);
  const top = Math.round(window.screenY + (window.outerHeight - h) / 2);
  return window.open(url, 'cf_oauth', `width=${w},height=${h},left=${left},top=${top},toolbar=no,menubar=no`);
}

export default function ConnectClouds() {
  const [view, setView] = useState('add'); // 'add' | 'manage'
  const [domainTab, setDomainTab] = useState('mail');
  const [accounts, setAccounts] = useState([]);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [googleFor, setGoogleFor] = useState(null); // cloud awaiting a DWD admin email
  const [googleEmail, setGoogleEmail] = useState('');
  const [expanded, setExpanded] = useState(null);

  const pollRef = useRef(null);
  const popupRef = useRef(null);

  const showToast = useCallback((msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  }, []);

  const loadAccounts = useCallback(async () => {
    try { const res = await getConnectedAccounts(); setAccounts(res.data.accounts || []); }
    catch { /* ignore */ }
  }, []);
  useEffect(() => { loadAccounts(); }, [loadAccounts]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);
  useEffect(() => () => stopPolling(), [stopPolling]);

  function runPopupFlow(getUrl, label) {
    setBusy(true);
    getUrl()
      .then((res) => {
        popupRef.current = openPopup(res.data.url);
        localStorage.removeItem(POPUP_KEY);
        pollRef.current = setInterval(() => {
          const raw = localStorage.getItem(POPUP_KEY);
          if (raw) {
            try {
              const result = JSON.parse(raw);
              localStorage.removeItem(POPUP_KEY);
              stopPolling(); popupRef.current?.close(); popupRef.current = null;
              if (result.error) showToast(result.message || result.error, 'error');
              else { showToast(`${label} connected`); loadAccounts(); setView('manage'); }
            } catch { /* ignore */ }
            setBusy(false);
            return;
          }
          if (popupRef.current?.closed) { stopPolling(); setBusy(false); }
        }, 500);
        setTimeout(() => { stopPolling(); setBusy(false); }, 300_000);
      })
      .catch((err) => { showToast(err.response?.data?.error || err.message, 'error'); setBusy(false); });
  }

  function handleTile(cloud) {
    if (!cloud.account) { showToast(`${cloud.name} is not implemented yet`, 'error'); return; }
    if (cloud.account === 'google') { setGoogleFor(cloud); setGoogleEmail(''); return; }
    if (cloud.account === 'microsoft') { runPopupFlow(() => getMicrosoftAdminConsentUrl(), cloud.name); return; }
    if (cloud.account === 'box') { runPopupFlow(() => getBoxOAuthUrl('popup'), cloud.name); return; }
    showToast(`${cloud.name} is not implemented yet`, 'error');
  }

  async function submitGoogle() {
    const e = googleEmail.trim().toLowerCase();
    if (!e) return;
    setBusy(true);
    try {
      await addDwdAccount(e);
      showToast(`${googleFor.name} connected (${e})`);
      setGoogleFor(null); setGoogleEmail('');
      await loadAccounts(); setView('manage');
    } catch (err) { showToast(err.response?.data?.error || err.message, 'error'); }
    finally { setBusy(false); }
  }

  async function disconnect(acct) {
    if (!confirm(`Disconnect ${acct.email}?`)) return;
    try {
      if (acct.provider === 'google') await signOutGoogle(acct.email);
      else if (acct.provider === 'box') await signOutBox(acct.email);
      else await signOutMicrosoft(acct.email);
      showToast(`${acct.email} disconnected`);
      await loadAccounts();
    } catch (err) { showToast(err.response?.data?.error || err.message, 'error'); }
  }

  const tiles = CATALOG[domainTab] || [];
  // Connected-account providers that belong to the selected domain (e.g. content → box/google/microsoft).
  const domainAccounts = [...new Set(tiles.map((c) => c.account).filter(Boolean))];
  const manageList = accounts.filter((a) => domainAccounts.includes(a.provider));
  const domainLabel = DOMAIN_TABS.find((d) => d.key === domainTab)?.label;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Connect Clouds</h1>
        <p className="text-sm text-gray-500 mt-1">Connect the cloud accounts you'll migrate between, and manage existing connections.</p>
      </div>

      {/* Top tabs: Add / Manage */}
      <div className="border-b border-gray-200 flex gap-6">
        {[['add', 'ADD CLOUDS'], ['manage', `MANAGE CLOUDS${manageList.length ? ` (${manageList.length})` : ''}`]].map(([k, label]) => (
          <button key={k} type="button" onClick={() => setView(k)}
            className={`relative pb-3 text-sm font-semibold tracking-wide transition-colors ${
              view === k ? 'text-teal-600' : 'text-gray-400 hover:text-gray-600'
            }`}>
            {label}
            {view === k && <span className="absolute -bottom-px left-0 right-0 h-0.5 bg-teal-500 rounded-full" />}
          </button>
        ))}
      </div>

      {/* Domain sub-tabs — apply to both Add and Manage */}
      <div className="flex gap-1 bg-gray-100 p-1 rounded-xl w-fit">
        {DOMAIN_TABS.map((d) => (
          <button key={d.key} type="button" onClick={() => setDomainTab(d.key)}
            className={`px-5 py-2 rounded-lg text-sm font-semibold transition-all ${
              domainTab === d.key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}>
            {d.label}
          </button>
        ))}
      </div>

      {view === 'add' ? (
        <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
          <h2 className="text-lg font-semibold text-gray-800">{domainLabel} Clouds</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
            {tiles.map((cloud) => {
              const connectedCount = cloud.account ? accounts.filter((a) => a.provider === cloud.account).length : 0;
              return (
                <button key={cloud.key} type="button" disabled={busy} onClick={() => handleTile(cloud)}
                  className={`relative flex flex-col items-center justify-center gap-2 rounded-xl border p-5 transition-all disabled:opacity-60 ${
                    cloud.account ? 'border-gray-200 bg-white hover:border-teal-300 hover:shadow-sm' : 'border-dashed border-gray-200 bg-gray-50'
                  }`}
                  title={cloud.account ? `Connect ${cloud.name}` : `${cloud.name} — not implemented yet`}>
                  <Glyph cloud={cloud.key} />
                  <span className="text-sm font-medium text-gray-700 text-center leading-tight">{cloud.name}</span>
                  {connectedCount > 0 && (
                    <span className="absolute top-1.5 right-1.5 text-[10px] bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded-full">{connectedCount}</span>
                  )}
                  {!cloud.account && <span className="text-[10px] text-gray-400">coming soon</span>}
                </button>
              );
            })}
          </div>
          {busy && <p className="text-xs text-gray-400">Waiting for connection…</p>}
        </div>
      ) : (
        <div className="space-y-3">
          {manageList.length === 0 && (
            <div className="bg-white rounded-xl border border-gray-200 p-8 text-center text-sm text-gray-500">
              No {domainLabel} clouds connected yet. Switch to <button className="text-teal-600 font-medium" onClick={() => setView('add')}>Add Clouds</button> to connect one.
            </div>
          )}
          {manageList.map((a) => (
            <div key={`${a.provider}:${a.email}`} className="bg-white rounded-xl border border-gray-200">
              <div className="flex items-center gap-4 p-4">
                <Glyph cloud={a.provider} size={44} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-gray-900 capitalize">{ACCOUNT_NAME[a.provider] || a.provider}</p>
                  <p className="text-sm text-gray-600 truncate">{a.email}</p>
                  <span className="inline-block mt-0.5 text-[10px] bg-indigo-50 text-indigo-600 px-1.5 py-0.5 rounded">{a.isDwd ? 'DWD Admin' : 'Admin'}</span>
                </div>
                <span className="text-sm text-gray-500 hidden sm:inline">Multiuser</span>
                <button type="button" onClick={() => disconnect(a)} title="Disconnect"
                  className="p-2 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50">
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916" /></svg>
                </button>
                <button type="button" onClick={() => setExpanded(expanded === a.email ? null : a.email)} title="Details"
                  className="p-2 rounded-lg text-teal-500 hover:bg-teal-50">
                  <svg className={`w-5 h-5 transition-transform ${expanded === a.email ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" /></svg>
                </button>
              </div>
              {expanded === a.email && (
                <div className="border-t border-gray-100 px-4 py-3 text-xs text-gray-500 grid grid-cols-2 sm:grid-cols-3 gap-2">
                  <div><span className="text-gray-400">Provider:</span> {a.provider}</div>
                  <div><span className="text-gray-400">Email:</span> {a.email}</div>
                  <div><span className="text-gray-400">Connected:</span> {a.connectedAt ? new Date(a.connectedAt).toLocaleString() : '—'}</div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Google DWD email modal */}
      {googleFor && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setGoogleFor(null)}>
          <div className="bg-white rounded-xl p-6 w-full max-w-md space-y-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-gray-900">Connect {googleFor.name}</h3>
            <p className="text-xs text-gray-500">Domain-Wide Delegation — enter a Google Workspace admin email. No sign-in needed.</p>
            <input type="email" value={googleEmail} autoFocus onChange={(e) => setGoogleEmail(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submitGoogle()} placeholder="admin@yourdomain.com"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-teal-500 outline-none" />
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setGoogleFor(null)} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800">Cancel</button>
              <button type="button" disabled={busy || !googleEmail.trim()} onClick={submitGoogle}
                className="px-4 py-2 text-sm font-semibold text-white bg-teal-600 rounded-lg hover:bg-teal-700 disabled:opacity-50">
                {busy ? 'Connecting…' : 'Connect'}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className={`fixed bottom-6 right-6 z-50 px-4 py-3 rounded-lg shadow-lg text-sm ${toast.type === 'error' ? 'bg-red-600 text-white' : 'bg-gray-900 text-white'}`}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}

// ── Cloud glyphs ────────────────────────────────────────────────────────────────
// Brand-ish marks for connectable clouds; colored initial badges for message clouds.
function Glyph({ cloud, size = 36 }) {
  const s = { width: size, height: size };
  if (cloud === 'google' || cloud === 'googledrive') return (
    <svg viewBox="0 0 48 48" style={s}>
      <path fill="#4285F4" d="M46.145 24.504c0-1.613-.134-3.167-.389-4.658H24v8.814h12.449c-.537 2.895-2.168 5.348-4.62 6.994v5.816h7.48c4.376-4.03 6.836-9.968 6.836-16.966z" />
      <path fill="#34A853" d="M24 48c6.24 0 11.473-2.065 15.298-5.597l-7.48-5.816c-2.072 1.39-4.724 2.21-7.818 2.21-6.012 0-11.1-4.062-12.921-9.516H3.324v6.009A23.998 23.998 0 0024 48z" />
      <path fill="#FBBC05" d="M11.079 29.281A14.416 14.416 0 0110.25 24c0-1.837.316-3.619.829-5.281v-6.009H3.324A23.998 23.998 0 000 24c0 3.867.927 7.53 2.563 10.71l8.516-5.429z" />
      <path fill="#EA4335" d="M24 9.503c3.387 0 6.428 1.164 8.82 3.451l6.615-6.615C35.469 2.378 30.24 0 24 0A23.998 23.998 0 002.563 13.29l8.516 6.429C12.9 13.565 17.988 9.503 24 9.503z" />
    </svg>
  );
  if (cloud === 'microsoft' || cloud === 'onedrive' || cloud === 'sharepoint' || cloud === 'teams') return (
    <svg viewBox="0 0 23 23" style={s}>
      <rect x="1" y="1" width="10" height="10" fill="#F25022" /><rect x="12" y="1" width="10" height="10" fill="#7FBA00" />
      <rect x="1" y="12" width="10" height="10" fill="#00A4EF" /><rect x="12" y="12" width="10" height="10" fill="#FFB900" />
    </svg>
  );
  if (cloud === 'box') return (
    <svg viewBox="0 0 24 24" style={s} fill="#0061D5"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2.4 12.6a1.6 1.6 0 110-3.2 1.6 1.6 0 010 3.2zm4.8 0a1.6 1.6 0 110-3.2 1.6 1.6 0 010 3.2z" /></svg>
  );
  const BADGES = {
    slack: { c: '#4A154B', t: 'S' }, googlechat: { c: '#1A73E8', t: 'C' },
    webex: { c: '#00BCEB', t: 'W' }, workplace: { c: '#1877F2', t: 'W' },
    viva: { c: '#0078D4', t: 'V' },
  };
  const b = BADGES[cloud] || { c: '#64748B', t: (cloud[0] || '?').toUpperCase() };
  return (
    <span style={{ ...s, backgroundColor: b.c }} className="rounded-lg flex items-center justify-center text-white font-bold" >
      {b.t}
    </span>
  );
}
