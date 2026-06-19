import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Link } from 'react-router-dom';
import UserMapping from './UserMapping';
import AdditionalCredentials from './AdditionalCredentials';
import { MESSAGE_MIGRATION_COMBINATIONS, parseIdList } from '../constants/messageCombinations';
import {
  getCustomTestCases, getMessageTargets, getConnectedAccounts,
  getMessageUserStatus, connectSlackToken,
  getMicrosoftOAuthUrl, getGoogleOAuthUrl, getSlackOAuthUrl,
  getCFCloudAccounts, getCFChannels, getCFDMs,
  getCFChannelsAll, getCFChannelsCache,
  getCFBrowserEvents, abortCFBrowserMigration,
  uploadMappingCsv,
} from '../services/api';

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

const BASE_DOWNLOADS = 'C:\\Users\\NagaLakshmiMangina\\Downloads';
const COMBINATION_DEFAULT_CSV = {
  'Slack → Microsoft Teams':         `${BASE_DOWNLOADS}\\Slack to teams mapping (1).csv`,
  'Slack → Google Chat':             `${BASE_DOWNLOADS}\\slack to chat mapping.csv`,
  'Slack → Slack':                   `${BASE_DOWNLOADS}\\Slack to Slack mapping.csv`,
  'Microsoft Teams → Microsoft Teams': `${BASE_DOWNLOADS}\\Teams to Teams mapping.csv`,
  'Microsoft Teams → Google Chat':   `${BASE_DOWNLOADS}\\Teams to chat mapping.csv`,
  'Google Chat → Microsoft Teams':   `${BASE_DOWNLOADS}\\chat to teams Mapping.csv`,
};

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
    migrationType: 'FULL',
    messageCombination: MESSAGE_MIGRATION_COMBINATIONS[0],
    channelIdsRaw: '',
    dmIdsRaw: '',
    userMappingCsvPath: COMBINATION_DEFAULT_CSV[MESSAGE_MIGRATION_COMBINATIONS[0]] || '',
    recordingPath: '',
  });

  const [mappedPairs, setMappedPairs]   = useState(null);
  const [mappingMeta, setMappingMeta]   = useState(null);
  const [liveSourceProvider, setLiveSourceProvider] = useState(null);

  // CSV mapping upload state (auto-generated from mapping pairs)
  const [csvFileName, setCsvFileName]   = useState(null);
  const [csvUploading, setCsvUploading] = useState(false);
  const [csvUploadError, setCsvUploadError] = useState(null);

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

  // Test scenarios for posting
  const [allScenarios, setAllScenarios]           = useState([]);
  const [scenariosLoading, setScenariosLoading]   = useState(false);
  const [selectedScenarioId, setSelectedScenarioId] = useState(null);

  const [targets, setTargets]           = useState(null);
  const [targetsLoading, setTargetsLoading] = useState(false);
  const [targetsError, setTargetsError] = useState(null);
  const [selectedChannelIds, setSelectedChannelIds] = useState([]);
  const [selectedDmIds, setSelectedDmIds]           = useState([]);
  const [showManualIds, setShowManualIds] = useState(false);
  const [selectedFetchAdmin, setSelectedFetchAdmin] = useState(null);

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

  const [cfAccountEmail, setCfAccountEmail] = useState('');

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

  const [cfMode, setCfMode]                 = useState(false);
  const [cfAccounts, setCfAccounts]         = useState([]);
  const [cfAccountsLoading, setCfAccountsLoading] = useState(false);
  const [cfAccountsError, setCfAccountsError]     = useState(null);
  const [cfSrcCloudId, setCfSrcCloudId]     = useState('');
  const [cfDstCloudId, setCfDstCloudId]     = useState('');
  const [cfChannels, setCfChannels]         = useState(null);
  const [cfChannelLoading, setCfChannelLoading] = useState(false);
  const [cfChannelError, setCfChannelError] = useState(null);
  const [cfSelectedChannels, setCfSelectedChannels] = useState([]);
  const [cfSelectedDms, setCfSelectedDms]   = useState([]);
  const [cfCacheFetchedAt, setCfCacheFetchedAt] = useState(null);

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

  useEffect(() => {
    // For same-platform migrations (T2T, S2S, GC2GC) the source and destination account lists
    // are identical — auto-selecting index 0 for both would send the same cloud ID twice,
    // causing CloudFuze to treat it as a self-migration and mark it "Conflict".
    const effectiveSrcId = cfSrcCloudId || (cfSrcAccounts.length > 0 ? cfSrcAccounts[0].id : '');
    if (cfSrcAccounts.length > 0 && !cfSrcCloudId) setCfSrcCloudId(cfSrcAccounts[0].id);
    if (cfDstAccounts.length > 0 && !cfDstCloudId) {
      const isSamePlatform = cfSrcPlatform && cfSrcPlatform === cfDstPlatform;
      if (isSamePlatform && effectiveSrcId) {
        const different = cfDstAccounts.find(a => a.id !== effectiveSrcId);
        setCfDstCloudId(different ? different.id : cfDstAccounts[0].id);
      } else {
        setCfDstCloudId(cfDstAccounts[0].id);
      }
    }
  }, [cfSrcAccounts, cfDstAccounts]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setCfChannels(null);
    setCfSelectedChannels([]);
    setCfSelectedDms([]);
    setCfCacheFetchedAt(null);
    setCfSrcCloudId('');
    setCfDstCloudId('');
    // Auto-set the CSV path to the correct default for this combination.
    // Only overwrite if the current value is one of the known defaults (i.e. not manually edited).
    const knownDefaults = new Set(Object.values(COMBINATION_DEFAULT_CSV));
    setForm(prev => {
      const currentPath = (prev.userMappingCsvPath || '').trim();
      if (!currentPath || knownDefaults.has(currentPath)) {
        return { ...prev, userMappingCsvPath: COMBINATION_DEFAULT_CSV[prev.messageCombination] || '' };
      }
      return prev;
    });
  }, [form.messageCombination]);

  const normCh = useCallback((arr, type) => (Array.isArray(arr) ? arr : []).map(ch => {
    const resolvedId   = ch.fromRootId || ch.channelId || ch.id || '';
    const resolvedName = ch.channelName || ch.channel_name || ch.name ||
                         ch.displayName || ch.display_name || ch.title ||
                         ch.fromRootId  || ch.channelId    || ch.id || '';
    // Covers CF's many team/workspace name field variants across platforms
    const workSpace = ch.workSpaceName || ch.teamName || ch.team_name ||
                      ch.sourceTeamName || ch.channelGroup || ch.groupName ||
                      ch.parentName || ch.teamDisplayName || ch.workspace ||
                      ch.teamId || ch.metadataUrl || '';
    return {
      id: resolvedId, name: resolvedName, channelName: resolvedName,
      channelType: type,
      workSpaceName: workSpace,
      destChannelName: ch.destChannelName || resolvedName,
      // Never fall back to '/' — CF shows it literally as the team name in reports
      destTeamName: ch.destTeamName || workSpace || resolvedName || '',
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
      } catch { /* ignore */ }
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

  // Load saved test scenarios filtered to current combination
  useEffect(() => {
    let cancelled = false;
    setScenariosLoading(true);
    (async () => {
      try {
        const { data } = await getCustomTestCases();
        if (cancelled) return;
        const list = Array.isArray(data?.scenarios) ? data.scenarios : [];
        const matched = list.filter(tc =>
          (tc.productType || '').toLowerCase() === 'message' &&
          (tc.combination || '').trim() === (form.messageCombination || '').trim()
        );
        setAllScenarios(matched);
        setSelectedScenarioId(prev => (matched.find(tc => (tc.testCaseId || tc.id) === prev) ? prev : (matched[0]?.testCaseId || matched[0]?.id || null)));
      } catch {
        if (!cancelled) setAllScenarios([]);
      } finally {
        if (!cancelled) setScenariosLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [form.messageCombination]); // eslint-disable-line react-hooks/exhaustive-deps

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

  function handleChange(e) {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  }

  async function handleMappingComplete(pairs, meta) {
    setMappedPairs(pairs);
    setMappingMeta(meta || null);

    if (!pairs || pairs.length === 0) return;

    // If user has already entered a local CSV path, use it directly — no upload needed
    if (form.userMappingCsvPath && form.userMappingCsvPath.trim()) {
      setCsvFileName(form.userMappingCsvPath.trim());
      return;
    }

    // Auto-generate CSV from mapping pairs and upload to backend
    const csvContent = [
      'Source User,Destination User',
      ...pairs.map(p => `${p.sourceEmail},${p.destinationEmail}`),
    ].join('\n');

    setCsvUploading(true);
    setCsvUploadError(null);
    setCsvFileName(null);
    try {
      const { data } = await uploadMappingCsv(csvContent, 'mapping.csv');
      setForm(p => ({ ...p, userMappingCsvPath: data.filePath }));
      setCsvFileName(data.filePath);
    } catch (err) {
      setCsvUploadError(err?.response?.data?.error || err.message || 'CSV upload failed');
    } finally {
      setCsvUploading(false);
    }
  }

  function clearMapping() {
    setMappedPairs(null);
    setMappingMeta(null);
    setCsvFileName(null);
    setCsvUploadError(null);
  }

  const hasMapping  = mappedPairs && mappedPairs.length > 0;
  const hasBulk     = mappedPairs && mappedPairs.length > 1;
  const hasTargets  = channelIds.length > 0 || dmIds.length > 0;
  const hasCsvPath  = !!(form.userMappingCsvPath || '').trim();
  const canPost     = hasMapping && hasTargets && !!selectedScenarioId;
  const canMigrate  = (hasMapping || hasCsvPath) && hasTargets;

  const selectedScenario = allScenarios.find(tc =>
    (tc.testCaseId || tc.id) === selectedScenarioId
  ) || null;

  const seedCompleted = useMemo(() => {
    if (!seedExecution) return false;
    if (seedExecution.bulk) return (seedExecution.completed || 0) > 0;
    const finalStatus = seedExecution.status || seedExecution.result?.status;
    return finalStatus === 'COMPLETED';
  }, [seedExecution]);

  function handlePostTestData(e) {
    e?.preventDefault?.();
    if (!canPost || !onSeed) return;
    const base = {
      migrationType:       form.migrationType,
      messageCombination:  form.messageCombination,
      channelIds,
      dmIds,
      channelObjects:      cfSelectedChannels,
      dmObjects:           cfSelectedDms,
      selectedTestCaseIds: [selectedScenarioId],
      sourceAdminEmail:    getActiveFetchAdmin(),
    };
    if (hasBulk) {
      onSeed({ ...base, mappedPairs });
    } else {
      onSeed({ ...base, sourceEmail: mappedPairs[0].sourceEmail, destinationEmail: mappedPairs[0].destinationEmail });
    }
  }

  function handleSubmit(e) {
    e.preventDefault();
    handleCFBrowserMigrate();
  }

  function handleCFBrowserMigrate() {
    if (!canMigrate || !onCFBrowserMigrate) return;

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
      mappingType,
      userMappings: pairs.map(p => ({
        sourceEmail:      p.sourceEmail,
        destinationEmail: p.destinationEmail,
      })),
      userMappingCsvPath: (form.userMappingCsvPath || '').trim() || null,
      migrationType:      form.migrationType,
      sourceAdminEmail:   getActiveFetchAdmin(),
      cfAccountEmail:     cfAccountEmail || null,
    });
  }

  // ── fetch-all helpers (auto-select after fetch) ───────────────────────────
  async function handleFetchAndSelectAllCF() {
    if (!cfSrcCloudId || !cfDstCloudId) return;
    setCfChannelLoading(true);
    setCfChannelError(null);
    try {
      const { data } = await getCFChannelsAll({
        srcCloudId:  cfSrcCloudId,
        dstCloudId:  cfDstCloudId,
        combination: form.messageCombination,
      });
      const pub  = normCh(data.publicChannels,  'public');
      const priv = normCh(data.privateChannels, 'private');
      const dms2 = normDm(data.dms);
      setCfChannels({ publicChannels: pub, privateChannels: priv, dms: dms2 });
      setCfCacheFetchedAt(data.fetchedAt || new Date().toISOString());
      setCfSelectedChannels([...pub, ...priv]);
      setCfSelectedDms([...dms2]);
    } catch (err) {
      setCfChannelError(err?.response?.data?.error || err.message || 'Failed to fetch channels');
    } finally {
      setCfChannelLoading(false);
    }
  }

  async function handleFetchAndSelectAllPlatform() {
    setTargetsError(null);
    setTargetsLoading(true);
    try {
      if (!step4Provider) throw new Error('Select a source platform in Section 1 first.');
      const adminEmail = getActiveFetchAdmin();
      if (!adminEmail) throw new Error(`No ${providerLabel(step4Provider)} admin connected.`);
      const { data } = await getMessageTargets(step4Provider, adminEmail);
      const tgts = {
        publicChannels:  data.publicChannels  || [],
        privateChannels: data.privateChannels || [],
        dms:             data.dms             || [],
        groupDms:        data.groupDms        || [],
      };
      setTargets(tgts);
      setSelectedChannelIds([...tgts.publicChannels.map(x => x.id), ...tgts.privateChannels.map(x => x.id)]);
      setSelectedDmIds([...tgts.dms.map(x => x.id), ...tgts.groupDms.map(x => x.id)]);
    } catch (err) {
      setTargetsError(err?.response?.data?.error || err.message || 'Failed to fetch targets');
      setTargets(null);
    } finally {
      setTargetsLoading(false);
    }
  }

  return (
    <form onSubmit={e => { e.preventDefault(); handleCFBrowserMigrate(); }}>
      <div style={{ padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 20 }}>

        {/* ─── Section 1: Source & Destination ─── */}
        <Section step="1" title="Source & Destination"
          subtitle="Connect admin accounts and map source → destination user pairs.">
          <UserMapping
            onMappingComplete={handleMappingComplete}
            includeSlack
            onSourceProviderChange={setLiveSourceProvider}
            srcProviderOverride={sourceProvider}
            dstProviderOverride={destinationProvider}
          />
          {mappedPairs && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {/* Pairs confirmed banner */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 16px', borderRadius: 10, backgroundColor: '#f0fdf4', border: '1px solid #86efac' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ width: 22, height: 22, borderRadius: '50%', backgroundColor: '#059669', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <svg width="10" height="8" viewBox="0 0 10 8" fill="none"><path d="M1 4L3.5 6.5L9 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  </div>
                  <span style={{ fontSize: 13, fontWeight: 700, color: '#065f46' }}>
                    {mappedPairs.length} pair{mappedPairs.length > 1 ? 's' : ''} mapped
                  </span>
                  <span style={{ fontSize: 12, color: '#6b7280' }}>
                    {mappedPairs.length === 1
                      ? `${mappedPairs[0].sourceEmail} → ${mappedPairs[0].destinationEmail}`
                      : 'All pairs queued together'}
                  </span>
                </div>
                <button type="button" onClick={clearMapping}
                  style={{ fontSize: 12, fontWeight: 600, color: '#059669', padding: '4px 12px', borderRadius: 6, border: '1px solid #86efac', backgroundColor: 'transparent', cursor: 'pointer' }}>
                  Clear
                </button>
              </div>

              {/* CSV path status */}
              {csvUploading && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 14px', borderRadius: 8, backgroundColor: '#f0f4ff', border: '1px solid #c5cef5', fontSize: 12 }}>
                  <svg style={{ width: 13, height: 13, animation: 'spin 1s linear infinite', flexShrink: 0 }} viewBox="0 0 24 24">
                    <circle cx="12" cy="12" r="10" stroke="#0129ac" strokeWidth="4" fill="none" opacity="0.25"/>
                    <path fill="#0129ac" opacity="0.75" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                  </svg>
                  <span style={{ color: '#0129ac', fontWeight: 600 }}>Generating &amp; uploading CSV…</span>
                </div>
              )}
              {!csvUploading && csvFileName && !csvUploadError && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3, padding: '8px 14px', borderRadius: 8, backgroundColor: '#f0f4ff', border: '1px solid #c5cef5' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#0129ac" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12"/>
                    </svg>
                    <span style={{ fontSize: 12, fontWeight: 700, color: '#0129ac' }}>CSV ready — Playwright will upload this file to CloudFuze</span>
                  </div>
                  <span style={{ fontSize: 11, fontFamily: 'monospace', color: '#374151', paddingLeft: 20, wordBreak: 'break-all' }}>
                    {csvFileName}
                  </span>
                </div>
              )}
              {!csvUploading && csvUploadError && (
                <div style={{ padding: '7px 14px', borderRadius: 8, backgroundColor: '#fff0f0', border: '1px solid #fca5a5', fontSize: 12, color: '#cc0000' }}>
                  CSV upload failed: {csvUploadError}
                </div>
              )}
            </div>
          )}

          {/* ── Local CSV path override ── */}
          <div style={{ borderRadius: 10, border: '1px solid #e4e9f5', overflow: 'hidden' }}>
            <div style={{ padding: '10px 16px', backgroundColor: '#f8fafc', borderBottom: '1px solid #e4e9f5', display: 'flex', alignItems: 'center', gap: 8 }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#0129ac" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>
              </svg>
              <span style={{ fontSize: 12, fontWeight: 700, color: '#0f172a' }}>Use CSV file directly</span>
              <span style={{ fontSize: 12, color: '#6b7280' }}>(optional — overrides auto-generated mapping)</span>
            </div>
            <div style={{ padding: '12px 16px', display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="text"
                value={form.userMappingCsvPath}
                onChange={e => setForm(p => ({ ...p, userMappingCsvPath: e.target.value }))}
                placeholder="C:\Users\...\mapping.csv"
                style={{ flex: 1, padding: '9px 13px', borderRadius: 8, border: '1.5px solid #e5e7eb', fontSize: 12, fontFamily: 'monospace', color: '#111827', outline: 'none', backgroundColor: '#fff' }}
              />
              {form.userMappingCsvPath && (
                <button type="button"
                  onClick={() => setForm(p => ({ ...p, userMappingCsvPath: '' }))}
                  style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #e5e7eb', backgroundColor: '#fff', color: '#6b7280', cursor: 'pointer', fontSize: 12, flexShrink: 0 }}>
                  Clear
                </button>
              )}
            </div>
            {form.userMappingCsvPath && (
              <div style={{ padding: '6px 16px 10px', fontSize: 11, color: '#0129ac' }}>
                Playwright will upload this file directly to CloudFuze
              </div>
            )}
          </div>

        </Section>

        {/* ─── Additional User Credentials ─── */}
        <AdditionalCredentials onCFAccountChange={setCfAccountEmail} />

        {/* ─── Section 2: Migration Route ─── */}
        <Section step="2" title="Migration Route"
          subtitle="Choose the source → destination platform. All combinations are supported (Slack, Teams, Google Chat).">
          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
              Platform Combination
            </label>
            <div style={{ position: 'relative' }}>
              <select name="messageCombination" value={form.messageCombination} onChange={handleChange}
                style={{ width: '100%', padding: '10px 36px 10px 14px', borderRadius: 8, border: '1.5px solid #e5e7eb', fontSize: 14, fontWeight: 600, color: '#111827', backgroundColor: '#fff', appearance: 'none', WebkitAppearance: 'none', outline: 'none', cursor: 'pointer' }}>
                {MESSAGE_MIGRATION_COMBINATIONS.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              <div style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}>
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 6l4 4 4-4" stroke="#6b7280" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </div>
            </div>
            {sourceProvider && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
                <span style={{ padding: '5px 14px', borderRadius: 6, fontSize: 13, fontWeight: 700, backgroundColor: '#eef1fd', color: '#0129ac', border: '1px solid #c5cef5' }}>
                  {providerLabel(sourceProvider)}
                </span>
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                  <path d="M4 10h12M11 5l5 5-5 5" stroke="#0129ac" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                <span style={{ padding: '5px 14px', borderRadius: 6, fontSize: 13, fontWeight: 700, backgroundColor: '#eef1fd', color: '#0129ac', border: '1px solid #c5cef5' }}>
                  {providerLabel(destinationProvider) || '—'}
                </span>
              </div>
            )}
          </div>
        </Section>

        {/* ─── Section 3: Source Channels & DMs ─── */}
        <Section step="3" title="Source Channels & DMs"
          subtitle="Fetch all channels from the source server. Every selected channel will be migrated with its full message history.">

          {/* Mode toggle */}
          <div style={{ display: 'inline-flex', borderRadius: 8, overflow: 'hidden', border: '1.5px solid #e5e7eb' }}>
            {[
              { label: 'CloudFuze Browser', value: true },
              { label: 'Platform API',      value: false },
            ].map(mode => (
              <button key={String(mode.value)} type="button"
                onClick={() => { setCfMode(mode.value); if (mode.value && cfAccounts.length === 0) loadCFAccounts(); }}
                style={{ padding: '8px 20px', fontSize: 13, fontWeight: 600, cursor: 'pointer', border: 'none', outline: 'none', backgroundColor: cfMode === mode.value ? '#0129ac' : '#f9fafb', color: cfMode === mode.value ? '#fff' : '#6b7280', transition: 'all 0.15s' }}>
                {mode.label}
              </button>
            ))}
          </div>

          {/* ── CloudFuze Browser mode ── */}
          {cfMode && (
            <div style={{ borderRadius: 10, padding: 16, backgroundColor: '#fafbff', border: '1px solid #e4e9f5', display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ width: 34, height: 34, borderRadius: 8, backgroundColor: '#eef1fd', border: '1px solid #c5cef5', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#0129ac" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
                  </svg>
                </div>
                <div>
                  <p style={{ fontSize: 13, fontWeight: 700, color: '#0f172a', margin: 0 }}>CloudFuze Browser</p>
                  <p style={{ fontSize: 12, color: '#6b7280', margin: 0 }}>No platform OAuth needed — connects directly via CloudFuze</p>
                </div>
              </div>

              {cfAccountsLoading ? (
                <p style={{ fontSize: 12, color: '#6b7280', margin: 0 }}>Loading cloud accounts…</p>
              ) : cfAccountsError ? (
                <div style={{ padding: '10px 14px', borderRadius: 8, backgroundColor: '#fee2e2', border: '1px solid #fca5a5', fontSize: 12, color: '#dc2626' }}>{cfAccountsError}</div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div>
                    <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Source · {cfSrcPlatform || '—'}</label>
                    {cfSrcAccounts.length === 0 ? (
                      <div style={{ padding: '8px 12px', borderRadius: 6, backgroundColor: '#fffbeb', border: '1px solid #fcd34d', fontSize: 12, color: '#92400e' }}>
                        No {cfSrcPlatform} cloud.{' '}
                        <a href="https://s2cdev.cloudfuze.com" target="_blank" rel="noreferrer" style={{ color: '#0129ac', fontWeight: 600 }}>Add at s2cdev.cloudfuze.com ↗</a>
                      </div>
                    ) : (
                      <select value={cfSrcCloudId} onChange={e => setCfSrcCloudId(e.target.value)}
                        style={{ width: '100%', padding: '8px 12px', borderRadius: 6, border: '1.5px solid #e5e7eb', fontSize: 13, color: '#111827', backgroundColor: '#fff', outline: 'none' }}>
                        {cfSrcAccounts.map(a => <option key={a.id} value={a.id}>{a.emailId || a.metadataUrl || a.id}{a.metadataUrl && a.metadataUrl !== a.emailId ? ` (${a.metadataUrl})` : ''}</option>)}
                      </select>
                    )}
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Destination · {cfDstPlatform || '—'}</label>
                    {cfDstAccounts.length === 0 ? (
                      <div style={{ padding: '8px 12px', borderRadius: 6, backgroundColor: '#fffbeb', border: '1px solid #fcd34d', fontSize: 12, color: '#92400e' }}>No {cfDstPlatform} cloud.</div>
                    ) : (
                      <select value={cfDstCloudId} onChange={e => setCfDstCloudId(e.target.value)}
                        style={{ width: '100%', padding: '8px 12px', borderRadius: 6, border: '1.5px solid #e5e7eb', fontSize: 13, color: '#111827', backgroundColor: '#fff', outline: 'none' }}>
                        {cfDstAccounts.map(a => <option key={a.id} value={a.id}>{a.emailId || a.metadataUrl || a.id}{a.metadataUrl && a.metadataUrl !== a.emailId ? ` (${a.metadataUrl})` : ''}</option>)}
                      </select>
                    )}
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" onClick={handleFetchAndSelectAllCF}
                  disabled={cfChannelLoading || !cfSrcCloudId || !cfDstCloudId}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 16px', borderRadius: 8, fontSize: 12, fontWeight: 700, backgroundColor: '#0129ac', color: '#fff', border: 'none', cursor: 'pointer', opacity: (cfChannelLoading || !cfSrcCloudId || !cfDstCloudId) ? 0.5 : 1 }}>
                  {cfChannelLoading ? (
                    <><svg className="animate-spin" style={{ width: 12, height: 12 }} viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>Fetching…</>
                  ) : cfChannels ? 'Refresh & Select All' : 'Fetch All Channels'}
                </button>
                {cfChannels && (
                  <button type="button" onClick={handleFetchCFChannels} disabled={cfChannelLoading}
                    style={{ padding: '8px 14px', borderRadius: 8, fontSize: 12, fontWeight: 600, color: '#6b7280', border: '1.5px solid #e5e7eb', backgroundColor: '#fff', cursor: 'pointer', opacity: cfChannelLoading ? 0.5 : 1 }}>
                    Refresh (keep selection)
                  </button>
                )}
                <button type="button" onClick={loadCFAccounts} disabled={cfAccountsLoading}
                  style={{ padding: '8px 14px', borderRadius: 8, fontSize: 12, fontWeight: 600, color: '#0129ac', border: '1.5px solid #e5e7eb', backgroundColor: '#fff', cursor: 'pointer', opacity: cfAccountsLoading ? 0.5 : 1 }}>
                  {cfAccountsLoading ? 'Reloading…' : 'Reload Accounts'}
                </button>
                <a href="https://s2cdev.cloudfuze.com" target="_blank" rel="noreferrer" style={{ fontSize: 12, fontWeight: 600, color: '#0129ac' }}>Open CloudFuze ↗</a>
              </div>

              {cfCacheFetchedAt && <p style={{ fontSize: 11, color: '#94a3b8', margin: 0 }}>Cached: {new Date(cfCacheFetchedAt).toLocaleString()} — click Refresh to update</p>}
              {cfChannelError && <div style={{ padding: '10px 14px', borderRadius: 8, backgroundColor: '#fee2e2', border: '1px solid #fca5a5', fontSize: 12, color: '#dc2626' }}>{cfChannelError}</div>}
              {cfChannels && (
                <CFTargetPicker channels={cfChannels} selectedChannels={cfSelectedChannels} selectedDms={cfSelectedDms}
                  onToggleChannel={toggleCFChannel} onToggleDm={toggleCFDm}
                  onSelectAll={() => { setCfSelectedChannels([...(cfChannels.publicChannels || []), ...(cfChannels.privateChannels || [])]); setCfSelectedDms([...(cfChannels.dms || [])]); }}
                  onClearAll={() => { setCfSelectedChannels([]); setCfSelectedDms([]); }}
                  sourceProvider={sourceProvider} />
              )}
              {(cfSelectedChannels.length > 0 || cfSelectedDms.length > 0) && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 12px', borderRadius: 20, backgroundColor: '#0129ac', color: '#fff', fontWeight: 700 }}>
                    <svg width="10" height="8" viewBox="0 0 10 8" fill="none"><path d="M1 4L3.5 6.5L9 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    {cfSelectedChannels.length + cfSelectedDms.length} selected
                  </span>
                  <span style={{ color: '#6b7280' }}>{cfSelectedChannels.length} channels · {cfSelectedDms.length} DMs</span>
                </div>
              )}
            </div>
          )}

          {/* ── Platform API mode ── */}
          {!cfMode && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <AdminSelector provider={step4Provider} accounts={step4Accounts} selectedAdmin={getActiveFetchAdmin()} onSelect={setSelectedFetchAdmin} />
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
                <span style={{ fontSize: 12, color: '#6b7280' }}>
                  {targets
                    ? `${(targets.publicChannels?.length || 0) + (targets.privateChannels?.length || 0) + (targets.dms?.length || 0) + (targets.groupDms?.length || 0)} channels & DMs found on source server`
                    : 'Fetch all channels and DMs from the source server'}
                </span>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" onClick={handleFetchAndSelectAllPlatform}
                    disabled={targetsLoading || !step4Provider || !getActiveFetchAdmin()}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 16px', borderRadius: 8, fontSize: 12, fontWeight: 700, backgroundColor: '#0129ac', color: '#fff', border: 'none', cursor: 'pointer', opacity: (targetsLoading || !step4Provider || !getActiveFetchAdmin()) ? 0.5 : 1 }}>
                    {targetsLoading ? (
                      <><svg className="animate-spin" style={{ width: 12, height: 12 }} viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>Fetching…</>
                    ) : targets ? 'Refresh & Select All' : 'Fetch All from Server'}
                  </button>
                  {targets && (
                    <button type="button" onClick={handleFetchTargets} disabled={targetsLoading}
                      style={{ padding: '8px 14px', borderRadius: 8, fontSize: 12, fontWeight: 600, color: '#6b7280', border: '1.5px solid #e5e7eb', backgroundColor: '#fff', cursor: 'pointer', opacity: targetsLoading ? 0.5 : 1 }}>
                      Refresh (keep selection)
                    </button>
                  )}
                </div>
              </div>

              {targetsError && (
                <div style={{ padding: '12px 14px', borderRadius: 8, backgroundColor: '#fee2e2', border: '1px solid #fca5a5', fontSize: 12, color: '#111827' }}>
                  <strong>Fetch failed:</strong> {targetsError}
                  {targetsError.includes('Chat app not configured') && (
                    <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      <a href="https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat" target="_blank" rel="noreferrer"
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '6px 12px', borderRadius: 6, backgroundColor: '#1a73e8', color: '#fff', fontSize: 12, fontWeight: 700, textDecoration: 'none' }}>
                        Open Google Cloud Console → Chat API Config
                      </a>
                      <span style={{ fontSize: 11, color: '#6b7280', alignSelf: 'center' }}>
                        Set Status to <strong>Live</strong> → Save → re-authenticate
                      </span>
                    </div>
                  )}
                </div>
              )}

              {targets && (
                <NamedTargetPicker targets={targets} selectedChannelIds={selectedChannelIds} selectedDmIds={selectedDmIds}
                  onToggleChannel={id => toggleId(selectedChannelIds, setSelectedChannelIds, id)}
                  onToggleDm={id => toggleId(selectedDmIds, setSelectedDmIds, id)}
                  onSelectAll={() => {
                    setSelectedChannelIds([...(targets.publicChannels || []).map(x => x.id), ...(targets.privateChannels || []).map(x => x.id)]);
                    setSelectedDmIds([...(targets.dms || []).map(x => x.id), ...(targets.groupDms || []).map(x => x.id)]);
                  }}
                  onClearAll={() => { setSelectedChannelIds([]); setSelectedDmIds([]); }} />
              )}

              <div>
                <button type="button" onClick={() => setShowManualIds(v => !v)}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: '#6b7280', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    {showManualIds ? <polyline points="18 15 12 9 6 15"/> : <polyline points="6 9 12 15 18 9"/>}
                  </svg>
                  {showManualIds ? 'Hide' : 'Add'} IDs manually (advanced)
                </button>
                {showManualIds && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
                    <div>
                      <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Extra Channel IDs</label>
                      <textarea name="channelIdsRaw" value={form.channelIdsRaw} onChange={handleChange} rows={3}
                        placeholder="C01234ABCDE, spaces/AAA..."
                        style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1.5px solid #e5e7eb', fontSize: 12, fontFamily: 'monospace', color: '#111827', backgroundColor: '#fff', resize: 'none', outline: 'none', boxSizing: 'border-box' }} />
                      <p style={{ fontSize: 11, color: '#94a3b8', marginTop: 4, marginBottom: 0 }}>Merged: {channelIds.length} channel id{channelIds.length !== 1 ? 's' : ''}</p>
                    </div>
                    <div>
                      <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Extra DM IDs</label>
                      <textarea name="dmIdsRaw" value={form.dmIdsRaw} onChange={handleChange} rows={3}
                        placeholder="D01234ABCDE, 19:abc...@thread.v2"
                        style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1.5px solid #e5e7eb', fontSize: 12, fontFamily: 'monospace', color: '#111827', backgroundColor: '#fff', resize: 'none', outline: 'none', boxSizing: 'border-box' }} />
                      <p style={{ fontSize: 11, color: '#94a3b8', marginTop: 4, marginBottom: 0 }}>Merged: {dmIds.length} DM id{dmIds.length !== 1 ? 's' : ''}</p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </Section>

        {/* ─── Section 4: Migration Type ─── */}
        <Section step="4" title="Migration Type"
          subtitle="One Time Migration moves the full message history. Delta picks up changes since the last run.">
          <div style={{ display: 'flex', gap: 10 }}>
            {MIGRATION_TYPES.map(opt => {
              const active = form.migrationType === opt.value;
              return (
                <button key={opt.value} type="button"
                  onClick={() => setForm(p => ({ ...p, migrationType: opt.value }))}
                  style={{ flex: 1, padding: '12px 16px', borderRadius: 10, textAlign: 'left', cursor: 'pointer', border: `2px solid ${active ? '#0129ac' : '#e5e7eb'}`, backgroundColor: active ? '#eef1fd' : '#fafafa', outline: 'none' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: active ? '#0129ac' : '#374151' }}>{opt.label}</span>
                    <div style={{ width: 16, height: 16, borderRadius: '50%', border: `2px solid ${active ? '#0129ac' : '#d1d5db'}`, backgroundColor: active ? '#0129ac' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      {active && <div style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: '#fff' }} />}
                    </div>
                  </div>
                  <span style={{ fontSize: 12, color: '#6b7280' }}>{opt.desc}</span>
                </button>
              );
            })}
          </div>
        </Section>

        {/* ─── Section 5: Post Data & Launch ─── */}
        <Section step="5" title="Post Data & Launch"
          subtitle="Optionally post test scenario data into source channels, then launch migration.">

          {/* Summary row */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {[
              { label: 'Channels', value: channelIds.length },
              { label: 'DMs',      value: dmIds.length },
              { label: 'Mode',     value: form.migrationType === 'FULL' ? 'One Time' : 'Delta' },
              { label: 'Scenario', value: selectedScenario ? (selectedScenario.summary?.slice(0, 22) + (selectedScenario.summary?.length > 22 ? '…' : '')) : 'None' },
            ].map(item => (
              <div key={item.label} style={{ display: 'inline-flex', alignItems: 'stretch', borderRadius: 7, overflow: 'hidden', border: '1px solid #e4e9f5', fontSize: 12 }}>
                <span style={{ padding: '5px 10px', backgroundColor: '#f1f5f9', color: '#64748b', fontWeight: 600 }}>{item.label}</span>
                <span style={{ padding: '5px 10px', backgroundColor: '#fff', color: '#0129ac', fontWeight: 700 }}>{item.value}</span>
              </div>
            ))}
          </div>

          {/* Source user sign-in */}
          {hasMapping && (
            <SourceUserSignInPanel mappedPairs={mappedPairs} sourceProvider={step4Provider} sourceAdminEmail={getActiveFetchAdmin()} />
          )}

          {/* ── Post Test Data ── */}
          <div style={{ borderRadius: 12, overflow: 'hidden', border: '1px solid #e4e9f5' }}>
            <div style={{ padding: '12px 18px', display: 'flex', alignItems: 'center', gap: 12, backgroundColor: '#f8fafc', borderBottom: '1px solid #e4e9f5' }}>
              <span style={{ width: 26, height: 26, borderRadius: '50%', backgroundColor: '#0129ac', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 800, flexShrink: 0 }}>1</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: '#1e40af' }}>Post Test Data</span>
                <span style={{ fontSize: 12, color: '#6b7280', marginLeft: 6 }}>(optional)</span>
                <p style={{ fontSize: 12, color: '#6b7280', margin: '2px 0 0' }}>
                  Select a saved scenario and post its messages into the source channels before migrating
                </p>
              </div>
            </div>
            <div style={{ padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>

              {/* Scenario selector */}
              {scenariosLoading ? (
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#6b7280' }}>
                  <svg style={{ width: 12, height: 12, animation: 'spin 1s linear infinite' }} viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" opacity="0.25"/><path fill="currentColor" opacity="0.75" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                  Loading scenarios…
                </div>
              ) : allScenarios.length === 0 ? (
                <div style={{ padding: '10px 14px', borderRadius: 8, backgroundColor: '#fffbeb', border: '1px solid #fcd34d', fontSize: 12 }}>
                  <p style={{ margin: 0, fontWeight: 600, color: '#92400e' }}>No scenarios saved for <strong>{form.messageCombination}</strong></p>
                  <p style={{ margin: '4px 0 0', color: '#6b7280' }}>
                    Go to <strong>Test Scenarios</strong> page, add a scenario with Product Type = <strong>Message</strong> and this combination.
                  </p>
                </div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  {allScenarios.map(tc => {
                    const id = tc.testCaseId || tc.id;
                    const isActive = selectedScenarioId === id;
                    return (
                      <button key={id} type="button" onClick={() => setSelectedScenarioId(isActive ? null : id)}
                        style={{ textAlign: 'left', padding: '10px 14px', borderRadius: 9, border: `2px solid ${isActive ? '#0129ac' : '#e4e9f5'}`, backgroundColor: isActive ? '#eef1fd' : '#fafbff', cursor: 'pointer', outline: 'none' }}>
                        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 6 }}>
                          <div style={{ minWidth: 0 }}>
                            <p style={{ fontSize: 12, fontWeight: 700, color: isActive ? '#0129ac' : '#111827', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {tc.summary || id}
                            </p>
                            <p style={{ fontSize: 11, color: '#6b7280', margin: '3px 0 0' }}>
                              {tc.folder ? `${tc.folder} · ` : ''}{tc.messageCount ? `${tc.messageCount.toLocaleString()} msgs` : ''}
                              {tc.testData ? ` · ${tc.testData.slice(0, 40)}${tc.testData.length > 40 ? '…' : ''}` : ''}
                            </p>
                          </div>
                          <div style={{ width: 16, height: 16, borderRadius: '50%', border: `2px solid ${isActive ? '#0129ac' : '#d1d5db'}`, backgroundColor: isActive ? '#0129ac' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 }}>
                            {isActive && <div style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: '#fff' }} />}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Hints */}
              {!hasMapping && (
                <p style={{ fontSize: 12, color: '#6b7280', margin: 0 }}>• Map at least one user pair in Section 1 to enable posting.</p>
              )}
              {hasMapping && !hasTargets && (
                <p style={{ fontSize: 12, color: '#6b7280', margin: 0 }}>• Select channels in Section 3 to enable posting.</p>
              )}

              {/* Post button */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <button type="button" onClick={handlePostTestData} disabled={seedLoading || !canPost}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '10px 22px', fontSize: 13, fontWeight: 700, borderRadius: 8, border: 'none', cursor: canPost && !seedLoading ? 'pointer' : 'not-allowed', backgroundColor: '#0129ac', color: '#fff', opacity: (seedLoading || !canPost) ? 0.5 : 1 }}>
                  {seedLoading ? (
                    <><svg style={{ width: 13, height: 13, animation: 'spin 1s linear infinite' }} viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" opacity="0.25"/><path fill="currentColor" opacity="0.75" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>Posting…</>
                  ) : (
                    <>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                      {seedCompleted ? 'Re-post' : `Post to ${channelIds.length + dmIds.length} target${(channelIds.length + dmIds.length) !== 1 ? 's' : ''}`}
                    </>
                  )}
                </button>
                {seedCompleted && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, padding: '5px 12px', borderRadius: 20, backgroundColor: '#d1fae5', color: '#065f46', border: '1px solid #a7f3d0' }}>
                    <svg width="10" height="8" viewBox="0 0 10 8" fill="none"><path d="M1 4L3.5 6.5L9 1" stroke="#065f46" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    Data posted ✓
                  </span>
                )}
                {seedError && (
                  <span style={{ fontSize: 12, color: '#dc2626' }}>Post failed: {seedError}</span>
                )}
              </div>
            </div>
          </div>

          {/* ── Initiate Migration CTA ── */}
          <div style={{ borderRadius: 14, overflow: 'hidden', background: 'linear-gradient(135deg, #020c6b 0%, #0129ac 50%, #1845d4 100%)', boxShadow: '0 6px 24px rgba(1,41,172,0.28)', position: 'relative' }}>
            <div style={{ position: 'absolute', top: -20, right: -20, width: 110, height: 110, borderRadius: '50%', background: 'radial-gradient(circle, rgba(255,255,255,0.07) 0%, transparent 70%)', pointerEvents: 'none' }} />
            <div style={{ padding: '22px 26px', position: 'relative' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 14 }}>
                <div style={{ width: 38, height: 38, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                </div>
                <div>
                  <h2 style={{ fontSize: 18, fontWeight: 800, color: '#fff', margin: 0, letterSpacing: '-0.3px' }}>Initiate Migration</h2>
                  <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)', margin: '2px 0 0' }}>
                    Picks all channels · Moves all messages · All combinations · Validates source vs destination after closing
                  </p>
                </div>
              </div>

              {!canMigrate && (
                <div style={{ padding: '10px 14px', borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.12)', marginBottom: 14 }}>
                  <p style={{ fontWeight: 700, color: '#fff', margin: '0 0 4px', fontSize: 12 }}>Complete these steps to enable migration:</p>
                  {!hasMapping && !hasCsvPath && <p style={{ color: 'rgba(255,255,255,0.65)', margin: '2px 0', fontSize: 12 }}>• Map at least one user pair in Section 1.</p>}
                  {!hasTargets && <p style={{ color: 'rgba(255,255,255,0.65)', margin: '2px 0', fontSize: 12 }}>• Fetch and select at least one channel in Section 4.</p>}
                </div>
              )}

              {canMigrate && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
                  <HeroBadge ok={hasMapping || hasCsvPath} label={
                    hasMapping
                      ? `${(mappedPairs || []).length} pair${(mappedPairs || []).length > 1 ? 's' : ''} mapped`
                      : hasCsvPath ? 'CSV file provided' : 'No pairs'
                  } />
                  <HeroBadge ok={hasTargets} label={hasTargets ? `${channelIds.length + dmIds.length} channel${(channelIds.length + dmIds.length) !== 1 ? 's' : ''} selected` : 'No channels'} />
                  <HeroBadge ok={true} label={form.migrationType === 'FULL' ? 'One Time Migration' : 'Delta Migration'} />
                </div>
              )}

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
                <button type="button" onClick={handleCFBrowserMigrate} disabled={cfBrowserLoading || !canMigrate}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '12px 28px', fontSize: 14, fontWeight: 800, borderRadius: 10, border: '2px solid rgba(255,255,255,0.3)', backgroundColor: 'rgba(255,255,255,0.15)', color: '#fff', cursor: canMigrate && !cfBrowserLoading ? 'pointer' : 'not-allowed', backdropFilter: 'blur(8px)', opacity: (!canMigrate || cfBrowserLoading) ? 0.45 : 1, letterSpacing: '-0.2px' }}>
                  {cfBrowserLoading ? (
                    <><svg className="animate-spin" style={{ width: 14, height: 14 }} viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>Launching…</>
                  ) : (
                    <>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                      {hasBulk
                        ? `Start Migration · ${mappedPairs.length} pairs · ${form.migrationType === 'FULL' ? 'One Time' : 'Delta'}`
                        : `Start Migration · ${form.migrationType === 'FULL' ? 'One Time' : 'Delta'} · ${channelIds.length + dmIds.length} target${(channelIds.length + dmIds.length) !== 1 ? 's' : ''}`}
                    </>
                  )}
                </button>
                {cfBrowserRunning && (
                  <button type="button" onClick={() => abortCFBrowserMigration().catch(() => {})}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '11px 18px', fontSize: 13, fontWeight: 700, borderRadius: 10, border: '2px solid rgba(252,165,165,0.4)', backgroundColor: 'rgba(220,38,38,0.15)', color: '#fca5a5', cursor: 'pointer' }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/></svg>
                    Stop
                  </button>
                )}
              </div>
            </div>
          </div>
        </Section>

        {/* Browser Automation Logs */}
        {cfBrowserEvents.length > 0 && (
          <BrowserAutomationLogs events={cfBrowserEvents} running={cfBrowserRunning} />
        )}
      </div>
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
    <div className="rounded-2xl overflow-hidden"
      style={{
        border: `1px solid ${isFailed ? '#fca5a5' : isDone ? '#6ee7b7' : '#1e3a8a'}`,
        boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
      }}>
      {/* Terminal header */}
      <div className="px-5 py-3 flex items-center justify-between"
        style={{
          background: isFailed
            ? 'linear-gradient(135deg, #7f1d1d, #991b1b)'
            : isDone
            ? 'linear-gradient(135deg, #064e3b, #065f46)'
            : 'linear-gradient(135deg, #020c6b 0%, #0129ac 100%)',
        }}>
        <div className="flex items-center gap-3">
          {/* Traffic light dots */}
          <div className="flex items-center gap-1.5">
            <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: isFailed ? '#f87171' : 'rgba(255,255,255,0.2)' }} />
            <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: isDone ? '#6ee7b7' : 'rgba(255,255,255,0.2)' }} />
            <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: 'rgba(255,255,255,0.2)' }} />
          </div>
          <div className="w-px h-4 opacity-30" style={{ backgroundColor: '#fff' }} />
          {running && !isDone && !isFailed && (
            <svg className="animate-spin h-3 w-3 flex-shrink-0" style={{ color: 'rgba(255,255,255,0.8)' }} viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          )}
          <span className="text-xs font-bold" style={{ color: 'rgba(255,255,255,0.9)' }}>
            {isFailed ? 'Automation Failed' : isDone ? 'Migration Started · Reports open' : 'CloudFuze Browser Automation'}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[10px] font-mono px-2 py-0.5 rounded"
            style={{ backgroundColor: 'rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.65)' }}>
            {events.length} event{events.length !== 1 ? 's' : ''}
          </span>
        </div>
      </div>

      {/* Terminal body */}
      <div className="max-h-72 overflow-y-auto font-mono text-[11px] leading-relaxed p-4 space-y-1"
        style={{ backgroundColor: '#060d1a', color: '#c9d1d9' }}>
        {events.map((ev, i) => {
          const isErr = ev.type === 'error-step' || ev.type === 'failed';
          const color = isErr ? '#f87171' : (STEP_COLOR[ev.step] ? '#7dd3fc' : '#a5f3fc');
          const time  = ev.ts ? new Date(ev.ts).toLocaleTimeString('en-US', { hour12: false }) : '';
          return (
            <div key={i} className="flex gap-2 items-baseline">
              <span className="text-[10px] flex-shrink-0" style={{ color: '#4a5568' }}>{time}</span>
              <span className="px-1.5 py-0 rounded text-[9px] font-bold uppercase flex-shrink-0"
                style={{
                  backgroundColor: isErr ? 'rgba(248,113,113,0.15)' : 'rgba(125,211,252,0.1)',
                  color,
                  minWidth: '80px',
                  textAlign: 'center',
                }}>
                {ev.step || ev.type}
              </span>
              <span style={{ color: isErr ? '#f87171' : '#e2e8f0' }}>{ev.detail || ev.error || ''}</span>
            </div>
          );
        })}
        <div ref={logsEndRef} />
      </div>
    </div>
  );
}

