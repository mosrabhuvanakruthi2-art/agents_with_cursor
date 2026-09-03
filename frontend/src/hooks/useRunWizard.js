import { useState, useEffect, useRef, useCallback } from 'react';
import {
  getConnectedAccounts, addDwdAccount, getMicrosoftAdminConsentUrl,
  signOutGoogle, signOutMicrosoft, getSourceUsers, getDestinationUsers,
  getBoxOAuthUrl, signOutBox,
  getDropboxOAuthUrl, signOutDropbox,
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
  // Per-row folder mapping for multi-user / multi-drive content migration.
  //
  // This was an object keyed by source email: { [sourceEmail]: { sourceFolderName, destinationPath } }.
  // A keyed map cannot hold two rows for the SAME source user, so a CSV naming two Shared Drives for
  // one user collapsed to one row — the second silently overwrote the first, and only one drive was
  // ever migrated. An ordered list can, which is what spec 002 needs.
  //
  // A NEW storage key on purpose: the old key holds an object, and reading that shape here would
  // break at runtime for anyone with a saved wizard.
  //
  // An empty list means "derive one row per selected Map-Users pair" — the previous behaviour.
  // Adding, editing, deleting or importing materialises the list, which then wins.
  const [contentFolderRows, setContentFolderRows] = usePersistedState('rw-contentFolderRows', []);

  const makeRow = (over = {}) => ({
    id: `r${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
    sourceEmail: '',
    sourceDriveName: '',
    // '' | 'open' | 'restricted' — drive-level access to seed (feature 4.10). '' = none, the
    // behaviour every run had before this existed.
    driveAccessMode: '',
    destinationPath: '',
    ...over,
  });
  // No per-row source folder on purpose. Every drive holds the SAME seeded data, so the folder name
  // is one shared base field (contentPaths.sourceFolderName). A per-row folder would let two drives
  // hold differently named trees, which is not what this test is for.

  /** One row per selected pair — what the table shows before anyone touches it. */
  const derivedFolderRows = () => selectedPairs.map((p) => makeRow({
    id: `auto:${(p.source.email || '').toLowerCase()}`,
    sourceEmail: p.source.email || '',
  }));

  /**
   * The rows actually in effect: explicit list if present, else derived from the pairs.
   * A function, not a computed value — `selectedPairs` is declared further down this hook, so
   * evaluating it here would throw on the temporal dead zone.
   */
  const effectiveFolderRows = () => (contentFolderRows.length > 0 ? contentFolderRows : derivedFolderRows());

  /**
   * Materialise the derived rows before mutating, so clicking + never drops the auto rows.
   *
   * Takes the PREVIOUS state from the updater argument rather than reading `contentFolderRows` from
   * the render closure: two updates in one batch (edit a field, then delete a row) would otherwise
   * both start from the same stale array and the first change would be lost.
   */
  const materialise = (prev) => ((prev && prev.length > 0) ? prev : derivedFolderRows());

  const addContentFolderRow = () => setContentFolderRows((prev) => {
    const base = materialise(prev);
    const firstEmail = base[0]?.sourceEmail || selectedPairs[0]?.source?.email || '';
    // Auto rows carry an "auto:<email>" id, which is not unique once the same user appears twice —
    // React would then reuse one row's DOM for another. Give them real ids as they materialise.
    return [...base.map((r) => (r.id.startsWith('auto:') ? { ...r, id: makeRow().id } : r)),
      makeRow({ sourceEmail: firstEmail })];
  });

  const updateContentFolderRow = (id, key, val) => setContentFolderRows((prev) =>
    materialise(prev).map((r) => (r.id === id ? { ...r, [key]: val } : r)));

  const removeContentFolderRow = (id) => setContentFolderRows((prev) =>
    materialise(prev).filter((r) => r.id !== id));

  /** "Reset to base" — drop the explicit list and fall back to one row per selected pair. */
  const clearContentFolderRows = () => setContentFolderRows([]);

  /**
   * Parse a CSV into folder rows. EVERY data row is kept, including several rows naming the same
   * source user with different Shared Drives — the case the old keyed map silently dropped.
   *
   * Columns: Source User/Cloud, Source Path, Destination User/Cloud, Destination Path.
   * For a Shared Drive source, column 2 names the DRIVE — CloudFuze's own mapping CSVs are written
   * that way, and the drive-only form is the one that actually scans (a drive id paired with a
   * subfolder path scans nothing). It is NOT stored as a folder name: the folder is the shared base
   * field, identical in every drive.
   */
  function importContentUserFoldersCsv(text) {
    const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return 0;
    const start = /source\s*user|source\s*cloud|source\s*email/i.test(lines[0]) ? 1 : 0;
    const rows = [];
    for (let i = start; i < lines.length; i++) {
      const cols = lines[i].split(',').map((c) => c.trim());
      const [srcUser, srcPath, , destPath] = cols;
      if (!srcUser) continue;
      rows.push(makeRow({
        sourceEmail: srcUser,
        sourceDriveName: srcPath || '',
        destinationPath: destPath || '',
      }));
    }
    // Lift the Destination Path column into the BASE field when every row agrees on it, which is the
    // normal case ("/QA/Documents" on each line). Without this the value lived only in hidden
    // per-row state: the base "Destination drive" box stayed empty after an import, so the screen
    // gave no clue where the destination had come from.
    //
    // Rows that disagree keep their own value — a mapping CSV may legitimately send each source to a
    // different place, and collapsing those into one base would silently retarget them.
    const dests = [...new Set(rows.map((r) => String(r.destinationPath || '').trim()).filter(Boolean))];
    let adoptedDestination = null;
    if (dests.length === 1) {
      adoptedDestination = dests[0];
      setContentPath('destinationPath', adoptedDestination);
      for (const r of rows) r.destinationPath = '';
    }

    if (rows.length > 0) setContentFolderRows(rows);
    return { count: rows.length, destination: adoptedDestination };
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

  // Box and Dropbox OAuth — the same popup → /oauth-callback → localStorage result flow as
  // Microsoft. Only the URL endpoint differs, so the flow lives here once: a second copy would
  // drift the moment one of them changed.
  async function connectViaPopup(getOAuthUrl) {
    setError(null); setBusy(true);
    try {
      const res = await getOAuthUrl('popup');
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

  const connectBox = () => connectViaPopup(getBoxOAuthUrl);
  const connectDropbox = () => connectViaPopup(getDropboxOAuthUrl);

  async function disconnect(provider, email) {
    try {
      if (provider === 'google') await signOutGoogle(email);
      else if (provider === 'box') await signOutBox(email);
      else if (provider === 'dropbox') await signOutDropbox(email);
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
    const skipReasons = [];
    for (let i = start; i < lines.length; i++) {
      const cols = lines[i].split(',').map((c) => c.trim());
      const srcEmail = (cols[0] || '').toLowerCase();
      // Accept "Source, Destination" or a 4-col content-style row
      // "Source User,Source Folder,Destination User,Destination Path".
      //
      // cols[1] used to be taken unconditionally. On a 4-col row that column is a FOLDER PATH,
      // so a row like "erik@x.co,/QA_Team1,granger@y.com,/QA/Documents" stored "/qa_team1" as
      // the destination email and reported a successful import. The `|| cols[last]` fallback
      // never ran (cols[1] was non-empty) and would have picked the destination PATH anyway.
      // Take the first column after the source that actually looks like an address; fall back to
      // cols[1] so a 2-col row naming a group without an "@" still imports as typed.
      const dstEmail = (cols.slice(1).find((c) => c.includes('@')) || cols[1] || '').toLowerCase();
      if (!srcEmail || !dstEmail) { skipped++; skipReasons.push(`row ${i + 1}: missing an email`); continue; }

      // A CSV row may name a principal that is not a mailbox — a group, a shared mailbox, a
      // distribution list. Those are never in the fetched user lists, so requiring a match
      // discarded them silently: three qa-group rows vanished and group permissions could not be
      // validated at all, while the run reported "no GROUP permissions were exercised".
      //
      // Synthesise a principal for anything not found. The backend only needs the address pair to
      // build its mapping, and CloudFuze resolves the principal itself.
      const synth = (email, side) => ({ id: `csv:${side}:${email}`, email, displayName: email, fromCsv: true });
      const s = srcByEmail.get(srcEmail) || synth(srcEmail, 'src');
      const d = dstByEmail.get(dstEmail) || synth(dstEmail, 'dst');
      if (mappedSrcIds.has(s.id) || usedSrc.has(srcEmail) || usedDst.has(dstEmail)) {
        skipped++;
        skipReasons.push(`${srcEmail}: already mapped`);
        continue;
      }
      newPairs.push({
        source: s, destination: d, autoMatched: false, imported: true,
        // Flagged so the row can show that it came from CSV rather than a fetched mailbox.
        synthetic: Boolean(s.fromCsv || d.fromCsv),
      });
      usedSrc.add(srcEmail); usedDst.add(dstEmail);
    }
    if (newPairs.length === 0) return { added: 0, skipped, skipReasons };
    // Add the mappings but do NOT auto-select them — importing a mapping list must not
    // enqueue those users for migration/cleanup. The user explicitly checks who to migrate.
    setMappings((prev) => [...prev, ...newPairs]);
    const newSrcIds = new Set(newPairs.map((p) => p.source.id));
    const newDstIds = new Set(newPairs.map((p) => p.destination.id));
    setUnmappedSource((p) => p.filter((u) => !newSrcIds.has(u.id)));
    setUnmappedDest((p) => p.filter((u) => !newDstIds.has(u.id)));
    return {
      added: newPairs.length,
      skipped,
      skipReasons,
      synthetic: newPairs.filter((p2) => p2.synthetic).length,
    };
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
        // Per-row folder mapping. One entry per ROW, not per user — two rows may name the same
        // source user with different Shared Drives. Each field falls back to the shared base
        // fields when the row leaves it blank. Backend seeds + migrates one per entry, resolving
        // each row's own drive.
        contentUserFolders: effectiveFolderRows().map((r) => {
          const email = (r.sourceEmail || '').toLowerCase();
          // The destination user comes from Map Users, matched on this row's source user.
          const pair = selectedPairs.find((p) => (p.source.email || '').toLowerCase() === email)
            || selectedPairs[0];
          // Give only the drive: the destination is the base path plus this row's drive name.
          //
          // A row's own destination is treated as that row's BASE, never as the final path. It used
          // to win outright, which meant typing the base value into every row — the obvious thing to
          // do, since the column looked like an input — resolved both drives to the SAME folder and
          // merged their trees. The drive name is now always appended, so that collision cannot
          // happen however the field was filled in.
          // Both CSV styles are accepted. Writing the BASE on every row ("/QA/Documents") appends
          // the drive; writing the FULL path ("/QA/Documents/QA_Team1") is left alone. The append is
          // therefore idempotent — it never produces "/QA/Documents/QA_Team1/QA_Team1".
          const drive = String(r.sourceDriveName || '').trim().replace(/^\/+|\/+$/g, '');
          const rowBase = String(r.destinationPath || '').trim();
          const chosen = rowBase || contentPaths.destinationPath || '';
          const base = String(chosen).replace(/\/+$/, '');
          const endsWithDrive = Boolean(drive)
            && base.toLowerCase().endsWith(`/${drive.toLowerCase()}`);
          // `base`, not `chosen`, on the no-append branch — chosen keeps a trailing slash, and
          // ".../QA_Team1/" must not be a different destination from ".../QA_Team1".
          const autoDest = drive && base && !endsWithDrive ? `${base}/${drive}` : (base || chosen);
          return {
            sourceEmail: r.sourceEmail || pair?.source?.email,
            destinationEmail: pair?.destination?.email,
            sourceDriveName: r.sourceDriveName || undefined,
            driveAccessMode: r.driveAccessMode || undefined,
            // Same folder name in every drive — the data is identical, the drives differ.
            sourceFolderName: contentPaths.sourceFolderName || undefined,
            destinationPath: autoDest || undefined,
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
    accounts, accountsLoading, loadAccounts, connectGoogle, connectMicrosoft, connectBox, connectDropbox, disconnect,
    fetched, needsFetch, fetchUsers, sourceUsers, destUsers, mappings, selectedIndices,
    togglePair, selectAll, deselectAll, manualMap, removeMapping, importUserMappingsCsv, clearImportedMappings, unmappedSource, unmappedDest, resetMapping,
    migrationServerUrl, setMigrationServerUrl, migrationServerEmail, setMigrationServerEmail,
    migrationServerPassword, setMigrationServerPassword,
    testType, setTestType, migrationType, setMigrationType,
    contentOptions, toggleContentOption, setContentOption, jobOptions, setJobOption,
    mailOptions, setMailOption,
    contentPaths, setContentPath,
    contentFolderRows, effectiveFolderRows, addContentFolderRow, updateContentFolderRow,
    removeContentFolderRow, clearContentFolderRows, importContentUserFoldersCsv,
    useExistingSource, setUseExistingSource,
    selectedPairs, buildPayload, reset,
    busy, error, setError,
  };
}
