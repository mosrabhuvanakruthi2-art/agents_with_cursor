import { useState, useEffect, useRef, useCallback } from 'react';
import {
  getSourceUsers, getDestinationUsers,
  getGoogleOAuthUrl, getMicrosoftOAuthUrl, getSlackOAuthUrl,
  getConnectedAccounts, signOutGoogle, signOutMicrosoft, signOutSlack,
  connectSlackToken, connectMicrosoftAdmin,
} from '../services/api';
import usePersistedState from '../hooks/usePersistedState';

// ─── Provider config ──────────────────────────────────────────────────────────

const PROVIDERS = {
  google: { key: 'google', label: 'Google Workspace', short: 'Google', icon: GoogleIcon },
  microsoft: { key: 'microsoft', label: 'Microsoft 365', short: 'Microsoft', icon: MicrosoftIcon },
  slack: { key: 'slack', label: 'Slack Cloud', short: 'Slack', icon: SlackIcon },
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

export default function UserMapping({
  onMappingComplete,
  includeSlack = false,
  onSourceProviderChange,
  srcProviderOverride,
  dstProviderOverride,
  agent = 'message',
}) {
  const pk = agent === 'mail' ? 'mail-' : includeSlack ? 'msg-' : '';

  // Default providers derived from the override; fall back to persisted value.
  const [srcProvider, setSrcProvider] = usePersistedState(
    `${pk}map-srcProvider`,
    srcProviderOverride || 'google'
  );
  const [dstProvider, setDstProvider] = usePersistedState(
    `${pk}map-dstProvider`,
    dstProviderOverride || 'microsoft'
  );

  useEffect(() => {
    onSourceProviderChange?.(srcProvider);
  }, [srcProvider, onSourceProviderChange]);

  const [srcEmail, setSrcEmail] = usePersistedState(`${pk}map-srcAdmin`, '');
  const [dstEmail, setDstEmail] = usePersistedState(`${pk}map-destAdmin`, '');

  const [sourceUsers, setSourceUsers] = usePersistedState(`${pk}map-srcUsers`, []);
  const [destUsers, setDestUsers] = usePersistedState(`${pk}map-destUsers`, []);
  const [mappings, setMappings] = usePersistedState(`${pk}map-mappings`, []);
  const [unmappedSource, setUnmappedSource] = usePersistedState(`${pk}map-unmapSrc`, []);
  const [unmappedDest, setUnmappedDest] = usePersistedState(`${pk}map-unmapDest`, []);
  const [selectedIndices, setSelectedIndices] = useState(() => new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [fetched, setFetched] = usePersistedState(`${pk}map-fetched`, false);

  // When the combination changes (parent passes new override), reset to the correct
  // provider and clear stale user data so the new combination starts fresh.
  const VALID = ['google', 'microsoft', 'slack'];

  useEffect(() => {
    if (!srcProviderOverride || !VALID.includes(srcProviderOverride)) return;
    if (srcProviderOverride === srcProvider) return;
    setSrcProvider(srcProviderOverride);
    setSrcEmail('');
    setSourceUsers([]);
    setMappings([]);
    setUnmappedSource([]);
    setUnmappedDest([]);
    setFetched(false);
  }, [srcProviderOverride]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!dstProviderOverride || !VALID.includes(dstProviderOverride)) return;
    if (dstProviderOverride === dstProvider) return;
    setDstProvider(dstProviderOverride);
    setDstEmail('');
    setDestUsers([]);
    setMappings([]);
    setUnmappedSource([]);
    setUnmappedDest([]);
    setFetched(false);
  }, [dstProviderOverride]); // eslint-disable-line react-hooks/exhaustive-deps

  // connected accounts (from backend)
  const [accounts, setAccounts] = useState([]);  // [{ provider, email, connectedAt }]
  const [accountsLoading, setAccountsLoading] = useState(true);

  // Auto-select the first connected account when email is empty (on load or provider change).
  // When src and dst use the same provider (e.g. Teams → Teams), pick different accounts
  // so they don't conflict: source gets the first, destination gets the second.
  useEffect(() => {
    const acc = accounts.find((a) => a.provider === srcProvider);
    if (acc && !srcEmail) setSrcEmail(acc.email);
  }, [accounts, srcProvider]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const sameProvider = dstProvider === srcProvider;
    const acc = accounts.find(
      (a) => a.provider === dstProvider && (!sameProvider || a.email !== srcEmail)
    );
    if (acc && !dstEmail) setDstEmail(acc.email);
  }, [accounts, dstProvider, srcEmail]); // eslint-disable-line react-hooks/exhaustive-deps

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
      const res = await getConnectedAccounts(agent);
      const list = res?.data?.accounts;
      setAccounts(Array.isArray(list) ? list : []);
    } catch {
      setAccounts([]);
    } finally {
      setAccountsLoading(false);
    }
  }, [agent]);

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
      else if (provider === 'slack') await signOutSlack(email);
      else await signOutMicrosoft(email);
      await loadAccounts();
    } catch { /* ignore */ }
  }

  async function handleLogin(target) {
    const providerKey = target === 'source' ? srcProvider : dstProvider;
    setOauthError(null);
    setOauthLoading(true);
    try {
      let res;
      if (providerKey === 'slack') {
        res = await getSlackOAuthUrl('popup', agent);
        if (res?.data?.alreadyConnected) {
          await loadAccounts();
          setLoginTarget(null);
          setOauthLoading(false);
          return;
        }
      } else if (providerKey === 'google') {
        res = await getGoogleOAuthUrl('popup', googleTenant, agent);
      } else {
        res = await getMicrosoftOAuthUrl('popup', msTenant, agent);
      }
      const authUrl = res?.data?.url;
      if (!authUrl) {
        throw new Error(res?.data?.error || 'OAuth URL not returned. Is the backend running on port 5000?');
      }
      popupRef.current = openOAuthPopup(authUrl);
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

  async function handleSlackTokenPaste(target, token) {
    setOauthError(null);
    setOauthLoading(true);
    try {
      const res = await connectSlackToken(token, agent);
      const email = res?.data?.email;
      if (!email) throw new Error('Token accepted but no email returned');
      if (target === 'source') setSrcEmail(email);
      else setDstEmail(email);
      await loadAccounts();
      setLoginTarget(null);
    } catch (err) {
      setOauthError(err.response?.data?.error || err.message);
    } finally {
      setOauthLoading(false);
    }
  }

  async function handleMicrosoftAdminConnect(target, email) {
    setOauthError(null);
    setOauthLoading(true);
    try {
      const res = await connectMicrosoftAdmin(email, msTenant, agent);
      const connectedEmail = res?.data?.email || email;
      if (target === 'source') setSrcEmail(connectedEmail);
      else setDstEmail(connectedEmail);
      await loadAccounts();
      setLoginTarget(null);
    } catch (err) {
      setOauthError(err.response?.data?.error || err.message);
    } finally {
      setOauthLoading(false);
    }
  }

  useEffect(() => () => stopPolling(), [stopPolling]);

  // ─── User mapping ─────────────────────────────────────────────────────────────

  // Build a user-shaped entry for an admin account (used to inject admin→admin pairs).
  function adminAsUser(email, provider) {
    const local = (email || '').split('@')[0] || '';
    const parts = local.replace(/[._-]+/g, ' ').trim().split(/\s+/);
    const firstName = parts[0] ? parts[0][0].toUpperCase() + parts[0].slice(1).toLowerCase() : '';
    const lastName = parts.slice(1).join(' ');
    return {
      id: `admin:${provider}:${email}`,
      email,
      firstName,
      lastName,
      displayName: firstName + (lastName ? ` ${lastName}` : ''),
      role: 'admin',
      _adminProvider: provider,
    };
  }

  // Union helper — dedup by email (case-insensitive).
  function unionUsersByEmail(lists) {
    const seen = new Set();
    const out = [];
    for (const list of lists) {
      for (const u of list || []) {
        const key = (u?.email || u?.id || '').toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(u);
      }
    }
    return out;
  }

  async function fetchUsers() {
    // Allow either the active admin field OR any connected accounts on that side.
    const srcAdminEmails = Array.from(new Set(
      [srcEmail, ...srcAccounts.map((a) => a.email)].filter(Boolean)
    ));
    const dstAdminEmails = Array.from(new Set(
      [dstEmail, ...dstAccounts.map((a) => a.email)].filter(Boolean)
    ));
    if (srcAdminEmails.length === 0 || dstAdminEmails.length === 0) return;

    setLoading(true);
    setError(null);
    setFetched(false);
    setMappings([]);
    setUnmappedSource([]);
    setUnmappedDest([]);
    try {
      // Fetch users for every connected admin on each side, then union.
      const [srcLists, dstLists] = await Promise.all([
        Promise.all(srcAdminEmails.map((e) =>
          getSourceUsers(e, srcProvider).then((r) => r.data.users || []).catch(() => [])
        )),
        Promise.all(dstAdminEmails.map((e) =>
          getDestinationUsers(e, dstProvider).then((r) => r.data.users || []).catch(() => [])
        )),
      ]);
      const src = unionUsersByEmail(srcLists);
      const dest = unionUsersByEmail(dstLists);
      setSourceUsers(src);
      setDestUsers(dest);
      autoMap(src, dest, srcAdminEmails, dstAdminEmails);
      setFetched(true);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  }

  function autoMap(src, dest, srcAdminEmails = [], dstAdminEmails = []) {
    // 1. Admin→admin pairs first — source admin #i ↔ destination admin #i by list order.
    //    Ensures mia@gajha.com → granger@gajha.com, mia@pepperwood.club → erik@filefuze.co
    //    appear as "auto" mapped pairs at the top, exactly as the user asked.
    const adminPairs = [];
    const adminSrcEmails = new Set();
    const adminDstEmails = new Set();
    const pairCount = Math.min(srcAdminEmails.length, dstAdminEmails.length);
    for (let i = 0; i < pairCount; i++) {
      const s = adminAsUser(srcAdminEmails[i], srcProvider);
      const d = adminAsUser(dstAdminEmails[i], dstProvider);
      adminPairs.push({ source: s, destination: d, autoMatched: true, isAdminPair: true });
      adminSrcEmails.add(s.email.toLowerCase());
      adminDstEmails.add(d.email.toLowerCase());
    }
    // Extra admins on either side that have no counterpart → surface as unmatched
    // with an admin marker so they can be paired manually.
    const extraSrcAdmins = srcAdminEmails.slice(pairCount)
      .map((e) => adminAsUser(e, srcProvider));
    const extraDstAdmins = dstAdminEmails.slice(pairCount)
      .map((e) => adminAsUser(e, dstProvider));

    // 2. Strip any regular user entry that duplicates an admin we just paired.
    const srcForMap = src.filter((u) => !adminSrcEmails.has((u.email || '').toLowerCase()));
    const destForMap = dest.filter((u) => !adminDstEmails.has((u.email || '').toLowerCase()));

    // 3. First-name auto-map for the remaining users.
    const userPairs = [];
    const usedDest = new Set();
    const unmatched = [];
    for (const s of srcForMap) {
      const f = (s.firstName || '').toLowerCase().trim();
      if (!f) { unmatched.push(s); continue; }
      const m = destForMap.find((d) => !usedDest.has(d.id) && (d.firstName || '').toLowerCase().trim() === f);
      if (m) { userPairs.push({ source: s, destination: m, autoMatched: true }); usedDest.add(m.id); }
      else unmatched.push(s);
    }

    const mapped = [...adminPairs, ...userPairs];
    setMappings(mapped);
    setSelectedIndices(new Set(mapped.map((_, i) => i)));
    setUnmappedSource([...extraSrcAdmins, ...unmatched]);
    setUnmappedDest([...extraDstAdmins, ...destForMap.filter((d) => !usedDest.has(d.id))]);
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
    const pairs = selected.map((m) => ({
      sourceEmail: m.source.email, destinationEmail: m.destination.email,
      sourceName: m.source.displayName, destinationName: m.destination.displayName,
      autoMatched: m.autoMatched,
    }));
    // Second arg gives the parent the admin emails + providers used for
    // source / destination. Consumers (e.g. Message Agent) use this to fetch
    // channels & DMs by name from the source platform without having to
    // re-derive which admin is connected to which provider.
    const meta = {
      sourceAdmin: srcEmail || null,
      sourceProvider: srcProvider || null,
      destinationAdmin: dstEmail || null,
      destinationProvider: dstProvider || null,
    };
    onMappingComplete(pairs, meta);
  }

  // Accounts for each provider
  const srcAccounts = accounts.filter((a) => a.provider === srcProvider);
  const dstAccounts = accounts.filter((a) => a.provider === dstProvider);

  const providerKeys = includeSlack ? ['google', 'microsoft', 'slack'] : ['google', 'microsoft'];

  return (
    <div className="space-y-6">
      {/* ── Admin fields ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <AdminField
          label="Source Admin"
          provider={srcProvider}
          providerKeys={providerKeys}
          email={srcEmail}
          connectedAccounts={srcAccounts}
          accountsLoading={accountsLoading}
          onProviderChange={(p) => {
            setSrcProvider(p);
            const first = accounts.find((a) => a.provider === p && a.email !== dstEmail);
            setSrcEmail(first ? first.email : '');
            setFetched(false);
          }}
          onEmailChange={setSrcEmail}
          onLogin={() => { setLoginTarget('source'); setOauthError(null); }}
          onSignOut={(email) => handleSignOut(srcProvider, email)}
        />
        <AdminField
          label="Destination Admin"
          provider={dstProvider}
          providerKeys={providerKeys}
          email={dstEmail}
          connectedAccounts={dstAccounts}
          accountsLoading={accountsLoading}
          onProviderChange={(p) => {
            setDstProvider(p);
            const first = accounts.find((a) => a.provider === p && a.email !== srcEmail);
            setDstEmail(first ? first.email : '');
            setFetched(false);
          }}
          onEmailChange={setDstEmail}
          onLogin={() => { setLoginTarget('destination'); setOauthError(null); }}
          onSignOut={(email) => handleSignOut(dstProvider, email)}
        />
      </div>

      <button
        type="button"
        onClick={fetchUsers}
        disabled={
          loading ||
          (!srcEmail && srcAccounts.length === 0) ||
          (!dstEmail && dstAccounts.length === 0)
        }
        className="inline-flex items-center gap-2 px-7 py-3.5 text-white text-base font-bold rounded-xl disabled:opacity-50 disabled:cursor-not-allowed transition-all"
        style={{ background: 'linear-gradient(135deg, #0129ac 0%, #4f46e5 100%)', boxShadow: '0 4px 14px rgba(1,41,172,0.32)' }}
      >
        {loading ? (
          <><svg className="animate-spin h-4 w-4" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>Fetching...</>
        ) : (
          <><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>Fetch &amp; Auto-Map Users</>
        )}
      </button>

      {error && <div className="rounded-xl p-4 text-sm font-medium" style={{ backgroundColor: '#fee2e2', border: '1px solid #fca5a5', color: '#dc2626' }}>{error}</div>}

      {/* ── Results ── */}
      {fetched && (
        <div className="space-y-5">
          <div className="flex flex-wrap gap-3">
            <Pill color="indigo" text={`${sourceUsers.length} source users`} />
            <Pill color="purple" text={`${destUsers.length} destination users`} />
            <Pill color="green" text={`${mappings.length} auto-mapped`} />
            {unmappedSource.length > 0 && <Pill color="yellow" text={`${unmappedSource.length} unmatched source`} />}
            {unmappedDest.length > 0 && <Pill color="orange" text={`${unmappedDest.length} unmatched destination`} />}
          </div>

          {mappings.length > 0 && (
            <div className="rounded-xl overflow-hidden" style={{ border: '1px solid #c5cef5' }}>
              <div className="px-5 py-4 flex items-center justify-between" style={{ backgroundColor: '#eef1fd', borderBottom: '1px solid #c5cef5' }}>
                <div className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    checked={selectedIndices.size === mappings.length && mappings.length > 0}
                    ref={(el) => { if (el) el.indeterminate = selectedIndices.size > 0 && selectedIndices.size < mappings.length; }}
                    onChange={(e) => setSelectedIndices(e.target.checked ? new Set(mappings.map((_, i) => i)) : new Set())}
                    className="w-4 h-4 cursor-pointer"
                    style={{ accentColor: '#0129ac' }}
                  />
                  <h3 className="text-base font-bold" style={{ color: '#0129ac' }}>
                    Mapped Pairs ({selectedIndices.size}/{mappings.length} selected)
                  </h3>
                </div>
              </div>
              <div className="divide-y max-h-80 overflow-y-auto" style={{ borderColor: '#eef1fd' }}>
                {mappings.map((m, idx) => (
                  <div
                    key={idx}
                    onClick={() => togglePair(idx)}
                    className="flex items-center gap-3 px-5 py-3.5 cursor-pointer transition-colors"
                    style={{ backgroundColor: selectedIndices.has(idx) ? '#f0f4ff' : '#fff', borderBottom: '1px solid #f1f5fb' }}
                  >
                    <input
                      type="checkbox"
                      checked={selectedIndices.has(idx)}
                      onChange={() => togglePair(idx)}
                      onClick={(e) => e.stopPropagation()}
                      className="w-4 h-4 cursor-pointer flex-shrink-0"
                      style={{ accentColor: '#0129ac' }}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold truncate" style={{ color: '#0f172a' }}>{m.source.email}</span>
                        <span style={{ color: '#94a3b8' }}>→</span>
                        <span className="text-sm font-semibold truncate" style={{ color: '#0f172a' }}>{m.destination.email}</span>
                      </div>
                      <div className="text-xs mt-1" style={{ color: '#64748b' }}>{m.source.displayName} → {m.destination.displayName}</div>
                    </div>
                    <span className="text-xs px-2.5 py-1 rounded-full font-bold"
                      style={{ backgroundColor: m.autoMatched ? '#dcfce7' : '#dbeafe', color: m.autoMatched ? '#15803d' : '#1d4ed8' }}>
                      {m.autoMatched ? 'auto' : 'manual'}
                    </span>
                    <button type="button" onClick={(e) => { e.stopPropagation(); removeMapping(idx); }}
                      className="flex-shrink-0 p-1.5 rounded-lg transition-colors"
                      style={{ color: '#94a3b8' }}
                      onMouseEnter={e => e.currentTarget.style.color = '#ef4444'}
                      onMouseLeave={e => e.currentTarget.style.color = '#94a3b8'}>
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="rounded-xl overflow-hidden" style={{ border: '1px solid #fcd34d' }}>
            <div className="px-5 py-4 flex items-center justify-between flex-wrap gap-2" style={{ backgroundColor: '#fffbeb', borderBottom: '1px solid #fcd34d' }}>
              <div>
                <h3 className="text-base font-bold" style={{ color: '#92400e' }}>
                  Manual Mapping ({unmappedSource.length} unmatched source · {unmappedDest.length} unmatched destination)
                </h3>
                <p className="text-sm mt-1" style={{ color: '#b45309' }}>
                  Pair any source user with a destination user. Auto-matched pairs above can also be removed and re-mapped here.
                </p>
              </div>
            </div>
            {unmappedSource.length === 0 ? (
              <div className="px-5 py-5 text-sm" style={{ color: '#64748b', backgroundColor: '#fff' }}>
                All source users are mapped. Remove a pair above to re-map it manually.
              </div>
            ) : (
              <div className="max-h-72 overflow-y-auto" style={{ backgroundColor: '#fff' }}>
                {unmappedSource.map((s) => (
                  <div key={s.id} className="flex items-center gap-4 px-5 py-3.5" style={{ borderBottom: '1px solid #f1f5f9' }}>
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-semibold" style={{ color: '#0f172a' }}>{s.email}</span>
                      <span className="text-xs ml-2" style={{ color: '#64748b' }}>({s.displayName})</span>
                    </div>
                    <span style={{ color: '#94a3b8' }}>→</span>
                    <select defaultValue="" onChange={(e) => { if (e.target.value) manualMap(s, e.target.value); }}
                      className="px-3 py-2.5 rounded-lg text-sm bg-white outline-none"
                      style={{ border: '1.5px solid #0129ac', color: '#0f172a', minWidth: '220px' }}>
                      <option value="">Select destination...</option>
                      {unmappedDest.map((d) => (<option key={d.id} value={d.email}>{d.email} ({d.firstName})</option>))}
                    </select>
                  </div>
                ))}
              </div>
            )}
          </div>

          {mappings.length > 0 && (
            <button type="button" onClick={handleConfirm} disabled={selectedIndices.size === 0}
              className="inline-flex items-center gap-2 px-7 py-3.5 text-white text-base font-bold rounded-xl disabled:opacity-40 disabled:cursor-not-allowed transition-all"
              style={{ background: 'linear-gradient(135deg, #059669 0%, #10b981 100%)', boxShadow: '0 4px 14px rgba(5,150,105,0.3)' }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
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
          onSlackTokenSubmit={(token) => handleSlackTokenPaste(loginTarget, token)}
          onMicrosoftAdminSubmit={(email) => handleMicrosoftAdminConnect(loginTarget, email)}
          onClose={() => { setLoginTarget(null); setOauthError(null); stopPolling(); popupRef.current?.close(); }}
          hasSlack={includeSlack}
        />
      )}
    </div>
  );
}

// ─── AdminField ───────────────────────────────────────────────────────────────

function AdminField({
  label,
  provider,
  providerKeys,
  email,
  connectedAccounts,
  accountsLoading,
  onProviderChange,
  onEmailChange,
  onLogin,
  onSignOut,
}) {
  const keys = providerKeys || ['google', 'microsoft'];
  const p = PROVIDERS[provider] || PROVIDERS.google;
  const Icon = p.icon;
  const count = connectedAccounts.length;
  const hasAccounts = count > 0;

  return (
    <div className="rounded-xl overflow-hidden" style={{ border: '1px solid #e4e9f5', boxShadow: '0 2px 8px rgba(1,41,172,0.06)' }}>
      {/* Header: label + count badge */}
      <div className="flex items-center justify-between px-5 py-4" style={{ background: 'linear-gradient(135deg, #f8faff 0%, #eef1fd 100%)', borderBottom: '1px solid #e4e9f5' }}>
        <label className="text-base font-bold" style={{ color: '#0129ac' }}>{label}</label>
        {count > 0 && (
          <span className="flex items-center gap-1.5 text-sm font-semibold" style={{ color: '#059669' }}>
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: '#10b981' }}></span>
            {count} account{count !== 1 ? 's' : ''} connected
          </span>
        )}
      </div>

      <div className="p-4 space-y-3">
        {/* Provider toggle */}
        <div className={`grid gap-2 p-1.5 rounded-xl ${keys.length > 2 ? 'grid-cols-3' : 'grid-cols-2'}`} style={{ backgroundColor: '#f1f5f9', border: '1px solid #e4e9f5' }}>
          {keys.map((k) => {
            const pv = PROVIDERS[k];
            if (!pv) return null;
            const PvIcon = pv.icon;
            const active = provider === pv.key;
            return (
              <button
                key={pv.key}
                type="button"
                onClick={() => onProviderChange(pv.key)}
                className="flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg text-sm font-bold transition-all"
                style={{
                  backgroundColor: active ? '#0129ac' : 'transparent',
                  color: active ? '#fff' : '#64748b',
                  boxShadow: active ? '0 2px 8px rgba(1,41,172,0.25)' : 'none',
                }}
              >
                <PvIcon className="w-5 h-5" />
                {pv.short}
              </button>
            );
          })}
        </div>

        {/* Connected accounts list with select + disconnect buttons */}
        {!accountsLoading && hasAccounts ? (
          <div className="space-y-2">
            {connectedAccounts.map((a) => (
              <div key={a.email} className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => onEmailChange(a.email)}
                  className="flex-1 flex items-center gap-3 px-4 py-3 rounded-xl text-sm text-left transition-all"
                  style={{
                    border: email === a.email ? '1.5px solid #0129ac' : '1.5px solid #e2e8f0',
                    backgroundColor: email === a.email ? '#eef1fd' : '#fff',
                    color: email === a.email ? '#0129ac' : '#374151',
                    fontWeight: email === a.email ? 700 : 500,
                  }}
                >
                  <Icon className="w-5 h-5 flex-shrink-0" />
                  <span className="truncate flex-1">{a.email}</span>
                  {email === a.email && (
                    <span className="ml-auto w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: '#0129ac' }} />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => onSignOut(a.email)}
                  title={`Disconnect ${a.email}`}
                  className="flex-shrink-0 p-2 rounded-lg transition-colors"
                  style={{ color: '#94a3b8', border: '1px solid #e2e8f0', backgroundColor: '#fff' }}
                  onMouseEnter={e => { e.currentTarget.style.color='#ef4444'; e.currentTarget.style.borderColor='#fca5a5'; }}
                  onMouseLeave={e => { e.currentTarget.style.color='#94a3b8'; e.currentTarget.style.borderColor='#e2e8f0'; }}
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={onLogin}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-bold rounded-xl transition-all"
              style={{ border: '1.5px dashed #c5cef5', color: '#0129ac', backgroundColor: '#f8faff' }}
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
              + Add Account
            </button>
          </div>
        ) : (
          <div className="flex gap-2">
            <div className="relative flex-1">
              <div className="absolute left-3.5 top-1/2 -translate-y-1/2">
                <Icon className="w-5 h-5" />
              </div>
              <input
                type="email"
                value={email}
                onChange={(e) => onEmailChange(e.target.value)}
                placeholder="admin@company.com"
                className="w-full pl-10 pr-4 py-3.5 rounded-xl text-sm outline-none"
                style={{ border: '1.5px solid #e2e8f0', color: '#0f172a' }}
              />
            </div>
            <button
              type="button"
              onClick={onLogin}
              title={`Sign in with ${p.label}`}
              className="flex items-center gap-2 px-4 py-3.5 text-sm font-bold rounded-xl transition-all flex-shrink-0"
              style={{ border: '1.5px solid #0129ac', color: '#0129ac', backgroundColor: '#eef1fd' }}
            >
              <Icon className="w-5 h-5" />
              Login
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Login Modal ──────────────────────────────────────────────────────────────

function LoginModal({
  provider,
  loading,
  error,
  onConnect,
  onSlackTokenSubmit,
  onMicrosoftAdminSubmit,
  onClose,
  googleTenant,
  onGoogleTenantChange,
  msTenant,
  onMsTenantChange,
  hasSlack,
}) {
  const p = PROVIDERS[provider] || PROVIDERS.google;
  const Icon = p.icon;
  const [slackMode, setSlackMode] = useState('oauth'); // 'oauth' | 'token'
  const [slackToken, setSlackToken] = useState('');
  const [msMode, setMsMode] = useState('oauth'); // 'oauth' | 'admin'
  const [msAdminEmail, setMsAdminEmail] = useState('');
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
            <>
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-gray-500 flex-shrink-0">Google tenant:</span>
                <select
                  value={googleTenant}
                  onChange={(e) => onGoogleTenantChange(e.target.value)}
                  className="flex-1 text-xs rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-400"
                >
                  <option value="1">cloudfuze.us</option>
                  <option value="2">storefuze.com</option>
                  <option value="3">cloudfuze.com</option>
                  <option value="4">filefuze.co</option>
                </select>
              </div>
              <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                If Google shows &quot;access blocked&quot; or &quot;app not verified&quot;: open Google Cloud Console →
                APIs &amp; Services → OAuth consent screen, and add this user under <strong>Test users</strong> (or
                publish the app).
              </p>
            </>
          )}
          {provider === 'microsoft' && (
            <>
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
              <div className="flex gap-1.5 p-1 bg-gray-100 rounded-lg">
                <button
                  type="button"
                  onClick={() => setMsMode('oauth')}
                  className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors ${msMode === 'oauth' ? 'bg-white shadow text-gray-900' : 'text-gray-600 hover:text-gray-900'}`}
                >
                  OAuth popup
                </button>
                <button
                  type="button"
                  onClick={() => setMsMode('admin')}
                  className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors ${msMode === 'admin' ? 'bg-white shadow text-gray-900' : 'text-gray-600 hover:text-gray-900'}`}
                >
                  Admin email
                </button>
              </div>
              {msMode === 'oauth' ? (
                <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  Azure AD app → <strong>Authentication</strong> must list redirect URI{' '}
                  <code className="text-[11px] break-all text-gray-900">http://localhost:5000/api/auth/microsoft/callback</code>{' '}
                  (Web). Delegated permissions <code>User.Read</code>, <code>User.ReadBasic.All</code>,{' '}
                  <code>offline_access</code> must have admin consent granted.
                </p>
              ) : (
                <div className="space-y-2">
                  <label className="block text-xs font-medium text-gray-700">Admin email (app-only, no popup)</label>
                  <input
                    type="email"
                    value={msAdminEmail}
                    onChange={(e) => setMsAdminEmail(e.target.value)}
                    placeholder="granger@gajha.com"
                    className="w-full text-xs rounded-lg border border-gray-200 bg-white px-2.5 py-2 text-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-400"
                  />
                  <p className="text-[11px] text-gray-500">
                    Uses the app&apos;s client_credentials token (no popup, no user consent).
                    Requires <code className="text-[11px]">User.Read.All</code>{' '}
                    <strong>Application</strong> permission with admin consent on the Azure app.
                  </p>
                </div>
              )}
            </>
          )}
          {hasSlack && provider === 'slack' && (
            <>
              <div className="flex gap-1.5 p-1 bg-gray-100 rounded-lg">
                <button
                  type="button"
                  onClick={() => setSlackMode('oauth')}
                  className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors ${slackMode === 'oauth' ? 'bg-white shadow text-gray-900' : 'text-gray-600 hover:text-gray-900'}`}
                >
                  OAuth popup
                </button>
                <button
                  type="button"
                  onClick={() => setSlackMode('token')}
                  className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors ${slackMode === 'token' ? 'bg-white shadow text-gray-900' : 'text-gray-600 hover:text-gray-900'}`}
                >
                  Paste token
                </button>
              </div>
              {slackMode === 'oauth' ? (
                <p className="text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
                  Slack app → <strong>OAuth &amp; Permissions</strong> → <strong>Redirect URLs</strong> must list this
                  exact URL (same host/port as your API):{' '}
                  <code className="text-[11px] break-all text-gray-900">http://localhost:5000/api/auth/slack/callback</code>
                  . If your API uses another port, add <code className="text-[11px]">SLACK_REDIRECT_URI</code> in{' '}
                  <code className="text-[11px]">backend/.env</code> and register that same value in Slack.
                </p>
              ) : (
                <div className="space-y-2">
                  <label className="block text-xs font-medium text-gray-700">
                    Slack user token (<code className="text-[11px]">xoxp-…</code>)
                  </label>
                  <textarea
                    value={slackToken}
                    onChange={(e) => setSlackToken(e.target.value)}
                    placeholder="xoxp-..."
                    rows={3}
                    className="w-full text-xs font-mono rounded-lg border border-gray-200 bg-white px-2.5 py-2 text-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-400 resize-none"
                  />
                  <p className="text-[11px] text-gray-500">
                    Get it from Slack app → <strong>OAuth &amp; Permissions</strong> → <strong>User OAuth Token</strong>.
                    The app must have <code className="text-[11px]">users:read</code> and{' '}
                    <code className="text-[11px]">users:read.email</code> scopes installed.
                  </p>
                </div>
              )}
            </>
          )}
          {error && <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-xs text-red-700">{error}</div>}
        </div>
        <div className="px-6 pb-6 flex gap-3">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 transition-colors">Cancel</button>
          <button
            onClick={() => {
              if (provider === 'slack' && slackMode === 'token') {
                const t = slackToken.trim();
                if (!t) return;
                onSlackTokenSubmit?.(t);
              } else if (provider === 'microsoft' && msMode === 'admin') {
                const e = msAdminEmail.trim();
                if (!e) return;
                onMicrosoftAdminSubmit?.(e);
              } else {
                onConnect();
              }
            }}
            disabled={
              loading ||
              (provider === 'slack' && slackMode === 'token' && !slackToken.trim()) ||
              (provider === 'microsoft' && msMode === 'admin' && !msAdminEmail.trim())
            }
            className={`flex-1 py-2.5 rounded-xl text-sm font-semibold text-white flex items-center justify-center gap-2 disabled:opacity-50 transition-colors ${
              provider === 'google' ? 'bg-blue-600 hover:bg-blue-700' : provider === 'slack' ? 'bg-[#4A154B] hover:bg-[#3d1140]' : 'bg-indigo-600 hover:bg-indigo-700'
            }`}>
            {loading
              ? <><svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>Waiting…</>
              : provider === 'slack' && slackMode === 'token'
                ? <><Icon className="w-3.5 h-3.5" />Install token</>
                : provider === 'microsoft' && msMode === 'admin'
                  ? <><Icon className="w-3.5 h-3.5" />Connect admin</>
                  : <><Icon className="w-3.5 h-3.5" />Sign in</>}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function Pill({ color, text }) {
  const styles = {
    indigo: { backgroundColor: '#eef1fd', color: '#0129ac', border: '1px solid #c5cef5' },
    purple: { backgroundColor: '#f5f3ff', color: '#7c3aed', border: '1px solid #ddd6fe' },
    green:  { backgroundColor: '#dcfce7', color: '#15803d', border: '1px solid #86efac' },
    yellow: { backgroundColor: '#fef9c3', color: '#a16207', border: '1px solid #fde047' },
    orange: { backgroundColor: '#ffedd5', color: '#c2410c', border: '1px solid #fdba74' },
  };
  return <span className="px-3.5 py-1.5 rounded-full text-sm font-semibold" style={styles[color] || styles.indigo}>{text}</span>;
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

function SlackIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 27 27" aria-hidden>
      <path
        fill="#E01E5A"
        d="M5.042 15.165a2.528 2.528 0 01-2.52 2.523A2.528 2.528 0 01.005 15.165a2.527 2.527 0 012.522-2.52h2.52v2.52zM6.313 15.165a2.528 2.528 0 012.522-2.52 2.527 2.527 0 012.523 2.52v6.313A2.528 2.528 0 018.835 24a2.528 2.528 0 01-2.523-2.522v-6.313z"
      />
      <path
        fill="#36C5F0"
        d="M8.835 5.042a2.528 2.528 0 012.523-2.52 2.527 2.527 0 012.52 2.52v2.52H8.835V5.042zm0 3.145a2.528 2.528 0 012.523 2.523 2.528 2.528 0 01-2.523 2.52H2.522A2.528 2.528 0 010 10.71a2.528 2.528 0 012.522-2.523h6.313z"
      />
      <path
        fill="#2EB67D"
        d="M21.955 10.71a2.528 2.528 0 012.52 2.523 2.527 2.527 0 01-2.52 2.52h-2.52v-2.52a2.528 2.528 0 012.52-2.523zm-3.145 2.52a2.528 2.528 0 01-2.523 2.523 2.528 2.528 0 01-2.52-2.523V6.41a2.528 2.528 0 012.52-2.52 2.528 2.528 0 012.523 2.52v6.82z"
      />
      <path
        fill="#ECB22E"
        d="M15.287 21.955a2.528 2.528 0 01-2.523 2.52A2.528 2.528 0 0110.24 21.955a2.528 2.528 0 012.522-2.52h2.525v2.52zm0-3.145a2.528 2.528 0 01-2.523-2.523 2.528 2.528 0 012.523-2.52h6.313A2.528 2.528 0 0124 16.287a2.528 2.528 0 01-2.522 2.523h-6.191z"
      />
    </svg>
  );
}
