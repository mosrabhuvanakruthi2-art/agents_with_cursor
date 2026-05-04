import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Link } from 'react-router-dom';
import UserMapping from './UserMapping';
import { MESSAGE_MIGRATION_COMBINATIONS, parseIdList } from '../constants/messageCombinations';
import {
  getCustomTestCases, getMessageTargets, getConnectedAccounts,
  getMessageUserStatus, connectSlackToken,
  getMicrosoftOAuthUrl, getGoogleOAuthUrl, getSlackOAuthUrl,
  getCFCloudAccounts, getCFChannels, getCFDMs,
  getCFChannelsAll, getCFChannelsCache,
  getCFBrowserEvents, abortCFBrowserMigration,
} from '../services/api';

// Reusable OAuth popup helper (same dimensions as UserMapping)
function openOAuthPopup(url) {
  const w = 520, h = 680;
  const left = Math.round(window.screenX + (window.outerWidth - w) / 2);
  const top  = Math.round(window.screenY + (window.outerHeight - h) / 2);
  return window.open(url, 'cf_oauth_msg', `width=${w},height=${h},left=${left},top=${top},toolbar=no,menubar=no`);
}

function deriveSourceProvider(combination) {
  const left = String(combination || '').split('→')[0].trim().toLowerCase();
  if (left.startsWith('slack')) return 'slack';
  if (left.startsWith('microsoft') || left.startsWith('teams')) return 'microsoft';
  if (left.startsWith('google') || left.startsWith('chat')) return 'google';
  return null;
}

function deriveDestinationProvider(combination) {
  const parts = String(combination || '').split('→');
  const right = (parts[1] || '').trim().toLowerCase();
  if (right.startsWith('slack')) return 'slack';
  if (right.startsWith('microsoft') || right.startsWith('teams')) return 'microsoft';
  if (right.startsWith('google') || right.startsWith('chat')) return 'google';
  return null;
}

function providerLabel(provider) {
  switch (provider) {
    case 'slack': return 'Slack';
    case 'microsoft': return 'Microsoft Teams';
    case 'google': return 'Google Chat';
    default: return provider || '';
  }
}

const MIGRATION_TYPES = [
  { value: 'FULL',  label: 'One Time Migration', desc: 'Move the full history in scope' },
  { value: 'DELTA', label: 'Delta Migration',    desc: 'Pick up changes since the last run' },
];

