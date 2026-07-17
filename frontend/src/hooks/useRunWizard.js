import { useState, useEffect, useRef, useCallback } from 'react';
import {
  getConnectedAccounts, addDwdAccount, getMicrosoftAdminConsentUrl,
  signOutGoogle, signOutMicrosoft, getSourceUsers, getDestinationUsers,
  getBoxOAuthUrl, signOutBox,
} from '../services/api';
import usePersistedState from './usePersistedState';
import { DOMAINS, accountProviderFor } from '../components/runwizard/domains';

const POPUP_KEY = 'cf_oauth_result';

function openPopup(url) {
  const w = 520, h = 680;
  const left = Math.round(window.screenX + (window.outerWidth - w) / 2);
  const top = Math.round(window.screenY + (window.outerHeight - h) / 2);
  return window.open(url, 'cf_oauth', `width=${w},height=${h},left=${left},top=${top},toolbar=no,menubar=no`);
}

/** Migration scope mirrors backend MigrationContext defaults. */
function scopesFor(migrationType) {
  return migrationType === 'DELTA'
    ? { includeMail: true, includeCalendar: true, includeContacts: true }
    : { includeMail: true, includeCalendar: false, includeContacts: false };
}

/**
 * All Run-Agent wizard state + actions. Frontend-only; reuses existing API endpoints.
 * State is persisted to localStorage so a refresh keeps the user's progress.
 */
