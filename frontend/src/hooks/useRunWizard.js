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
  // Smoke was merged into Sanity — normalize any persisted legacy value so the selector highlights.
  useEffect(() => { if (testType === 'SMOKE') setTestType('SANITY'); }, [testType, setTestType]);
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
  // Mail migration options (devemail server "Options & Preview" step). Defaults mirror the
  // values the backend previously hardcoded, so a run behaves identically unless a toggle is
  // changed: Archive Mailbox ON (backup:true), In-Place Archive OFF (archivedMailBox:false),
  // Migrate Rules OFF (opt-in), Exclude Groups OFF (disableGroups:false).
  // Delta additionally exposes Calendars/Contacts (default ON to match today's DELTA scope).
  const [mailOptions, setMailOptions] = usePersistedState('rw-mailOptions', {
    archiveMailbox: true, migrateAsInPlaceArchive: false,
    migrateRules: false, excludeGroups: false,
    calendars: true, contacts: true, jobName: '',
    // Migrate date range (devemail "Migrate: From / To"). Empty = migrate everything.
    fromDate: '', toDate: '',
  });
  const setMailOption = (key, val) => setMailOptions((o) => ({ ...o, [key]: val }));
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
        getSourceUsers(srcEmail, accountProviderFor(srcProvider), { allDomains: domain === 'content' }),
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

  // Import source→destination user mappings from CSV text. Columns: Source User email,
  // Destination User email (a header row is auto-detected/skipped). Emails are matched
  // (case-insensitively) against the fetched source/destination user lists. Rows whose
  // source is already mapped, or whose source/destination email isn't found, are skipped.
  // Returns { added, skipped }.
  function importUserMappingsCsv(text) {
    const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return { added: 0, skipped: 0 };
    const start = /source|destination|from|to/i.test(lines[0]) ? 1 : 0;
    const srcByEmail = new Map(sourceUsers.map((u) => [String(u.email || '').toLowerCase(), u]));
    const dstByEmail = new Map(destUsers.map((u) => [String(u.email || '').toLowerCase(), u]));
    const mappedSrcIds = new Set(mappings.map((m) => m.source.id));
    const newPairs = [];
    const usedSrc = new Set();
    const usedDst = new Set();
    let skipped = 0;
    for (let i = start; i < lines.length; i++) {
      const cols = lines[i].split(',').map((c) => c.trim());
      const srcEmail = (cols[0] || '').toLowerCase();
      // Accept "Source, Destination" or a 4-col content-style row (dest is the 2nd non-empty).
      const dstEmail = (cols[1] || cols[cols.length - 1] || '').toLowerCase();
      if (!srcEmail || !dstEmail) { skipped++; continue; }
      const s = srcByEmail.get(srcEmail);
      const d = dstByEmail.get(dstEmail);
      if (!s || !d || mappedSrcIds.has(s.id) || usedSrc.has(srcEmail) || usedDst.has(dstEmail)) { skipped++; continue; }
      newPairs.push({ source: s, destination: d, autoMatched: false, imported: true });
      usedSrc.add(srcEmail); usedDst.add(dstEmail);
    }
    if (newPairs.length === 0) return { added: 0, skipped };
    // Add the mappings but do NOT auto-select them — importing a mapping list must not
    // enqueue those users for migration/cleanup. The user explicitly checks who to migrate.
    setMappings((prev) => [...prev, ...newPairs]);
    const newSrcIds = new Set(newPairs.map((p) => p.source.id));
    const newDstIds = new Set(newPairs.map((p) => p.destination.id));
    setUnmappedSource((p) => p.filter((u) => !newSrcIds.has(u.id)));
    setUnmappedDest((p) => p.filter((u) => !newDstIds.has(u.id)));
    return { added: newPairs.length, skipped };
  }

  // Remove all CSV-imported mappings, restoring their users to the unmatched lists.
  // Returns the number of pairs removed.
  function clearImportedMappings() {
    const removed = mappings.filter((m) => m.imported);
    if (removed.length === 0) return 0;
    const kept = [];
    const keptOldIdx = [];
    mappings.forEach((m, i) => { if (!m.imported) { kept.push(m); keptOldIdx.push(i); } });
    setSelectedIndices((sel) => {
      const next = new Set();
      keptOldIdx.forEach((oldIdx, newIdx) => { if (sel.has(oldIdx)) next.add(newIdx); });
      return next;
    });
    setUnmappedSource((p) => [...p, ...removed.map((m) => m.source)]);
    setUnmappedDest((p) => [...p, ...removed.map((m) => m.destination)]);
    setMappings(kept);
    return removed.length;
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
    // userEmailMappings scopes BOTH what devemail migrates (one mailbox per entry) AND the
    // recipient identity mapping used in validation. It MUST be the SELECTED pairs only —
    // otherwise selecting one pair would still migrate every mapped user's mailbox.
    const selectedMapped = pairs.map((p) => ({ sourceEmail: p.sourceEmail, destinationEmail: p.destinationEmail }));
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
      userEmailMappings: selectedMapped,
      ...server,
      // Mail migration options (devemail server toggles). Backend maps these to the devemail
      // payload; when omitted the backend falls back to today's defaults (backup:true,
      // archivedMailBox:false, disableGroups:false, mailRules off). In-Place Archive is a
      // One-Time-only toggle; Calendars/Contacts are Delta-only (they drive the scope).
      ...(domain === 'mail' ? (() => {
        const inPlace = migrationType !== 'DELTA' && !!mailOptions.migrateAsInPlaceArchive;
        // In-Place Archive (One-Time) supersedes the other Migration Options — devemail greys
        // them out, so we send Archive Mailbox off and omit Migrate Rules / Exclude Groups.
        return {
          migrateRules: (migrationType === 'DELTA' || inPlace) ? undefined : (mailOptions.migrateRules || undefined),
          excludeGroups: (migrationType === 'DELTA' || inPlace) ? undefined : (mailOptions.excludeGroups || undefined),
          archiveMailbox: inPlace ? false : mailOptions.archiveMailbox,
          migrateAsInPlaceArchive: migrationType === 'DELTA' ? false : !!mailOptions.migrateAsInPlaceArchive,
          mailJobName: mailOptions.jobName || undefined,
          // Migrate date range → devemail pickEmailsFromDate / pickEmailsBeforeDate (opt-in).
          mailFromDate: mailOptions.fromDate || undefined,
          mailToDate: mailOptions.toDate || undefined,
          ...(migrationType === 'DELTA' ? {
            includeCalendar: mailOptions.calendars,
            includeContacts: mailOptions.contacts,
          } : {}),
        };
      })() : {}),
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
    togglePair, selectAll, deselectAll, manualMap, removeMapping, importUserMappingsCsv, clearImportedMappings, unmappedSource, unmappedDest, resetMapping,
    migrationServerUrl, setMigrationServerUrl, migrationServerEmail, setMigrationServerEmail,
    migrationServerPassword, setMigrationServerPassword,
    testType, setTestType, migrationType, setMigrationType,
    contentOptions, toggleContentOption, setContentOption, jobOptions, setJobOption,
    mailOptions, setMailOption,
    contentPaths, setContentPath,
    contentUserFolders, setContentUserFolder, clearContentUserFolders, importContentUserFoldersCsv,
    useExistingSource, setUseExistingSource,
    selectedPairs, buildPayload, reset,
    busy, error, setError,
  };
}
