import { useState, useEffect, useCallback, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Stepper } from './runwizard/steps';
import StatusBadge from './StatusBadge';
import usePersistedState from '../hooks/usePersistedState';
import useMessageAgentExecution from '../hooks/useMessageAgentExecution';
import { MESSAGE_MIGRATION_COMBINATIONS } from '../constants/messageCombinations';
import {
  getConnectedAccounts, getMessageTargets, getCustomTestCases,
  getSourceUsers, getDestinationUsers, uploadMappingCsv,
} from '../services/api';

const STEPS = ['Source & Destination', 'Map Users', 'Channels & DMs', 'Migration Server', 'Summary'];

// Message provider (platform) → connected-account provider that backs it.
function platformOf(side, combination) {
  const part = String(combination || '').split('→')[side === 'src' ? 0 : 1] || '';
  const s = part.trim().toLowerCase();
  if (s.startsWith('slack')) return 'slack';
  if (s.startsWith('microsoft') || s.startsWith('teams')) return 'microsoft';
  if (s.startsWith('google') || s.startsWith('chat')) return 'google';
  return null;
}
const PLATFORM_LABEL = { slack: 'Slack', microsoft: 'Microsoft Teams', google: 'Google Chat' };

// ── Fetch cache ───────────────────────────────────────────────────────────────
// Channels/DMs and mapped users are expensive to fetch. Cache them keyed by the
// source/destination so going Back/Forward (which remounts this component) or
// refreshing the page reuses the result instead of re-fetching every time.
// In-memory Map handles SPA navigation; sessionStorage survives a full refresh
// (and clears when the tab closes, so data never goes permanently stale).
const _mem = new Map();
function cacheGet(key) {
  if (_mem.has(key)) return _mem.get(key);
  try {
    const raw = sessionStorage.getItem(`msgwiz:${key}`);
    if (raw) { const v = JSON.parse(raw); _mem.set(key, v); return v; }
  } catch { /* ignore */ }
  return null;
}
function cacheSet(key, val) {
  _mem.set(key, val);
  try { sessionStorage.setItem(`msgwiz:${key}`, JSON.stringify(val)); } catch { /* ignore */ }
}

