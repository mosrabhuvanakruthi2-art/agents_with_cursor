import { useState, useEffect, useRef, useCallback } from 'react';
import {
  getSourceUsers,
  getDestinationUsers,
  getGoogleOAuthUrl,
  getMicrosoftOAuthUrl,
  getConnectedAccounts,
  signOutGoogle,
  signOutMicrosoft,
} from '../services/api';
import usePersistedState from '../hooks/usePersistedState';

/**
 * Message migration: UI uses Slack | Teams | Google Chat.
 * API mapping: Teams → microsoft Graph, Google Chat → google Workspace directory.
 * Slack: no user-directory API in this app — manual pair entry only.
 */
const MSG_PROVIDERS = {
  slack: {
    key: 'slack',
    label: 'Slack',
    short: 'Slack',
    apiKey: null,
    icon: SlackIcon,
    color: '#4A154B',
  },
  teams: {
    key: 'teams',
    label: 'Microsoft Teams',
    short: 'Teams',
    apiKey: 'microsoft',
    icon: TeamsIcon,
    color: '#6264A7',
  },
  googleChat: {
    key: 'googleChat',
    label: 'Google Chat',
    short: 'Chat',
    apiKey: 'google',
    icon: GoogleChatIcon,
    color: '#00832D',
  },
};

const POPUP_KEY = 'cf_oauth_result';

function openOAuthPopup(url) {
  const w = 520;
  const h = 680;
  const left = Math.round(window.screenX + (window.outerWidth - w) / 2);
  const top = Math.round(window.screenY + (window.outerHeight - h) / 2);
  return window.open(url, 'cf_oauth', `width=${w},height=${h},left=${left},top=${top},toolbar=no,menubar=no`);
}