export default function useRunWizard() {
  const [step, setStep] = usePersistedState('rw-step', 1);

  // Migration domain: 'mail' | 'content' (| 'message' future) — selected via the tab bar.
  const [domain, setDomainRaw] = usePersistedState('rw-domain', 'mail');

  // Source / destination admins (assigned in step 2)
  const [srcProvider, setSrcProvider] = usePersistedState('rw-srcProvider', 'google');
  const [srcEmail, setSrcEmail] = usePersistedState('rw-srcEmail', '');
  const [dstProvider, setDstProvider] = usePersistedState('rw-dstProvider', 'microsoft');
  const [dstEmail, setDstEmail] = usePersistedState('rw-dstEmail', '');

  // Mapping (step 3)
  const [sourceUsers, setSourceUsers] = usePersistedState('rw-srcUsers', []);
  const [destUsers, setDestUsers] = usePersistedState('rw-destUsers', []);
  const [mappings, setMappings] = usePersistedState('rw-mappings', []);
  const [unmappedSource, setUnmappedSource] = usePersistedState('rw-unmapSrc', []);
  const [unmappedDest, setUnmappedDest] = usePersistedState('rw-unmapDest', []);
  const [fetched, setFetched] = usePersistedState('rw-fetched', false);
  const [fetchedKey, setFetchedKey] = usePersistedState('rw-fetchedKey', '');
  const [selectedIndices, setSelectedIndices] = useState(() => {
    try { const raw = localStorage.getItem('cf:rw-selected'); if (raw) return new Set(JSON.parse(raw)); } catch { /* ignore */ }
    return new Set();
  });
  useEffect(() => {
    try { localStorage.setItem('cf:rw-selected', JSON.stringify([...selectedIndices])); } catch { /* ignore */ }
  }, [selectedIndices]);

  // Migration server (step 4)
  const [migrationServerUrl, setMigrationServerUrl] = usePersistedState('rw-serverUrl', 'https://devemail.cloudfuze.com/proxyservices/v1');
  const [migrationServerEmail, setMigrationServerEmail] = usePersistedState('rw-serverEmail', '');
  // Persisted so the password is entered ONCE in the UI and reused across runs (credentials
  // come from the UI, not env). Internal QA tool — stored in localStorage like the URL/email.
  const [migrationServerPassword, setMigrationServerPassword] = usePersistedState('rw-serverPassword', '');

  // Options (step 5)
  const [testType, setTestType] = usePersistedState('rw-testType', 'E2E');
  const [migrationType, setMigrationType] = usePersistedState('rw-migrationType', 'FULL');

  // Content migration options (CloudFuze Team Migration "Options" step). Permission
  // toggles default ON to mirror a full migration; job options are free-form.
  const [contentOptions, setContentOptions] = usePersistedState('rw-contentOptions', {
    rootFolderPermissions: true, rootFilePermissions: true,
    subFolderPermissions: true, subFilePermissions: true,
    sharedLinks: true, externalShares: true, versionHistory: true,
    customMetadata: true, workbookLinks: true, preserveTimestamp: true, comments: true,
    permissions: true, notifyInternalUsers: false, notifyExternalUsers: false,
  });
  const [jobOptions, setJobOptions] = usePersistedState('rw-jobOptions', {
    jobName: '', excludeFileTypes: '', replaceSpecialChar: '_',
  });
  // Content mapping. sourceFolderName = the folder the test-data agent creates in the
  // source (deduped " 1" on conflict; the CSV uses the actual created name). Blank
  // destination → backend uses the cloud default (SharePoint /SANITY DATAA/Documents, Drive /OSM).
  const [contentPaths, setContentPaths] = usePersistedState('rw-contentPaths', { sourceFolderName: '', destinationPath: '' });
  const setContentPath = (key, val) => setContentPaths((p) => ({ ...p, [key]: val }));
  // When true: the source folder(s) already exist — skip the data-creation agent and migrate
  // the folder at the given path directly. The "Source folder" fields become existing paths.
  const [useExistingSource, setUseExistingSource] = usePersistedState('rw-useExistingSource', false);
  // Per-user folder overrides for multi-user content migration, keyed by source email:
  //   { [sourceEmail]: { sourceFolderName, destinationPath } }
  // A row left blank falls back to the shared base fields above. Editable in the table and
  // importable via CSV (Source User, Source Folder, Destination User, Destination Path).
  const [contentUserFolders, setContentUserFolders] = usePersistedState('rw-contentUserFolders', {});
  const setContentUserFolder = (email, key, val) =>
    setContentUserFolders((m) => ({ ...m, [email]: { ...(m[email] || {}), [key]: val } }));
  const clearContentUserFolders = () => setContentUserFolders({});
  // Parse a pasted/uploaded CSV into per-user folder overrides (matched by source email).
  function importContentUserFoldersCsv(text) {
    const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return 0;
    const start = /source\s*user|source\s*cloud|source\s*email/i.test(lines[0]) ? 1 : 0;
    const next = {};
    let n = 0;
    for (let i = start; i < lines.length; i++) {
      const cols = lines[i].split(',').map((c) => c.trim());
      const [srcUser, srcFolder, , destPath] = cols;
      if (!srcUser) continue;
      next[srcUser.toLowerCase()] = {
        sourceFolderName: srcFolder || '',
        destinationPath: destPath || '',
      };
      n++;
    }
    setContentUserFolders((m) => ({ ...m, ...next }));
    return n;
  }
  const toggleContentOption = (key) => setContentOptions((o) => ({ ...o, [key]: !o[key] }));
  const setContentOption = (key, val) => setContentOptions((o) => ({ ...o, [key]: !!val }));
  const setJobOption = (key, val) => setJobOptions((o) => ({ ...o, [key]: val }));

  // Connected accounts (live)
  const [accounts, setAccounts] = useState([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const pollRef = useRef(null);
  const popupRef = useRef(null);

  const loadAccounts = useCallback(async () => {
    try { const res = await getConnectedAccounts(); setAccounts(res.data.accounts || []); }
    catch { /* ignore */ }
    finally { setAccountsLoading(false); }
  }, []);
  useEffect(() => { loadAccounts(); }, [loadAccounts]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);
  useEffect(() => () => stopPolling(), [stopPolling]);

  // ── Connect (step 1) ──────────────────────────────────────────────────────
  async function connectGoogle(email) {
    const e = (email || '').trim().toLowerCase();
    if (!e) { setError('Enter a Google admin email first'); return; }
    setError(null); setBusy(true);
    try { await addDwdAccount(e); await loadAccounts(); }
    catch (err) { setError(err.response?.data?.error || err.message); }
    finally { setBusy(false); }
  }

  async function connectMicrosoft() {
    // Opens the Microsoft sign-in + consent popup. The admin signs in there; the
    // backend reads their email + tenant from the returned token and registers them.
    setError(null); setBusy(true);
    try {
      const res = await getMicrosoftAdminConsentUrl();
      popupRef.current = openPopup(res.data.url);
      localStorage.removeItem(POPUP_KEY);
      pollRef.current = setInterval(() => {
        const raw = localStorage.getItem(POPUP_KEY);
        if (raw) {
          try {
            const result = JSON.parse(raw);
            localStorage.removeItem(POPUP_KEY);
            stopPolling(); popupRef.current?.close(); popupRef.current = null;
            if (result.error) setError(result.message || result.error);
            else loadAccounts();
          } catch { /* ignore */ }
          setBusy(false);
          return;
        }
        if (popupRef.current?.closed) { stopPolling(); setBusy(false); }
      }, 500);
      setTimeout(() => { stopPolling(); setBusy(false); }, 300_000);
    } catch (err) { setError(err.response?.data?.error || err.message); setBusy(false); }
  }

  // Box OAuth — same popup → /oauth-callback → localStorage result flow as Microsoft.
  async function connectBox() {
    setError(null); setBusy(true);
    try {
      const res = await getBoxOAuthUrl('popup');
      popupRef.current = openPopup(res.data.url);
      localStorage.removeItem(POPUP_KEY);
      pollRef.current = setInterval(() => {
        const raw = localStorage.getItem(POPUP_KEY);
        if (raw) {
          try {
            const result = JSON.parse(raw);
            localStorage.removeItem(POPUP_KEY);
            stopPolling(); popupRef.current?.close(); popupRef.current = null;
            if (result.error) setError(result.message || result.error);
            else loadAccounts();
          } catch { /* ignore */ }
          setBusy(false);
          return;
        }
        if (popupRef.current?.closed) { stopPolling(); setBusy(false); }
      }, 500);
      setTimeout(() => { stopPolling(); setBusy(false); }, 300_000);
    } catch (err) { setError(err.response?.data?.error || err.message); setBusy(false); }
  }

  async function disconnect(provider, email) {
    try {
      if (provider === 'google') await signOutGoogle(email);
      else if (provider === 'box') await signOutBox(email);
      else await signOutMicrosoft(email);
      if (srcEmail === email) setSrcEmail('');
      if (dstEmail === email) setDstEmail('');
      await loadAccounts();
    } catch { /* ignore */ }
  }

  // Default CloudFuze migration server per product: Mail → devemail, Content → qarelease.
  // (Message uses its own wizard.) Switching domains resets the server URL to the right default.
  const SERVER_URL_BY_DOMAIN = {
    mail: 'https://devemail.cloudfuze.com/proxyservices/v1',
    // Content server (qarelease) stays BARE — the backend detects a content server by the
    // absence of /proxyservices/ in the URL and adds the path itself. A /proxyservices/ URL
    // would force the legacy login branch and break content auth.
    content: 'https://qarelease.cloudfuze.com',
  };

  // Self-correct a stale persisted URL: if it's blank or a known default for a DIFFERENT
  // domain (e.g. devemail left over while on the Content tab), snap it to this domain's
  // default. A custom URL matches no known default, so it is preserved.
  useEffect(() => {
    const want = SERVER_URL_BY_DOMAIN[domain];
    if (!want) return;
    const knownDefaults = Object.values(SERVER_URL_BY_DOMAIN);
    if (!migrationServerUrl || (knownDefaults.includes(migrationServerUrl) && migrationServerUrl !== want)) {
      setMigrationServerUrl(want);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domain]);

  // Switch migration domain (tab). Resets provider/email selection + mapping to the new
  // domain's defaults so a half-built mail run never leaks into a content run.
  function setDomain(next) {
    if (next === domain) return;
    const cfg = DOMAINS[next] || DOMAINS.mail;
    setDomainRaw(next);
    setSrcProvider(cfg.defaultSrc);
    setDstProvider(cfg.defaultDst);
    setSrcEmail(''); setDstEmail('');
    if (SERVER_URL_BY_DOMAIN[next]) setMigrationServerUrl(SERVER_URL_BY_DOMAIN[next]);
    resetMapping();
    setStep(1);
  }

  // ── Fetch + auto-map (step 3) ─────────────────────────────────────────────
  function autoMap(src, dest) {
    const mapped = [], usedDest = new Set(), unmatched = [];
    for (const s of src) {
      const f = (s.firstName || '').toLowerCase().trim();
      const m = f ? dest.find((d) => !usedDest.has(d.id) && (d.firstName || '').toLowerCase().trim() === f) : null;
      if (m) { mapped.push({ source: s, destination: m, autoMatched: true }); usedDest.add(m.id); }
      else unmatched.push(s);
    }
    setMappings(mapped);
    setSelectedIndices(new Set(mapped.map((_, i) => i)));
    setUnmappedSource(unmatched);
    setUnmappedDest(dest.filter((d) => !usedDest.has(d.id)));
  }

  async function fetchUsers() {
    if (!srcEmail || !dstEmail) return;
    setBusy(true); setError(null); setFetched(false);
    setMappings([]); setUnmappedSource([]); setUnmappedDest([]);
    try {
      // User listing is done per connected-account type (google/microsoft/box). For content
      // the provider is a finer service (googledrive/onedrive/sharepoint) → map to its account.
      const [srcRes, destRes] = await Promise.all([
        getSourceUsers(srcEmail, accountProviderFor(srcProvider)),
        getDestinationUsers(dstEmail, accountProviderFor(dstProvider)),
      ]);
      const src = srcRes.data.users || [];
      const dest = destRes.data.users || [];
      setSourceUsers(src); setDestUsers(dest);
      autoMap(src, dest);
      setFetched(true);
      setFetchedKey(`${domain}|${srcProvider}:${srcEmail}|${dstProvider}:${dstEmail}`);
    } catch (err) { setError(err.response?.data?.error || err.message); }
    finally { setBusy(false); }
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

  // Bulk select / deselect a given list of mapping indices (e.g. the currently
  // search-filtered pairs). Select-all adds, deselect-all removes — leaving any
  // indices outside the filter untouched.
  function selectAll(indices) {
    setSelectedIndices((s) => new Set([...s, ...indices]));
  }
  function deselectAll(indices) {
    setSelectedIndices((s) => {
      const next = new Set(s);
      indices.forEach((i) => next.delete(i));
      return next;
    });
  }

  function resetMapping() {
    setFetched(false); setFetchedKey(''); setMappings([]); setSourceUsers([]); setDestUsers([]);
    setUnmappedSource([]); setUnmappedDest([]); setSelectedIndices(new Set());
  }

  // True when a source+destination are chosen but their users haven't been fetched yet
  // (or the selection changed) — drives the automatic fetch on the Map Users step.
  const needsFetch = !!(srcEmail && dstEmail) && fetchedKey !== `${domain}|${srcProvider}:${srcEmail}|${dstProvider}:${dstEmail}`;

  // ── Payload (step 6) ──────────────────────────────────────────────────────
  const selectedPairs = mappings.filter((_, i) => selectedIndices.has(i));

  function buildPayload() {
    const pairs = selectedPairs.map((m) => ({
      sourceEmail: m.source.email,
      destinationEmail: m.destination.email,
      sourceProvider: srcProvider,
      destinationProvider: dstProvider,
    }));
    const allMapped = mappings.map((m) => ({ sourceEmail: m.source.email, destinationEmail: m.destination.email }));
    const scope = scopesFor(migrationType);
    const server = {
      ...(migrationServerUrl ? { migrationServerUrl } : {}),
      ...(migrationServerEmail ? { migrationServerEmail } : {}),
      ...(migrationServerPassword ? { migrationServerPassword } : {}),
    };
    const base = {
      domain, mode: (DOMAINS[domain] || DOMAINS.mail).mode,
      testType, migrationType, ...scope,
      sourceAdminEmail: srcEmail, destAdminEmail: dstEmail,
      userEmailMappings: allMapped.length ? allMapped : pairs.map((p) => ({ sourceEmail: p.sourceEmail, destinationEmail: p.destinationEmail })),
      ...server,
      // Content Team-Migration options (permission flags + job options). Backend uses
      // these only for the content flow; harmless for mail/message.
      ...(domain === 'content' ? {
        contentOptions,
        jobName: jobOptions.jobName || undefined,
        excludeFileTypes: jobOptions.excludeFileTypes || undefined,
        replaceSpecialChar: jobOptions.replaceSpecialChar,
        sourceFolderName: contentPaths.sourceFolderName || undefined,
        destinationPath: contentPaths.destinationPath || undefined,
        useExistingSource: useExistingSource || undefined,
        // Per-user folder mapping (one entry per selected user). Each falls back to the shared
        // base fields above when its row is left blank. Backend seeds + migrates one per entry.
        contentUserFolders: selectedPairs.map((p) => {
          const ov = contentUserFolders[(p.source.email || '').toLowerCase()] || {};
          return {
            sourceEmail: p.source.email,
            destinationEmail: p.destination.email,
            sourceFolderName: ov.sourceFolderName || contentPaths.sourceFolderName || undefined,
            destinationPath: ov.destinationPath || contentPaths.destinationPath || undefined,
          };
        }),
      } : {}),
    };
    // Content multi-user is ONE execution: a single CloudFuze job with one workspace pair per
    // user (the orchestrator seeds each user and builds the N-pair job from userEmailMappings /
    // contentUserFolders). So content NEVER fans out to the bulk path — it always returns a
    // single-execution payload, which runs async and redirects to /logs immediately.
    // Mail/message keep bulk fan-out (N independent migrations) when more than one pair.
    if (domain === 'content' || pairs.length === 1) {
      return {
        ...base,
        sourceEmail: pairs[0]?.sourceEmail || srcEmail,
        destinationEmail: pairs[0]?.destinationEmail || dstEmail,
        sourceProvider: srcProvider,
        destinationProvider: dstProvider,
      };
    }
    return { ...base, mappedPairs: pairs };
  }

  function reset() {
    resetMapping();
    setStep(1);
    setSrcEmail(''); setDstEmail('');
    setMigrationServerPassword('');
  }

  return {
    step, setStep,
    domain, setDomain,
    srcProvider, setSrcProvider, srcEmail, setSrcEmail,
    dstProvider, setDstProvider, dstEmail, setDstEmail,
    accounts, accountsLoading, loadAccounts, connectGoogle, connectMicrosoft, connectBox, disconnect,
    fetched, needsFetch, fetchUsers, sourceUsers, destUsers, mappings, selectedIndices,
    togglePair, selectAll, deselectAll, manualMap, removeMapping, unmappedSource, unmappedDest, resetMapping,
    migrationServerUrl, setMigrationServerUrl, migrationServerEmail, setMigrationServerEmail,
    migrationServerPassword, setMigrationServerPassword,
    testType, setTestType, migrationType, setMigrationType,
    contentOptions, toggleContentOption, setContentOption, jobOptions, setJobOption,
    contentPaths, setContentPath,
    contentUserFolders, setContentUserFolder, clearContentUserFolders, importContentUserFoldersCsv,
    useExistingSource, setUseExistingSource,
    selectedPairs, buildPayload, reset,
    busy, error, setError,
  };
}