export default function MessageWizard() {
  const msg = useMessageAgentExecution();
  const navigate = useNavigate();
  // Persisted so returning from the Logs page (or a refresh) restores the wizard's
  // position and source/destination selection instead of resetting to step 1.
  const [step, setStep] = usePersistedState('msgwiz:step', 1);

  const errorRef = useRef(null);

  // Initiate seed/migrate, then jump to the logs page to watch progress.
  async function runAndOpenLogs(fn, payload) {
    try {
      const data = await fn(payload);
      const id = data?.executionId;
      if (id) navigate(`/logs?id=${encodeURIComponent(id)}&domain=message`);
    } catch (err) {
      // If the error is an auth failure (400 from pre-flight), jump back to Step 4 so the
      // user can fix their credentials immediately instead of hunting in the logs.
      const errMsg = err?.response?.data?.error || err?.message || '';
      const isAuthErr = err?.response?.status === 400 && (
        errMsg.toLowerCase().includes('401') ||
        errMsg.toLowerCase().includes('rejected') ||
        errMsg.toLowerCase().includes('auth') ||
        errMsg.toLowerCase().includes('credentials')
      );
      if (isAuthErr) {
        setStep(4);
        setStep4Error(errMsg);
        return;
      }
      // Other errors: scroll the error message into view on the Summary page
      setTimeout(() => errorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 100);
    }
  }
  const [accounts, setAccounts] = useState([]);

  const [combination, setCombination] = usePersistedState('msgwiz:combination', MESSAGE_MIGRATION_COMBINATIONS[0]);
  const [migrationType, setMigrationType] = usePersistedState('msgwiz:migrationType', 'FULL');
  const [srcEmail, setSrcEmail] = usePersistedState('msgwiz:srcEmail', '');
  const [dstEmail, setDstEmail] = usePersistedState('msgwiz:dstEmail', '');

  // Step 2 — user mapping (auto-fetched + auto-mapped by first name)
  const [pairs, setPairs] = useState([]); // [{ sourceEmail, destinationEmail }]
  const [srcUsers, setSrcUsers] = useState([]);
  const [dstUsers, setDstUsers] = useState([]);
  const [unmatched, setUnmatched] = useState([]); // source users with no auto match
  const [mapBusy, setMapBusy] = useState(false);
  const [mapError, setMapError] = useState(null);
  const [mapKey, setMapKey] = useState(''); // src/dst pair already fetched for
  // Step 2 — CSV upload
  const [csvUploading, setCsvUploading] = useState(false);
  const [csvFilename, setCsvFilename] = usePersistedState('msgwiz:csvFilename', '');
  const [csvRows, setCsvRows] = usePersistedState('msgwiz:csvRows', 0);
  const [csvCfPairs, setCsvCfPairs] = usePersistedState('msgwiz:csvCfPairs', 0);
  const [csvError, setCsvError] = useState(null);
  const [csvServerPath, setCsvServerPath] = usePersistedState('msgwiz:csvServerPath', '');

  // Step 3 — channels & DMs
  const [targets, setTargets] = useState(null);
  const [targetsBusy, setTargetsBusy] = useState(false);
  const [targetsError, setTargetsError] = useState(null);
  const [selChannels, setSelChannels] = useState([]); // ids
  const [selDms, setSelDms] = useState([]); // ids
  const [targetTab, setTargetTab] = useState('channels'); // 'channels' | 'dms'
  const [targetSearch, setTargetSearch] = useState('');

  // Step 4 — CloudFuze migration server + credentials (entered by the user; sent per
  // migration so any server/account works — no hardcoded backend account). Persisted so
  // they survive the redirect-to-logs remount. (Password is kept in localStorage for this
  // internal QA tool's convenience.)
  const [serverUrl, setServerUrl] = usePersistedState('msgwiz:serverUrl', '');
  const [serverEmail, setServerEmail] = usePersistedState('msgwiz:serverEmail', '');
  const [serverPassword, setServerPassword] = usePersistedState('msgwiz:serverPassword', '');
  // For SSO (Google-login) CloudFuze accounts that have no API password — paste the
  // "Authorization: Basic …" token from DevTools. Takes priority over email/password.
  const [serverToken, setServerToken] = usePersistedState('msgwiz:serverToken', '');
  // Step 4 — error shown when migration pre-flight fails (navigates back here)
  const [step4Error, setStep4Error] = useState(null);

  // Step 5 — seed scenario (optional)
  const [scenarios, setScenarios] = useState([]);
  const [scenarioId, setScenarioId] = useState(null);

  const srcPlatform = platformOf('src', combination);
  const dstPlatform = platformOf('dst', combination);

  useEffect(() => {
    getConnectedAccounts('message').then((r) => setAccounts(r.data.accounts || [])).catch(() => {});
  }, []);

  // Reset selections when the combination *changes* (not on mount — that would wipe
  // the persisted source/destination selection when returning to the page).
  const prevCombo = useRef(combination);
  useEffect(() => {
    if (prevCombo.current === combination) return;
    prevCombo.current = combination;
    setSrcEmail(''); setDstEmail(''); setTargets(null); setSelChannels([]); setSelDms([]);
  }, [combination, setSrcEmail, setDstEmail]);

  // Load custom test scenarios for the combination (for the optional seed step).
  useEffect(() => {
    getCustomTestCases().then((r) => {
      const all = [...(r.data?.smoke || []), ...(r.data?.sanity || [])].filter(
        (tc) => !tc.combination || tc.combination.trim() === combination.trim()
      );
      setScenarios(all);
    }).catch(() => setScenarios([]));
  }, [combination]);

  const srcAccounts = accounts.filter((a) => a.provider === srcPlatform);
  const dstAccounts = accounts.filter((a) => a.provider === dstPlatform);

  const fetchTargets = useCallback(async (force = false) => {
    if (!srcPlatform || !srcEmail) return;
    const cacheKey = `targets:${srcPlatform}:${srcEmail}`;
    if (force !== true) {
      const cached = cacheGet(cacheKey);
      if (cached?.targets) {
        setTargets(cached.targets);
        setSelChannels(cached.selChannels || []);
        setSelDms(cached.selDms || []);
        return;
      }
    }
    setTargetsBusy(true); setTargetsError(null);
    try {
      const { data } = await getMessageTargets(srcPlatform, srcEmail);
      const t = {
        publicChannels: data.publicChannels || [],
        privateChannels: data.privateChannels || [],
        dms: data.dms || [],
        groupDms: data.groupDms || [],
      };
      const sc = [...t.publicChannels, ...t.privateChannels].map((c) => c.id);
      const sd = [...t.dms, ...t.groupDms].map((d) => d.id);
      setTargets(t);
      setSelChannels(sc);
      setSelDms(sd);
      cacheSet(cacheKey, { targets: t, selChannels: sc, selDms: sd });
    } catch (err) {
      setTargetsError(err?.response?.data?.error || err.message);
      setTargets(null);
    } finally {
      setTargetsBusy(false);
    }
  }, [srcPlatform, srcEmail]);

  useEffect(() => { if (step === 3 && !targets && srcEmail) fetchTargets(); }, [step, targets, srcEmail, fetchTargets]);

  // Write selection changes back into the cache so Back/Forward/refresh restores them.
  useEffect(() => {
    if (targets && srcEmail) cacheSet(`targets:${srcPlatform}:${srcEmail}`, { targets, selChannels, selDms });
  }, [targets, selChannels, selDms, srcPlatform, srcEmail]);

  // Step 2 — auto-fetch source + destination users, then auto-map them.
  const fetchMapUsers = useCallback(async (force = false) => {
    if (!srcEmail || !dstEmail) return;
    const key = `${srcPlatform}:${srcEmail}|${dstPlatform}:${dstEmail}`;

    // Build matched pairs from src/dst arrays.
    // Priority: 1) exact email  2) first name  3) email username (john@a.com → john@b.com)
    function buildPairs(src, dst) {
      const used = new Set();
      const mapped = [];
      const left = [];
      for (const s of src) {
        const sEmail = (s.email || '').toLowerCase();
        const sFirst = (s.firstName || '').toLowerCase().trim();
        const sUser  = sEmail.split('@')[0];
        const find   = (pred) => dst.find((d) => !used.has(d.id) && pred(d));
        const m =
          find((d) => (d.email || '').toLowerCase() === sEmail) ||
          (sFirst && find((d) => (d.firstName || '').toLowerCase().trim() === sFirst)) ||
          (sUser  && find((d) => (d.email || '').toLowerCase().split('@')[0] === sUser));
        if (m) { mapped.push({ sourceEmail: s.email, destinationEmail: m.email }); used.add(m.id); }
        else left.push(s);
      }
      return { mapped, left };
    }

    // Guarantee the selected admin accounts (srcEmail → dstEmail) are always paired.
    // Runs on both the fresh-fetch path AND the cache-restore path so the admin pair
    // is never missing just because the cache was set before this logic existed.
    function ensureAdminPair(mapped, left) {
      if (mapped.some((p) => p.sourceEmail.toLowerCase() === srcEmail.toLowerCase())) return;
      // Free dstEmail if it was claimed by a first-name / username match.
      const dstIdx = mapped.findIndex((p) => p.destinationEmail.toLowerCase() === dstEmail.toLowerCase());
      if (dstIdx !== -1) mapped.splice(dstIdx, 1);
      // Pull admin from unmatched list if present; otherwise insert directly — some
      // platforms don't include the workspace admin in the regular member list.
      const leftIdx = left.findIndex((s) => s.email.toLowerCase() === srcEmail.toLowerCase());
      if (leftIdx !== -1) {
        mapped.push({ sourceEmail: left[leftIdx].email, destinationEmail: dstEmail });
        left.splice(leftIdx, 1);
      } else {
        mapped.push({ sourceEmail: srcEmail, destinationEmail: dstEmail });
      }
    }

    if (force !== true) {
      const cached = cacheGet(`map:${key}`);
      if (cached?.srcUsers?.length > 0 && cached?.dstUsers?.length > 0) {
        const cachedPairs     = [...(cached.pairs     || [])];
        const cachedUnmatched = [...(cached.unmatched || [])];
        ensureAdminPair(cachedPairs, cachedUnmatched);
        setSrcUsers(cached.srcUsers);
        setDstUsers(cached.dstUsers);
        setPairs(cachedPairs);
        setUnmatched(cachedUnmatched);
        setMapKey(key);
        return;
      }
    }

    setMapBusy(true); setMapError(null);
    try {
      const [srcRes, dstRes] = await Promise.all([
        getSourceUsers(srcEmail, srcPlatform),
        getDestinationUsers(dstEmail, dstPlatform),
      ]);
      const src = srcRes.data.users || [];
      const dst = dstRes.data.users || [];
      setSrcUsers(src); setDstUsers(dst);
      const { mapped, left } = buildPairs(src, dst);
      ensureAdminPair(mapped, left);
      setPairs(mapped);
      setUnmatched(left);
      setMapKey(key);
      cacheSet(`map:${key}`, { srcUsers: src, dstUsers: dst, pairs: mapped, unmatched: left });
    } catch (err) {
      setMapError(err?.response?.data?.error || err.message);
    } finally {
      setMapBusy(false);
    }
  }, [srcEmail, dstEmail, srcPlatform, dstPlatform]);

  // Auto-fetch + auto-map on entering step 2 (or when the source/dest selection changes).
  useEffect(() => {
    const key = `${srcPlatform}:${srcEmail}|${dstPlatform}:${dstEmail}`;
    if (step === 2 && srcEmail && dstEmail && mapKey !== key && !mapBusy) fetchMapUsers();
  }, [step, srcEmail, dstEmail, srcPlatform, dstPlatform, mapKey, mapBusy, fetchMapUsers]);

  // Write mapping edits back into the cache so Back/Forward/refresh restores them.
  useEffect(() => {
    const key = `${srcPlatform}:${srcEmail}|${dstPlatform}:${dstEmail}`;
    if (mapKey === key && srcUsers.length) cacheSet(`map:${key}`, { srcUsers, dstUsers, pairs, unmatched });
  }, [mapKey, srcUsers, dstUsers, pairs, unmatched, srcPlatform, srcEmail, dstPlatform, dstEmail]);

  function mapUnmatched(srcEmailVal, destEmailVal) {
    if (!destEmailVal) return;
    setPairs((p) => [...p, { sourceEmail: srcEmailVal, destinationEmail: destEmailVal }]);
    setUnmatched((u) => u.filter((s) => s.email !== srcEmailVal));
  }

  async function handleCsvUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setCsvUploading(true); setCsvError(null);
    try {
      const text = await file.text();
      // Parse: skip header if present, split on comma
      const lines = text.split(/\r?\n/).filter(Boolean);
      const start = lines[0]?.toLowerCase().includes('source') ? 1 : 0;
      const parsed = [];
      for (let i = start; i < lines.length; i++) {
        const [src, dst] = lines[i].split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
        if (src && dst) parsed.push({ sourceEmail: src, destinationEmail: dst });
      }
      if (parsed.length === 0) throw new Error('No valid rows found. Expected: Source User,Destination User');
      setPairs(parsed);
      setUnmatched([]);
      setCsvFilename(file.name);
      setCsvRows(parsed.length);
      // Save CSV to server AND immediately push to CF server for all combinations.
      const res = await uploadMappingCsv(text, file.name);
      setCsvServerPath(res.data.filePath || '');
      setCsvCfPairs(res.data.cfUploaded || 0);
    } catch (err) {
      setCsvError(err?.response?.data?.error || err.message);
    } finally {
      setCsvUploading(false);
      e.target.value = '';
    }
  }

  const channelObjects = targets
    ? [...targets.publicChannels, ...targets.privateChannels].filter((c) => selChannels.includes(c.id))
    : [];
  const dmObjects = targets
    ? [...targets.dms, ...targets.groupDms].filter((d) => selDms.includes(d.id))
    : [];

  function basePayload() {
    // Message migration is CHANNEL/DM-level, not per-user: the selected channels &
    // DMs migrate ONCE from the source workspace admin to the destination workspace
    // admin. We must NOT send `mappedPairs` here — that makes the backend fan out one
    // full migration per user pair (e.g. 6 mapped users → 6 identical channel runs).
    // User mappings (for DM ownership) ride along as `userMappings`, which the backend
    // does not fan out on.
    return {
      messageCombination: combination,
      migrationType,
      sourceAdminEmail: srcEmail,
      sourceEmail: srcEmail,
      destinationEmail: dstEmail,
      channelIds: selChannels,
      dmIds: selDms,
      ...(pairs.length ? { userMappings: pairs } : {}),
      ...(csvServerPath ? { userMappingCsvPath: csvServerPath } : {}),
      ...(serverUrl ? { migrationServerUrl: serverUrl } : {}),
      ...(serverEmail ? { migrationServerEmail: serverEmail } : {}),
      ...(serverPassword ? { migrationServerPassword: serverPassword } : {}),
    };
  }

  const canAdvance = {
    1: !!(combination && srcEmail && dstEmail),
    2: true,
    3: selChannels.length > 0 || selDms.length > 0,
    4: true,
    5: true,
  }[step];

  const hasTargets = selChannels.length > 0 || selDms.length > 0;

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6 flex flex-col h-[calc(100vh-16rem)]">
      <Stepper steps={STEPS} current={step} maxReached={step} onJump={setStep} />

      <div className="flex items-center justify-between border-b border-gray-100 pb-4 mb-4">
        <button type="button" disabled={step === 1} onClick={() => setStep(step - 1)}
          className="inline-flex items-center gap-1 px-5 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg shadow-sm hover:bg-gray-50 disabled:opacity-40">← Back</button>
        {step < 5 ? (
          <button type="button" disabled={!canAdvance} onClick={() => setStep(step + 1)}
            className="px-6 py-2 bg-indigo-600 text-white text-sm font-semibold rounded-lg hover:bg-indigo-700 disabled:opacity-50">Next →</button>
        ) : <span className="text-xs text-gray-400">Seed / migrate from the summary</span>}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto pr-1 space-y-5">
        {/* Step 1 — Source & Destination */}
        {step === 1 && (
          <div className="space-y-5">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Combination</label>
              <select value={combination} onChange={(e) => setCombination(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white">
                {MESSAGE_MIGRATION_COMBINATIONS.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Migration type</label>
              <select value={migrationType} onChange={(e) => setMigrationType(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white">
                <option value="FULL">One Time Migration</option>
                <option value="DELTA">Delta Migration</option>
              </select>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <AccountColumn label={`Source — ${PLATFORM_LABEL[srcPlatform] || '—'}`} accounts={srcAccounts} email={srcEmail} onPick={setSrcEmail} />
              <AccountColumn label={`Destination — ${PLATFORM_LABEL[dstPlatform] || '—'}`} accounts={dstAccounts} email={dstEmail} onPick={setDstEmail} />
            </div>
          </div>
        )}

        {/* Step 2 — Map Users */}
        {step === 2 && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm text-gray-500">Users are fetched from both sides and auto-mapped by first name. Map any unmatched users below.</p>
              <button type="button" onClick={() => fetchMapUsers(true)} disabled={mapBusy} className="text-xs text-indigo-600 hover:text-indigo-800">{mapBusy ? 'Fetching…' : 'Refresh'}</button>
            </div>
            {mapBusy && <div className="text-sm text-gray-400">Fetching &amp; auto-mapping users…</div>}
            {mapError && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-600">{mapError}</div>}
            {!mapBusy && (
              <div className="flex flex-wrap gap-2 text-xs">
                <span className="bg-indigo-50 text-indigo-700 px-3 py-1 rounded-full font-medium">{srcUsers.length} source</span>
                <span className="bg-purple-50 text-purple-700 px-3 py-1 rounded-full font-medium">{dstUsers.length} destination</span>
                <span className="bg-green-50 text-green-700 px-3 py-1 rounded-full font-medium">{pairs.length} mapped</span>
                {unmatched.length > 0 && <span className="bg-yellow-50 text-yellow-700 px-3 py-1 rounded-full font-medium">{unmatched.length} unmatched</span>}
              </div>
            )}
            {pairs.length > 0 && (
              <div className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100 text-sm">
                {pairs.map((p, i) => (
                  <div key={i} className="px-4 py-2 flex items-center justify-between">
                    <span className="truncate">{p.sourceEmail} <span className="text-gray-400">→</span> {p.destinationEmail}</span>
                    <button type="button" onClick={() => setPairs((arr) => arr.filter((_, j) => j !== i))} className="text-gray-400 hover:text-red-500">✕</button>
                  </div>
                ))}
              </div>
            )}
            {unmatched.length > 0 && (
              <div className="bg-white border border-yellow-200 rounded-xl divide-y divide-gray-100">
                <div className="px-4 py-2 bg-yellow-50 text-xs font-semibold text-yellow-800">Unmatched source — map manually</div>
                {unmatched.map((s) => (
                  <div key={s.id || s.email} className="px-4 py-2.5 flex items-center gap-3 text-sm">
                    <span className="flex-1 truncate">{s.email}</span>
                    <span className="text-gray-400">→</span>
                    <select defaultValue="" onChange={(e) => mapUnmatched(s.email, e.target.value)} className="min-w-44 px-3 py-1.5 border border-gray-300 rounded-lg text-sm bg-white">
                      <option value="">Select destination…</option>
                      {dstUsers.filter((d) => !pairs.some((p) => p.destinationEmail === d.email)).map((d) => <option key={d.id || d.email} value={d.email}>{d.email}</option>)}
                    </select>
                  </div>
                ))}
              </div>
            )}

            {/* CSV upload — replaces auto-mapping with your own file */}
            <div className="border border-dashed border-gray-300 rounded-xl p-4 bg-gray-50/50">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-700">Upload mapping CSV</p>
                  <p className="text-xs text-gray-400 mt-0.5">Format: <span className="font-mono">Source User,Destination User</span> — replaces current mapping and uploads to server</p>
                </div>
                <label className={`cursor-pointer px-3 py-1.5 text-xs font-semibold rounded-lg border ${csvUploading ? 'opacity-50 cursor-not-allowed border-gray-200 bg-white text-gray-400' : 'border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100'}`}>
                  {csvUploading ? 'Uploading…' : 'Browse CSV'}
                  <input type="file" accept=".csv,text/csv" className="hidden" onChange={handleCsvUpload} disabled={csvUploading} />
                </label>
              </div>
              {csvFilename && !csvError && (
                <p className="mt-2 text-xs text-green-700 font-medium">
                  ✓ {csvFilename} — {csvRows} row(s) loaded
                  {csvServerPath ? ' · saved to server' : ''}
                  {csvCfPairs > 0
                    ? ` · uploaded to CF server (${csvCfPairs} combination${csvCfPairs !== 1 ? 's' : ''})`
                    : csvServerPath ? ' · CF upload pending (will run at migration)' : ''}
                </p>
              )}
              {csvError && (
                <p className="mt-2 text-xs text-red-600">{csvError}</p>
              )}
            </div>
          </div>
        )}

        {/* Step 3 — Channels & DMs (tabbed: Channels | DMs, with search + select-all) */}
        {step === 3 && (() => {
          const channelItems = targets ? [...targets.publicChannels, ...targets.privateChannels] : [];
          const dmItems = targets ? [...targets.dms, ...targets.groupDms] : [];
          const items = targetTab === 'channels' ? channelItems : dmItems;
          const sel = targetTab === 'channels' ? selChannels : selDms;
          const setSel = targetTab === 'channels' ? setSelChannels : setSelDms;
          const labelOf = (it) => it.name || it.channelName || it.displayName || it.id;
          const q = targetSearch.trim().toLowerCase();
          const filtered = q ? items.filter((it) => labelOf(it).toLowerCase().includes(q)) : items;
          const filteredIds = filtered.map((it) => it.id);
          const selectAll = () => setSel((s) => [...new Set([...s, ...filteredIds])]);
          const deselectAll = () => setSel((s) => s.filter((id) => !filteredIds.includes(id)));
          return (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm text-gray-500">Select channels and DMs to migrate.</p>
                <button type="button" onClick={() => fetchTargets(true)} disabled={targetsBusy} className="text-xs text-indigo-600 hover:text-indigo-800">{targetsBusy ? 'Fetching…' : 'Refresh'}</button>
              </div>
              {targetsError && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-600">{targetsError}</div>}

              {/* Channels / DMs tabs */}
              <div className="flex gap-1 bg-gray-100 p-1 rounded-lg w-fit">
                {[['channels', `Channels (${channelItems.length})`], ['dms', `DMs (${dmItems.length})`]].map(([k, label]) => (
                  <button key={k} type="button" onClick={() => { setTargetTab(k); setTargetSearch(''); }}
                    className={`px-4 py-1.5 rounded-md text-sm font-medium transition-all ${targetTab === k ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-700'}`}>
                    {label}
                  </button>
                ))}
              </div>

              {/* Search + select all / deselect all */}
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative flex-1 min-w-48">
                  <input value={targetSearch} onChange={(e) => setTargetSearch(e.target.value)} placeholder={`Search ${targetTab}…`}
                    className="w-full pl-3 pr-3 py-2 rounded-lg border border-gray-200 text-sm focus:ring-2 focus:ring-indigo-400 outline-none" />
                </div>
                <button type="button" onClick={selectAll} className="px-3 py-2 text-xs font-semibold rounded-lg border border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100">Select all</button>
                <button type="button" onClick={deselectAll} className="px-3 py-2 text-xs font-semibold rounded-lg border border-gray-200 bg-white text-gray-600 hover:bg-gray-50">Deselect all</button>
                <span className="text-xs text-gray-500">{sel.length} selected</span>
              </div>

              {/* List */}
              <div className="border border-gray-200 rounded-xl bg-white max-h-[24rem] overflow-y-auto divide-y divide-gray-50">
                {targetsBusy && <p className="px-4 py-6 text-sm text-gray-400 text-center">Fetching {targetTab}…</p>}
                {!targetsBusy && filtered.length === 0 && (
                  <p className="px-4 py-6 text-sm text-gray-400 text-center">
                    {items.length === 0 ? `No ${targetTab} found for this account.` : `No ${targetTab} match “${targetSearch}”.`}
                  </p>
                )}
                {filtered.map((it) => (
                  <label key={it.id} className="px-4 py-2.5 flex items-center gap-3 text-sm cursor-pointer hover:bg-gray-50">
                    <input type="checkbox" checked={sel.includes(it.id)}
                      onChange={() => setSel((s) => s.includes(it.id) ? s.filter((x) => x !== it.id) : [...s, it.id])}
                      className="w-4 h-4 text-indigo-600 rounded" />
                    <span className="truncate">{labelOf(it)}</span>
                    {(it.kind === 'private' || it.isPrivate) && <span className="ml-auto text-[10px] bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded">private</span>}
                  </label>
                ))}
              </div>
            </div>
          );
        })()}

        {/* Step 4 — Migration Server */}
        {step === 4 && (
          <div className="space-y-4">
            <p className="text-sm text-gray-500">
              Enter the CloudFuze server URL and credentials to override the default server. Leave blank to use the pre-configured server from environment settings.
            </p>

            <Field label="Server URL">
              <input value={serverUrl} onChange={(e) => { setServerUrl(e.target.value); setStep4Error(null); }}
                placeholder="https://s2cdev.cloudfuze.com/"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono" />
            </Field>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Email">
                <input value={serverEmail} onChange={(e) => { setServerEmail(e.target.value); setStep4Error(null); }}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
              </Field>
              <Field label="Password">
                <input type="password" value={serverPassword} onChange={(e) => { setServerPassword(e.target.value); setStep4Error(null); }}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
              </Field>
            </div>

            {step4Error && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
                <p className="font-semibold">Login failed — check your credentials and try again</p>
                <p className="text-xs mt-1 text-red-600">{step4Error}</p>
              </div>
            )}
          </div>
        )}

        {/* Step 5 — Summary + Seed/Migrate */}
        {step === 5 && (
          <div className="space-y-5">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
              <Card title="Combination" lines={[combination, `Type: ${migrationType}`]} />
              <Card title="Accounts" lines={[`Src: ${srcEmail || '—'}`, `Dst: ${dstEmail || '—'}`]} />
              <Card title="Targets" lines={[`${selChannels.length} channel(s)`, `${selDms.length} DM(s)`]} />
              <Card title="User pairs" lines={[`${pairs.length} mapped`]} />
              <Card title="Migration Server" lines={[serverUrl || '— not set —', serverEmail || '— no credentials —']} />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Seed scenario (optional)</label>
              <select value={scenarioId || ''} onChange={(e) => setScenarioId(e.target.value || null)} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white">
                <option value="">— none —</option>
                {scenarios.map((s) => <option key={s.testCaseId || s.id} value={s.testCaseId || s.id}>{s.title || s.testCaseId || s.id}</option>)}
              </select>
            </div>

            <div className="flex flex-wrap gap-3">
              <button type="button" disabled={!scenarioId || !hasTargets || msg.seedLoading}
                onClick={() => runAndOpenLogs(msg.seed, { ...basePayload(), selectedTestCaseIds: [scenarioId] })}
                className="px-6 py-2.5 bg-amber-600 text-white text-sm font-semibold rounded-lg hover:bg-amber-700 disabled:opacity-50">
                {msg.seedLoading ? 'Seeding…' : 'Seed test data'}
              </button>
              <button type="button" disabled={!hasTargets || msg.migrateLoading}
                onClick={() => runAndOpenLogs(msg.migrate, basePayload())}
                className="px-6 py-2.5 bg-indigo-600 text-white text-sm font-semibold rounded-lg hover:bg-indigo-700 disabled:opacity-50">
                {msg.migrateLoading ? 'Migrating…' : 'Run migration'}
              </button>
            </div>

            <div ref={errorRef}>
              {msg.seedError && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-600">Seed: {msg.seedError}</div>}
              {msg.migrateError && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-600">Migration: {msg.migrateError}</div>}
            </div>
            {msg.seedExecution && (
              <div className="bg-white border border-gray-200 rounded-xl p-4 flex items-center justify-between">
                <span className="text-sm text-gray-700">Seed: {msg.seedExecution.progress || msg.seedExecution.status}</span>
                <StatusBadge status={msg.seedExecution.status} />
              </div>
            )}
            {msg.migrateExecution && (
              <div className="bg-white border border-gray-200 rounded-xl p-4 flex items-center justify-between">
                <span className="text-sm text-gray-700">Migration: {msg.migrateExecution.progress || msg.migrateExecution.status}</span>
                <StatusBadge status={msg.migrateExecution.status} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function AccountColumn({ label, accounts, email, onPick }) {
  return (
    <div className="border border-gray-200 rounded-xl p-4 bg-gray-50/50 space-y-2">
      <h3 className="text-sm font-semibold text-gray-900">{label}</h3>
      {accounts.length === 0 ? (
        <p className="text-xs text-amber-600">No accounts connected — connect one on the{' '}
          <Link to="/connect" className="font-semibold text-indigo-600">Connect Clouds</Link> page.</p>
      ) : accounts.map((a) => (
        <button key={a.email} type="button" onClick={() => onPick(a.email)}
          className={`w-full text-left px-3 py-2 rounded-lg border text-xs transition-colors ${email === a.email ? 'border-indigo-400 bg-indigo-50 text-indigo-700 font-semibold' : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300'}`}>
          {a.email}
        </button>
      ))}
    </div>
  );
}

function Field({ label, children }) {
  return <div><label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>{children}</div>;
}
function Card({ title, lines }) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{title}</p>
      {lines.map((l, i) => <p key={i} className={`mt-1 text-sm ${i === 0 ? 'font-semibold text-gray-900' : 'text-gray-600'} truncate`}>{l}</p>)}
    </div>
  );
}