export default function MessageUserMapping({ onMappingComplete }) {
  const [srcProvider, setSrcProvider] = usePersistedState('msg-map-src', 'slack');
  const [dstProvider, setDstProvider] = usePersistedState('msg-map-dst', 'teams');
  const [srcEmail, setSrcEmail] = usePersistedState('msg-map-srcAdmin', '');
  const [dstEmail, setDstEmail] = usePersistedState('msg-map-dstAdmin', '');

  const [sourceUsers, setSourceUsers] = usePersistedState('msg-map-srcUsers', []);
  const [destUsers, setDestUsers] = usePersistedState('msg-map-destUsers', []);
  const [mappings, setMappings] = usePersistedState('msg-map-mappings', []);
  const [unmappedSource, setUnmappedSource] = usePersistedState('msg-map-unmapSrc', []);
  const [unmappedDest, setUnmappedDest] = usePersistedState('msg-map-unmapDest', []);
  const [selectedIndices, setSelectedIndices] = useState(() => new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [fetched, setFetched] = usePersistedState('msg-map-fetched', false);

  const [manualPairs, setManualPairs] = useState([{ sourceEmail: '', destinationEmail: '' }]);
  const [accounts, setAccounts] = useState([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [loginTarget, setLoginTarget] = useState(null);
  const [oauthLoading, setOauthLoading] = useState(false);
  const [oauthError, setOauthError] = useState(null);
  const [googleTenant, setGoogleTenant] = useState('1');
  const [msTenant, setMsTenant] = useState('1');
  const pollRef = useRef(null);
  const popupRef = useRef(null);

  const needsManualOnly = srcProvider === 'slack' || dstProvider === 'slack';

  const loadAccounts = useCallback(async () => {
    try {
      const res = await getConnectedAccounts();
      setAccounts(res.data.accounts || []);
    } catch {
      /* ignore */
    } finally {
      setAccountsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAccounts();
  }, [loadAccounts]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const startPolling = useCallback(
    (providerKey, onSuccess) => {
      localStorage.removeItem(POPUP_KEY);
      pollRef.current = setInterval(() => {
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
              loadAccounts();
            } else if (result.error) {
              setOauthError(result.message || result.error);
            }
          } catch {
            /* ignore */
          }
          setOauthLoading(false);
          return;
        }
        if (popupRef.current?.closed) {
          stopPolling();
          setOauthLoading(false);
        }
      }, 500);
      setTimeout(() => {
        stopPolling();
        setOauthLoading(false);
      }, 300000);
    },
    [stopPolling, loadAccounts]
  );

  async function handleSignOut(provider, email) {
    try {
      if (provider === 'google') await signOutGoogle(email);
      else await signOutMicrosoft(email);
      await loadAccounts();
    } catch {
      /* ignore */
    }
  }

  async function handleLogin(target) {
    const msgPv = target === 'source' ? srcProvider : dstProvider;
    const oauthProvider = msgPv === 'googleChat' ? 'google' : msgPv === 'teams' ? 'microsoft' : null;
    if (!oauthProvider) return;
    setOauthError(null);
    setOauthLoading(true);
    try {
      const getFn = oauthProvider === 'google' ? getGoogleOAuthUrl : getMicrosoftOAuthUrl;
      const tenant = oauthProvider === 'google' ? googleTenant : msTenant;
      const res = await getFn('popup', tenant);
      popupRef.current = openOAuthPopup(res.data.url);
      startPolling(oauthProvider, (email) => {
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

  async function fetchUsers() {
    const srcApi = MSG_PROVIDERS[srcProvider].apiKey;
    const dstApi = MSG_PROVIDERS[dstProvider].apiKey;
    if (!srcEmail || !dstEmail || !srcApi || !dstApi) return;
    setLoading(true);
    setError(null);
    setFetched(false);
    setMappings([]);
    setUnmappedSource([]);
    setUnmappedDest([]);
    try {
      const [srcRes, destRes] = await Promise.all([
        getSourceUsers(srcEmail, srcApi),
        getDestinationUsers(dstEmail, dstApi),
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
    const mapped = [];
    const usedDest = new Set();
    const unmatched = [];
    for (const s of src) {
      const f = (s.firstName || '').toLowerCase().trim();
      if (!f) {
        unmatched.push(s);
        continue;
      }
      const m = dest.find(
        (d) => !usedDest.has(d.id) && (d.firstName || '').toLowerCase().trim() === f
      );
      if (m) {
        mapped.push({ source: s, destination: m, autoMatched: true });
        usedDest.add(m.id);
      } else unmatched.push(s);
    }
    setMappings(mapped);
    setSelectedIndices(new Set(mapped.map((_, i) => i)));
    setUnmappedSource(unmatched);
    setUnmappedDest(dest.filter((d) => !usedDest.has(d.id)));
  }

  function manualMap(srcUser, destEmailStr) {
    const destUser = unmappedDest.find((d) => d.email === destEmailStr);
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
      s.forEach((i) => {
        if (i < idx) next.add(i);
        else if (i > idx) next.add(i - 1);
      });
      return next;
    });
    setUnmappedSource((p) => [...p, removed.source]);
    setUnmappedDest((p) => [...p, removed.destination]);
  }

  function togglePair(idx) {
    setSelectedIndices((s) => {
      const next = new Set(s);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }

  function handleConfirmAuto() {
    const selected = mappings.filter((_, i) => selectedIndices.has(i));
    onMappingComplete(
      selected.map((m) => ({
        sourceEmail: m.source.email,
        destinationEmail: m.destination.email,
        sourceName: m.source.displayName,
        destinationName: m.destination.displayName,
        autoMatched: m.autoMatched,
      }))
    );
  }

  function handleConfirmManual() {
    const pairs = manualPairs.filter((p) => p.sourceEmail?.trim() && p.destinationEmail?.trim());
    if (pairs.length === 0) {
      setError('Enter at least one source and destination email pair.');
      return;
    }
    setError(null);
    onMappingComplete(
      pairs.map((p) => ({
        sourceEmail: p.sourceEmail.trim(),
        destinationEmail: p.destinationEmail.trim(),
        sourceName: p.sourceEmail.trim(),
        destinationName: p.destinationEmail.trim(),
        autoMatched: false,
      }))
    );
  }

  const srcAccounts = accounts.filter(
    (a) => a.provider === (srcProvider === 'googleChat' ? 'google' : srcProvider === 'teams' ? 'microsoft' : '')
  );
  const dstAccounts = accounts.filter(
    (a) => a.provider === (dstProvider === 'googleChat' ? 'google' : dstProvider === 'teams' ? 'microsoft' : '')
  );

  return (
    <div className="space-y-5">
      <p className="text-xs" style={{ color: '#4a65c0' }}>
        Choose <strong>Slack</strong>, <strong>Teams</strong>, or <strong>Google Chat</strong> per side. Teams and Chat use Microsoft / Google sign-in to list users. Slack has no directory sync here — use{' '}
        <strong>manual pairs</strong> when Slack is selected.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <MessageAdminField
          label="Source"
          messageProvider={srcProvider}
          email={srcEmail}
          connectedAccounts={srcAccounts}
          accountsLoading={accountsLoading}
          onProviderChange={(p) => {
            setSrcProvider(p);
            setSrcEmail('');
            setFetched(false);
          }}
          onEmailChange={setSrcEmail}
          onLogin={() => {
            setLoginTarget('source');
            setOauthError(null);
          }}
          onSignOut={(email) =>
            handleSignOut(srcProvider === 'googleChat' ? 'google' : 'microsoft', email)
          }
        />
        <MessageAdminField
          label="Destination"
          messageProvider={dstProvider}
          email={dstEmail}
          connectedAccounts={dstAccounts}
          accountsLoading={accountsLoading}
          onProviderChange={(p) => {
            setDstProvider(p);
            setDstEmail('');
            setFetched(false);
          }}
          onEmailChange={setDstEmail}
          onLogin={() => {
            setLoginTarget('destination');
            setOauthError(null);
          }}
          onSignOut={(email) =>
            handleSignOut(dstProvider === 'googleChat' ? 'google' : 'microsoft', email)
          }
        />
      </div>

      {needsManualOnly ? (
        <div className="rounded-xl p-4 space-y-3" style={{ border: '1px solid #c5cef5', backgroundColor: '#fff' }}>
          <h4 className="text-sm font-semibold" style={{ color: '#0129ac' }}>
            Manual migration pairs (Slack)
          </h4>
          <p className="text-xs" style={{ color: '#4a65c0' }}>
            Enter source and destination user emails for each row. These are used as CloudFuze / seed identities (same as auto-map output).
          </p>
          {manualPairs.map((row, idx) => (
            <div key={idx} className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-center">
              <input
                type="email"
                placeholder="source user @ email"
                value={row.sourceEmail}
                onChange={(e) => {
                  const next = [...manualPairs];
                  next[idx] = { ...next[idx], sourceEmail: e.target.value };
                  setManualPairs(next);
                }}
                className="flex-1 px-3 py-2 rounded-lg border text-sm outline-none"
                style={{ borderColor: '#c5cef5', color: '#0129ac' }}
              />
              <span className="text-center text-gray-400 hidden sm:inline">→</span>
              <input
                type="email"
                placeholder="destination user @ email"
                value={row.destinationEmail}
                onChange={(e) => {
                  const next = [...manualPairs];
                  next[idx] = { ...next[idx], destinationEmail: e.target.value };
                  setManualPairs(next);
                }}
                className="flex-1 px-3 py-2 rounded-lg border text-sm outline-none"
                style={{ borderColor: '#c5cef5', color: '#0129ac' }}
              />
              {manualPairs.length > 1 && (
                <button
                  type="button"
                  className="text-xs px-2 py-1 rounded text-red-600 hover:bg-red-50"
                  onClick={() => setManualPairs((p) => p.filter((_, i) => i !== idx))}
                >
                  Remove
                </button>
              )}
            </div>
          ))}
          <button
            type="button"
            onClick={() => setManualPairs((p) => [...p, { sourceEmail: '', destinationEmail: '' }])}
            className="text-xs font-semibold px-3 py-1.5 rounded-lg border"
            style={{ borderColor: '#c5cef5', color: '#0129ac' }}
          >
            + Add pair
          </button>
          {error && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">{error}</div>
          )}
          <button
            type="button"
            onClick={handleConfirmManual}
            className="px-6 py-2.5 text-white text-sm font-semibold rounded-lg"
            style={{ backgroundColor: '#0129ac' }}
          >
            Use manual pair{manualPairs.filter((p) => p.sourceEmail && p.destinationEmail).length !== 1 ? 's' : ''}
          </button>
        </div>
      ) : (
        <>
          <button
            type="button"
            onClick={fetchUsers}
            disabled={loading || !srcEmail || !dstEmail}
            className="px-6 py-2.5 text-white text-sm font-semibold rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            style={{ backgroundColor: '#0129ac' }}
          >
            {loading ? 'Fetching...' : 'Fetch & Auto-Map Users'}
          </button>

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-600">{error}</div>
          )}

          {fetched && (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-3 text-sm">
                <Pill color="indigo" text={`${sourceUsers.length} source users`} />
                <Pill color="purple" text={`${destUsers.length} destination users`} />
                <Pill color="green" text={`${mappings.length} auto-mapped`} />
                {unmappedSource.length > 0 && (
                  <Pill color="yellow" text={`${unmappedSource.length} unmatched source`} />
                )}
                {unmappedDest.length > 0 && (
                  <Pill color="orange" text={`${unmappedDest.length} unmatched destination`} />
                )}
              </div>

              {mappings.length > 0 && (
                <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
                  <div className="px-4 py-3 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={selectedIndices.size === mappings.length && mappings.length > 0}
                        ref={(el) => {
                          if (el) {
                            el.indeterminate =
                              selectedIndices.size > 0 && selectedIndices.size < mappings.length;
                          }
                        }}
                        onChange={(e) =>
                          setSelectedIndices(
                            e.target.checked ? new Set(mappings.map((_, i) => i)) : new Set()
                          )
                        }
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
                            <span className="text-gray-400">→</span>
                            <span className="font-medium text-gray-900 truncate">{m.destination.email}</span>
                          </div>
                          <div className="text-xs text-gray-500 mt-0.5">
                            {m.source.displayName} → {m.destination.displayName}
                          </div>
                        </div>
                        <span
                          className={
                            'text-xs px-2 py-0.5 rounded-full ' +
                            (m.autoMatched ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700')
                          }
                        >
                          {m.autoMatched ? 'auto' : 'manual'}
                        </span>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeMapping(idx);
                          }}
                          className="text-gray-400 hover:text-red-500 transition-colors flex-shrink-0"
                        >
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {unmappedSource.length > 0 && (
                <div className="bg-white border border-yellow-200 rounded-xl overflow-hidden">
                  <div className="px-4 py-3 bg-yellow-50 border-b border-yellow-200">
                    <h3 className="text-sm font-semibold text-yellow-800">
                      Unmatched Source Users ({unmappedSource.length})
                    </h3>
                    <p className="text-xs text-yellow-600 mt-0.5">Map manually to a destination user</p>
                  </div>
                  <div className="divide-y divide-gray-100 max-h-60 overflow-y-auto">
                    {unmappedSource.map((s) => (
                      <div key={s.id} className="px-4 py-2.5 flex items-center gap-3 text-sm">
                        <div className="flex-1 min-w-0">
                          <span className="font-medium text-gray-900">{s.email}</span>
                          <span className="text-xs text-gray-500 ml-2">({s.displayName})</span>
                        </div>
                        <span className="text-gray-400">→</span>
                        <select
                          defaultValue=""
                          onChange={(e) => {
                            if (e.target.value) manualMap(s, e.target.value);
                          }}
                          className="min-w-48 px-3 py-1.5 border border-gray-300 rounded-lg text-sm bg-white focus:ring-2 focus:ring-indigo-500 outline-none"
                        >
                          <option value="">Select destination...</option>
                          {unmappedDest.map((d) => (
                            <option key={d.id} value={d.email}>
                              {d.email} ({d.firstName})
                            </option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {mappings.length > 0 && (
                <button
                  type="button"
                  onClick={handleConfirmAuto}
                  disabled={selectedIndices.size === 0}
                  className="px-6 py-2.5 bg-indigo-600 text-white text-sm font-semibold rounded-lg hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Use {selectedIndices.size} Pair{selectedIndices.size !== 1 ? 's' : ''}
                </button>
              )}
            </div>
          )}
        </>
      )}

      {loginTarget && (
        <LoginModal
          messageProvider={loginTarget === 'source' ? srcProvider : dstProvider}
          loading={oauthLoading}
          error={oauthError}
          googleTenant={googleTenant}
          onGoogleTenantChange={setGoogleTenant}
          msTenant={msTenant}
          onMsTenantChange={setMsTenant}
          onConnect={() => handleLogin(loginTarget)}
          onClose={() => {
            setLoginTarget(null);
            setOauthError(null);
            stopPolling();
            popupRef.current?.close();
          }}
        />
      )}
    </div>
  );
}

function MessageAdminField({
  label,
  messageProvider,
  email,
  connectedAccounts,
  accountsLoading,
  onProviderChange,
  onEmailChange,
  onLogin,
  onSignOut,
}) {
  const p = MSG_PROVIDERS[messageProvider];
  const Icon = p.icon;
  const oauthReady = messageProvider === 'teams' || messageProvider === 'googleChat';
  const hasAccounts = connectedAccounts.length > 0;

  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium" style={{ color: '#0129ac' }}>
        {label} — platform
      </label>
      <div className="flex gap-1.5 p-1 rounded-lg" style={{ backgroundColor: '#eef1fb' }}>
        {Object.values(MSG_PROVIDERS).map((pv) => {
          const PvIcon = pv.icon;
          const active = messageProvider === pv.key;
          return (
            <button
              key={pv.key}
              type="button"
              onClick={() => onProviderChange(pv.key)}
              className="flex-1 flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-md text-xs font-medium transition-all"
              style={{
                backgroundColor: active ? '#fff' : 'transparent',
                color: active ? '#0129ac' : '#4a65c0',
                boxShadow: active ? '0 1px 4px rgba(1,41,172,0.15)' : 'none',
                fontWeight: active ? 600 : 400,
              }}
            >
              <PvIcon className="w-4 h-4 flex-shrink-0" />
              <span>{pv.short}</span>
            </button>
          );
        })}
      </div>

      {messageProvider === 'slack' && (
        <p className="text-[11px] rounded-lg p-2" style={{ backgroundColor: '#faf5fb', color: '#4a154b' }}>
          Slack workspace admin email (for records). User pairs are entered manually below — Slack directory API is not connected here.
        </p>
      )}

      {!accountsLoading && oauthReady && hasAccounts ? (
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
            className="w-full flex items-center justify-center gap-1 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors"
            style={{ borderColor: '#c5cef5', color: '#0129ac' }}
          >
            + Add {p.label} account
          </button>
        </div>
      ) : !accountsLoading && oauthReady ? (
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
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg border flex-shrink-0"
            style={{ borderColor: '#c5cef5', color: '#0129ac', backgroundColor: '#fff' }}
          >
            <Icon className="w-3.5 h-3.5" />
            Login
          </button>
        </div>
      ) : oauthReady ? (
        <div className="text-xs text-gray-500">Loading accounts…</div>
      ) : (
        <div className="relative">
          <div className="absolute left-3 top-1/2 -translate-y-1/2">
            <Icon className="w-3.5 h-3.5" />
          </div>
          <input
            type="email"
            value={email}
            onChange={(e) => onEmailChange(e.target.value)}
            placeholder="workspace primary owner / admin"
            className="w-full pl-8 pr-3 py-2.5 border border-gray-300 rounded-lg text-sm outline-none"
          />
        </div>
      )}
    </div>
  );
}

function LoginModal({
  messageProvider,
  loading,
  error,
  onConnect,
  onClose,
  googleTenant,
  onGoogleTenantChange,
  msTenant,
  onMsTenantChange,
}) {
  const p = MSG_PROVIDERS[messageProvider];
  const Icon = p.icon;
  const oauth = messageProvider === 'googleChat' ? 'google' : 'microsoft';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
        <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-900">Connect {p.label}</h2>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-lg hover:bg-gray-100 flex items-center justify-center text-gray-400 hover:text-gray-600"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="px-6 py-6 space-y-5">
          <div className="flex items-center gap-4">
            <div
              className="w-14 h-14 rounded-2xl border flex items-center justify-center flex-shrink-0"
              style={{ borderColor: '#eef1fb', backgroundColor: '#f8fafc' }}
            >
              <Icon className="w-8 h-8" />
            </div>
            <div>
              <p className="text-sm font-semibold text-gray-900">{p.label}</p>
              <p className="text-xs text-gray-500 mt-0.5">
                Sign in with the {oauth === 'google' ? 'Google Workspace' : 'Microsoft 365'} admin used for directory lookup
              </p>
            </div>
          </div>
          {messageProvider === 'googleChat' && (
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
          {messageProvider === 'teams' && (
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
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-xs text-red-700">{error}</div>
          )}
        </div>
        <div className="px-6 pb-6 flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConnect}
            disabled={loading}
            className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-white flex items-center justify-center gap-2 disabled:opacity-50 transition-colors"
            style={{ backgroundColor: '#0129ac' }}
          >
            {loading ? (
              <>
                <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                  />
                </svg>
                Waiting…
              </>
            ) : (
              <>
                <Icon className="w-3.5 h-3.5" />
                Sign in
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function Pill({ color, text }) {
  const colors = {
    indigo: 'bg-indigo-50 text-indigo-700',
    purple: 'bg-purple-50 text-purple-700',
    green: 'bg-green-50 text-green-700',
    yellow: 'bg-yellow-50 text-yellow-700',
    orange: 'bg-orange-50 text-orange-700',
  };
  return <span className={`${colors[color]} px-3 py-1 rounded-full font-medium`}>{text}</span>;
}

function SlackIcon({ className }) {
  return (
    <svg viewBox="0 0 270 270" className={className} xmlns="http://www.w3.org/2000/svg">
      <g fill="none" fillRule="evenodd">
        <g fill="#2EB67D">
          <path d="M99.4 151.2c0 7.1-5.8 12.9-12.9 12.9-7.1 0-12.9-5.8-12.9-12.9 0-7.1 5.8-12.9 12.9-12.9h12.9v12.9z"/>
          <path d="M105.9 151.2c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9v32.3c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9v-32.3z"/>
        </g>
        <g fill="#E01E5A">
          <path d="M118.8 99c-7.1 0-12.9-5.8-12.9-12.9 0-7.1 5.8-12.9 12.9-12.9 7.1 0 12.9 5.8 12.9 12.9V99h-12.9z"/>
          <path d="M118.8 105.5c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H86.5c-7.1 0-12.9-5.8-12.9-12.9s5.8-12.9 12.9-12.9h32.3z"/>
        </g>
        <g fill="#ECB22E">
          <path d="M170.6 118.4c0-7.1 5.8-12.9 12.9-12.9 7.1 0 12.9 5.8 12.9 12.9 0 7.1-5.8 12.9-12.9 12.9h-12.9v-12.9z"/>
          <path d="M164.1 118.4c0 7.1-5.8 12.9-12.9 12.9-7.1 0-12.9-5.8-12.9-12.9V86.1c0-7.1 5.8-12.9 12.9-12.9 7.1 0 12.9 5.8 12.9 12.9v32.3z"/>
        </g>
        <g fill="#36C5F0">
          <path d="M151.2 170.6c7.1 0 12.9 5.8 12.9 12.9 0 7.1-5.8 12.9-12.9 12.9-7.1 0-12.9-5.8-12.9-12.9v-12.9h12.9z"/>
          <path d="M151.2 164.1c-7.1 0-12.9-5.8-12.9-12.9 0-7.1 5.8-12.9 12.9-12.9h32.3c7.1 0 12.9 5.8 12.9 12.9 0 7.1-5.8 12.9-12.9 12.9h-32.3z"/>
        </g>
      </g>
    </svg>
  );
}

function TeamsIcon({ className }) {
  return (
    <svg viewBox="0 0 48 48" className={className} xmlns="http://www.w3.org/2000/svg">
      <circle fill="#7B83EB" cx="18" cy="9" r="7"/>
      <path fill="#7B83EB" d="M28 20H8a2 2 0 0 0-2 2v14a11 11 0 0 0 22 0V22a2 2 0 0 0-2-2z"/>
      <path fill="#fff" d="M20 20h-4v2h2v12h2V22h2v-2h-2z" opacity=".9"/>
      <circle fill="#5059C9" cx="36" cy="11" r="5"/>
      <path fill="#5059C9" d="M44 22h-8a2 2 0 0 0-2 2v9.5A7.5 7.5 0 0 0 41.5 41 7.5 7.5 0 0 0 46 34V24a2 2 0 0 0-2-2z"/>
    </svg>
  );
}

function GoogleChatIcon({ className }) {
  return (
    <svg viewBox="0 0 48 48" className={className} xmlns="http://www.w3.org/2000/svg">
      <path fill="#1A73E8" d="M44 24c0 11.05-8.95 20-20 20-3.08 0-5.99-.7-8.59-1.95L6 44v-7.41A19.93 19.93 0 0 1 4 24C4 12.95 12.95 4 24 4s20 8.95 20 20z"/>
      <rect fill="#fff" x="14" y="20" width="20" height="3" rx="1.5"/>
      <rect fill="#fff" x="14" y="27" width="14" height="3" rx="1.5"/>
    </svg>
  );
}