// ── CloudFuze Target Picker ───────────────────────────────────────────────────

function CFTargetPicker({ channels, selectedChannels, selectedDms, onToggleChannel, onToggleDm, onSelectAll, onClearAll, sourceProvider }) {
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

  const isTeamsSource = (sourceProvider || '').toLowerCase().includes('microsoft');
  const groupedByTeam = useMemo(() => {
    if (!isTeamsSource || !tab?.isChannel) return null;
    const groups = {};
    for (const item of tabItems) {
      const key = item.workSpaceName
        ? (item.workSpaceName.startsWith('http')
            ? item.workSpaceName.split('/').filter(Boolean).pop()
            : item.workSpaceName)
        : '(No Team)';
      if (!groups[key]) groups[key] = [];
      groups[key].push(item);
    }
    return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
  }, [isTeamsSource, tab?.isChannel, tabItems]);

  function toggleAll(checked) {
    tabItems.forEach(item => {
      const has = tabSelected.some(s => s.id === item.id);
      if (checked && !has) tabToggle(item);
      if (!checked && has) tabToggle(item);
    });
  }

  if (totalCount === 0) {
    return (
      <div className="rounded-xl p-4 text-xs" style={{ backgroundColor: '#fffbeb', border: '1px solid #fcd34d', color: '#0f172a' }}>
        No channels or DMs found in CloudFuze for the selected cloud accounts.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Tab bar + selection controls */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex gap-1 p-1 rounded-xl" style={{ backgroundColor: '#f1f5f9', border: '1px solid #e4e9f5' }}>
          {TABS.map(t => (
            <button key={t.key} type="button"
              onClick={() => setActiveTab(t.key)}
              className="px-5 py-2 rounded-lg text-sm font-bold transition-all"
              style={{
                backgroundColor: activeTab === t.key ? '#0129ac' : 'transparent',
                color: activeTab === t.key ? '#fff' : '#64748b',
                boxShadow: activeTab === t.key ? '0 2px 8px rgba(1,41,172,0.25)' : 'none',
              }}>
              {t.label}
              <span className="ml-2 px-2 py-0.5 rounded-full text-xs font-black"
                style={{
                  backgroundColor: activeTab === t.key ? 'rgba(255,255,255,0.25)' : '#e2e8f0',
                  color: activeTab === t.key ? '#fff' : '#64748b',
                }}>
                {t.items.length}
              </span>
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm px-3 py-1.5 rounded-lg font-semibold"
            style={{ backgroundColor: selectedCount > 0 ? '#eef1fd' : '#f8fafc', color: selectedCount > 0 ? '#0129ac' : '#94a3b8', border: '1px solid #e4e9f5' }}>
            {selectedCount}/{totalCount}
          </span>
          <button type="button" onClick={onSelectAll}
            className="text-sm font-bold px-3 py-1.5 rounded-lg"
            style={{ color: '#0129ac', backgroundColor: '#eef1fd', border: '1px solid #c5cef5' }}>
            All
          </button>
          <button type="button" onClick={onClearAll}
            className="text-sm font-bold px-3 py-1.5 rounded-lg"
            style={{ color: '#64748b', backgroundColor: '#f8fafc', border: '1px solid #e2e8f0' }}>
            Clear
          </button>
        </div>
      </div>

      {/* List panel */}
      <div className="rounded-xl overflow-hidden"
        style={{ border: '1px solid #e4e9f5', boxShadow: '0 2px 8px rgba(1,41,172,0.06)' }}>
        <div className="flex items-center gap-3 px-4 py-3"
          style={{ background: 'linear-gradient(135deg, #0129ac 0%, #2a46d4 100%)' }}>
          <input type="checkbox" checked={allChecked} onChange={e => toggleAll(e.target.checked)}
            style={{ accentColor: '#fff', width: '15px', height: '15px' }} />
          <span className="text-sm font-bold text-white">{tab?.label}</span>
          <span className="ml-auto text-xs font-semibold px-2 py-0.5 rounded-full"
            style={{ backgroundColor: 'rgba(255,255,255,0.18)', color: 'rgba(255,255,255,0.9)' }}>
            {tabSelected.filter(s => tabItems.some(x => x.id === s.id)).length}/{tabItems.length} selected
          </span>
        </div>
        <div className="max-h-80 overflow-y-auto" style={{ backgroundColor: '#fff' }}>
          {groupedByTeam ? (
            // Teams source: hierarchical tree — Team header → indented channels
            groupedByTeam.map(([teamName, items]) => {
              const teamAllChecked = items.length > 0 && items.every(x => tabSelected.some(s => s.id === x.id));
              const teamPartial = !teamAllChecked && items.some(x => tabSelected.some(s => s.id === x.id));
              return (
                <div key={teamName}>
                  <div className="flex items-center gap-3 px-4 py-3 sticky top-0 z-10"
                    style={{ backgroundColor: '#eef1fd', borderBottom: '1px solid #c5cef5' }}>
                    <input type="checkbox"
                      checked={teamAllChecked}
                      ref={el => { if (el) el.indeterminate = teamPartial; }}
                      onChange={() => items.forEach(item => {
                        const has = tabSelected.some(s => s.id === item.id);
                        if (!teamAllChecked && !has) tabToggle(item);
                        if (teamAllChecked && has) tabToggle(item);
                      })}
                      style={{ accentColor: '#0129ac', width: '15px', height: '15px', flexShrink: 0 }} />
                    <span className="text-sm font-bold truncate flex-1" style={{ color: '#0129ac' }}>
                      {teamName}
                    </span>
                    <span className="text-xs font-bold px-2 py-0.5 rounded-full"
                      style={{ backgroundColor: '#dde7ff', color: '#0129ac' }}>
                      {items.filter(x => tabSelected.some(s => s.id === x.id)).length}/{items.length}
                    </span>
                  </div>
                  {items.map((item, idx) => {
                    const checked = tabSelected.some(s => s.id === item.id);
                    return (
                      <label key={item.id}
                        className="flex items-center gap-3 pl-10 pr-4 py-3 cursor-pointer transition-colors"
                        style={{
                          backgroundColor: checked ? '#f0f4ff' : idx % 2 === 0 ? '#fff' : '#fafbff',
                          borderBottom: '1px solid #f1f5f9',
                        }}>
                        <input type="checkbox" checked={checked} onChange={() => tabToggle(item)}
                          style={{ accentColor: '#0129ac', width: '15px', height: '15px', flexShrink: 0 }} />
                        <span className="flex-1 min-w-0">
                          <span className="block text-sm font-semibold truncate" style={{ color: checked ? '#0129ac' : '#1e293b' }} title={item.name}>
                            {item.name}
                          </span>
                        </span>
                        <span className="text-xs font-bold uppercase flex-shrink-0 px-2 py-0.5 rounded"
                          style={{ backgroundColor: checked ? '#dde7ff' : '#e8eeff', color: checked ? '#0129ac' : '#6b7db8' }}>
                          {item.channelType}
                        </span>
                      </label>
                    );
                  })}
                </div>
              );
            })
          ) : (
            // Flat list for all non-Teams sources
            tabItems.map((item, idx) => {
              const checked = tabSelected.some(s => s.id === item.id);
              const teamName = item.workSpaceName
                ? (item.workSpaceName.startsWith('http')
                    ? item.workSpaceName.split('/').filter(Boolean).pop()
                    : item.workSpaceName)
                : '';
              return (
                <label key={item.id}
                  className="flex items-center gap-3 px-4 py-3 cursor-pointer transition-colors"
                  style={{
                    backgroundColor: checked ? '#f0f4ff' : idx % 2 === 0 ? '#fff' : '#fafbff',
                    borderBottom: '1px solid #f1f5f9',
                  }}>
                  <input type="checkbox" checked={checked} onChange={() => tabToggle(item)}
                    style={{ accentColor: '#0129ac', width: '15px', height: '15px', flexShrink: 0 }} />
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-semibold truncate" style={{ color: checked ? '#0129ac' : '#1e293b' }} title={item.name}>
                      {item.name}
                    </span>
                    {teamName && (
                      <span className="block text-xs truncate mt-0.5" style={{ color: '#94a3b8' }} title={teamName}>
                        {teamName}
                      </span>
                    )}
                  </span>
                  <span className="text-xs font-bold uppercase flex-shrink-0 px-2 py-0.5 rounded"
                    style={{ backgroundColor: checked ? '#dde7ff' : '#e8eeff', color: checked ? '#0129ac' : '#6b7db8', letterSpacing: '0.05em' }}>
                    {item.channelType}
                  </span>
                </label>
              );
            })
          )}
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
      <div className="rounded-xl p-4 text-xs" style={{ backgroundColor: '#fffbeb', border: '1px solid #fcd34d', color: '#0f172a' }}>
        No channels or DMs found. Make sure the selected admin has joined channels/spaces and OAuth scopes are granted.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <select
          value={activeKey}
          onChange={(e) => setActiveKey(e.target.value)}
          className="text-sm font-semibold px-4 py-3 rounded-lg outline-none bg-white"
          style={{ border: '2px solid #0129ac', color: '#0f172a', minWidth: '220px' }}
        >
          {CATEGORIES.map((c) => (
            <option key={c.key} value={c.key}>
              {c.icon} {c.label} ({c.items.length})
            </option>
          ))}
        </select>

        <span className="text-xs" style={{ color: '#64748b' }}>
          {picked} / {total} selected total
        </span>

        <div className="flex gap-2 ml-auto">
          <button type="button" onClick={onSelectAll} className="text-xs font-semibold underline" style={{ color: '#0129ac' }}>Select all</button>
          <span className="text-xs" style={{ color: '#d0d5e8' }}>|</span>
          <button type="button" onClick={onClearAll}  className="text-xs font-semibold underline" style={{ color: '#0129ac' }}>Clear all</button>
        </div>
      </div>

      <div className="rounded-xl overflow-hidden" style={{ border: '1px solid #0129ac' }}>
        <div className="flex items-center gap-3 px-4 py-3" style={{ backgroundColor: '#0129ac' }}>
          <input
            type="checkbox"
            checked={allChecked}
            onChange={(e) => toggleAllActive(e.target.checked)}
            style={{ accentColor: '#fff', width: '15px', height: '15px' }}
          />
          <span className="text-sm font-bold text-white">
            {activeCategory?.icon} {activeCategory?.label}
          </span>
          <span className="ml-auto text-sm font-bold text-white/80">
            {activeSelected.filter((id) => activeItems.some((t) => t.id === id)).length} / {activeItems.length} selected
          </span>
        </div>

        <div className="max-h-80 overflow-y-auto divide-y" style={{ backgroundColor: '#fff' }}>
          {activeItems.map((t) => {
            const checked = activeSelected.includes(t.id);
            return (
              <label
                key={t.id}
                className="flex items-center gap-3 px-4 py-3 cursor-pointer"
                style={{ backgroundColor: checked ? '#f0f4ff' : '#fff', borderBottom: '1px solid #eef1fb' }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => activeToggle(t.id)}
                  style={{ accentColor: '#0129ac', width: '15px', height: '15px', flexShrink: 0 }}
                />
                <span className="flex-1 text-sm font-medium truncate" style={{ color: '#0f172a' }} title={t.name}>
                  {t.name}
                </span>
                <span className="text-xs font-mono flex-shrink-0 px-2 py-0.5 rounded"
                  style={{ backgroundColor: '#e8eeff', color: '#0129ac' }}>
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
      <div className="rounded-xl p-3 text-xs" style={{ backgroundColor: '#fffbeb', border: '1px solid #fcd34d', color: '#0f172a' }}>
        No <strong>{providerLabel(provider)}</strong> admin authenticated. Add one via Step 1 → {providerLabel(provider)} tab.
      </div>
    );
  }

  return (
    <div className="rounded-xl p-4 space-y-3" style={{ border: '1px solid #e2e8f0', backgroundColor: '#f8fafc' }}>
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-sm font-bold" style={{ color: '#0f172a' }}>
          Source · {providerLabel(provider)}:
        </span>
        {connected.length === 1 ? (
          <span className="text-sm font-mono px-3 py-1 rounded" style={{ backgroundColor: '#e8eeff', color: '#0129ac', border: '1px solid #c5cef5' }}>
            {connected[0].email}
          </span>
        ) : (
          <select
            value={selectedAdmin || ''}
            onChange={(e) => onSelect(e.target.value)}
            className="text-sm px-3 py-2 rounded outline-none bg-white font-mono"
            style={{ border: '1px solid #0129ac', color: '#0f172a', minWidth: '240px' }}
          >
            {connected.map((a) => (
              <option key={a.email} value={a.email}>{a.email}</option>
            ))}
          </select>
        )}
      </div>
      <p className="text-xs" style={{ color: '#64748b' }}>
        Will fetch public channels, private channels, 1:1 DMs and group DMs as{' '}
        <span className="font-mono" style={{ color: '#0f172a' }}>{selectedAdmin || connected[0]?.email}</span>.
      </p>
    </div>
  );
}

// ── Source user sign-in status panel ─────────────────────────────────────────

function SourceUserSignInPanel({ mappedPairs, sourceProvider, sourceAdminEmail }) {
  const [statuses, setStatuses]   = useState([]);
  const [signingIn, setSigningIn] = useState(null);
  const [tokenInput, setTokenInput] = useState('');
  const [tokenInstalling, setTokenInstalling] = useState(false);
  const [tokenResult, setTokenResult] = useState(null);
  const popupRef = useRef(null);
  const pollRef  = useRef(null);

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

  useEffect(() => {
    fetchStatus();
    const t = setInterval(fetchStatus, 4000);
    return () => clearInterval(t);
  }, [fetchStatus]);

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
        if (res?.data?.alreadyConnected) {
          setSigningIn(null);
          fetchStatus();
          return;
        }
      }
      const url = res?.data?.url;
      if (!url) { setSigningIn(null); return; }

      localStorage.removeItem('cf_oauth_result');
      popupRef.current = openOAuthPopup(url);

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
    <div className="rounded-xl overflow-hidden"
      style={{ border: `1px solid ${allReady ? '#6ee7b7' : '#fcd34d'}` }}>
      <div className="px-4 py-2.5 flex items-center justify-between"
        style={{ backgroundColor: allReady ? '#d1fae5' : '#fffbeb' }}>
        <span className="text-xs font-bold"
          style={{ color: allReady ? '#065f46' : '#92400e' }}>
          {allReady
            ? `✓ All ${sourceEmails.length} source user${sourceEmails.length > 1 ? 's' : ''} signed in — ready to post`
            : `⚠ ${readyCount} / ${sourceEmails.length} source user${sourceEmails.length > 1 ? 's' : ''} signed in`}
        </span>
        <span className="text-[11px]" style={{ color: '#64748b' }}>
          {providerLabel(sourceProvider)} · auto-refreshes every 4 s
        </span>
      </div>

      <div style={{ backgroundColor: '#fff' }}>
        {sourceEmails.map((email, i) => {
          const s         = statuses.find(x => x.email === email);
          const ready     = s?.hasToken || false;
          const busy      = signingIn === email;
          const isAdmin   = email === sourceAdminEmail;
          const adminReady = sourceAdminEmail && statuses.find(x => x.email === sourceAdminEmail)?.hasToken;
          const willUseAdmin = !ready && !isAdmin && adminReady;

          return (
            <div key={email}
              className="flex items-center gap-3 px-4 py-2.5"
              style={{
                borderTop: i === 0 ? 'none' : '1px solid #eef1fb',
                backgroundColor: ready ? '#f0fdf4' : willUseAdmin ? '#eff6ff' : '#fffbeb',
              }}>
              <span className="w-5 h-5 rounded-full flex-shrink-0 flex items-center justify-center text-white text-[10px] font-bold"
                style={{ backgroundColor: ready ? '#059669' : willUseAdmin ? '#0129ac' : '#dc2626' }}>
                {ready ? '✓' : willUseAdmin ? '↑' : '✗'}
              </span>

              <span className="flex-1 text-xs font-mono truncate" style={{ color: '#0f172a' }} title={email}>
                {email}
              </span>

              <span className="text-[11px] px-2 py-0.5 rounded"
                style={{
                  backgroundColor: isAdmin ? '#0129ac' : '#e8eeff',
                  color:           isAdmin ? '#fff'    : '#0129ac',
                  border: '1px solid #c5cef5',
                }}>
                {isAdmin ? 'Admin' : 'User'}
              </span>

              {ready ? (
                <span className="text-[11px] font-semibold w-28 text-right" style={{ color: '#065f46' }}>
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
                  className="text-xs font-bold px-3 py-1.5 rounded-lg disabled:opacity-50 w-28 text-center"
                  style={{ backgroundColor: '#0129ac', color: '#fff' }}>
                  {busy ? 'Opening…' : 'Sign in'}
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div className="px-4 py-2 text-[11px]"
        style={{ backgroundColor: '#f8fafc', borderTop: '1px solid #eef1fb', color: '#64748b' }}>
        {allReady
          ? `All users have their own ${providerLabel(sourceProvider)} token — messages will appear from each user individually.`
          : sourceAdminEmail && statuses.find(x => x.email === sourceAdminEmail)?.hasToken
          ? `Admin token active — users marked "↑ Uses admin" will post through the admin account. Sign them in individually to post as each user.`
          : `Sign in at least the admin account to enable live posting.`}
        {sourceProvider === 'microsoft' && !allReady && (
          <span> Use <strong>Message Agent app</strong> (Teams scopes) when signing in.</span>
        )}
      </div>

      {sourceProvider === 'slack' && (
        <div className="px-4 py-3" style={{ borderTop: '1px solid #eef1fb', backgroundColor: '#fafbff' }}>
          <p className="text-[11px] font-bold mb-2" style={{ color: '#0f172a' }}>
            Install Slack token directly (xoxp-…)
          </p>
          <div className="flex gap-2 items-start flex-wrap">
            <input
              type="text"
              value={tokenInput}
              onChange={(e) => { setTokenInput(e.target.value); setTokenResult(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleInstallToken(e); } }}
              placeholder="xoxp-000000000000-000000000000-…"
              className="flex-1 min-w-0 px-3 py-1.5 rounded-lg text-xs font-mono outline-none bg-white"
              style={{ border: '1.5px solid #e2e8f0', color: '#0f172a', minWidth: '260px' }}
            />
            <button
              type="submit"
              disabled={tokenInstalling || !tokenInput.trim().startsWith('xox')}
              className="px-4 py-1.5 rounded-lg text-xs font-bold disabled:opacity-50 flex-shrink-0"
              style={{ backgroundColor: '#0129ac', color: '#fff' }}
            >
              {tokenInstalling ? 'Installing…' : 'Install Token'}
            </button>
          </div>
          {tokenResult?.ok && (
            <p className="text-[11px] mt-1.5 font-semibold" style={{ color: '#065f46' }}>
              ✓ Token installed for <span className="font-mono">{tokenResult.email}</span>
            </p>
          )}
          {tokenResult?.error && (
            <p className="text-[11px] mt-1.5" style={{ color: '#dc2626' }}>
              {tokenResult.error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Layout primitives ─────────────────────────────────────────────────────────

function HeroBadge({ ok, label }) {
  return (
    <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold"
      style={{
        backgroundColor: ok ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.06)',
        color: ok ? '#fff' : 'rgba(255,255,255,0.38)',
        border: `1px solid ${ok ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.1)'}`,
        boxShadow: ok ? '0 2px 8px rgba(0,0,0,0.12)' : 'none',
        backdropFilter: 'blur(4px)',
      }}>
      {ok && (
        <span className="w-3.5 h-3.5 rounded-full flex items-center justify-center flex-shrink-0"
          style={{ backgroundColor: 'rgba(255,255,255,0.22)' }}>
          <svg width="7" height="5" viewBox="0 0 7 5" fill="none">
            <path d="M1 2.5l1.5 1.5 3.5-3.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </span>
      )}
      {label}
    </div>
  );
}

function Section({ step, title, subtitle, children }) {
  return (
    <div style={{ position: 'relative', borderRadius: 14, overflow: 'hidden', border: '1px solid #e4e9f5', backgroundColor: '#ffffff', boxShadow: '0 2px 12px rgba(1,41,172,0.05)' }}>
      <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: 'linear-gradient(180deg, #0129ac 0%, #6366f1 100%)' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 20px 14px 22px', borderBottom: '1px solid #f1f5f9' }}>
        <div style={{ width: 34, height: 34, borderRadius: 10, background: 'linear-gradient(135deg, #0129ac, #4f46e5)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 14, flexShrink: 0, boxShadow: '0 3px 10px rgba(1,41,172,0.28)' }}>
          {step}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 style={{ fontSize: 14, fontWeight: 700, color: '#0f172a', margin: 0, letterSpacing: '-0.2px' }}>{title}</h3>
          {subtitle && <p style={{ fontSize: 12, color: '#6b7280', margin: '2px 0 0', lineHeight: 1.5 }}>{subtitle}</p>}
        </div>
      </div>
      <div style={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 16 }}>{children}</div>
    </div>
  );
}
