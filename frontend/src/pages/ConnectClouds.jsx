import { useEffect, useState, useCallback, useRef } from 'react';
import {
  getConnectedAccounts, addDwdAccount, getMicrosoftAdminConsentUrl, getBoxOAuthUrl,
  signOutGoogle, signOutMicrosoft, signOutBox,
  getMicrosoftOAuthUrl, getGoogleOAuthUrl, getSlackOAuthUrl, signOutSlack,
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
    { key: 'dropbox', name: 'Dropbox' },                 // connector pending
    { key: 'egnyte', name: 'Egnyte' },                   // connector pending
    { key: 'citrix', name: 'Citrix ShareFile' },         // connector pending
    { key: 'googledrive', name: 'Google Drive', account: 'google' },
    { key: 'googleshareddrive', name: 'Google Shared Drive', account: 'google' },
    { key: 'onedrive', name: 'OneDrive', account: 'microsoft' },
    { key: 'sharepoint', name: 'SharePoint', account: 'microsoft' },
  ],
  message: [
    { key: 'slack', name: 'Slack', account: 'slack' },
    { key: 'teams', name: 'Microsoft Teams', account: 'microsoft' },
    { key: 'googlechat', name: 'Google Chat', account: 'google' },
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

const ACCOUNT_NAME = { google: 'Google', microsoft: 'Microsoft', box: 'Box', slack: 'Slack' };

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
  const [dwdBlocked, setDwdBlocked] = useState(null); // why DWD failed, so the modal can offer OAuth
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
    // Message clouds connect with agent=message scopes (Teams/Chat) or a Slack user token.
    if (domainTab === 'message') {
      if (cloud.key === 'slack') { runPopupFlow(() => getSlackOAuthUrl('popup', 'message'), cloud.name); return; }
      if (cloud.key === 'teams') { runPopupFlow(() => getMicrosoftOAuthUrl('popup', '1', 'message'), cloud.name); return; }
      if (cloud.key === 'googlechat') { runPopupFlow(() => getGoogleOAuthUrl('popup', '1', 'message'), cloud.name); return; }
      showToast(`${cloud.name} is not implemented yet`, 'error'); return;
    }
    if (cloud.account === 'google') { setGoogleFor(cloud); setGoogleEmail(''); setDwdBlocked(null); return; }
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
    } catch (err) {
      const msg = err.response?.data?.error || err.message || '';
      // Not every Google domain has Domain-Wide Delegation authorized for our service account, and
      // this modal used to be the ONLY way to connect a Google content cloud — so such a domain was
      // simply unconnectable through the UI, even though the OAuth route below works fine for it.
      // Offer sign-in instead of a dead end.
      if (/unauthorized_client|not authorized|Domain-Wide Delegation/i.test(msg)) {
        setDwdBlocked(msg);
        showToast('Domain-Wide Delegation is not available for this domain — sign in with Google instead', 'error');
      } else {
        showToast(msg, 'error');
      }
    }
    finally { setBusy(false); }
  }

  /** OAuth sign-in for a Google content cloud — the alternative when DWD is not authorized. */
  function signInWithGoogle() {
    const label = googleFor?.name || 'Google';
    const agent = domainTab === 'message' ? 'message' : domainTab === 'content' ? 'content' : 'mail';
    setGoogleFor(null); setDwdBlocked(null);
    runPopupFlow(() => getGoogleOAuthUrl('popup', '1', agent), label);
  }

  async function disconnect(acct) {
    if (!confirm(`Disconnect ${acct.email}?`)) return;
    try {
      if (acct.provider === 'google') await signOutGoogle(acct.email);
      else if (acct.provider === 'box') await signOutBox(acct.email);
      else if (acct.provider === 'slack') await signOutSlack(acct.email);
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
            <p className="text-xs text-gray-500">
              Two ways to connect. <strong>Domain-Wide Delegation</strong> needs no sign-in, but only works
              if this service account is authorized for that domain. Otherwise use <strong>Sign in with
              Google</strong>.
            </p>
            {dwdBlocked && (
              <div className="text-xs bg-amber-50 border border-amber-200 text-amber-800 rounded-lg p-3 space-y-1">
                <p className="font-semibold">Domain-Wide Delegation is not available for this domain.</p>
                <p>Use “Sign in with Google” below — it works today. To enable DWD instead, an admin must
                grant the service-account client id the Drive scope in the Google Admin console.</p>
              </div>
            )}
            <input type="email" value={googleEmail} autoFocus onChange={(e) => setGoogleEmail(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submitGoogle()} placeholder="admin@yourdomain.com"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-teal-500 outline-none" />
            <div className="flex items-center justify-between gap-2 pt-1">
              <button type="button" disabled={busy} onClick={signInWithGoogle}
                className="px-3 py-2 text-sm font-medium text-teal-700 border border-teal-300 rounded-lg hover:bg-teal-50 disabled:opacity-50">
                Sign in with Google
              </button>
              <div className="flex gap-2">
                <button type="button" onClick={() => setGoogleFor(null)} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800">Cancel</button>
                <button type="button" disabled={busy || !googleEmail.trim()} onClick={submitGoogle}
                  className="px-4 py-2 text-sm font-semibold text-white bg-teal-600 rounded-lg hover:bg-teal-700 disabled:opacity-50">
                  {busy ? 'Connecting…' : 'Use DWD'}
                </button>
              </div>
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
// Distinct, brand-correct logo per cloud (no shared marks). Falls back to a
// brand-coloured initial badge only for clouds without a drawn logo yet.
function Glyph({ cloud, size = 36 }) {
  const s = { width: size, height: size, flexShrink: 0 };
  switch (cloud) {
    case 'google': // Google Workspace / Gmail — multicolour G
      return (
        <svg viewBox="0 0 48 48" style={s}>
          <path fill="#4285F4" d="M46.145 24.504c0-1.613-.134-3.167-.389-4.658H24v8.814h12.449c-.537 2.895-2.168 5.348-4.62 6.994v5.816h7.48c4.376-4.03 6.836-9.968 6.836-16.966z" />
          <path fill="#34A853" d="M24 48c6.24 0 11.473-2.065 15.298-5.597l-7.48-5.816c-2.072 1.39-4.724 2.21-7.818 2.21-6.012 0-11.1-4.062-12.921-9.516H3.324v6.009A23.998 23.998 0 0024 48z" />
          <path fill="#FBBC05" d="M11.079 29.281A14.416 14.416 0 0110.25 24c0-1.837.316-3.619.829-5.281v-6.009H3.324A23.998 23.998 0 000 24c0 3.867.927 7.53 2.563 10.71l8.516-5.429z" />
          <path fill="#EA4335" d="M24 9.503c3.387 0 6.428 1.164 8.82 3.451l6.615-6.615C35.469 2.378 30.24 0 24 0A23.998 23.998 0 002.563 13.29l8.516 6.429C12.9 13.565 17.988 9.503 24 9.503z" />
        </svg>
      );
    case 'googledrive': // Google Drive — tri-colour triangle
    case 'googleshareddrive':
      return (
        <svg viewBox="0 0 88 78" style={s}>
          <path fill="#0066DA" d="M6.6 66.85l3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3L27.5 53H0c0 1.55.4 3.1 1.2 4.5z" />
          <path fill="#00AC47" d="M43.65 25L29.9 1.2c-1.35.8-2.5 1.9-3.3 3.3L1.2 48.5C.4 49.9 0 51.45 0 53h27.5z" />
          <path fill="#EA4335" d="M73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75L86.8 57c.8-1.4 1.2-2.95 1.2-4.5H60.5l5.85 11.5z" />
          <path fill="#00832D" d="M43.65 25L57.4 1.2C56.05.4 54.5 0 52.9 0H34.4c-1.6 0-3.15.45-4.5 1.2z" />
          <path fill="#2684FC" d="M60.5 53H27.5L13.75 76.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z" />
          <path fill="#FFBA00" d="M73.4 26.5L60.75 4.5c-.8-1.4-1.95-2.5-3.3-3.3L43.65 25 60.5 53H88c0-1.55-.4-3.1-1.2-4.5z" />
        </svg>
      );
    case 'microsoft': // Microsoft 365 — four squares
      return (
        <svg viewBox="0 0 23 23" style={s}>
          <rect x="1" y="1" width="10" height="10" fill="#F25022" /><rect x="12" y="1" width="10" height="10" fill="#7FBA00" />
          <rect x="1" y="12" width="10" height="10" fill="#00A4EF" /><rect x="12" y="12" width="10" height="10" fill="#FFB900" />
        </svg>
      );
    case 'onedrive': // OneDrive — blue cloud
      return (
        <svg viewBox="0 0 24 24" style={s} fill="#0078D4">
          <path d="M13.5 7a5.5 5.5 0 015.42 4.6A4 4 0 0118 19.5H7a4.5 4.5 0 01-1.06-8.87A5.5 5.5 0 0113.5 7z" />
        </svg>
      );
    case 'sharepoint': // SharePoint — teal mark
      return (
        <svg viewBox="0 0 24 24" style={s}>
          <circle cx="12" cy="12" r="11" fill="#036C70" />
          <text x="12" y="16.5" textAnchor="middle" fontSize="12" fontWeight="700" fill="#fff" fontFamily="Segoe UI, Arial, sans-serif">S</text>
        </svg>
      );
    case 'teams': // Microsoft Teams — purple
      return (
        <svg viewBox="0 0 24 24" style={s}>
          <rect x="1" y="4" width="22" height="16" rx="4" fill="#5059C9" />
          <text x="12" y="16.5" textAnchor="middle" fontSize="12" fontWeight="700" fill="#fff" fontFamily="Segoe UI, Arial, sans-serif">T</text>
        </svg>
      );
    case 'box': // Box — blue "box" mark
      return (
        <svg viewBox="0 0 24 24" style={s}>
          <rect width="24" height="24" rx="5" fill="#0061D5" />
          <text x="12" y="15.5" textAnchor="middle" fontSize="8.5" fontWeight="700" fill="#fff" fontFamily="Arial, sans-serif">box</text>
        </svg>
      );
    case 'dropbox': // Dropbox — blue chevrons
      return (
        <svg viewBox="0 0 24 24" style={s} fill="#0061FF">
          <path d="M6 2L0 6l6 4 6-4-6-4zm12 0l-6 4 6 4 6-4-6-4zM0 14l6 4 6-4-6-4-6 4zm18-4l-6 4 6 4 6-4-6-4zM6 19.34l6 4 6-4-6-4-6 4z" />
        </svg>
      );
    case 'slack': // Slack — four-colour hash
      return (
        <svg viewBox="0 0 24 24" style={s}>
          <path fill="#36C5F0" d="M5 15a2 2 0 11-2-2h2zM6 15a2 2 0 014 0v5a2 2 0 11-4 0z" />
          <path fill="#2EB67D" d="M9 5a2 2 0 112-2v2zM9 6a2 2 0 010 4H4a2 2 0 110-4z" />
          <path fill="#ECB22E" d="M19 9a2 2 0 112 2h-2zM18 9a2 2 0 01-4 0V4a2 2 0 114 0z" />
          <path fill="#E01E5A" d="M15 19a2 2 0 11-2 2v-2zM15 18a2 2 0 010-4h5a2 2 0 110 4z" />
        </svg>
      );
    case 'googlechat': // Google Chat — green bubble
      return (
        <svg viewBox="0 0 24 24" style={s} fill="#00AC47">
          <path d="M3 4a2 2 0 012-2h14a2 2 0 012 2v11a2 2 0 01-2 2H9l-5 4v-4a2 2 0 01-2-2V4z" transform="translate(0 1)" />
        </svg>
      );
    default: {
      const BADGES = {
        egnyte: { c: '#00AEC7', t: 'E' }, citrix: { c: '#452D82', t: 'C' },
        sharefile: { c: '#1E7B6F', t: 'S' }, webex: { c: '#00BCEB', t: 'W' },
        workplace: { c: '#1877F2', t: 'W' }, viva: { c: '#0078D4', t: 'V' },
      };
      const b = BADGES[cloud] || { c: '#64748B', t: (cloud[0] || '?').toUpperCase() };
      return (
        <span style={{ ...s, backgroundColor: b.c }} className="rounded-lg flex items-center justify-center text-white font-bold">
          {b.t}
        </span>
      );
    }
  }
}
