import { useState, useEffect, useRef, useCallback } from 'react';
import {
  getConnectedAccounts, addDwdAccount, getMicrosoftAdminConsentUrl,
  signOutGoogle, signOutMicrosoft, getSourceUsers, getDestinationUsers,
} from '../services/api';
import usePersistedState from './usePersistedState';

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
  const [migrationServerPassword, setMigrationServerPassword] = useState(''); // never persisted

  // Options (step 5)
  const [testType, setTestType] = usePersistedState('rw-testType', 'E2E');
  const [migrationType, setMigrationType] = usePersistedState('rw-migrationType', 'FULL');

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

  async function disconnect(provider, email) {
    try {
      if (provider === 'google') await signOutGoogle(email); else await signOutMicrosoft(email);
      if (srcEmail === email) setSrcEmail('');
      if (dstEmail === email) setDstEmail('');
      await loadAccounts();
    } catch { /* ignore */ }
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
      const [srcRes, destRes] = await Promise.all([
        getSourceUsers(srcEmail, srcProvider),
        getDestinationUsers(dstEmail, dstProvider),
      ]);
      const src = srcRes.data.users || [];
      const dest = destRes.data.users || [];
      setSourceUsers(src); setDestUsers(dest);
      autoMap(src, dest);
      setFetched(true);
      setFetchedKey(`${srcProvider}:${srcEmail}|${dstProvider}:${dstEmail}`);
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

  function resetMapping() {
    setFetched(false); setFetchedKey(''); setMappings([]); setSourceUsers([]); setDestUsers([]);
    setUnmappedSource([]); setUnmappedDest([]); setSelectedIndices(new Set());
  }

  // True when a source+destination are chosen but their users haven't been fetched yet
  // (or the selection changed) — drives the automatic fetch on the Map Users step.
  const needsFetch = !!(srcEmail && dstEmail) && fetchedKey !== `${srcProvider}:${srcEmail}|${dstProvider}:${dstEmail}`;

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
      testType, migrationType, ...scope,
      sourceAdminEmail: srcEmail, destAdminEmail: dstEmail,
      userEmailMappings: allMapped.length ? allMapped : pairs.map((p) => ({ sourceEmail: p.sourceEmail, destinationEmail: p.destinationEmail })),
      ...server,
    };
    if (pairs.length === 1) {
      return { ...base, sourceEmail: pairs[0].sourceEmail, destinationEmail: pairs[0].destinationEmail, sourceProvider: srcProvider, destinationProvider: dstProvider };
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
    srcProvider, setSrcProvider, srcEmail, setSrcEmail,
    dstProvider, setDstProvider, dstEmail, setDstEmail,
    accounts, accountsLoading, loadAccounts, connectGoogle, connectMicrosoft, disconnect,
    fetched, needsFetch, fetchUsers, sourceUsers, destUsers, mappings, selectedIndices,
    togglePair, manualMap, removeMapping, unmappedSource, unmappedDest, resetMapping,
    migrationServerUrl, setMigrationServerUrl, migrationServerEmail, setMigrationServerEmail,
    migrationServerPassword, setMigrationServerPassword,
    testType, setTestType, migrationType, setMigrationType,
    selectedPairs, buildPayload, reset,
    busy, error, setError,
  };
}