export default function MessageAgentForm({
  onSubmit,
  onSeed,
  onCFBrowserMigrate,
  loading,
  cfBrowserLoading,
  seedLoading,
  seedExecution,
  seedError,
}) {
  const [form, setForm] = useState({
    testType: 'SMOKE',
    migrationType: 'FULL',
    messageCombination: MESSAGE_MIGRATION_COMBINATIONS[0],
    channelIdsRaw: '',
    dmIdsRaw: '',
    userMappingCsvPath: '',
  });

  const [mappedPairs, setMappedPairs]   = useState(null);
  const [mappingMeta, setMappingMeta]   = useState(null);
  const [liveSourceProvider, setLiveSourceProvider] = useState(null);

  // ── CloudFuze browser automation execution logs ──────────────────────────────
  const [cfBrowserEvents, setCfBrowserEvents] = useState([]);
  const [cfBrowserRunning, setCfBrowserRunning] = useState(false);
  const cfEventsTimerRef = useRef(null);

  useEffect(() => {
    if (cfBrowserLoading || cfBrowserRunning) {
      const poll = async () => {
        try {
          const { data } = await getCFBrowserEvents();
          if (Array.isArray(data.events)) setCfBrowserEvents(data.events);
          setCfBrowserRunning(!!data.running);
        } catch { /* ignore */ }
      };
      poll();
      cfEventsTimerRef.current = setInterval(poll, 1200);
      return () => clearInterval(cfEventsTimerRef.current);
    }
    return () => clearInterval(cfEventsTimerRef.current);
  }, [cfBrowserLoading, cfBrowserRunning]);

  // ── Test cases ──────────────────────────────────────────────────────────────
  const [allCases, setAllCases]               = useState([]);
  const [casesLoading, setCasesLoading]       = useState(false);
  const [selectedTestCaseIds, setSelectedTestCaseIds] = useState([]);
  const [repeatCount, setRepeatCount]         = useState(1);

  // ── Targets ─────────────────────────────────────────────────────────────────
  const [targets, setTargets]           = useState(null);
  const [targetsLoading, setTargetsLoading] = useState(false);
  const [targetsError, setTargetsError] = useState(null);
  const [selectedChannelIds, setSelectedChannelIds] = useState([]);
  const [selectedDmIds, setSelectedDmIds]           = useState([]);
  const [showManualIds, setShowManualIds] = useState(false);
  const [selectedFetchAdmin, setSelectedFetchAdmin] = useState(null);

  // ── Connected Message Agent accounts ────────────────────────────────────────
  const [msgAccounts, setMsgAccounts] = useState([]);
  const reloadMsgAccounts = useCallback(async () => {
    try {
      const res = await getConnectedAccounts('message');
      const list = res?.data?.accounts;
      setMsgAccounts(Array.isArray(list) ? list : []);
    } catch { setMsgAccounts([]); }
  }, []);
  useEffect(() => { reloadMsgAccounts(); }, [reloadMsgAccounts]);
  useEffect(() => {
    const t = setInterval(reloadMsgAccounts, 5000);
    return () => clearInterval(t);
  }, [reloadMsgAccounts]);

  // ── Derived provider / accounts ─────────────────────────────────────────────
  const sourceProvider      = deriveSourceProvider(form.messageCombination);
  const destinationProvider = deriveDestinationProvider(form.messageCombination);
  const step4Provider       = liveSourceProvider || sourceProvider;
  const step4Accounts       = useMemo(
    () => (msgAccounts || []).filter((a) => a.provider === step4Provider),
    [msgAccounts, step4Provider],
  );

  function pickSourceAdmin() {
    if (mappingMeta?.sourceProvider === step4Provider && mappingMeta?.sourceAdmin) {
      return mappingMeta.sourceAdmin;
    }
    return step4Accounts[0]?.email || null;
  }

  // ── CloudFuze channel browser state ────────────────────────────────────────
  const [cfMode, setCfMode]                 = useState(false);   // show CF browser panel
  const [cfAccounts, setCfAccounts]         = useState([]);
  const [cfAccountsLoading, setCfAccountsLoading] = useState(false);
  const [cfAccountsError, setCfAccountsError]     = useState(null);
  const [cfSrcCloudId, setCfSrcCloudId]     = useState('');
  const [cfDstCloudId, setCfDstCloudId]     = useState('');
  const [cfChannels, setCfChannels]         = useState(null);   // { publicChannels, privateChannels, dms }
  const [cfChannelLoading, setCfChannelLoading] = useState(false);
  const [cfChannelError, setCfChannelError] = useState(null);
  const [cfSelectedChannels, setCfSelectedChannels] = useState([]); // enriched objects
  const [cfSelectedDms, setCfSelectedDms]   = useState([]);          // enriched objects
  const [cfCacheFetchedAt, setCfCacheFetchedAt] = useState(null);   // ISO timestamp of last cache write

  // CF platform name from combination string
  function toCFPlatform(combo, side) {
    const parts = (combo || '').split('→');
    const part  = (side === 'src' ? parts[0] : parts[1] || '').trim().toLowerCase();
    if (part.includes('slack'))                                    return 'SLACK';
    if (part.includes('microsoft') || part.includes('teams'))      return 'MICROSOFT_TEAMS';
    if (part.includes('google') || part.includes('chat'))          return 'GOOGLE_CHAT';
    return null;
  }

  const cfSrcPlatform = toCFPlatform(form.messageCombination, 'src');
  const cfDstPlatform = toCFPlatform(form.messageCombination, 'dst');
  const cfSrcAccounts = useMemo(() => cfAccounts.filter(a => a.cloudName === cfSrcPlatform), [cfAccounts, cfSrcPlatform]);
  const cfDstAccounts = useMemo(() => cfAccounts.filter(a => a.cloudName === cfDstPlatform), [cfAccounts, cfDstPlatform]);

  // Auto-select first CF cloud when accounts load
  useEffect(() => {
    if (cfSrcAccounts.length > 0 && !cfSrcCloudId) setCfSrcCloudId(cfSrcAccounts[0].id);
    if (cfDstAccounts.length > 0 && !cfDstCloudId) setCfDstCloudId(cfDstAccounts[0].id);
  }, [cfSrcAccounts, cfDstAccounts]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset CF channel selections when combination changes
  useEffect(() => {
    setCfChannels(null);
    setCfSelectedChannels([]);
    setCfSelectedDms([]);
    setCfCacheFetchedAt(null);
    setCfSrcCloudId('');
    setCfDstCloudId('');
  }, [form.messageCombination]);

  // Shared channel/DM normalizers — used by both fetch-from-API and load-from-cache paths
  const normCh = useCallback((arr, type) => (Array.isArray(arr) ? arr : []).map(ch => {
    const resolvedId   = ch.fromRootId || ch.channelId || ch.id || '';
    const resolvedName = ch.channelName || ch.channel_name || ch.name ||
                         ch.displayName || ch.display_name || ch.title ||
                         ch.fromRootId  || ch.channelId    || ch.id || '';
    return {
      id: resolvedId, name: resolvedName, channelName: resolvedName,
      channelType: type, workSpaceName: ch.workSpaceName || ch.metadataUrl || '',
      destChannelName: resolvedName, destTeamName: resolvedName || '/',
      channelDate: ch.channelDate || String(Math.floor(Date.now() / 1000)),
      externalShared: ch.externalShared || false,
    };
  }).filter(c => c.id), []);

  const normDm = useCallback((arr) => (Array.isArray(arr) ? arr : []).map(dm => {
    const resolvedId   = dm.fromRootId || dm.channelId || dm.id || '';
    const resolvedName = dm.channelName || dm.channel_name || dm.name ||
                         dm.displayName || dm.display_name || dm.title ||
                         dm.fromRootId  || dm.channelId    || dm.id || '';
    return {
      id: resolvedId, name: resolvedName, channelName: resolvedName,
      channelType: 'im', workSpaceName: dm.workSpaceName || dm.metadataUrl || '',
      emailPairs: dm.emailPairs || [],
      channelDate: dm.channelDate || String(Math.floor(Date.now() / 1000)),
    };
  }).filter(d => d.id), []);

  // Auto-load from cache when combination + cloud IDs are all set
  useEffect(() => {
    if (!cfSrcCloudId || !cfDstCloudId) return;
    let cancelled = false;
    (async () => {
      try {
        const { data } = await getCFChannelsCache({
          srcCloudId: cfSrcCloudId,
          dstCloudId: cfDstCloudId,
          combination: form.messageCombination,
        });
        if (cancelled) return;
        if (data.cached) {
          setCfChannels({
            publicChannels:  normCh(data.publicChannels,  'public'),
            privateChannels: normCh(data.privateChannels, 'private'),
            dms:             normDm(data.dms),
          });
          setCfCacheFetchedAt(data.fetchedAt || null);
        }
      } catch { /* ignore — cache miss is fine */ }
    })();
    return () => { cancelled = true; };
  }, [cfSrcCloudId, cfDstCloudId, form.messageCombination, normCh, normDm]);

  const loadCFAccounts = useCallback(async () => {
    setCfAccountsLoading(true);
    setCfAccountsError(null);
    try {
      const { data } = await getCFCloudAccounts();
      setCfAccounts(Array.isArray(data.accounts) ? data.accounts : []);
    } catch (err) {
      setCfAccountsError(err?.response?.data?.error || err.message || 'Failed to load cloud accounts');
    } finally {
      setCfAccountsLoading(false);
    }
  }, []);

  async function handleFetchCFChannels() {
    if (!cfSrcCloudId || !cfDstCloudId) return;
    setCfChannelLoading(true);
    setCfChannelError(null);
    try {
      // getCFChannelsAll fetches public+private+DMs in one request and saves to cache
      const { data } = await getCFChannelsAll({
        srcCloudId:  cfSrcCloudId,
        dstCloudId:  cfDstCloudId,
        combination: form.messageCombination,
      });
      setCfChannels({
        publicChannels:  normCh(data.publicChannels,  'public'),
        privateChannels: normCh(data.privateChannels, 'private'),
        dms:             normDm(data.dms),
      });
      setCfCacheFetchedAt(data.fetchedAt || new Date().toISOString());
    } catch (err) {
      setCfChannelError(err?.response?.data?.error || err.message || 'Failed to fetch CF channels');
    } finally {
      setCfChannelLoading(false);
    }
  }

  function toggleCFChannel(ch) {
    setCfSelectedChannels(prev =>
      prev.some(x => x.id === ch.id) ? prev.filter(x => x.id !== ch.id) : [...prev, ch]
    );
  }
  function toggleCFDm(dm) {
    setCfSelectedDms(prev =>
      prev.some(x => x.id === dm.id) ? prev.filter(x => x.id !== dm.id) : [...prev, dm]
    );
  }

  // ── Manual channel/DM IDs (advanced override) ───────────────────────────────
  const manualChannelIds = parseIdList(form.channelIdsRaw);
  const manualDmIds      = parseIdList(form.dmIdsRaw);
  const channelIds = useMemo(
    () => Array.from(new Set([...selectedChannelIds, ...cfSelectedChannels.map(c => c.id), ...manualChannelIds])),
    [selectedChannelIds, cfSelectedChannels, form.channelIdsRaw], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const dmIds = useMemo(
    () => Array.from(new Set([...selectedDmIds, ...cfSelectedDms.map(d => d.id), ...manualDmIds])),
    [selectedDmIds, cfSelectedDms, form.dmIdsRaw], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // ── Load test cases whenever testType or combination changes ─────────────────
  useEffect(() => {
    let cancelled = false;
    setCasesLoading(true);
    setAllCases([]);
    setSelectedTestCaseIds([]);
    (async () => {
      try {
        const { data } = await getCustomTestCases();
        if (cancelled) return;
        const bucket = (form.testType || 'SMOKE').toLowerCase();
        const list   = Array.isArray(data?.[bucket]) ? data[bucket] : [];
        const matched = list.filter((tc) => {
          if ((tc.productType || '').toLowerCase() !== 'message') return false;
          if ((tc.combination || '').trim() !== (form.messageCombination || '').trim()) return false;
          return true;
        });
        setAllCases(matched);
        // Auto-select all matching cases
        setSelectedTestCaseIds(matched.map((tc) => String(tc.testCaseId || tc.id || '')).filter(Boolean));
      } catch {
        if (!cancelled) setAllCases([]);
      } finally {
        if (!cancelled) setCasesLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [form.testType, form.messageCombination]);

  // ── Clear fetched targets when source provider / combination changes ──────────
  useEffect(() => {
    setTargets(null);
    setTargetsError(null);
    setSelectedChannelIds([]);
    setSelectedDmIds([]);
    setSelectedFetchAdmin(null);
  }, [step4Provider, form.messageCombination]);

  function getActiveFetchAdmin() {
    if (selectedFetchAdmin && step4Accounts.some((a) => a.email === selectedFetchAdmin)) {
      return selectedFetchAdmin;
    }
    return pickSourceAdmin();
  }

  async function handleFetchTargets() {
    setTargetsError(null);
    setTargetsLoading(true);
    try {
      if (!step4Provider) throw new Error('Select a source cloud in Step 1 first.');
      const adminEmail = getActiveFetchAdmin();
      if (!adminEmail) throw new Error(
        `No ${providerLabel(step4Provider)} admin connected. Add an account on the Source side of Step 1.`
      );
      const { data } = await getMessageTargets(step4Provider, adminEmail);
      setTargets({
        publicChannels:  data.publicChannels  || [],
        privateChannels: data.privateChannels || [],
        dms:             data.dms             || [],
        groupDms:        data.groupDms        || [],
      });
    } catch (err) {
      setTargetsError(err?.response?.data?.error || err.message || 'Failed to fetch targets');
      setTargets(null);
    } finally {
      setTargetsLoading(false);
    }
  }

  function toggleId(list, setList, id) {
    setList(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  }

  function toggleCaseId(id) {
    setSelectedTestCaseIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  function handleChange(e) {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  }

  function handleMappingComplete(pairs, meta) {
    setMappedPairs(pairs);
    setMappingMeta(meta || null);
  }

  function clearMapping() {
    setMappedPairs(null);
    setMappingMeta(null);
  }

  const seedCompleted = useMemo(() => {
    if (!seedExecution) return false;
    if (seedExecution.bulk) return (seedExecution.completed || 0) > 0;
    const finalStatus = seedExecution.status || seedExecution.result?.status;
    return finalStatus === 'COMPLETED';
  }, [seedExecution]);

  const hasMapping  = mappedPairs && mappedPairs.length > 0;
  const hasBulk     = mappedPairs && mappedPairs.length > 1;
  const hasTargets  = channelIds.length > 0 || dmIds.length > 0;
  const hasCases    = selectedTestCaseIds.length > 0;
  const hasCsvPath  = !!(form.userMappingCsvPath || '').trim();
  const canPost     = hasMapping && hasTargets && hasCases;
  // Migration can run with mapped pairs OR a CSV path (CSV path replaces manual user mapping).
  const canMigrate  = (hasMapping || hasCsvPath) && hasTargets;

  function buildPayloadBase() {
    return {
      testType:            form.testType,
      migrationType:       form.migrationType,
      messageCombination:  form.messageCombination,
      channelIds,
      dmIds,
      // Enriched CF objects carry name/type/workSpaceName for accurate migration payload
      channelObjects: cfSelectedChannels,
      dmObjects:      cfSelectedDms,
      selectedTestCaseIds,
      sourceAdminEmail: getActiveFetchAdmin(),
      repeatCount: Math.max(1, parseInt(repeatCount, 10) || 1),
    };
  }

  function handlePostTestData(e) {
    e?.preventDefault?.();
    if (!canPost || !onSeed) return;
    const base = buildPayloadBase();
    if (hasBulk) {
      onSeed({ ...base, mappedPairs });
    } else {
      onSeed({ ...base, sourceEmail: mappedPairs[0].sourceEmail, destinationEmail: mappedPairs[0].destinationEmail });
    }
  }

  function handleSubmit(e) {
    e.preventDefault();
    // Route form-submit (Enter key) through browser automation, same as the button
    handleCFBrowserMigrate();
  }

  function handleCFBrowserMigrate() {
    if (!canMigrate || !onCFBrowserMigrate) return;

    // mappedPairs may be empty when user provides CSV path instead of doing Fetch & Auto-Map
    const pairs = mappedPairs || [];
    const pair  = pairs[0] || null;
    const mappingType = pairs.length === 0 ? 'csv'
      : pairs.every(p => p.autoMatched) ? 'auto'
      : 'manual';

    onCFBrowserMigrate({
      sourceEmail:         pair?.sourceEmail  || '',
      destinationEmail:    pair?.destinationEmail || '',
      sourcePlatform:      sourceProvider,
      destinationPlatform: destinationProvider,
      combination:         form.messageCombination,
      channelIds,
      dmIds,
      channelObjects: cfSelectedChannels,
      dmObjects:      cfSelectedDms,
      cfSrcCloudId:   cfSrcCloudId || null,
      cfDstCloudId:   cfDstCloudId || null,
      // Mapped pairs from the tool (used to build CSV if no csvPath given)
      mappingType,
      userMappings: pairs.map(p => ({
        sourceEmail:      p.sourceEmail,
        destinationEmail: p.destinationEmail,
      })),
      // If a CSV path is set, browser automation uploads it directly to CF server ↑ CSV button
      userMappingCsvPath: (form.userMappingCsvPath || '').trim() || null,
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">

      {/* ── Step 1: Source & Destination ── */}
      <Section step={1} title="Source & Destination" subtitle="Connect each admin, fetch users, then confirm pairs before running.">
        <UserMapping
          onMappingComplete={handleMappingComplete}
          includeSlack
          onSourceProviderChange={setLiveSourceProvider}
        />
        {mappedPairs && (
          <div className="rounded-lg px-4 py-3 text-sm flex items-center justify-between"
            style={{ backgroundColor: '#f0f4ff', border: '1px solid #0129ac' }}>
            <span style={{ color: '#000' }}>
              {mappedPairs.length} pair{mappedPairs.length > 1 ? 's' : ''} mapped.
              {mappedPairs.length === 1 && ` ${mappedPairs[0].sourceEmail} → ${mappedPairs[0].destinationEmail}`}
              {mappedPairs.length > 1  && ' All pairs will be queued together.'}
            </span>
            <button type="button" onClick={clearMapping}
              className="text-xs underline ml-4 flex-shrink-0"
              style={{ color: '#0129ac' }}>
              Clear mapping
            </button>
          </div>
        )}
      </Section>

      {/* ── Step 2: Migration Combination ── */}
      <Section step={2} title="Migration Combination" subtitle="Choose the source → destination platforms.">
        <div>
          <label htmlFor="msg-combination" className="block text-xs font-semibold mb-1" style={{ color: '#000' }}>
            Combination
          </label>
          <select
            id="msg-combination"
            name="messageCombination"
            value={form.messageCombination}
            onChange={handleChange}
            className="w-full px-4 py-2.5 rounded-lg text-sm outline-none bg-white"
            style={{ border: '2px solid #0129ac', color: '#000' }}
          >
            {MESSAGE_MIGRATION_COMBINATIONS.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          {sourceProvider && (
            <p className="text-xs mt-1.5" style={{ color: '#555' }}>
              Source: <strong style={{ color: '#000' }}>{providerLabel(sourceProvider)}</strong>
              {' · '}
              Destination: <strong style={{ color: '#000' }}>{providerLabel(destinationProvider) || '—'}</strong>
            </p>
          )}
        </div>
      </Section>

      {/* ── Step 3: Test Type + Test Case Picker ── */}
      <Section step={3} title="Test Type & Test Cases"
        subtitle="Select Smoke or Sanity, then choose which test cases from Agent Repo to post.">

        {/* Smoke / Sanity toggle */}
        <div className="grid grid-cols-2 gap-3">
          {[
            { value: 'SMOKE',  label: 'Smoke',  desc: 'Quick connectivity check' },
            { value: 'SANITY', label: 'Sanity', desc: 'Core feature validation' },
          ].map((opt) => (
            <TypeBox
              key={opt.value}
              active={form.testType === opt.value}
              label={opt.label}
              desc={opt.desc}
              onClick={() => setForm((prev) => ({ ...prev, testType: opt.value }))}
            />
          ))}
        </div>

        {/* Test cases list */}
        <div className="mt-1">
          {casesLoading ? (
            <div className="text-sm py-4 text-center" style={{ color: '#555' }}>Loading test cases…</div>
          ) : allCases.length === 0 ? (
            <div className="rounded-lg p-4 text-sm" style={{ backgroundColor: '#fff8e5', border: '1px solid #e5b94a', color: '#000' }}>
              No <strong>{form.testType.charAt(0) + form.testType.slice(1).toLowerCase()}</strong> test cases found for{' '}
              <strong>{form.messageCombination}</strong>.{' '}
              Go to <strong>Test Case Generator</strong> to create and save some to Agent Repo first.
            </div>
          ) : (
            <TestCasePicker
              cases={allCases}
              selectedIds={selectedTestCaseIds}
              onToggle={toggleCaseId}
              onSelectAll={() => setSelectedTestCaseIds(allCases.map((tc) => String(tc.testCaseId || tc.id || '')).filter(Boolean))}
              onClearAll={() => setSelectedTestCaseIds([])}
            />
          )}
        </div>
      </Section>

      {/* ── Step 4: Source Channels & DMs ── */}
      <Section step={4} title="Source Channels & DMs"
        subtitle="Pick channels and DMs via CloudFuze (recommended) or directly from the source platform.">

        {/* ── Mode toggle ── */}
        <div className="flex gap-2">
          <button type="button"
            onClick={() => { setCfMode(true); if (cfAccounts.length === 0) loadCFAccounts(); }}
            className="flex-1 py-2 rounded-lg text-xs font-semibold transition-all"
            style={{
              backgroundColor: cfMode ? '#0129ac' : '#fff',
              color: cfMode ? '#fff' : '#0129ac',
              border: '2px solid #0129ac',
            }}>
            CloudFuze Browser
          </button>
          <button type="button"
            onClick={() => setCfMode(false)}
            className="flex-1 py-2 rounded-lg text-xs font-semibold transition-all"
            style={{
              backgroundColor: !cfMode ? '#0129ac' : '#fff',
              color: !cfMode ? '#fff' : '#0129ac',
              border: '2px solid #0129ac',
            }}>
            Platform API
          </button>
        </div>

        {/* ── CloudFuze Browser panel ── */}
        {cfMode && (
          <div className="space-y-3 rounded-xl p-4" style={{ backgroundColor: '#f0f4ff', border: '1px solid #0129ac' }}>
            <p className="text-xs font-semibold" style={{ color: '#000' }}>
              Browse channels &amp; DMs directly from CloudFuze — no platform OAuth needed.
            </p>

            {/* CF cloud account selectors */}
            {cfAccountsLoading ? (
              <p className="text-xs" style={{ color: '#555' }}>Loading cloud accounts…</p>
            ) : cfAccountsError ? (
              <div className="rounded-lg p-2 text-xs" style={{ backgroundColor: '#fff0f0', color: '#cc0000' }}>
                {cfAccountsError}
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {/* Source cloud */}
                <div>
                  <label className="block text-xs font-semibold mb-1" style={{ color: '#000' }}>
                    Source: {cfSrcPlatform || '—'}
                  </label>
                  {cfSrcAccounts.length === 0 ? (
                    <p className="text-xs rounded-lg px-3 py-2" style={{ backgroundColor: '#fff8e5', color: '#7a5400', border: '1px solid #e5b94a' }}>
                      No {cfSrcPlatform} cloud connected to CloudFuze. Add it at{' '}
                      <a href="https://s2cdev.cloudfuze.com" target="_blank" rel="noreferrer" style={{ color: '#0129ac' }}>
                        s2cdev.cloudfuze.com
                      </a>
                    </p>
                  ) : (
                    <select value={cfSrcCloudId} onChange={e => setCfSrcCloudId(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg text-xs outline-none bg-white"
                      style={{ border: '1px solid #0129ac', color: '#000' }}>
                      {cfSrcAccounts.map(a => (
                        <option key={a.id} value={a.id}>
                          {a.emailId || a.metadataUrl || a.cloudUserId || a.id}
                          {a.metadataUrl && a.metadataUrl !== a.emailId ? ` (${a.metadataUrl})` : ''}
                        </option>
                      ))}
                    </select>
                  )}
                </div>

                {/* Dest cloud */}
                <div>
                  <label className="block text-xs font-semibold mb-1" style={{ color: '#000' }}>
                    Destination: {cfDstPlatform || '—'}
                  </label>
                  {cfDstAccounts.length === 0 ? (
                    <p className="text-xs rounded-lg px-3 py-2" style={{ backgroundColor: '#fff8e5', color: '#7a5400', border: '1px solid #e5b94a' }}>
                      No {cfDstPlatform} cloud connected.
                    </p>
                  ) : (
                    <select value={cfDstCloudId} onChange={e => setCfDstCloudId(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg text-xs outline-none bg-white"
                      style={{ border: '1px solid #0129ac', color: '#000' }}>
                      {cfDstAccounts.map(a => (
                        <option key={a.id} value={a.id}>
                          {a.emailId || a.metadataUrl || a.cloudUserId || a.id}
                          {a.metadataUrl && a.metadataUrl !== a.emailId ? ` (${a.metadataUrl})` : ''}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </div>
            )}

            <div className="flex items-center gap-3 flex-wrap">
              <button type="button"
                onClick={handleFetchCFChannels}
                disabled={cfChannelLoading || !cfSrcCloudId || !cfDstCloudId}
                className="px-4 py-2 rounded-lg text-xs font-semibold disabled:opacity-50"
                style={{ backgroundColor: '#0129ac', color: '#fff' }}>
                {cfChannelLoading ? 'Loading…' : cfChannels ? 'Refresh from CloudFuze' : 'Load Channels from CloudFuze'}
              </button>
              <button type="button" onClick={loadCFAccounts} disabled={cfAccountsLoading}
                className="px-3 py-2 rounded-lg text-xs font-semibold disabled:opacity-50"
                style={{ border: '1px solid #0129ac', color: '#0129ac', backgroundColor: '#fff' }}>
                {cfAccountsLoading ? 'Reloading…' : 'Reload Accounts'}
              </button>
              <a href="https://s2cdev.cloudfuze.com" target="_blank" rel="noreferrer"
                className="text-xs underline" style={{ color: '#0129ac' }}>
                Open CloudFuze ↗
              </a>
            </div>

            {cfCacheFetchedAt && (
              <p className="text-[11px]" style={{ color: '#777' }}>
                Last fetched: {new Date(cfCacheFetchedAt).toLocaleString()} — click &quot;Refresh from CloudFuze&quot; to update
              </p>
            )}

            {cfChannelError && (
              <div className="rounded-lg p-2 text-xs" style={{ backgroundColor: '#fff0f0', color: '#cc0000' }}>
                {cfChannelError}
              </div>
            )}

            {cfChannels && (
              <CFTargetPicker
                channels={cfChannels}
                selectedChannels={cfSelectedChannels}
                selectedDms={cfSelectedDms}
                onToggleChannel={toggleCFChannel}
                onToggleDm={toggleCFDm}
                onSelectAll={() => {
                  setCfSelectedChannels([
                    ...(cfChannels.publicChannels || []),
                    ...(cfChannels.privateChannels || []),
                  ]);
                  setCfSelectedDms([...(cfChannels.dms || [])]);
                }}
                onClearAll={() => { setCfSelectedChannels([]); setCfSelectedDms([]); }}
              />
            )}

            {(cfSelectedChannels.length > 0 || cfSelectedDms.length > 0) && (
              <div className="flex items-center gap-2 text-xs">
                <span className="px-2 py-1 rounded-full font-bold"
                  style={{ backgroundColor: '#0129ac', color: '#fff' }}>
                  {cfSelectedChannels.length + cfSelectedDms.length} selected from CloudFuze
                </span>
                <span style={{ color: '#555' }}>
                  ({cfSelectedChannels.length} ch · {cfSelectedDms.length} DMs)
                </span>
              </div>
            )}
          </div>
        )}

        {/* ── Platform API panel (original) ── */}
        {!cfMode && (
          <>
            <AdminSelector
              provider={step4Provider}
              accounts={step4Accounts}
              selectedAdmin={getActiveFetchAdmin()}
              onSelect={setSelectedFetchAdmin}
            />

            <div className="flex items-center justify-end">
              <button
                type="button"
                onClick={handleFetchTargets}
                disabled={targetsLoading || !step4Provider || !getActiveFetchAdmin()}
                className="px-4 py-2 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                style={{ border: '2px solid #0129ac', color: '#0129ac', backgroundColor: '#fff' }}
              >
                {targetsLoading ? 'Fetching…' : targets ? 'Refresh Channels & DMs' : 'Fetch Channels & DMs'}
              </button>
            </div>

        {targetsError && (
          <div className="rounded-lg p-3 text-xs space-y-2" style={{ backgroundColor: '#fff0f0', border: '1px solid #cc0000', color: '#000' }}>
            <div><strong>Fetch failed:</strong> {targetsError}</div>
            {targetsError.includes('Chat app not configured') && (
              <div className="flex flex-wrap gap-2 pt-1">
                <a
                  href="https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 px-3 py-1 rounded text-xs font-semibold"
                  style={{ backgroundColor: '#1a73e8', color: '#fff', textDecoration: 'none' }}
                >
                  Open Google Cloud Console → Chat API Config
                </a>
                <span className="text-[11px] self-center" style={{ color: '#555' }}>
                  Fill App Name + Description → set Status to <strong>Live</strong> → Save → re-authenticate
                </span>
              </div>
            )}
          </div>
        )}

        {targets && (
          <NamedTargetPicker
            targets={targets}
            selectedChannelIds={selectedChannelIds}
            selectedDmIds={selectedDmIds}
            onToggleChannel={(id) => toggleId(selectedChannelIds, setSelectedChannelIds, id)}
            onToggleDm={(id) => toggleId(selectedDmIds, setSelectedDmIds, id)}
            onSelectAll={() => {
              setSelectedChannelIds([
                ...(targets.publicChannels  || []).map((x) => x.id),
                ...(targets.privateChannels || []).map((x) => x.id),
              ]);
              setSelectedDmIds([
                ...(targets.dms     || []).map((x) => x.id),
                ...(targets.groupDms || []).map((x) => x.id),
              ]);
            }}
            onClearAll={() => { setSelectedChannelIds([]); setSelectedDmIds([]); }}
          />
        )}

        {/* Advanced manual IDs */}
        <div className="pt-1">
          <button type="button" onClick={() => setShowManualIds((v) => !v)}
            className="text-xs underline" style={{ color: '#0129ac' }}>
            {showManualIds ? 'Hide' : 'Add'} IDs manually (advanced)
          </button>
          {showManualIds && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-3">
              <div>
                <label className="block text-xs font-semibold mb-1" style={{ color: '#000' }}>Extra Channel IDs</label>
                <textarea
                  name="channelIdsRaw"
                  value={form.channelIdsRaw}
                  onChange={handleChange}
                  rows={3}
                  placeholder="C01234ABCDE, spaces/AAA..."
                  className="w-full px-3 py-2 rounded-lg text-xs outline-none bg-white font-mono"
                  style={{ border: '1px solid #0129ac', color: '#000' }}
                />
                <p className="text-[11px] mt-1" style={{ color: '#555' }}>
                  Merged: {channelIds.length} channel id{channelIds.length !== 1 ? 's' : ''}
                </p>
              </div>
              <div>
                <label className="block text-xs font-semibold mb-1" style={{ color: '#000' }}>Extra DM IDs</label>
                <textarea
                  name="dmIdsRaw"
                  value={form.dmIdsRaw}
                  onChange={handleChange}
                  rows={3}
                  placeholder="D01234ABCDE, 19:abc...@thread.v2"
                  className="w-full px-3 py-2 rounded-lg text-xs outline-none bg-white font-mono"
                  style={{ border: '1px solid #0129ac', color: '#000' }}
                />
                <p className="text-[11px] mt-1" style={{ color: '#555' }}>
                  Merged: {dmIds.length} DM id{dmIds.length !== 1 ? 's' : ''}
                </p>
              </div>
            </div>
          )}
        </div>
          </>
        )}
      </Section>

      {/* ── Step 5: Migration Type ── */}
      <Section step={5} title="Migration Type" subtitle="Choose how the migration engine runs this combination.">
        <div className="grid grid-cols-2 gap-3">
          {MIGRATION_TYPES.map((opt) => (
            <TypeBox
              key={opt.value}
              active={form.migrationType === opt.value}
              label={opt.label}
              desc={opt.desc}
              onClick={() => setForm((prev) => ({ ...prev, migrationType: opt.value }))}
            />
          ))}
        </div>
      </Section>

      {/* ── Post Test Data (Optional) ── */}
      <Section step={6} title="Post Test Data" subtitle="Optional — seed test cases into channels/DMs before migrating. Skip this step to migrate existing channel data directly.">

        {/* Two-flow info banner */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="rounded-lg p-3 text-xs" style={{ backgroundColor: '#f0f4ff', border: '1px solid #0129ac' }}>
            <p className="font-semibold mb-1" style={{ color: '#000' }}>Flow 1 — With Test Data</p>
            <p style={{ color: '#555' }}>Select test cases → Post Test Data → Initiate Migration</p>
          </div>
          <div className="rounded-lg p-3 text-xs" style={{ backgroundColor: '#f9f9f9', border: '1px solid #d0d5e8' }}>
            <p className="font-semibold mb-1" style={{ color: '#000' }}>Flow 2 — Existing Data</p>
            <p style={{ color: '#555' }}>Skip this step → click Initiate Migration directly</p>
          </div>
        </div>

        {/* Summary chips */}
        <div className="flex flex-wrap gap-3 text-xs">
          <Chip label="Test cases" value={selectedTestCaseIds.length} />
          <Chip label="Channels"   value={channelIds.length} />
          <Chip label="DMs"        value={dmIds.length} />
          <Chip label="Type"       value={form.testType.charAt(0) + form.testType.slice(1).toLowerCase()} />
          <Chip label="Total messages" value={selectedTestCaseIds.length * Math.max(1, parseInt(repeatCount, 10) || 1)} />
        </div>

        {/* Repeat count — how many times each test case is posted */}
        <div className="flex items-center gap-3">
          <label className="text-xs font-semibold" style={{ color: '#000', whiteSpace: 'nowrap' }}>
            Messages per test case
          </label>
          <input
            type="number"
            min={1}
            max={100000}
            value={repeatCount}
            onChange={(e) => setRepeatCount(Math.max(1, parseInt(e.target.value, 10) || 1))}
            className="w-28 px-3 py-1.5 rounded-lg text-sm outline-none"
            style={{ border: '2px solid #0129ac', color: '#000' }}
          />
          <span className="text-xs" style={{ color: '#555' }}>
            × {selectedTestCaseIds.length} cases = <strong>{selectedTestCaseIds.length * Math.max(1, parseInt(repeatCount, 10) || 1)}</strong> messages per target
          </span>
        </div>

        {/* Source user sign-in status — shown as soon as pairs are mapped */}
        {hasMapping && (
          <SourceUserSignInPanel
            mappedPairs={mappedPairs}
            sourceProvider={step4Provider}
            sourceAdminEmail={getActiveFetchAdmin()}
          />
        )}

        {!canPost && (
          <div className="rounded-lg p-3 text-xs" style={{ backgroundColor: '#f9f9f9', border: '1px solid #d0d5e8', color: '#555' }}>
            {!hasMapping && <p>• Map at least one user pair in Step 1 to post test data.</p>}
            {!hasCases   && <p>• Select at least one test case in Step 3 to post test data.</p>}
            {!hasTargets && <p>• Select at least one channel or DM in Step 4 to post test data.</p>}
          </div>
        )}

        <div className="flex items-center gap-3 flex-wrap">
          <button
            type="button"
            onClick={handlePostTestData}
            disabled={seedLoading || !canPost}
            className="px-6 py-2.5 text-sm font-semibold rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            style={{ backgroundColor: '#0129ac', color: '#fff' }}
          >
            {seedLoading ? (
              <span className="inline-flex items-center gap-2">
                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Posting test data…
              </span>
            ) : (() => {
              const rc = Math.max(1, parseInt(repeatCount, 10) || 1);
              const totalMsgs = selectedTestCaseIds.length * rc;
              const targets = channelIds.length + dmIds.length;
              return seedCompleted
                ? `Re-post Test Data · ${totalMsgs} message${totalMsgs !== 1 ? 's' : ''}`
                : `Post Test Data · ${totalMsgs} message${totalMsgs !== 1 ? 's' : ''} → ${targets} target${targets !== 1 ? 's' : ''}`;
            })()}
          </button>
          {seedCompleted && (
            <span className="text-xs font-medium px-3 py-1 rounded-full" style={{ backgroundColor: '#d4edda', color: '#155724', border: '1px solid #c3e6cb' }}>
              ✓ Test data posted
            </span>
          )}
        </div>

        <SeedStatusPanel
          seedExecution={seedExecution}
          seedError={seedError}
          targets={targets}
          selectedChannelIds={selectedChannelIds}
          selectedDmIds={selectedDmIds}
          selectedTestCaseCount={selectedTestCaseIds.length}
        />
      </Section>

      {/* ── Initiate Migration ── */}
      {!canMigrate && (
        <div className="rounded-lg p-3 text-xs" style={{ backgroundColor: '#f9f9f9', border: '1px solid #d0d5e8', color: '#555' }}>
          {!hasMapping && !hasCsvPath && (
            <p>• Map at least one user pair in Step 1 <strong>or</strong> enter a User Mapping CSV path below.</p>
          )}
          {!hasTargets && <p>• Select at least one channel or DM in Step 4.</p>}
        </div>
      )}

      {/* User Mapping CSV path (optional override for the CF Map & Migrate Users tab) */}
      <div className="rounded-lg p-3 space-y-1" style={{ backgroundColor: '#fff', border: '1px solid #d0d5e8' }}>
        <label htmlFor="user-mapping-csv-path" className="block text-xs font-semibold" style={{ color: '#000' }}>
          User Mapping CSV path <span className="font-normal" style={{ color: '#777' }}>(optional)</span>
        </label>
        <input
          id="user-mapping-csv-path"
          name="userMappingCsvPath"
          type="text"
          value={form.userMappingCsvPath}
          onChange={handleChange}
          placeholder="e.g. C:\Users\you\Desktop\user-mapping.csv  —  leave blank to auto-build from Step 1 pairs"
          className="w-full px-3 py-2 rounded-lg text-xs outline-none bg-white font-mono"
          style={{ border: '1px solid #0129ac', color: '#000' }}
        />
        <p className="text-[11px]" style={{ color: '#555' }}>
          When provided, the browser uploads this exact file via the &quot;CSV ↑&quot; button on the Users tab.
          Path must be readable by the backend host. Header: <code>Source User,Destination User</code>.
        </p>
      </div>

      <div className="flex flex-wrap gap-3 items-center">
        {/* Initiate Migration — always opens CloudFuze browser automation */}
        <button
          type="button"
          onClick={handleCFBrowserMigrate}
          disabled={cfBrowserLoading || !canMigrate}
          className="flex items-center gap-2 px-8 py-3 text-white text-sm font-semibold rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-all"
          style={{ backgroundColor: '#0129ac' }}
          title={!hasTargets ? 'Select at least one channel or DM in Step 4' : (!hasMapping && !hasCsvPath) ? 'Map users in Step 1 or enter a CSV path' : 'Opens CloudFuze in a browser window and auto-starts migration'}
        >
          {cfBrowserLoading ? (
            <span className="flex items-center gap-2">
              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Launching browser…
            </span>
          ) : (
            <span className="flex items-center gap-2">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="2" y1="12" x2="22" y2="12" />
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
              </svg>
              {hasBulk
                ? `Initiate Migration (${mappedPairs.length} pairs · ${form.migrationType === 'FULL' ? 'One Time' : 'Delta'})`
                : `Initiate Migration · ${form.migrationType === 'FULL' ? 'One Time' : 'Delta'} · ${channelIds.length + dmIds.length} target${(channelIds.length + dmIds.length) !== 1 ? 's' : ''}`}
            </span>
          )}
        </button>

        {cfBrowserRunning && (
          <button
            type="button"
            onClick={() => abortCFBrowserMigration().catch(() => {})}
            className="px-4 py-3 text-sm font-semibold rounded-lg"
            style={{ backgroundColor: '#fff0f0', color: '#cc0000', border: '1px solid #cc0000' }}>
            Stop Browser
          </button>
        )}
      </div>

      {/* ── CloudFuze Browser Automation Execution Logs ── */}
      {cfBrowserEvents.length > 0 && (
        <BrowserAutomationLogs events={cfBrowserEvents} running={cfBrowserRunning} />
      )}
    </form>
  );
}

// ── Browser Automation Execution Logs ────────────────────────────────────────

function BrowserAutomationLogs({ events, running }) {
  const logsEndRef = useRef(null);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events]);

  const STEP_COLOR = {
    LAUNCH:      '#0129ac',
    LOGIN:       '#0129ac',
    CLOUDS:      '#7c3aed',
    ADD_CLOUD:   '#7c3aed',
    NAV:         '#0369a1',
    SOURCE_CLOUD:'#0f766e',
    DEST_CLOUD:  '#0f766e',
    CLOUD_PICK:  '#0f766e',
    COMBO:       '#0f766e',
    PREMIG:      '#b45309',
    MAPPING:     '#b45309',
    CHANNELS:    '#1d4ed8',
    MIGRATE:     '#166534',
    REPORTS:     '#166534',
    DONE:        '#166534',
    FAILED:      '#cc0000',
  };

  const isDone   = events.some(e => e.type === 'done');
  const isFailed = events.some(e => e.type === 'failed');

  return (
    <div className="rounded-xl overflow-hidden" style={{ border: '1px solid #0129ac' }}>
      {/* Header */}
      <div className="px-4 py-2.5 flex items-center justify-between"
        style={{ backgroundColor: isFailed ? '#fff0f0' : isDone ? '#d4edda' : '#0129ac' }}>
        <div className="flex items-center gap-2">
          {running && !isDone && !isFailed && (
            <svg className="animate-spin h-3.5 w-3.5 text-white flex-shrink-0" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          )}
          <span className="text-xs font-bold"
            style={{ color: isFailed ? '#cc0000' : isDone ? '#155724' : '#fff' }}>
            {isFailed ? 'Browser Automation Failed' : isDone ? 'Migration Started — Reports page open' : 'CloudFuze Browser Automation Running…'}
          </span>
        </div>
        <span className="text-[11px]" style={{ color: isFailed ? '#cc0000' : isDone ? '#155724' : '#fff9' }}>
          {events.length} event{events.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Log lines */}
      <div className="max-h-72 overflow-y-auto font-mono text-[11px] leading-relaxed p-3 space-y-0.5"
        style={{ backgroundColor: '#0d1117', color: '#c9d1d9' }}>
        {events.map((ev, i) => {
          const isErr = ev.type === 'error-step' || ev.type === 'failed';
          const color = isErr ? '#f87171' : (STEP_COLOR[ev.step] ? '#7dd3fc' : '#a5f3fc');
          const time  = ev.ts ? new Date(ev.ts).toLocaleTimeString('en-US', { hour12: false }) : '';
          return (
            <div key={i} className="flex gap-2">
              <span style={{ color: '#6e7681', flexShrink: 0 }}>{time}</span>
              <span style={{ color, flexShrink: 0, minWidth: '100px' }}>[{ev.step || ev.type}]</span>
              <span style={{ color: isErr ? '#f87171' : '#e6edf3' }}>{ev.detail || ev.error || ''}</span>
            </div>
          );
        })}
        <div ref={logsEndRef} />
      </div>
    </div>
  );
}

// ── CloudFuze Target Picker ───────────────────────────────────────────────────

function CFTargetPicker({ channels, selectedChannels, selectedDms, onToggleChannel, onToggleDm, onSelectAll, onClearAll }) {
  const { publicChannels = [], privateChannels = [], dms = [] } = channels || {};
  const totalCount = publicChannels.length + privateChannels.length + dms.length;
  const selectedCount = selectedChannels.length + selectedDms.length;

  const TABS = [
    { key: 'public',  label: 'Public',  items: publicChannels,  isChannel: true },
    { key: 'private', label: 'Private', items: privateChannels, isChannel: true },
    { key: 'dm',      label: 'DMs',     items: dms,             isChannel: false },
  ].filter(t => t.items.length > 0);

  const [activeTab, setActiveTab] = useState(TABS[0]?.key || 'public');
  const tab = TABS.find(t => t.key === activeTab) || TABS[0];
  const tabItems    = tab?.items || [];
  const tabSelected = tab?.isChannel ? selectedChannels : selectedDms;
  const tabToggle   = tab?.isChannel ? onToggleChannel : onToggleDm;
  const allChecked  = tabItems.length > 0 && tabItems.every(x => tabSelected.some(s => s.id === x.id));

  function toggleAll(checked) {
    tabItems.forEach(item => {
      const has = tabSelected.some(s => s.id === item.id);
      if (checked && !has) tabToggle(item);
      if (!checked && has) tabToggle(item);
    });
  }

  if (totalCount === 0) {
    return (
      <div className="rounded-lg p-3 text-xs" style={{ backgroundColor: '#fff8e5', border: '1px solid #e5b94a', color: '#000' }}>
        No channels or DMs found in CloudFuze for the selected cloud accounts.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex gap-1">
          {TABS.map(t => (
            <button key={t.key} type="button"
              onClick={() => setActiveTab(t.key)}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
              style={{
                backgroundColor: activeTab === t.key ? '#0129ac' : '#fff',
                color: activeTab === t.key ? '#fff' : '#0129ac',
                border: '1px solid #0129ac',
              }}>
              {t.label} ({t.items.length})
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs" style={{ color: '#555' }}>{selectedCount}/{totalCount} selected</span>
          <button type="button" onClick={onSelectAll} className="text-xs underline" style={{ color: '#0129ac' }}>All</button>
          <span className="text-xs" style={{ color: '#ccc' }}>|</span>
          <button type="button" onClick={onClearAll}  className="text-xs underline" style={{ color: '#0129ac' }}>None</button>
        </div>
      </div>

      <div className="rounded-lg overflow-hidden" style={{ border: '1px solid #0129ac' }}>
        <div className="flex items-center gap-2 px-3 py-2" style={{ backgroundColor: '#0129ac' }}>
          <input type="checkbox" checked={allChecked} onChange={e => toggleAll(e.target.checked)}
            style={{ accentColor: '#fff', width: '14px', height: '14px' }} />
          <span className="text-xs font-bold text-white">{tab?.label}</span>
          <span className="ml-auto text-xs text-white/80">
            {tabSelected.filter(s => tabItems.some(x => x.id === s.id)).length}/{tabItems.length}
          </span>
        </div>
        <div className="max-h-56 overflow-y-auto divide-y" style={{ backgroundColor: '#fff' }}>
          {tabItems.map(item => {
            const checked = tabSelected.some(s => s.id === item.id);
            return (
              <label key={item.id}
                className="flex items-center gap-3 px-3 py-2 cursor-pointer"
                style={{ backgroundColor: checked ? '#f0f4ff' : '#fff', borderBottom: '1px solid #eef1fb' }}>
                <input type="checkbox" checked={checked} onChange={() => tabToggle(item)}
                  style={{ accentColor: '#0129ac', width: '14px', height: '14px', flexShrink: 0 }} />
                <span className="flex-1 text-xs font-medium truncate" style={{ color: '#000' }} title={item.name}>
                  {item.name}
                </span>
                <span className="text-[10px] font-mono flex-shrink-0 px-1.5 py-0.5 rounded"
                  style={{ backgroundColor: '#eef1fb', color: '#0129ac' }}>
                  {item.channelType}
                </span>
              </label>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Test Case Picker ──────────────────────────────────────────────────────────

function TestCasePicker({ cases, selectedIds, onToggle, onSelectAll, onClearAll }) {
  const allSelected = cases.length > 0 && cases.every((tc) => selectedIds.includes(String(tc.testCaseId || tc.id || '')));

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold" style={{ color: '#000' }}>
          {selectedIds.length} of {cases.length} selected
        </span>
        <div className="flex gap-2">
          <button type="button" onClick={onSelectAll} className="text-xs underline" style={{ color: '#0129ac' }}>Select all</button>
          <span className="text-xs" style={{ color: '#ccc' }}>|</span>
          <button type="button" onClick={onClearAll}  className="text-xs underline" style={{ color: '#0129ac' }}>Clear</button>
        </div>
      </div>

      <div className="rounded-lg overflow-hidden" style={{ border: '1px solid #0129ac' }}>
        <div className="px-3 py-2 flex items-center gap-2"
          style={{ backgroundColor: '#0129ac' }}>
          <input
            type="checkbox"
            checked={allSelected}
            onChange={(e) => e.target.checked ? onSelectAll() : onClearAll()}
            className="w-3.5 h-3.5"
          />
          <span className="text-xs font-bold text-white uppercase tracking-wider">Test Case</span>
          <span className="text-xs font-bold text-white uppercase tracking-wider ml-auto">Folder</span>
        </div>
        <div className="divide-y max-h-64 overflow-y-auto" style={{ divideColor: '#e0e6ff' }}>
          {cases.map((tc, i) => {
            const id = String(tc.testCaseId || tc.id || `case-${i}`);
            const title = tc.summary || tc.subject || tc.name || id;
            const folder = tc.folder || tc.category || '—';
            const checked = selectedIds.includes(id);
            return (
              <label
                key={id}
                className="flex items-center gap-3 px-3 py-2 cursor-pointer transition-colors"
                style={{
                  backgroundColor: checked ? '#f0f4ff' : '#fff',
                  borderBottom: '1px solid #e0e6ff',
                }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggle(id)}
                  className="w-3.5 h-3.5 flex-shrink-0"
                  style={{ accentColor: '#0129ac' }}
                />
                <div className="flex-1 min-w-0">
                  <span className="text-xs font-medium truncate block" style={{ color: '#000' }}>{title}</span>
                  <span className="text-[11px]" style={{ color: '#555' }}>{id}</span>
                </div>
                <span className="text-[11px] flex-shrink-0 px-2 py-0.5 rounded"
                  style={{ backgroundColor: '#f0f4ff', color: '#0129ac', border: '1px solid #c5cef5' }}>
                  {folder}
                </span>
              </label>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Named target picker ───────────────────────────────────────────────────────

function NamedTargetPicker({ targets, selectedChannelIds, selectedDmIds, onToggleChannel, onToggleDm, onSelectAll, onClearAll }) {
  const { publicChannels = [], privateChannels = [], dms = [], groupDms = [] } = targets || {};
  const total  = publicChannels.length + privateChannels.length + dms.length + groupDms.length;
  const picked = selectedChannelIds.length + selectedDmIds.length;

  const CATEGORIES = [
    { key: 'public',   label: 'Public Channels',       icon: '🌐', items: publicChannels,  isChannel: true },
    { key: 'private',  label: 'Private Channels',      icon: '🔒', items: privateChannels, isChannel: true },
    { key: 'dm',       label: 'Direct Messages (1:1)', icon: '💬', items: dms,             isChannel: false },
    { key: 'groupdm',  label: 'Group DMs',             icon: '👥', items: groupDms,        isChannel: false },
  ].filter((c) => c.items.length > 0);

  const [activeKey, setActiveKey] = useState(CATEGORIES[0]?.key || 'public');

  const activeCategory = CATEGORIES.find((c) => c.key === activeKey) || CATEGORIES[0];
  const activeItems    = activeCategory?.items || [];
  const activeSelected = activeCategory?.isChannel ? selectedChannelIds : selectedDmIds;
  const activeToggle   = activeCategory?.isChannel ? onToggleChannel : onToggleDm;
  const allChecked     = activeItems.length > 0 && activeItems.every((t) => activeSelected.includes(t.id));

  function toggleAllActive(checked) {
    activeItems.forEach((t) => {
      const has = activeSelected.includes(t.id);
      if (checked && !has) activeToggle(t.id);
      if (!checked && has) activeToggle(t.id);
    });
  }

  if (total === 0) {
    return (
      <div className="rounded-lg p-3 text-xs" style={{ backgroundColor: '#fff8e5', border: '1px solid #e5b94a', color: '#000' }}>
        No channels or DMs found. Make sure the selected admin has joined channels/spaces and OAuth scopes are granted.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Top bar: dropdown + summary + global actions */}
      <div className="flex items-center gap-3 flex-wrap">
        <select
          value={activeKey}
          onChange={(e) => setActiveKey(e.target.value)}
          className="text-xs font-semibold px-3 py-2 rounded-lg outline-none bg-white"
          style={{ border: '2px solid #0129ac', color: '#000', minWidth: '200px' }}
        >
          {CATEGORIES.map((c) => (
            <option key={c.key} value={c.key}>
              {c.icon} {c.label} ({c.items.length})
            </option>
          ))}
        </select>

        <span className="text-xs" style={{ color: '#555' }}>
          {picked} / {total} selected total
        </span>

        <div className="flex gap-2 ml-auto">
          <button type="button" onClick={onSelectAll} className="text-xs underline" style={{ color: '#0129ac' }}>Select all</button>
          <span className="text-xs" style={{ color: '#ccc' }}>|</span>
          <button type="button" onClick={onClearAll}  className="text-xs underline" style={{ color: '#0129ac' }}>Clear all</button>
        </div>
      </div>

      {/* Active category list */}
      <div className="rounded-lg overflow-hidden" style={{ border: '1px solid #0129ac' }}>
        {/* Category header with select-all */}
        <div className="flex items-center gap-2 px-3 py-2.5" style={{ backgroundColor: '#0129ac' }}>
          <input
            type="checkbox"
            checked={allChecked}
            onChange={(e) => toggleAllActive(e.target.checked)}
            style={{ accentColor: '#fff', width: '14px', height: '14px' }}
          />
          <span className="text-xs font-bold text-white">
            {activeCategory?.icon} {activeCategory?.label}
          </span>
          <span className="ml-auto text-xs font-bold text-white/80">
            {activeSelected.filter((id) => activeItems.some((t) => t.id === id)).length} / {activeItems.length} selected
          </span>
        </div>

        {/* Items list */}
        <div className="max-h-64 overflow-y-auto divide-y" style={{ divideColor: '#eef1fb', backgroundColor: '#fff' }}>
          {activeItems.map((t) => {
            const checked = activeSelected.includes(t.id);
            return (
              <label
                key={t.id}
                className="flex items-center gap-3 px-3 py-2.5 cursor-pointer"
                style={{ backgroundColor: checked ? '#f0f4ff' : '#fff', borderBottom: '1px solid #eef1fb' }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => activeToggle(t.id)}
                  style={{ accentColor: '#0129ac', width: '14px', height: '14px', flexShrink: 0 }}
                />
                <span className="flex-1 text-xs font-medium truncate" style={{ color: '#000' }} title={t.name}>
                  {t.name}
                </span>
                <span className="text-[10px] font-mono flex-shrink-0 px-1.5 py-0.5 rounded"
                  style={{ backgroundColor: '#eef1fb', color: '#0129ac' }}>
                  {t.id.length > 20 ? t.id.slice(0, 20) + '…' : t.id}
                </span>
              </label>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Admin selector for Step 4 ─────────────────────────────────────────────────

function AdminSelector({ provider, accounts, selectedAdmin, onSelect }) {
  if (!provider) return null;
  const connected = Array.isArray(accounts) ? accounts : [];

  if (connected.length === 0) {
    return (
      <div className="rounded-lg p-3 text-xs" style={{ backgroundColor: '#fff8e5', border: '1px solid #e5b94a', color: '#000' }}>
        No <strong>{providerLabel(provider)}</strong> admin authenticated. Add one via Step 1 → {providerLabel(provider)} tab.
      </div>
    );
  }

  return (
    <div className="rounded-lg p-3 text-xs space-y-2" style={{ border: '1px solid #d0d5e8', backgroundColor: '#fff' }}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-semibold" style={{ color: '#000' }}>
          Source · {providerLabel(provider)}:
        </span>
        {connected.length === 1 ? (
          <span className="font-mono px-2 py-0.5 rounded" style={{ backgroundColor: '#f0f4ff', color: '#0129ac', border: '1px solid #c5cef5' }}>
            {connected[0].email}
          </span>
        ) : (
          <select
            value={selectedAdmin || ''}
            onChange={(e) => onSelect(e.target.value)}
            className="text-xs px-2 py-1 rounded outline-none bg-white font-mono"
            style={{ border: '1px solid #0129ac', color: '#000', minWidth: '220px' }}
          >
            {connected.map((a) => (
              <option key={a.email} value={a.email}>{a.email}</option>
            ))}
          </select>
        )}
      </div>
      <p className="text-[11px]" style={{ color: '#555' }}>
        Will fetch public channels, private channels, 1:1 DMs and group DMs as{' '}
        <span className="font-mono" style={{ color: '#000' }}>{selectedAdmin || connected[0]?.email}</span>.
      </p>
    </div>
  );
}

// ── Seed status panel ─────────────────────────────────────────────────────────

function SeedStatusPanel({ seedExecution, seedError, targets, selectedChannelIds, selectedDmIds, selectedTestCaseCount }) {
  if (seedError) {
    return (
      <div className="rounded-lg p-3 text-xs" style={{ backgroundColor: '#fff0f0', border: '1px solid #cc0000', color: '#000' }}>
        <strong>Seeding failed:</strong> {seedError}
      </div>
    );
  }
  if (!seedExecution) return null;

  if (seedExecution.bulk) {
    return (
      <div className="rounded-lg p-3 text-xs" style={{ backgroundColor: '#f0f4ff', border: '1px solid #0129ac', color: '#000' }}>
        Seeded <strong>{seedExecution.completed}</strong>/{seedExecution.totalPairs} pairs
        {seedExecution.failed ? ` · ${seedExecution.failed} failed` : ''}.
      </div>
    );
  }

  const status = seedExecution.status || seedExecution.result?.status;
  const source = seedExecution.result?.sourceData || seedExecution.sourceData;

  if (status === 'RUNNING') {
    return (
      <div className="rounded-lg p-3 text-xs flex items-center gap-2" style={{ backgroundColor: '#f0f4ff', border: '1px solid #0129ac', color: '#000' }}>
        <svg className="animate-spin h-3 w-3 flex-shrink-0" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="#0129ac" strokeWidth="4" fill="none" />
          <path className="opacity-75" fill="#0129ac" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        Seeding in progress… {seedExecution.progress || seedExecution.currentAgent || ''}
      </div>
    );
  }

  if (status === 'FAILED') {
    return (
      <div className="rounded-lg p-3 text-xs" style={{ backgroundColor: '#fff0f0', border: '1px solid #cc0000', color: '#000' }}>
        <strong>Seeding failed:</strong> {seedExecution.error || seedExecution.result?.error || 'unknown error'}
      </div>
    );
  }

  if (status === 'COMPLETED' && source) {
    // Build a name/type lookup from the fetched targets list
    const nameMap = {};
    const typeMap = {};
    const allTargetsList = [
      ...(targets?.publicChannels  || []).map(t => ({ ...t, category: 'Public Channel' })),
      ...(targets?.privateChannels || []).map(t => ({ ...t, category: 'Private Channel' })),
      ...(targets?.dms             || []).map(t => ({ ...t, category: '1:1 DM' })),
      ...(targets?.groupDms        || []).map(t => ({ ...t, category: 'Group DM' })),
    ];
    allTargetsList.forEach(t => { nameMap[t.id] = t.name; typeMap[t.id] = t.category; });

    const isDryRun = !(source.livePosting || source.liveSlackPosting);
    // Use the count of test cases that were actually selected in the UI (most accurate).
    // Fall back to what the backend reports if the prop is not available.
    const totalCases = (selectedTestCaseCount != null && selectedTestCaseCount > 0)
      ? selectedTestCaseCount
      : (source.totalCases || 0);

    // Collect ALL targets that should have been seeded:
    //   1. The channels/DMs the user had selected in Step 4 (passed as props).
    //   2. Any additional IDs that appear in skipped[] or errors[] (safety net).
    // This ensures targets with 100% success (not in either array) still appear.
    const allProcessedIds = [
      ...new Set([
        ...(selectedChannelIds || []),
        ...(selectedDmIds      || []),
        ...(source.skipped || []).map(s => s.target),
        ...(source.errors  || []).map(e => e.target),
      ]),
    ];

    // Per-target breakdown
    const perTarget = allProcessedIds.map(id => {
      const skippedCount  = (source.skipped || []).filter(s => s.target === id).length;
      const failedCount   = (source.errors  || []).filter(e => e.target === id).length;
      // In live mode: attempted = totalCases, succeeded = those not in errors or skipped.
      // In dry-run:   all entries land in skipped[]; succeeded is irrelevant — we show skipped count.
      const succeededCount = isDryRun ? 0 : Math.max(0, totalCases - failedCount);
      const errors = (source.errors || []).filter(e => e.target === id);
      return {
        id,
        name: nameMap[id] || id,
        category: typeMap[id] || '',
        attempted: totalCases,
        succeeded: succeededCount,
        failed: failedCount,
        skipped: skippedCount,
        errors,
      };
    });

    return (
      <div className="space-y-3">
        {/* Summary stat cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <SeedStatCard label="Total Targets" value={source.totalTargets ?? 0} color="#0129ac" />
          <SeedStatCard label="Messages Attempted" value={source.postsAttempted ?? 0} color="#0129ac" />
          <SeedStatCard
            label={isDryRun ? 'Dry-run (simulated)' : 'Posted Successfully'}
            value={isDryRun ? (source.postsAttempted ?? 0) : (source.postsSucceeded ?? 0)}
            color={isDryRun ? '#555' : '#155724'}
            bg={isDryRun ? '#f0f0f0' : '#d4edda'}
          />
          <SeedStatCard
            label="Failed"
            value={source.postsFailed ?? 0}
            color={(source.postsFailed ?? 0) > 0 ? '#8b1a1a' : '#155724'}
            bg={(source.postsFailed ?? 0) > 0 ? '#fff0f0' : '#d4edda'}
          />
        </div>

        {isDryRun && (
          <div className="rounded-lg px-3 py-2 text-xs" style={{ backgroundColor: '#fff8e5', border: '1px solid #e5b94a', color: '#000' }}>
            Dry-run mode — platform not connected live. Messages were simulated and logged but not actually posted.
          </div>
        )}

        {/* Per-channel/DM breakdown table */}
        {perTarget.length > 0 && (
          <div className="rounded-lg overflow-hidden" style={{ border: '1px solid #0129ac' }}>
            <div className="px-4 py-2.5" style={{ backgroundColor: '#0129ac' }}>
              <span className="text-xs font-bold text-white">Messages Posted — Per Channel / DM</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr style={{ backgroundColor: '#f0f4ff', borderBottom: '1px solid #c5cef5' }}>
                    <th className="px-3 py-2 text-left font-semibold" style={{ color: '#000' }}>Channel / DM</th>
                    <th className="px-3 py-2 text-left font-semibold" style={{ color: '#000' }}>Type</th>
                    <th className="px-3 py-2 text-center font-semibold" style={{ color: '#000' }}>Attempted</th>
                    <th className="px-3 py-2 text-center font-semibold" style={{ color: '#000' }}>
                      {isDryRun ? 'Simulated' : 'Posted ✓'}
                    </th>
                    <th className="px-3 py-2 text-center font-semibold" style={{ color: '#000' }}>Failed ✗</th>
                    <th className="px-3 py-2 text-center font-semibold" style={{ color: '#000' }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {perTarget.map((t, i) => (
                    <tr key={t.id} style={{ borderBottom: '1px solid #eef1fb', backgroundColor: i % 2 === 0 ? '#fff' : '#fafbff' }}>
                      <td className="px-3 py-2 font-medium" style={{ color: '#000' }}>
                        <span className="truncate block max-w-[180px]" title={t.name}>{t.name}</span>
                        <span className="text-[10px] font-mono" style={{ color: '#aaa' }}>
                          {t.id.length > 18 ? t.id.slice(0, 18) + '…' : t.id}
                        </span>
                      </td>
                      <td className="px-3 py-2" style={{ color: '#555' }}>{t.category}</td>
                      <td className="px-3 py-2 text-center font-semibold" style={{ color: '#000' }}>{t.attempted}</td>
                      <td className="px-3 py-2 text-center font-semibold" style={{ color: isDryRun ? '#555' : '#155724' }}>
                        {isDryRun ? t.skipped : t.succeeded}
                      </td>
                      <td className="px-3 py-2 text-center font-semibold" style={{ color: t.failed > 0 ? '#cc0000' : '#155724' }}>
                        {t.failed}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {isDryRun ? (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold" style={{ backgroundColor: '#f0f0f0', color: '#555' }}>DRY-RUN</span>
                        ) : t.failed === 0 ? (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold" style={{ backgroundColor: '#d4edda', color: '#155724' }}>✓ ALL POSTED</span>
                        ) : t.succeeded === 0 ? (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold" style={{ backgroundColor: '#fff0f0', color: '#cc0000' }}>✗ ALL FAILED</span>
                        ) : (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold" style={{ backgroundColor: '#fff8e5', color: '#7a5400' }}>⚠ PARTIAL</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Error details */}
            {(source.errors || []).length > 0 && (
              <div className="px-4 py-3 space-y-1" style={{ borderTop: '1px solid #eef1fb', backgroundColor: '#fff8f8' }}>
                <p className="text-xs font-semibold mb-2" style={{ color: '#cc0000' }}>Post Errors</p>
                {(source.errors || []).map((e, i) => (
                  <div key={i} className="text-xs" style={{ color: '#000' }}>
                    <span className="font-mono">{nameMap[e.target] || e.target}</span>
                    {' — '}<span className="font-medium">{e.case}</span>: {e.error}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  return null;
}

// ── Source user sign-in status panel ─────────────────────────────────────────

/**
 * Shows per-user sign-in status for every source email in mappedPairs.
 * Polls the backend every 4 s so the indicators update automatically after
 * a user signs in via the OAuth popup.
 */
function SourceUserSignInPanel({ mappedPairs, sourceProvider, sourceAdminEmail }) {
  const [statuses, setStatuses]   = useState([]);
  const [signingIn, setSigningIn] = useState(null); // email currently signing in
  const [tokenInput, setTokenInput] = useState('');
  const [tokenInstalling, setTokenInstalling] = useState(false);
  const [tokenResult, setTokenResult] = useState(null); // { ok, email } | { error }
  const popupRef = useRef(null);
  const pollRef  = useRef(null);

  // All unique source emails (admin + mapped users)
  const sourceEmails = useMemo(() => {
    const users = Array.isArray(mappedPairs) ? mappedPairs.map(p => p.sourceEmail).filter(Boolean) : [];
    const all   = sourceAdminEmail ? [sourceAdminEmail, ...users] : users;
    return [...new Set(all)];
  }, [mappedPairs, sourceAdminEmail]);

  const fetchStatus = useCallback(async () => {
    if (!sourceEmails.length || !sourceProvider) return;
    try {
      const { data } = await getMessageUserStatus(sourceEmails, sourceProvider);
      setStatuses(data.statuses || []);
    } catch { /* ignore */ }
  }, [sourceEmails, sourceProvider]);

  // Initial fetch + auto-refresh every 4 s
  useEffect(() => {
    fetchStatus();
    const t = setInterval(fetchStatus, 4000);
    return () => clearInterval(t);
  }, [fetchStatus]);

  // Cleanup on unmount
  useEffect(() => () => {
    clearInterval(pollRef.current);
    popupRef.current?.close();
  }, []);

  async function handleSignIn(email) {
    try {
      setSigningIn(email);
      let res;
      if (sourceProvider === 'microsoft') {
        res = await getMicrosoftOAuthUrl('popup', '1', 'message');
      } else if (sourceProvider === 'google') {
        res = await getGoogleOAuthUrl('popup', '3', 'message');
      } else if (sourceProvider === 'slack') {
        res = await getSlackOAuthUrl('popup', 'message');
      }
      const url = res?.data?.url;
      if (!url) { setSigningIn(null); return; }

      localStorage.removeItem('cf_oauth_result');
      popupRef.current = openOAuthPopup(url);

      // Poll localStorage until popup writes cf_oauth_result or closes
      clearInterval(pollRef.current);
      pollRef.current = setInterval(() => {
        const raw = localStorage.getItem('cf_oauth_result');
        if (raw) {
          try {
            const result = JSON.parse(raw);
            if (result.ts && Date.now() - result.ts < 60000) {
              localStorage.removeItem('cf_oauth_result');
              clearInterval(pollRef.current);
              popupRef.current?.close();
              popupRef.current = null;
              setSigningIn(null);
              fetchStatus();
            }
          } catch { /* ignore */ }
        }
        if (popupRef.current?.closed) {
          clearInterval(pollRef.current);
          setSigningIn(null);
          fetchStatus();
        }
      }, 500);
    } catch {
      setSigningIn(null);
    }
  }

  async function handleInstallToken(e) {
    e?.preventDefault?.();
    const tok = tokenInput.trim();
    if (!tok || !tok.startsWith('xox')) return;
    setTokenInstalling(true);
    setTokenResult(null);
    try {
      const { data } = await connectSlackToken(tok, 'message');
      setTokenResult({ ok: true, email: data.email });
      setTokenInput('');
      fetchStatus();
    } catch (err) {
      setTokenResult({ error: err?.response?.data?.error || err.message || 'Install failed' });
    } finally {
      setTokenInstalling(false);
    }
  }

  if (!sourceEmails.length || !sourceProvider) return null;

  const readyCount = statuses.filter(s => s.hasToken).length;
  const allReady   = readyCount === sourceEmails.length && sourceEmails.length > 0;

  return (
    <div className="rounded-lg overflow-hidden"
      style={{ border: `1px solid ${allReady ? '#28a745' : '#e5b94a'}` }}>
      {/* Header */}
      <div className="px-4 py-2.5 flex items-center justify-between"
        style={{ backgroundColor: allReady ? '#d4edda' : '#fff8e5' }}>
        <span className="text-xs font-bold"
          style={{ color: allReady ? '#155724' : '#7a5400' }}>
          {allReady
            ? `✓ All ${sourceEmails.length} source user${sourceEmails.length > 1 ? 's' : ''} signed in — ready to post`
            : `⚠ ${readyCount} / ${sourceEmails.length} source user${sourceEmails.length > 1 ? 's' : ''} signed in`}
        </span>
        <span className="text-[11px]" style={{ color: '#555' }}>
          {providerLabel(sourceProvider)} · auto-refreshes every 4 s
        </span>
      </div>

      {/* Per-user rows */}
      <div style={{ backgroundColor: '#fff' }}>
        {sourceEmails.map((email, i) => {
          const s         = statuses.find(x => x.email === email);
          const ready     = s?.hasToken || false;
          const busy      = signingIn === email;
          const isAdmin   = email === sourceAdminEmail;
          // A user without their own token will use the admin as fallback
          const adminReady = sourceAdminEmail && statuses.find(x => x.email === sourceAdminEmail)?.hasToken;
          const willUseAdmin = !ready && !isAdmin && adminReady;

          return (
            <div key={email}
              className="flex items-center gap-3 px-4 py-2.5"
              style={{
                borderTop: i === 0 ? 'none' : '1px solid #eef1fb',
                backgroundColor: ready ? '#f6fff8' : willUseAdmin ? '#f0f4ff' : '#fffdf5',
              }}>
              {/* Status dot */}
              <span className="w-5 h-5 rounded-full flex-shrink-0 flex items-center justify-center text-white text-[10px] font-bold"
                style={{ backgroundColor: ready ? '#28a745' : willUseAdmin ? '#0129ac' : '#dc3545' }}>
                {ready ? '✓' : willUseAdmin ? '↑' : '✗'}
              </span>

              {/* Email */}
              <span className="flex-1 text-xs font-mono truncate" style={{ color: '#000' }} title={email}>
                {email}
              </span>

              {/* Role badge */}
              <span className="text-[11px] px-2 py-0.5 rounded"
                style={{
                  backgroundColor: isAdmin ? '#0129ac' : '#f0f4ff',
                  color:           isAdmin ? '#fff'    : '#0129ac',
                  border: '1px solid #c5cef5',
                }}>
                {isAdmin ? 'Admin' : 'User'}
              </span>

              {/* Status label / Sign-in button */}
              {ready ? (
                <span className="text-[11px] font-semibold w-28 text-right" style={{ color: '#155724' }}>
                  ✓ Ready
                </span>
              ) : willUseAdmin ? (
                <span className="text-[11px] font-semibold w-28 text-right" style={{ color: '#0129ac' }}>
                  ↑ Uses admin
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => handleSignIn(email)}
                  disabled={!!signingIn}
                  className="text-xs font-semibold px-3 py-1 rounded disabled:opacity-50 w-28 text-center"
                  style={{ backgroundColor: '#0129ac', color: '#fff' }}>
                  {busy ? 'Opening…' : 'Sign in'}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Bottom hint */}
      <div className="px-4 py-2 text-[11px]"
        style={{ backgroundColor: '#f9f9f9', borderTop: '1px solid #eef1fb', color: '#555' }}>
        {allReady
          ? `All users have their own ${providerLabel(sourceProvider)} token — messages will appear from each user individually.`
          : sourceAdminEmail && statuses.find(x => x.email === sourceAdminEmail)?.hasToken
          ? `Admin token active — users marked "↑ Uses admin" will post through the admin account. Sign them in individually to post as each user.`
          : `Sign in at least the admin account to enable live posting.`}
        {sourceProvider === 'microsoft' && !allReady && (
          <span> Use <strong>Message Agent app</strong> (Teams scopes) when signing in.</span>
        )}
      </div>

      {/* Slack direct token install — paste xoxp- token without browser popup */}
      {sourceProvider === 'slack' && (
        <div className="px-4 py-3" style={{ borderTop: '1px solid #eef1fb', backgroundColor: '#fafbff' }}>
          <p className="text-[11px] font-semibold mb-2" style={{ color: '#000' }}>
            Install Slack token directly (xoxp-…)
          </p>
          <div className="flex gap-2 items-start flex-wrap">
            <input
              type="text"
              value={tokenInput}
              onChange={(e) => { setTokenInput(e.target.value); setTokenResult(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleInstallToken(e); } }}
              placeholder="xoxp-000000000000-000000000000-…"
              className="flex-1 min-w-0 px-3 py-1.5 rounded text-xs font-mono outline-none bg-white"
              style={{ border: '1px solid #0129ac', color: '#000', minWidth: '260px' }}
            />
            <button
              type="submit"
              disabled={tokenInstalling || !tokenInput.trim().startsWith('xox')}
              className="px-4 py-1.5 rounded text-xs font-semibold disabled:opacity-50 flex-shrink-0"
              style={{ backgroundColor: '#0129ac', color: '#fff' }}
            >
              {tokenInstalling ? 'Installing…' : 'Install Token'}
            </button>
          </div>
          {tokenResult?.ok && (
            <p className="text-[11px] mt-1.5 font-semibold" style={{ color: '#155724' }}>
              ✓ Token installed for <span className="font-mono">{tokenResult.email}</span>
            </p>
          )}
          {tokenResult?.error && (
            <p className="text-[11px] mt-1.5" style={{ color: '#cc0000' }}>
              {tokenResult.error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function SeedStatCard({ label, value, color, bg }) {
  return (
    <div className="rounded-lg p-3 text-center" style={{ backgroundColor: bg || '#f0f4ff', border: `1px solid ${color || '#0129ac'}` }}>
      <p className="text-lg font-black" style={{ color: color || '#0129ac' }}>{value}</p>
      <p className="text-[11px] font-medium mt-0.5" style={{ color: '#555' }}>{label}</p>
    </div>
  );
}

// ── Layout primitives ─────────────────────────────────────────────────────────

function Section({ step, title, subtitle, children }) {
  return (
    <div className="rounded-xl p-5 space-y-4" style={{ border: '1px solid #0129ac', backgroundColor: '#ffffff' }}>
      <div className="flex items-start gap-3">
        <span
          className="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold text-white"
          style={{ backgroundColor: '#0129ac' }}
        >
          {step}
        </span>
        <div>
          <h3 className="text-sm font-semibold" style={{ color: '#000' }}>{title}</h3>
          {subtitle && <p className="text-xs mt-0.5" style={{ color: '#555' }}>{subtitle}</p>}
        </div>
      </div>
      {children}
    </div>
  );
}

function TypeBox({ active, label, desc, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="relative rounded-xl p-4 text-left transition-all"
      style={{
        border: active ? '2px solid #0129ac' : '2px solid #d0d5e8',
        backgroundColor: active ? '#f0f4ff' : '#ffffff',
      }}
    >
      <p className="text-sm font-semibold" style={{ color: '#000' }}>{label}</p>
      <p className="text-xs mt-0.5" style={{ color: '#555' }}>{desc}</p>
      {active && (
        <span className="absolute top-2 right-2 w-2 h-2 rounded-full" style={{ backgroundColor: '#0129ac' }} />
      )}
    </button>
  );
}

function Chip({ label, value }) {
  return (
    <div className="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs"
      style={{ backgroundColor: '#f0f4ff', border: '1px solid #0129ac', color: '#000' }}>
      <span style={{ color: '#555' }}>{label}:</span>
      <strong style={{ color: '#0129ac' }}>{value}</strong>
    </div>
  );
}
