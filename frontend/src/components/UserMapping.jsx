import { useState, useEffect, useRef, useCallback } from 'react';
import {
  getSourceUsers, getDestinationUsers,
  getGoogleOAuthUrl, getMicrosoftOAuthUrl,
  getConnectedAccounts, signOutGoogle, signOutMicrosoft,
} from '../services/api';
import usePersistedState from '../hooks/usePersistedState';

// ─── Provider config ──────────────────────────────────────────────────────────

const PROVIDERS = {
  google: { key: 'google', label: 'Google Workspace', short: 'Google', icon: GoogleIcon },
  microsoft: { key: 'microsoft', label: 'Microsoft 365', short: 'Microsoft', icon: MicrosoftIcon },
};

// ─── OAuth popup ──────────────────────────────────────────────────────────────

const POPUP_KEY = 'cf_oauth_result';

function openOAuthPopup(url) {
  const w = 520, h = 680;
  const left = Math.round(window.screenX + (window.outerWidth - w) / 2);
  const top = Math.round(window.screenY + (window.outerHeight - h) / 2);
  return window.open(url, 'cf_oauth', `width=${w},height=${h},left=${left},top=${top},toolbar=no,menubar=no`);
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function UserMapping({ onMappingComplete }) {
  const [srcProvider, setSrcProvider] = usePersistedState('map-srcProvider', 'google');
  const [srcEmail, setSrcEmail] = usePersistedState('map-srcAdmin', '');
  const [dstProvider, setDstProvider] = usePersistedState('map-dstProvider', 'microsoft');
  const [dstEmail, setDstEmail] = usePersistedState('map-destAdmin', '');

  const [sourceUsers, setSourceUsers] = usePersistedState('map-srcUsers', []);
  const [destUsers, setDestUsers] = usePersistedState('map-destUsers', []);
  const [mappings, setMappings] = usePersistedState('map-mappings', []);
  const [unmappedSource, setUnmappedSource] = usePersistedState('map-unmapSrc', []);
  const [unmappedDest, setUnmappedDest] = usePersistedState('map-unmapDest', []);
  const [selectedIndices, setSelectedIndices] = useState(() => new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [fetched, setFetched] = usePersistedState('map-fetched', false);

  // connected accounts (from backend)
  const [accounts, setAccounts] = useState([]);  // [{ provider, email, connectedAt }]
  const [accountsLoading, setAccountsLoading] = useState(true);

  // Login modal
  const [loginTarget, setLoginTarget] = useState(null); // 'source' | 'destination'
  const [oauthLoading, setOauthLoading] = useState(false);
  const [oauthError, setOauthError] = useState(null);
  const [googleTenant, setGoogleTenant] = useState('1');
  const [msTenant, setMsTenant] = useState('1');
  const pollRef = useRef(null);
  const popupRef = useRef(null);

  const loadAccounts = useCallback(async () => {
    try {
      const res = await getConnectedAccounts();
      setAccounts(res.data.accounts || []);
    } catch { /* ignore */ }
    finally { setAccountsLoading(false); }
  }, []);

  useEffect(() => { loadAccounts(); }, [loadAccounts]);

  // ─── OAuth popup ─────────────────────────────────────────────────────────────

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  const startPolling = useCallback((providerKey, onSuccess) => {
    localStorage.removeItem(POPUP_KEY);
    pollRef.current = setInterval(() => {
      // Check result FIRST — popup may already be closed
      const raw = localStorage.getItem(POPUP_KEY);
      if (raw) {
        try {
          const result = JSON.parse(raw);
          localStorage.removeItem(POPUP_KEY);
          stopPolling();
          popupRef.current?.close();
          popupRef.current = null;
          if (result.connected === providerKey && result.email) {
            onSuccess(result.email);
            setOauthError(null);
            loadAccounts(); // refresh account list
          } else if (result.error) {
            setOauthError(result.message || result.error);
          }
        } catch { /* ignore */ }
        setOauthLoading(false);
        return;
      }
      if (popupRef.current?.closed) { stopPolling(); setOauthLoading(false); }
    }, 500);
    setTimeout(() => { stopPolling(); setOauthLoading(false); }, 300_000);
  }, [stopPolling, loadAccounts]);

  async function handleSignOut(provider, email) {
    try {
      if (provider === 'google') await signOutGoogle(email);
      else await signOutMicrosoft(email);
      await loadAccounts();
    } catch { /* ignore */ }
  }

  async function handleLogin(target) {
    const providerKey = target === 'source' ? srcProvider : dstProvider;
    setOauthError(null);
    setOauthLoading(true);
    try {
      const getFn = providerKey === 'google' ? getGoogleOAuthUrl : getMicrosoftOAuthUrl;
      const tenant = providerKey === 'google' ? googleTenant : msTenant;
      const res = await getFn('popup', tenant);
      popupRef.current = openOAuthPopup(res.data.url);
      startPolling(providerKey, (email) => {
        if (target === 'source') setSrcEmail(email);
        else setDstEmail(email);
        setLoginTarget(null);
      });
    } catch (err) {
      setOauthError(err.response?.data?.error || err.message);
      setOauthLoading(false);
    }
  }

  useEffect(() => () => stopPolling(), [stopPolling]);

  // ─── User mapping ─────────────────────────────────────────────────────────────

  async function fetchUsers() {
    if (!srcEmail || !dstEmail) return;
    setLoading(true);
    setError(null);
    setFetched(false);
    setMappings([]);
    setUnmappedSource([]);
    setUnmappedDest([]);
    try {
      const [srcRes, destRes] = await Promise.all([
        getSourceUsers(srcEmail, srcProvider),
        getDestinationUsers(dstEmail, dstProvider),
      ]);
      const src = srcRes.data.users || [];
      const dest = destRes.data.users || [];
      setSourceUsers(src);
      setDestUsers(dest);
      autoMap(src, dest);
      setFetched(true);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  }

  function autoMap(src, dest) {
    const mapped = [], usedDest = new Set(), unmatched = [];
    for (const s of src) {
      const f = (s.firstName || '').toLowerCase().trim();
      if (!f) { unmatched.push(s); continue; }
      const m = dest.find((d) => !usedDest.has(d.id) && (d.firstName || '').toLowerCase().trim() === f);
      if (m) { mapped.push({ source: s, destination: m, autoMatched: true }); usedDest.add(m.id); }
      else unmatched.push(s);
    }
    setMappings(mapped);
    setSelectedIndices(new Set(mapped.map((_, i) => i)));
    setUnmappedSource(unmatched);
    setUnmappedDest(dest.filter((d) => !usedDest.has(d.id)));
  }

  function manualMap(srcUser, destEmail) {
    const destUser = unmappedDest.find((d) => d.email === destEmail);
    if (!destUser) return;
    setMappings((p) => {
      const next = [...p, { source: srcUser, destination: destUser, autoMatched: false }];
      setSelectedIndices((s) => new Set([...s, next.length - 1]));
      return next;
    });
    setUnmappedSource((p) => p.filter((u) => u.id !== srcUser.id));
    setUnmappedDest((p) => p.filter((u) => u.id !== destUser.id));
  }

  function removeMapping(idx) {
    const removed = mappings[idx];
    setMappings((p) => p.filter((_, i) => i !== idx));
    setSelectedIndices((s) => {
      const next = new Set();
      s.forEach((i) => { if (i < idx) next.add(i); else if (i > idx) next.add(i - 1); });
      return next;
    });
    setUnmappedSource((p) => [...p, removed.source]);
    setUnmappedDest((p) => [...p, removed.destination]);
  }

  function togglePair(idx) {
    setSelectedIndices((s) => {
      const next = new Set(s);
      next.has(idx) ? next.delete(idx) : next.add(idx);
      return next;
    });
  }

  function handleConfirm() {
    const selected = mappings.filter((_, i) => selectedIndices.has(i));
    onMappingComplete(selected.map((m) => ({
      sourceEmail: m.source.email, destinationEmail: m.destination.email,
      sourceName: m.source.displayName, destinationName: m.destination.displayName,
      autoMatched: m.autoMatched,
    })));
  }

  // Accounts for each provider
  const srcAccounts = accounts.filter((a) => a.provider === srcProvider);
  const dstAccounts = accounts.filter((a) => a.provider === dstProvider);

  return (
    <div className="space-y-5">
      {/* ── Admin fields ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <AdminField
          label="Source Admin"
          provider={srcProvider}
          email={srcEmail}
          connectedAccounts={srcAccounts}
          accountsLoading={accountsLoading}
          onProviderChange={(p) => { setSrcProvider(p); setSrcEmail(''); setFetched(false); }}
          onEmailChange={setSrcEmail}
          onLogin={() => { setLoginTarget('source'); setOauthError(null); }}
          onSignOut={(email) => handleSignOut(srcProvider, email)}
        />
        <AdminField
          label="Destination Admin"
          provider={dstProvider}
          email={dstEmail}
          connectedAccounts={dstAccounts}
          accountsLoading={accountsLoading}
          onProviderChange={(p) => { setDstProvider(p); setDstEmail(''); setFetched(false); }}
          onEmailChange={setDstEmail}
          onLogin={() => { setLoginTarget('destination'); setOauthError(null); }}
          onSignOut={(email) => handleSignOut(dstProvider, email)}
        />
      </div>

      <button
        type="button"
        onClick={fetchUsers}
        disabled={loading || !srcEmail || !dstEmail}
        className="px-6 py-2.5 bg-gray-900 text-white text-sm font-semibold rounded-lg hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
      >
        {loading ? 'Fetching...' : 'Fetch & Auto-Map Users'}
      </button>

      {error && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-600">{error}</div>}

      {/* ── Results ── */}
      {fetched && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-3 text-sm">
            <Pill color="indigo" text={`${sourceUsers.length} source users`} />
            <Pill color="purple" text={`${destUsers.length} destination users`} />
            <Pill color="green" text={`${mappings.length} auto-mapped`} />
            {unmappedSource.length > 0 && <Pill color="yellow" text={`${unmappedSource.length} unmatched source`} />}
            {unmappedDest.length > 0 && <Pill color="orange" text={`${unmappedDest.length} unmatched destination`} />}
          </div>

          {mappings.length > 0 && (
            <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
              <div className="px-4 py-3 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={selectedIndices.size === mappings.length && mappings.length > 0}
                    ref={(el) => { if (el) el.indeterminate = selectedIndices.size > 0 && selectedIndices.size < mappings.length; }}
                    onChange={(e) => setSelectedIndices(e.target.checked ? new Set(mappings.map((_, i) => i)) : new Set())}
                    className="w-4 h-4 text-indigo-600 border-gray-300 rounded cursor-pointer"
                  />
                  <h3 className="text-sm font-semibold text-gray-900">
                    Mapped Pairs ({selectedIndices.size}/{mappings.length} selected)
                  </h3>
                </div>
              </div>
              <div className="divide-y divide-gray-100 max-h-72 overflow-y-auto">
                {mappings.map((m, idx) => (
                  <div
                    key={idx}
                    onClick={() => togglePair(idx)}
                    className={`px-4 py-2.5 flex items-center gap-3 text-sm cursor-pointer transition-colors ${
                      selectedIndices.has(idx) ? 'bg-indigo-50/50' : 'hover:bg-gray-50'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={selectedIndices.has(idx)}
                      onChange={() => togglePair(idx)}
                      onClick={(e) => e.stopPropagation()}
                      className="w-4 h-4 text-indigo-600 border-gray-300 rounded cursor-pointer flex-shrink-0"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-gray-900 truncate">{m.source.email}</span>
                        <span className="text-gray-400">&rarr;</span>
                        <span className="font-medium text-gray-900 truncate">{m.destination.email}</span>
                      </div>
                      <div className="text-xs text-gray-500 mt-0.5">{m.source.displayName} &rarr; {m.destination.displayName}</div>
                    </div>
                    <span className={'text-xs px-2 py-0.5 rounded-full ' + (m.autoMatched ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700')}>
                      {m.autoMatched ? 'auto' : 'manual'}
                    </span>
                    <button type="button" onClick={(e) => { e.stopPropagation(); removeMapping(idx); }}
                      className="text-gray-400 hover:text-red-500 transition-colors flex-shrink-0">
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {unmappedSource.length > 0 && (
            <div className="bg-white border border-yellow-200 rounded-xl overflow-hidden">
              <div className="px-4 py-3 bg-yellow-50 border-b border-yellow-200">
                <h3 className="text-sm font-semibold text-yellow-800">Unmatched Source Users ({unmappedSource.length})</h3>
                <p className="text-xs text-yellow-600 mt-0.5">Select a destination user to map manually</p>
              </div>
              <div className="divide-y divide-gray-100 max-h-60 overflow-y-auto">
                {unmappedSource.map((s) => (
                  <div key={s.id} className="px-4 py-2.5 flex items-center gap-3 text-sm">
                    <div className="flex-1 min-w-0">
                      <span className="font-medium text-gray-900">{s.email}</span>
                      <span className="text-xs text-gray-500 ml-2">({s.displayName})</span>
                    </div>
                    <span className="text-gray-400">&rarr;</span>
                    <select defaultValue="" onChange={(e) => { if (e.target.value) manualMap(s, e.target.value); }} className="min-w-48 px-3 py-1.5 border border-gray-300 rounded-lg text-sm bg-white focus:ring-2 focus:ring-indigo-500 outline-none">
                      <option value="">Select destination...</option>
                      {unmappedDest.map((d) => (<option key={d.id} value={d.email}>{d.email} ({d.firstName})</option>))}
                    </select>
                  </div>
                ))}
              </div>
            </div>
          )}

          {mappings.length > 0 && (
            <button type="button" onClick={handleConfirm} disabled={selectedIndices.size === 0}
              className="px-6 py-2.5 bg-indigo-600 text-white text-sm font-semibold rounded-lg hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
              Use {selectedIndices.size} Pair{selectedIndices.size !== 1 ? 's' : ''}
            </button>
          )}
        </div>
      )}

      {/* ── Login modal ── */}
      {loginTarget && (
        <LoginModal
          provider={loginTarget === 'source' ? srcProvider : dstProvider}
          loading={oauthLoading}
          error={oauthError}
          googleTenant={googleTenant}
          onGoogleTenantChange={setGoogleTenant}
          msTenant={msTenant}
          onMsTenantChange={setMsTenant}
          onConnect={() => handleLogin(loginTarget)}
          onClose={() => { setLoginTarget(null); setOauthError(null); stopPolling(); popupRef.current?.close(); }}
        />
      )}
    </div>
  );
}

// ─── AdminField ───────────────────────────────────────────────────────────────

function AdminField({ label, provider, email, connectedAccounts, accountsLoading, onProviderChange, onEmailChange, onLogin, onSignOut }) {
  const p = PROVIDERS[provider];
  const Icon = p.icon;
  const count = connectedAccounts.length;
  const hasAccounts = count > 0;

  return (
    <div className="space-y-2">
      {/* Label + count badge */}
      <div className="flex items-center justify-between">
        <label className="block text-sm font-medium text-gray-700">{label}</label>
        {count > 0 && (
          <span className="flex items-center gap-1 text-xs text-emerald-600 font-medium">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
            {count} account{count !== 1 ? 's' : ''} connected
          </span>
        )}
      </div>

      {/* Provider toggle */}
      <div className="flex gap-1.5 p-1 bg-gray-100 rounded-lg">
        {Object.values(PROVIDERS).map((pv) => {
          const PvIcon = pv.icon;
          const pvCount = connectedAccounts.filter ? 0 : 0; // unused but keep pattern
          const active = provider === pv.key;
          return (
            <button
              key={pv.key}
              type="button"
              onClick={() => onProviderChange(pv.key)}
              className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-md text-xs font-medium transition-all ${
                active ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              <PvIcon className="w-3.5 h-3.5" />
              {pv.short}
            </button>
          );
        })}
      </div>

      {/* Connected accounts list with select + disconnect buttons */}
      {!accountsLoading && hasAccounts ? (
        <div className="space-y-1.5">
          {connectedAccounts.map((a) => (
            <div key={a.email} className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => onEmailChange(a.email)}
                className={`flex-1 flex items-center gap-2 px-2.5 py-2 rounded-lg border text-xs text-left transition-colors ${
                  email === a.email
                    ? 'border-indigo-400 bg-indigo-50 text-indigo-700 font-semibold'
                    : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300'
                }`}
              >
                <Icon className="w-3.5 h-3.5 flex-shrink-0" />
                <span className="truncate">{a.email}</span>
                {email === a.email && (
                  <span className="ml-auto w-1.5 h-1.5 rounded-full bg-indigo-500 flex-shrink-0" />
                )}
              </button>
              <button
                type="button"
                onClick={() => onSignOut(a.email)}
                title={`Disconnect ${a.email}`}
                className="flex-shrink-0 p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 border border-transparent hover:border-red-200 transition-colors"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={onLogin}
            className={`w-full flex items-center justify-center gap-1 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${
              provider === 'google'
                ? 'border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100'
                : 'border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100'
            }`}
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            + Add Account
          </button>
        </div>
      ) : (
        <div className="flex gap-2">
          <div className="relative flex-1">
            <div className="absolute left-3 top-1/2 -translate-y-1/2">
              <Icon className="w-3.5 h-3.5" />
            </div>
            <input
              type="email"
              value={email}
              onChange={(e) => onEmailChange(e.target.value)}
              placeholder="admin@company.com"
              className="w-full pl-8 pr-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
            />
          </div>
          <button
            type="button"
            onClick={onLogin}
            title={`Sign in with ${p.label}`}
            className={`flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg border transition-colors flex-shrink-0 ${
              provider === 'google'
                ? 'border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100'
                : 'border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100'
            }`}
          >
            <Icon className="w-3.5 h-3.5" />
            Login
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Login Modal ──────────────────────────────────────────────────────────────

function LoginModal({ provider, loading, error, onConnect, onClose, googleTenant, onGoogleTenantChange, msTenant, onMsTenantChange }) {
  const p = PROVIDERS[provider];
  const Icon = p.icon;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
        <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-900">Connect {p.label}</h2>
          <button onClick={onClose} className="w-7 h-7 rounded-lg hover:bg-gray-100 flex items-center justify-center text-gray-400 hover:text-gray-600">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="px-6 py-6 space-y-5">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-2xl border border-gray-100 bg-gray-50 flex items-center justify-center flex-shrink-0">
              <Icon className="w-8 h-8" />
            </div>
            <div>
              <p className="text-sm font-semibold text-gray-900">{p.label}</p>
              <p className="text-xs text-gray-500 mt-0.5">Sign in as an admin to fetch and auto-map users</p>
            </div>
          </div>
          <ol className="space-y-2 text-xs text-gray-600">
            {['A sign-in window will open', `Select your ${p.short} admin account`, 'Grant the requested permissions', 'Your admin email is auto-filled'].map((t, i) => (
              <li key={i} className="flex items-start gap-2.5 list-none">
                <span className="w-4 h-4 rounded-full bg-indigo-100 text-indigo-700 text-[10px] font-bold flex items-center justify-center flex-shrink-0 mt-0.5">{i + 1}</span>
                <span>{t}</span>
              </li>
            ))}
          </ol>
          {provider === 'google' && (
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-gray-500 flex-shrink-0">Google tenant:</span>
              <select
                value={googleTenant}
                onChange={(e) => onGoogleTenantChange(e.target.value)}
                className="flex-1 text-xs rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-400"
              >
                <option value="1">cloudfuze.us</option>
                <option value="2">storefuze.com</option>
              </select>
            </div>
          )}
          {provider === 'microsoft' && (
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-gray-500 flex-shrink-0">Microsoft tenant:</span>
              <select
                value={msTenant}
                onChange={(e) => onMsTenantChange(e.target.value)}
                className="flex-1 text-xs rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-400"
              >
                <option value="1">gajha.com</option>
                <option value="2">filefuze.co</option>
              </select>
            </div>
          )}
          {error && <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-xs text-red-700">{error}</div>}
        </div>
        <div className="px-6 pb-6 flex gap-3">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 transition-colors">Cancel</button>
          <button onClick={onConnect} disabled={loading}
            className={`flex-1 py-2.5 rounded-xl text-sm font-semibold text-white flex items-center justify-center gap-2 disabled:opacity-50 transition-colors ${provider === 'google' ? 'bg-blue-600 hover:bg-blue-700' : 'bg-indigo-600 hover:bg-indigo-700'}`}>
            {loading
              ? <><svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>Waiting…</>
              : <><Icon className="w-3.5 h-3.5" />Sign in</>}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function Pill({ color, text }) {
  const colors = { indigo: 'bg-indigo-50 text-indigo-700', purple: 'bg-purple-50 text-purple-700', green: 'bg-green-50 text-green-700', yellow: 'bg-yellow-50 text-yellow-700', orange: 'bg-orange-50 text-orange-700' };
  return <span className={`${colors[color]} px-3 py-1 rounded-full font-medium`}>{text}</span>;
}

function GoogleIcon({ className }) {
  return (
    <svg viewBox="0 0 48 48" className={className}>
      <path fill="#4285F4" d="M46.145 24.504c0-1.613-.134-3.167-.389-4.658H24v8.814h12.449c-.537 2.895-2.168 5.348-4.62 6.994v5.816h7.48c4.376-4.03 6.836-9.968 6.836-16.966z" />
      <path fill="#34A853" d="M24 48c6.24 0 11.473-2.065 15.298-5.597l-7.48-5.816c-2.072 1.39-4.724 2.21-7.818 2.21-6.012 0-11.1-4.062-12.921-9.516H3.324v6.009A23.998 23.998 0 0024 48z" />
      <path fill="#FBBC05" d="M11.079 29.281A14.416 14.416 0 0110.25 24c0-1.837.316-3.619.829-5.281v-6.009H3.324A23.998 23.998 0 000 24c0 3.867.927 7.53 2.563 10.71l8.516-5.429z" />
      <path fill="#EA4335" d="M24 9.503c3.387 0 6.428 1.164 8.82 3.451l6.615-6.615C35.469 2.378 30.24 0 24 0A23.998 23.998 0 002.563 13.29l8.516 6.429C12.9 13.565 17.988 9.503 24 9.503z" />
    </svg>
  );
}

function MicrosoftIcon({ className }) {
  return (
    <svg viewBox="0 0 23 23" className={className}>
      <rect x="1" y="1" width="10" height="10" fill="#F25022" />
      <rect x="12" y="1" width="10" height="10" fill="#7FBA00" />
      <rect x="1" y="12" width="10" height="10" fill="#00A4EF" />
      <rect x="12" y="12" width="10" height="10" fill="#FFB900" />
    </svg>
  );
}
