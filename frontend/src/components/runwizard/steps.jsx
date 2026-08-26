import { useState, useEffect } from 'react';
import { DOMAINS, PROVIDER_META } from './domains';

// ── Provider config + icons ──────────────────────────────────────────────────
// Icons per provider key; label/short/account come from PROVIDER_META (domains.js).
const ICONS = {
  google: GoogleIcon, microsoft: MicrosoftIcon, box: BoxIcon,
  gmail: GmailIcon, outlook: OutlookIcon,
  googledrive: DriveIcon, googleshareddrive: SharedDriveIcon, onedrive: OneDriveIcon, sharepoint: SharePointIcon,
  dropbox: DropboxIcon, egnyte: EgnyteIcon, citrix: CitrixIcon,
};

// Service-specific icon key for an account in a given product domain:
//   mail    → Gmail (google) / Outlook (microsoft)
//   content → the finer service the account backs (Drive / OneDrive / SharePoint / Box)
function iconKeyFor(domain, account, serviceKey) {
  if (domain === 'mail') {
    if (account === 'google') return 'gmail';
    if (account === 'microsoft') return 'outlook';
  }
  return serviceKey || account;
}
function provMeta(key) {
  return { key, ...(PROVIDER_META[key] || { label: key, short: key, account: key }), Icon: ICONS[key] || GenericCloudIcon };
}

export function Stepper({ steps, current, onJump, maxReached }) {
  return (
    <ol className="flex items-center w-full mb-8">
      {steps.map((s, i) => {
        const n = i + 1;
        const done = n < current;
        const active = n === current;
        const reachable = n <= maxReached;
        return (
          <li key={s} className={`flex items-center ${i < steps.length - 1 ? 'flex-1' : ''}`}>
            <button
              type="button"
              disabled={!reachable}
              onClick={() => reachable && onJump(n)}
              className="flex items-center gap-2 group disabled:cursor-not-allowed"
            >
              <span className={`flex items-center justify-center w-8 h-8 rounded-full text-xs font-bold transition-colors ${
                active ? 'bg-indigo-600 text-white ring-4 ring-indigo-100'
                : done ? 'bg-indigo-600 text-white'
                : reachable ? 'bg-white border-2 border-gray-300 text-gray-500 group-hover:border-indigo-400'
                : 'bg-gray-100 border-2 border-gray-200 text-gray-300'}`}>
                {done ? '✓' : n}
              </span>
              <span className={`text-xs font-medium hidden md:inline ${active ? 'text-indigo-700' : 'text-gray-500'}`}>{s}</span>
            </button>
            {i < steps.length - 1 && <span className={`flex-1 h-0.5 mx-2 ${done ? 'bg-indigo-600' : 'bg-gray-200'}`} />}
          </li>
        );
      })}
    </ol>
  );
}

// ── Step 1: Connect clouds ────────────────────────────────────────────────────
// Cards shown are driven by the active domain's `connectAccounts` (mail → Google/Microsoft;
// content → Box/Google/Microsoft). Each card connects an account TYPE (google|microsoft|box).
export function StepConnect({ wiz }) {
  const [gEmail, setGEmail] = useState('');
  const cfg = DOMAINS[wiz.domain] || DOMAINS.mail;
  const accountsOf = (acct) => wiz.accounts.filter((a) => a.provider === acct);

  const cardFor = (acct) => {
    if (acct === 'google') return (
      <ConnectCard key="google"
        provider="google" accounts={accountsOf('google')} busy={wiz.busy}
        hint="Domain-Wide Delegation — enter a Workspace admin email; no sign-in needed."
        value={gEmail} onChange={setGEmail}
        onConnect={() => wiz.connectGoogle(gEmail).then(() => setGEmail(''))}
        onDisconnect={(e) => wiz.disconnect('google', e)}
      />
    );
    if (acct === 'microsoft') return (
      <ConnectCard key="microsoft"
        provider="microsoft" accounts={accountsOf('microsoft')} busy={wiz.busy} popup
        hint="Sign in as a tenant admin in the popup — consent is granted there (one-time per tenant)."
        onConnect={() => wiz.connectMicrosoft()}
        onDisconnect={(e) => wiz.disconnect('microsoft', e)}
      />
    );
    if (acct === 'box') return (
      <ConnectCard key="box"
        provider="box" accounts={accountsOf('box')} busy={wiz.busy} popup
        hint="Sign in to Box in the popup to authorize the QA app for this account."
        onConnect={() => wiz.connectBox()}
        onDisconnect={(e) => wiz.disconnect('box', e)}
      />
    );
    return null;
  };

  return (
    <div className="space-y-5">
      <p className="text-sm text-gray-500">Connect the cloud accounts you'll migrate between. You'll assign which is source and which is destination next.</p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {cfg.connectAccounts.map((acct) => cardFor(acct))}
      </div>
      {wiz.error && <Err msg={wiz.error} />}
    </div>
  );
}

function ConnectCard({ provider, accounts, busy, hint, value, onChange, onConnect, onDisconnect, popup }) {
  const p = provMeta(provider);
  const { Icon } = p;
  return (
    <div className="border border-gray-200 rounded-xl p-4 bg-gray-50/50 space-y-3">
      <div className="flex items-center gap-2">
        <Icon className="w-5 h-5" />
        <h3 className="text-sm font-semibold text-gray-900">{p.label}</h3>
        {accounts.length > 0 && <span className="ml-auto text-xs text-emerald-600 font-medium">{accounts.length} connected</span>}
      </div>
      {accounts.map((a) => (
        <div key={a.email} className="flex items-center gap-1.5 text-xs">
          <span className="flex-1 truncate px-2.5 py-2 rounded-lg border border-gray-200 bg-white text-gray-700">
            {a.email}{a.isDwd && <span className="ml-1 text-[10px] bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded-full">DWD</span>}
          </span>
          <button type="button" onClick={() => onDisconnect(a.email)} title="Disconnect"
            className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
          </button>
        </div>
      ))}
      {popup ? (
        <button type="button" disabled={busy} onClick={onConnect}
          className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg border border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 disabled:opacity-50">
          <Icon className="w-3.5 h-3.5" />{busy ? 'Waiting for popup…' : 'Sign in & consent'}
        </button>
      ) : (
        <div className="flex gap-2">
          <input type="email" value={value} onChange={(e) => onChange(e.target.value)} placeholder="admin@yourdomain.com"
            className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 outline-none bg-white" />
          <button type="button" disabled={busy} onClick={onConnect}
            className="px-3 py-2 text-xs font-semibold rounded-lg border border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 disabled:opacity-50">
            {busy ? '…' : 'Connect'}
          </button>
        </div>
      )}
      <p className="text-[11px] text-gray-400">{hint}</p>
    </div>
  );
}

// ── Step 2: Select source & destination ───────────────────────────────────────
// Two-panel picker: connected accounts for the domain on each side, searchable, single-select.
export function StepSelect({ wiz }) {
  const cfg = DOMAINS[wiz.domain] || DOMAINS.mail;
  const srcTypes = [...new Set(cfg.sourceProviders.map((p) => PROVIDER_META[p].account))];
  const dstTypes = [...new Set(cfg.destProviders.map((p) => PROVIDER_META[p].account))];
  const ready = !!(wiz.srcEmail && wiz.dstEmail);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto_1fr] gap-4 items-stretch">
        <AccountPanel
          title="Source" subtitle="Choose the account to transfer from" accent="indigo" domain={wiz.domain}
          accounts={wiz.accounts.filter((a) => srcTypes.includes(a.provider))}
          providerList={cfg.sourceProviders}
          email={wiz.srcEmail} provider={wiz.srcProvider}
          onSelect={(a, prov) => { wiz.setSrcEmail(a.email); wiz.setSrcProvider(prov); }}
          onProvider={wiz.setSrcProvider}
        />
        <div className="hidden lg:flex items-center justify-center"><ArrowOrb /></div>
        <AccountPanel
          title="Destination" subtitle="Choose the account to transfer to" accent="emerald" domain={wiz.domain}
          accounts={wiz.accounts.filter((a) => dstTypes.includes(a.provider))}
          providerList={cfg.destProviders}
          email={wiz.dstEmail} provider={wiz.dstProvider}
          onSelect={(a, prov) => { wiz.setDstEmail(a.email); wiz.setDstProvider(prov); }}
          onProvider={wiz.setDstProvider}
        />
      </div>
      <div className="bg-white border border-gray-200 rounded-xl px-4 py-3 text-sm flex items-center gap-2.5">
        <span className="shrink-0 w-7 h-7 rounded-lg bg-indigo-50 text-indigo-500 flex items-center justify-center"><SparkIcon /></span>
        <span className={ready ? 'text-emerald-700 font-medium' : 'text-gray-600'}>
          {ready ? 'Source and destination selected — click Next to map users.' : 'Select a source on the left and a destination on the right to continue.'}
        </span>
      </div>
    </div>
  );
}

function AccountPanel({ title, subtitle, accent, domain, accounts, providerList, email, provider, onSelect }) {
  const [q, setQ] = useState('');
  const query = q.trim().toLowerCase();
  // One row per (account × service it backs) — so My Drive, Shared Drive, OneDrive,
  // SharePoint, Box are each a distinct selectable cloud (no service toggle). Selection
  // is identified by email + service key, which is unique even when the same email exists
  // under two account providers.
  const rows = accounts.flatMap((a) =>
    providerList
      .filter((p) => PROVIDER_META[p]?.account === a.provider)
      .map((service) => ({ a, service })),
  );
  const filtered = query
    ? rows.filter(({ a, service }) =>
        a.email.toLowerCase().includes(query) || (PROVIDER_META[service]?.label || '').toLowerCase().includes(query))
    : rows;
  const accentBox = accent === 'emerald' ? 'bg-emerald-100 text-emerald-600' : 'bg-indigo-100 text-indigo-600';
  return (
    <div className="border border-gray-200 rounded-2xl p-5 bg-white flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <span className={`w-11 h-11 rounded-xl flex items-center justify-center ${accentBox}`}><TrayIcon /></span>
        <div>
          <h3 className="text-lg font-bold text-gray-900">{title}</h3>
          <p className="text-xs text-gray-500">{subtitle}</p>
        </div>
      </div>
      <div className="relative">
        <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search accounts"
          className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-gray-200 text-sm focus:ring-2 focus:ring-indigo-400 outline-none" />
      </div>
      <div className="space-y-1.5 max-h-[20rem] overflow-y-auto pr-1">
        {rows.length === 0 ? (
          <p className="text-xs text-amber-600 px-1 py-2">No connected accounts for this domain — add one on the <span className="font-semibold">Connect Clouds</span> page.</p>
        ) : filtered.length === 0 ? (
          <p className="text-xs text-gray-400 px-1 py-2">No clouds match “{q}”.</p>
        ) : filtered.map(({ a, service }) => {
          const selected = a.email === email && service === provider;
          // Service-specific icon: Gmail/Outlook for mail; Drive/Shared Drive/OneDrive/SharePoint/Box for content.
          const Icon = provMeta(iconKeyFor(domain, a.provider, service)).Icon;
          return (
            <button key={`${service}:${a.email}`} type="button" onClick={() => onSelect(a, service)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border text-left transition-colors ${selected ? 'border-indigo-300 bg-indigo-50/60' : 'border-transparent hover:bg-gray-50'}`}>
              <span className={`shrink-0 w-4 h-4 rounded-full border flex items-center justify-center ${selected ? 'border-indigo-500' : 'border-gray-300'}`}>
                {selected && <span className="w-2 h-2 rounded-full bg-indigo-500" />}
              </span>
              <span className="shrink-0 w-9 h-9 rounded-full bg-gray-100 flex items-center justify-center"><Icon className="w-5 h-5" /></span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-gray-900 truncate">{a.email}</span>
                <span className="block text-xs text-gray-500 truncate">{PROVIDER_META[service]?.label || provMeta(a.provider).label}{a.isDwd ? ' · DWD' : ''}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function TrayIcon() {
  return (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" />
    </svg>
  );
}
function SearchIcon({ className }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
    </svg>
  );
}
function SparkIcon() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09Z" />
    </svg>
  );
}
function ArrowOrb() {
  return (
    <span className="relative flex items-center justify-center w-24 h-24">
      <span className="absolute inset-0 rounded-full border-2 border-dashed border-indigo-200" />
      <span className="flex items-center justify-center w-14 h-14 rounded-full border border-indigo-200 bg-white shadow-sm">
        <svg className="w-6 h-6 text-indigo-500" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3" />
        </svg>
      </span>
    </span>
  );
}

// ── Step 3: Auto / manual map ──────────────────────────────────────────────────
export function StepMap({ wiz }) {
  const [q, setQ] = useState('');
  // Auto-fetch + auto-map as soon as a source and destination are selected.
  useEffect(() => {
    if (wiz.srcEmail && wiz.dstEmail && wiz.needsFetch && !wiz.busy) wiz.fetchUsers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wiz.srcEmail, wiz.dstEmail, wiz.needsFetch]);

  if (!wiz.srcEmail || !wiz.dstEmail) {
    return <p className="text-sm text-amber-600">Choose a source and destination admin in the previous step first.</p>;
  }

  const query = q.trim().toLowerCase();
  const match = (...vals) => !query || vals.some((v) => (v || '').toLowerCase().includes(query));
  // Keep original indices so checkbox/select-all operate on the real mapping index.
  const visibleMappings = wiz.mappings
    .map((m, idx) => ({ m, idx }))
    .filter(({ m }) => match(m.source.email, m.destination.email));
  const visibleUnmapped = wiz.unmappedSource.filter((s) => match(s.email));
  const visibleIndices = visibleMappings.map(({ idx }) => idx);
  const allVisibleSelected = visibleIndices.length > 0 && visibleIndices.every((i) => wiz.selectedIndices.has(i));

  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-500">Users are mapped source → destination by first name. Map any unmatched users below and uncheck pairs you don't want to migrate.</p>
      {wiz.busy && !wiz.fetched && <div className="text-sm text-gray-400">Fetching &amp; auto-mapping users…</div>}
      {wiz.error && <Err msg={wiz.error} />}
      {wiz.fetched && (
        <>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Pill c="indigo" t={`${wiz.sourceUsers.length} source`} />
            <Pill c="purple" t={`${wiz.destUsers.length} destination`} />
            <Pill c="green" t={`${wiz.selectedIndices.size} selected`} />
            {wiz.unmappedSource.length > 0 && <Pill c="yellow" t={`${wiz.unmappedSource.length} unmatched`} />}
            <label className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-indigo-200 bg-indigo-50 text-indigo-700 font-medium cursor-pointer hover:bg-indigo-100">
              Import CSV
              <input type="file" accept=".csv,text/csv" className="hidden" onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const text = await file.text();
                e.target.value = '';
                const { added, skipped, skipReasons, synthetic } = wiz.importUserMappingsCsv(text);
                // Report the outcome precisely. The previous message lumped every skip under
                // "email not found", which is what made three silently-dropped group rows look
                // like nothing had happened at all.
                const lines = [`Mapped ${added} pair(s) from CSV.`];
                if (synthetic) {
                  lines.push(`${synthetic} of them name a principal that is not a fetched mailbox `
                    + '(group, shared mailbox or distribution list) — kept as typed.');
                }
                if (added) lines.push('None are selected yet — tick the pair(s) you want to migrate.');
                if (skipped) {
                  lines.push(`${skipped} row(s) skipped:`);
                  lines.push((skipReasons || []).slice(0, 8).join('\n'));
                }
                alert(lines.join('\n\n'));
              }} />
            </label>
            {wiz.mappings.some((m) => m.imported) && (
              <button type="button"
                onClick={() => { const n = wiz.clearImportedMappings(); if (n) alert(`Removed ${n} CSV-imported mapping(s).`); }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-red-200 bg-red-50 text-red-700 font-medium hover:bg-red-100">
                Remove CSV
              </button>
            )}
          </div>
          <p className="text-[11px] text-gray-400">CSV columns: <span className="font-mono">Source User, Destination User</span> (emails; a header row is auto-detected). Addresses that are not fetched mailboxes — groups, shared mailboxes, distribution lists — are kept as typed.</p>

          {/* Search + bulk select */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-48">
              <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search users by email"
                className="w-full pl-9 pr-3 py-2 rounded-lg border border-gray-200 text-sm focus:ring-2 focus:ring-indigo-400 outline-none" />
            </div>
            <button type="button" onClick={() => wiz.selectAll(visibleIndices)} disabled={visibleIndices.length === 0}
              className="px-3 py-2 text-xs font-medium rounded-lg border border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 disabled:opacity-40">Select all</button>
            <button type="button" onClick={() => wiz.deselectAll(visibleIndices)} disabled={visibleIndices.length === 0}
              className="px-3 py-2 text-xs font-medium rounded-lg border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 disabled:opacity-40">Deselect all</button>
          </div>

          {wiz.mappings.length === 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-sm text-amber-700">
              No users auto-matched by first name. Pick a destination for the source users below — map at least one to continue.
              {wiz.destUsers.length < wiz.sourceUsers.length && ` (Only ${wiz.destUsers.length} destination mailbox${wiz.destUsers.length === 1 ? '' : 'es'} available.)`}
            </div>
          )}
          <div className="space-y-3">
            {wiz.mappings.length > 0 && (
              <div className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100">
                {/* Header row: select-all checkbox for the visible set */}
                <label className="px-4 py-2 flex items-center gap-3 text-xs font-semibold text-gray-600 bg-gray-50">
                  <input type="checkbox" checked={allVisibleSelected}
                    onChange={() => (allVisibleSelected ? wiz.deselectAll(visibleIndices) : wiz.selectAll(visibleIndices))}
                    className="w-4 h-4 text-indigo-600 rounded" />
                  <span>{allVisibleSelected ? 'Deselect' : 'Select'} all{query ? ' (filtered)' : ''} · {visibleIndices.length} pair{visibleIndices.length === 1 ? '' : 's'}</span>
                </label>
                {visibleMappings.length === 0 ? (
                  <p className="px-4 py-3 text-sm text-gray-400">No mapped pairs match “{q}”.</p>
                ) : visibleMappings.map(({ m, idx }) => (
                  <label key={idx} className={`px-4 py-2.5 flex items-center gap-3 text-sm cursor-pointer ${wiz.selectedIndices.has(idx) ? 'bg-indigo-50/50' : 'hover:bg-gray-50'}`}>
                    <input type="checkbox" checked={wiz.selectedIndices.has(idx)} onChange={() => wiz.togglePair(idx)} className="w-4 h-4 text-indigo-600 rounded" />
                    <span className="flex-1 min-w-0 truncate">{m.source.email} <span className="text-gray-400">→</span> {m.destination.email}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${m.autoMatched ? 'bg-green-100 text-green-700' : m.imported ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700'}`}>{m.autoMatched ? 'auto' : m.imported ? 'csv' : 'manual'}</span>
                    <button type="button" onClick={(e) => { e.preventDefault(); wiz.removeMapping(idx); }} className="text-gray-400 hover:text-red-500">
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
                    </button>
                  </label>
                ))}
              </div>
            )}
            {wiz.unmappedSource.length > 0 && (
              <div className="bg-white border border-yellow-200 rounded-xl divide-y divide-gray-100">
                <div className="px-4 py-2 bg-yellow-50 text-xs font-semibold text-yellow-800 sticky top-0">Unmatched source — map manually</div>
                {visibleUnmapped.length === 0 ? (
                  <p className="px-4 py-3 text-sm text-gray-400">No unmatched users match “{q}”.</p>
                ) : visibleUnmapped.map((s) => (
                  <div key={s.id} className="px-4 py-2.5 flex items-center gap-3 text-sm">
                    <span className="flex-1 truncate">{s.email}</span>
                    <span className="text-gray-400">→</span>
                    <select defaultValue="" onChange={(e) => e.target.value && wiz.manualMap(s, e.target.value)}
                      className="min-w-44 px-3 py-1.5 border border-gray-300 rounded-lg text-sm bg-white">
                      <option value="">Select destination…</option>
                      {wiz.unmappedDest.map((d) => <option key={d.id} value={d.email}>{d.email}</option>)}
                    </select>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ── Step 4: Migration server ───────────────────────────────────────────────────
export function StepServer({ wiz }) {
  const newMode = wiz.migrationServerEmail && wiz.migrationServerPassword;
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-gray-500">The CloudFuze server that runs the migration.</p>
        <span className={`shrink-0 inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium border ${newMode ? 'bg-indigo-50 border-indigo-200 text-indigo-700' : 'bg-amber-50 border-amber-200 text-amber-700'}`}>
          {newMode ? 'New server (email + password)' : 'Legacy server (Basic auth from .env)'}
        </span>
      </div>
      <Field label="Server URL">
        <input type="url" value={wiz.migrationServerUrl} onChange={(e) => wiz.setMigrationServerUrl(e.target.value)}
          placeholder="https://devemail.cloudfuze.com/proxyservices/v1"
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:ring-2 focus:ring-indigo-500 outline-none" />
      </Field>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Email (optional for devemail)">
          <input type="email" value={wiz.migrationServerEmail} onChange={(e) => wiz.setMigrationServerEmail(e.target.value)}
            placeholder="e.g. bhuvana.mosra@cloudfuze.com" className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 outline-none" />
        </Field>
        <Field label="Password (optional for devemail)">
          <input type="password" value={wiz.migrationServerPassword} onChange={(e) => wiz.setMigrationServerPassword(e.target.value)}
            placeholder="CloudFuze login password" className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 outline-none" />
        </Field>
      </div>
    </div>
  );
}

// ── Step 5: Test type & migration type ─────────────────────────────────────────
export function StepOptions({ wiz }) {
  const types = [
    { value: 'SANITY', label: 'Smoke', desc: 'Core feature validation' },
    { value: 'E2E', label: 'Sanity', desc: 'Full seed + calendar (slow)' },
  ];
  return (
    <div className="space-y-6">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">Test Type</label>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {types.map((o) => (
            <button key={o.value} type="button" onClick={() => wiz.setTestType(o.value)}
              className={`rounded-xl border-2 p-4 text-left transition-all ${wiz.testType === o.value ? 'border-indigo-500 bg-indigo-50 ring-1 ring-indigo-500' : 'border-gray-200 bg-white hover:border-gray-300'}`}>
              <p className={`text-sm font-semibold ${wiz.testType === o.value ? 'text-indigo-700' : 'text-gray-900'}`}>{o.label}</p>
              <p className="text-xs text-gray-500 mt-0.5">{o.desc}</p>
            </button>
          ))}
        </div>
      </div>
      {/* Mail sets Job Type inside its Job Options box (devemail layout); other domains use
          this shared Migration Type selector. */}
      {wiz.domain !== 'mail' && (
        <div className="space-y-2">
          <label className="block text-sm font-medium text-gray-700">Migration Type</label>
          <select value={wiz.migrationType} onChange={(e) => wiz.setMigrationType(e.target.value)}
            className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm bg-white focus:ring-2 focus:ring-indigo-500 outline-none">
            <option value="FULL">One Time Migration</option>
            <option value="DELTA">Delta Migration</option>
          </select>
          <p className="text-xs text-gray-500">
            {wiz.migrationType === 'FULL'
              ? 'One Time — initial transfer of email, folders/labels, threads (mail scope).'
              : 'Delta — incremental email/folder changes plus contacts and calendars.'}
          </p>
        </div>
      )}

      {wiz.domain === 'mail' && <MailOptions wiz={wiz} />}
      {wiz.domain === 'content' && <ContentOptions wiz={wiz} />}
    </div>
  );
}

// devemail server "Options & Preview" toggles (mail only). The set of Migration Options
// mirrors the devemail UI: One-Time shows Archive Mailbox + Migrate Rules + Exclude Groups
// (with In-Place Archive under Job Options); Delta shows Archive Mailbox + Calendars + Contacts.
function MailToggle({ checked, onChange, disabled = false }) {
  return (
    <button type="button" role="switch" aria-checked={checked} disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={`relative inline-flex h-5 w-9 flex-shrink-0 rounded-full transition-colors ${checked ? 'bg-indigo-600' : 'bg-gray-300'} ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}>
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform mt-0.5 ${checked ? 'translate-x-4' : 'translate-x-0.5'}`} />
    </button>
  );
}
// devemail-style row (white row, subtle border, label left + control right).
function MailRow({ label, children, className = '', disabled = false }) {
  return (
    <div className={`flex items-center justify-between gap-3 border border-gray-200 rounded-lg px-3 py-2.5 ${disabled ? 'opacity-50' : ''} ${className}`}>
      <span className="text-sm text-gray-800">{label}</span>
      {children}
    </div>
  );
}
function MailCheckRow({ label, checked, onChange, highlight = false }) {
  return (
    <label className={`flex items-center gap-2.5 border border-gray-200 rounded-lg px-3 py-2.5 text-sm text-gray-800 cursor-pointer ${highlight ? 'bg-indigo-50' : ''}`}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="w-4 h-4 text-indigo-600 rounded" />
      {label}
    </label>
  );
}
// "Migrate: From / To" date range with devemail-style preset filters. Empty = migrate all.
function MailDateRange({ wiz, m, isDelta }) {
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const applyPreset = (months) => {
    const to = new Date();
    const from = new Date();
    if (months >= 12) from.setFullYear(from.getFullYear() - Math.round(months / 12));
    else from.setMonth(from.getMonth() - months);
    wiz.setMailOption('fromDate', iso(from));
    wiz.setMailOption('toDate', iso(to));
  };
  const presets = [['Last 3 Months', 3], ['Last 6 Months', 6], ['Last 9 Months', 9], ['Last 1 Year', 12]];
  return (
    <div className="space-y-2">
      <label className="block text-xs font-medium text-gray-700">Migrate: From / To</label>
      <div className="flex flex-wrap items-center gap-2">
        <input type="date" value={m.fromDate || ''} max={m.toDate || undefined}
          onChange={(e) => wiz.setMailOption('fromDate', e.target.value)}
          className="px-2 py-1.5 border border-gray-300 rounded-lg text-sm" />
        <span className="text-gray-400 text-sm">→</span>
        <input type="date" value={m.toDate || ''} min={m.fromDate || undefined}
          onChange={(e) => wiz.setMailOption('toDate', e.target.value)}
          className="px-2 py-1.5 border border-gray-300 rounded-lg text-sm" />
        {(m.fromDate || m.toDate) && (
          <button type="button" onClick={() => { wiz.setMailOption('fromDate', ''); wiz.setMailOption('toDate', ''); }}
            className="text-xs text-gray-500 hover:text-gray-700 underline">Clear</button>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {presets.map(([label, months]) => (
          <button key={label} type="button" onClick={() => applyPreset(months)}
            className="text-xs px-2 py-1 rounded-md border border-gray-200 text-gray-600 hover:bg-indigo-50 hover:border-indigo-300">{label}</button>
        ))}
      </div>
      <p className="text-[11px] text-gray-400">Leave blank to migrate all mail. A range limits migration to messages within these dates{isDelta ? '' : ''}.</p>
    </div>
  );
}
function MailOptions({ wiz }) {
  const m = wiz.mailOptions || {};
  const isDelta = wiz.migrationType === 'DELTA';
  const allDeltaOn = !!m.calendars && !!m.contacts;
  const setDeltaAll = (v) => { wiz.setMailOption('calendars', v); wiz.setMailOption('contacts', v); };
  // devemail: enabling In-Place Archive (One-Time) greys out the Migration Options.
  const optsDisabled = !isDelta && !!m.migrateAsInPlaceArchive;
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
      {/* Job Options — mirrors devemail: Job Type + Job Name (+ In-Place Archive for One-Time) */}
      <div className="border border-gray-200 rounded-xl overflow-hidden self-start">
        <div className="bg-indigo-50 text-gray-900 px-4 py-3 text-sm font-semibold">Job Options</div>
        <div className="p-4 space-y-3">
          <Field label="Job Type">
            <select value={wiz.migrationType} onChange={(e) => wiz.setMigrationType(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white">
              <option value="FULL">One-Time</option>
              <option value="DELTA">Delta</option>
            </select>
          </Field>
          <Field label="Job Name">
            <input value={m.jobName} onChange={(e) => wiz.setMailOption('jobName', e.target.value)}
              placeholder="(auto-generated if blank)" className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono" />
          </Field>
          <MailDateRange wiz={wiz} m={m} isDelta={isDelta} />
          {!isDelta && (
            <MailRow label="Migrate As In-Place Archive :">
              <MailToggle checked={!!m.migrateAsInPlaceArchive} onChange={(v) => wiz.setMailOption('migrateAsInPlaceArchive', v)} />
            </MailRow>
          )}
        </div>
      </div>

      {/* Migration Options — One-Time: Archive/Rules/Groups toggles · Delta: Archive + Calendars/Contacts checkboxes */}
      <div className="border border-gray-200 rounded-xl overflow-hidden self-start">
        <div className="bg-indigo-50 text-gray-900 px-4 py-3 text-sm font-semibold">Migration Options</div>
        <div className="p-4 space-y-2.5">
          <MailRow label="Archive Mailbox :" disabled={optsDisabled}>
            <MailToggle checked={!!m.archiveMailbox} disabled={optsDisabled} onChange={(v) => wiz.setMailOption('archiveMailbox', v)} />
          </MailRow>
          {isDelta ? (
            <>
              <MailCheckRow label="Select All" checked={allDeltaOn} onChange={setDeltaAll} highlight />
              <MailCheckRow label="Calendars" checked={!!m.calendars} onChange={(v) => wiz.setMailOption('calendars', v)} />
              <MailCheckRow label="Contacts" checked={!!m.contacts} onChange={(v) => wiz.setMailOption('contacts', v)} />
            </>
          ) : (
            <>
              <MailRow label="Migrate Rules :" disabled={optsDisabled}>
                <MailToggle checked={!!m.migrateRules} disabled={optsDisabled} onChange={(v) => wiz.setMailOption('migrateRules', v)} />
              </MailRow>
              <MailRow label="Exclude Groups :" disabled={optsDisabled}>
                <MailToggle checked={!!m.excludeGroups} disabled={optsDisabled} onChange={(v) => wiz.setMailOption('excludeGroups', v)} />
              </MailRow>
              {optsDisabled && (
                <p className="text-xs text-gray-500 pt-0.5">Disabled while <strong>Migrate As In-Place Archive</strong> is on (matches devemail).</p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// CloudFuze Team-Migration permission + job options (content only).
const CONTENT_PERMS = [
  ['rootFolderPermissions', 'Root Folder Permissions'],
  ['rootFilePermissions', 'Root File Permissions'],
  ['subFolderPermissions', 'Sub-Folder Permissions'],
  ['subFilePermissions', 'Sub-File Permissions'],
  ['sharedLinks', 'Shared Links'],
  ['externalShares', 'External Shares'],
  ['versionHistory', 'Version History'],
  ['preserveTimestamp', 'Preserve Timestamp'],
  ['customMetadata', 'Custom Metadata'],
  ['workbookLinks', 'Workbook Links'],
  ['comments', 'Comments'],
];
// Per-user folder mapping table for multi-user content migration. One row per selected user
// (from Map Users). Each row's source folder / destination path defaults to the shared base
// fields; editing a row overrides just that user. CSV import matches by source email.
function PerUserFolderTable({ wiz, destDefault }) {
  const pairs = wiz.selectedPairs || [];
  if (pairs.length === 0) {
    return (
      <p className="sm:col-span-2 text-xs text-amber-600">
        No users selected on the Map Users step — map at least one user to migrate.
      </p>
    );
  }
  const baseName = wiz.contentPaths.sourceFolderName || 'Agent Box Data';
  const onCsv = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const n = wiz.importContentUserFoldersCsv(text);
    e.target.value = '';
    alert(`Imported folder overrides for ${n} user(s).`);
  };
  return (
    <div className="sm:col-span-2">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-gray-700">Per-user folders ({pairs.length})</span>
        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-indigo-600 hover:text-indigo-700 cursor-pointer">
            Import CSV
            <input type="file" accept=".csv,text/csv" onChange={onCsv} className="hidden" />
          </label>
          <button type="button" onClick={() => wiz.clearContentUserFolders()}
            className="text-xs font-medium text-gray-500 hover:text-gray-700">Reset to base</button>
        </div>
      </div>
      <div className="overflow-x-auto border border-gray-200 rounded-lg">
        <table className="w-full text-xs">
          <thead className="bg-gray-50 text-gray-600">
            <tr>
              <th className="text-left font-semibold px-3 py-2">Source user</th>
              <th className="text-left font-semibold px-3 py-2">Source folder</th>
              <th className="text-left font-semibold px-3 py-2">Destination user</th>
              <th className="text-left font-semibold px-3 py-2">Destination path</th>
            </tr>
          </thead>
          <tbody>
            {pairs.map((p) => {
              const email = (p.source.email || '').toLowerCase();
              const ov = wiz.contentUserFolders[email] || {};
              return (
                <tr key={email} className="border-t border-gray-100">
                  <td className="px-3 py-1.5 font-mono text-gray-700 whitespace-nowrap">{p.source.email}</td>
                  <td className="px-2 py-1.5">
                    <input value={ov.sourceFolderName || ''} onChange={(e) => wiz.setContentUserFolder(email, 'sourceFolderName', e.target.value)}
                      placeholder={baseName} className="w-full px-2 py-1 border border-gray-300 rounded text-xs font-mono" />
                  </td>
                  <td className="px-3 py-1.5 font-mono text-gray-700 whitespace-nowrap">{p.destination.email}</td>
                  <td className="px-2 py-1.5">
                    <input value={ov.destinationPath || ''} onChange={(e) => wiz.setContentUserFolder(email, 'destinationPath', e.target.value)}
                      placeholder={destDefault} className="w-full px-2 py-1 border border-gray-300 rounded text-xs font-mono" />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-gray-400 mt-1.5">
        CSV columns: <span className="font-mono">Source User, Source Folder, Destination User, Destination Path</span> (matched by source email).
      </p>
    </div>
  );
}

function ContentOptions({ wiz }) {
  const o = wiz.contentOptions;
  const allOn = CONTENT_PERMS.every(([k]) => o[k]);
  const setAll = (val) => CONTENT_PERMS.forEach(([k]) => { if (o[k] !== val) wiz.toggleContentOption(k); });
  // Default destination path shown to the user, based on the chosen destination service.
  const destDefault = wiz.dstProvider === 'sharepoint' ? '/SANITY DATAA/Documents'
    : (wiz.dstProvider === 'onedrive' ? '/' : (String(wiz.dstProvider).includes('drive') ? '/OSM' : '/'));
  return (
    <>
    {/* Content Mapping — which folder migrates where (the path CSV the agent uploads) */}
    <div className="border border-gray-200 rounded-xl overflow-hidden mb-5">
      <div className="bg-indigo-600 text-white px-4 py-2.5 text-sm font-semibold">Content Mapping</div>
      <div className="p-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
        <label className="sm:col-span-2 flex items-center gap-2.5 text-sm text-gray-800 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 cursor-pointer">
          <input type="checkbox" checked={wiz.useExistingSource} onChange={(e) => wiz.setUseExistingSource(e.target.checked)} className="w-4 h-4 text-indigo-600 rounded" />
          <span><strong>Use existing source folder</strong> — skip data creation and migrate the folder(s) that already exist at the paths below.</span>
        </label>
        <Field label={wiz.useExistingSource ? 'Existing source folder path' : 'Source folder base name'}>
          <input value={wiz.contentPaths.sourceFolderName} onChange={(e) => wiz.setContentPath('sourceFolderName', e.target.value)}
            placeholder={wiz.useExistingSource ? 'e.g. /NEWDATA or /Projects/Q1' : 'e.g. NEWDATA (default: Agent Box Data)'} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono" />
        </Field>
        <Field label="Destination path">
          <input value={wiz.contentPaths.destinationPath} onChange={(e) => wiz.setContentPath('destinationPath', e.target.value)}
            placeholder={`default ${destDefault}`} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono" />
        </Field>
        <p className="sm:col-span-2 text-xs text-gray-500">
          {wiz.useExistingSource ? (
            <><strong>Using existing folders.</strong> The agent does NOT create data — it resolves each user row's path to the
            existing Box folder and migrates it. Per-user paths in the table override the base path above.</>
          ) : (
            <><strong>Per-user mapping below.</strong> The two fields above are <strong>bulk defaults</strong> — applied to any user
            row left blank. The agent seeds one dataset per mapped user and migrates each under its Destination path as its own
            sub-folder. If a name already exists it appends “ 1”. Leave a Destination blank for the cloud default ({destDefault}).</>
          )}
        </p>
        <PerUserFolderTable wiz={wiz} destDefault={destDefault} />
      </div>
    </div>
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
      <div className="border border-gray-200 rounded-xl overflow-hidden">
        <div className="bg-indigo-600 text-white px-4 py-2.5 text-sm font-semibold">Migration Options</div>
        <div className="p-4 space-y-2.5">
          <label className="flex items-center gap-2.5 text-sm font-medium text-gray-800 pb-2 border-b border-gray-100">
            <input type="checkbox" checked={allOn} onChange={() => setAll(!allOn)} className="w-4 h-4 text-indigo-600 rounded" />
            Select All
          </label>
          {CONTENT_PERMS.map(([key, label]) => (
            <label key={key} className="flex items-center gap-2.5 text-sm text-gray-700 cursor-pointer">
              <input type="checkbox" checked={!!o[key]} onChange={() => wiz.toggleContentOption(key)} className="w-4 h-4 text-indigo-600 rounded" />
              {label}
            </label>
          ))}
        </div>
      </div>
      <div className="border border-gray-200 rounded-xl overflow-hidden">
        <div className="bg-indigo-600 text-white px-4 py-2.5 text-sm font-semibold">Job Options</div>
        <div className="p-4 space-y-3">
          <Field label="Job Name">
            <input value={wiz.jobOptions.jobName} onChange={(e) => wiz.setJobOption('jobName', e.target.value)}
              placeholder="(auto-generated if blank)" className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
          </Field>
          <Field label="Replace special characters with">
            <select value={wiz.jobOptions.replaceSpecialChar} onChange={(e) => wiz.setJobOption('replaceSpecialChar', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white">
              <option value="_">Underscore ( _ )</option>
              <option value="-">Hyphen ( - )</option>
              <option value="">Remove</option>
            </select>
          </Field>
          <Field label="Exclude file types">
            <input value={wiz.jobOptions.excludeFileTypes} onChange={(e) => wiz.setJobOption('excludeFileTypes', e.target.value)}
              placeholder="e.g. mp3,mp4,psd" className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
          </Field>
          <label className="flex items-center gap-2.5 text-sm text-gray-700 cursor-pointer pt-1">
            <input type="checkbox"
              checked={!wiz.contentOptions.notifyInternalUsers && !wiz.contentOptions.notifyExternalUsers}
              onChange={(e) => { const notify = !e.target.checked; wiz.setContentOption('notifyInternalUsers', notify); wiz.setContentOption('notifyExternalUsers', notify); }}
              className="w-4 h-4 text-indigo-600 rounded" />
            Suppress email notifications
          </label>
        </div>
      </div>
    </div>
    </>
  );
}

// ── Step 6: Summary ─────────────────────────────────────────────────────────────
export function StepSummary({ wiz, onRun, running }) {
  const pairs = wiz.selectedPairs;
  const isContent = wiz.domain === 'content';
  const o = wiz.contentOptions || {};
  const enabledPerms = CONTENT_PERMS.filter(([k]) => o[k]).map(([, label]) => label);
  const baseFolder = wiz.contentPaths.sourceFolderName || 'Agent Box Data';
  const baseDest = wiz.contentPaths.destinationPath || '(cloud default)';

  return (
    <div className="space-y-5">
      <p className="text-sm text-gray-500">Review everything you selected, then run the migration QA flow.</p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <SummaryCard title="Source" lines={[`${provMeta(wiz.srcProvider).short}`, wiz.srcEmail || '—']} />
        <SummaryCard title="Destination" lines={[`${provMeta(wiz.dstProvider).short}`, wiz.dstEmail || '—']} />
        <SummaryCard title="Migration server" lines={[wiz.migrationServerUrl || '—', wiz.migrationServerEmail || '—']} />
        <SummaryCard title="Run type" lines={[`Test: ${wiz.testType}`, `Migration: ${wiz.migrationType === 'FULL' ? 'One Time' : 'Delta'}`]} />
      </div>

      {/* Permission / user mapping — ALL mapped users (applies to every collaborator on the
          migrated content, not just the users selected for migration). */}
      {(() => {
        const allMappings = wiz.mappings || [];
        const selected = new Set(pairs.map((p) => (p.source.email || '').toLowerCase()));
        return (
          <SummarySection title={`Permission Mapping · ${allMappings.length} user${allMappings.length === 1 ? '' : 's'}`}
            subtitle="Applies to EVERY collaborator on the migrated content (not only the selected users). Each source user's permissions are re-granted to the mapped destination user. ★ = selected for content migration.">
            {allMappings.length === 0
              ? <p className="px-4 py-3 text-xs text-amber-600">No user mapping yet — fetch/map users in the Map Users step.</p>
              : (
                <div className="divide-y divide-gray-100 max-h-56 overflow-y-auto">
                  {allMappings.map((m, i) => {
                    const isSel = selected.has((m.source.email || '').toLowerCase());
                    return (
                      <div key={i} className="px-4 py-2 flex items-center gap-2 text-sm">
                        <span className="w-3 text-amber-500">{isSel ? '★' : ''}</span>
                        <span className="font-mono text-gray-700 truncate flex-1">{m.source.email}</span>
                        <span className="text-indigo-400">→</span>
                        <span className="font-mono text-gray-700 truncate flex-1 text-right">{m.destination.email}</span>
                      </div>
                    );
                  })}
                </div>
              )}
          </SummarySection>
        );
      })()}

      {isContent && (
        <>
          {/* Per-user folder mapping */}
          <SummarySection title="Content Mapping · per-user folders"
            subtitle={`Base folder "${baseFolder}", base destination "${baseDest}" — overrides shown per user.`}>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 text-gray-500">
                  <tr><th className="text-left px-4 py-2 font-semibold">Source user</th><th className="text-left px-2 py-2 font-semibold">Source folder</th><th className="text-left px-2 py-2 font-semibold">Destination path</th></tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {pairs.map((p, i) => {
                    const ov = wiz.contentUserFolders[(p.source.email || '').toLowerCase()] || {};
                    return (
                      <tr key={i}>
                        <td className="px-4 py-1.5 font-mono text-gray-700">{p.source.email}</td>
                        <td className="px-2 py-1.5 font-mono text-gray-600">{ov.sourceFolderName || baseFolder}</td>
                        <td className="px-2 py-1.5 font-mono text-gray-600">{ov.destinationPath || baseDest}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </SummarySection>

          {/* Migration options (permission flags) */}
          <SummarySection title={`Migration Options · ${enabledPerms.length} enabled`}>
            <div className="px-4 py-3 flex flex-wrap gap-1.5">
              {enabledPerms.length === 0
                ? <span className="text-xs text-gray-400">None selected</span>
                : enabledPerms.map((label) => (
                    <span key={label} className="text-[11px] bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded-full">{label}</span>
                  ))}
            </div>
          </SummarySection>

          {/* Job options */}
          <SummarySection title="Job Options">
            <div className="px-4 py-3 grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
              <div><span className="text-gray-500">Job name: </span><span className="font-mono">{wiz.jobOptions.jobName || '(auto)'}</span></div>
              <div><span className="text-gray-500">Replace special chars: </span><span className="font-mono">{wiz.jobOptions.replaceSpecialChar || '-'}</span></div>
              <div><span className="text-gray-500">Exclude file types: </span><span className="font-mono">{wiz.jobOptions.excludeFileTypes || '(none)'}</span></div>
            </div>
          </SummarySection>
        </>
      )}

      {wiz.domain === 'mail' && (() => {
        const m = wiz.mailOptions || {};
        const isDelta = wiz.migrationType === 'DELTA';
        const opts = isDelta
          ? [`Archive Mailbox: ${m.archiveMailbox ? 'On' : 'Off'}`, `Calendars: ${m.calendars ? 'On' : 'Off'}`, `Contacts: ${m.contacts ? 'On' : 'Off'}`]
          : [`Archive Mailbox: ${m.archiveMailbox ? 'On' : 'Off'}`, `Migrate Rules: ${m.migrateRules ? 'On' : 'Off'}`, `Exclude Groups: ${m.excludeGroups ? 'On' : 'Off'}`, `In-Place Archive: ${m.migrateAsInPlaceArchive ? 'On' : 'Off'}`];
        const dateRange = (m.fromDate || m.toDate) ? `${m.fromDate || '…'} → ${m.toDate || '…'}` : 'all mail';
        return (
          <SummarySection title="Mail Options" subtitle={`Job Type: ${isDelta ? 'Delta' : 'One-Time'} · Job Name: ${m.jobName || '(auto)'} · Range: ${dateRange}`}>
            <div className="px-4 py-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-gray-700">
              {opts.map((t) => <span key={t} className="font-mono">{t}</span>)}
            </div>
          </SummarySection>
        );
      })()}

      <button type="button" onClick={onRun} disabled={running || pairs.length === 0}
        className="w-full md:w-auto px-8 py-3 bg-indigo-600 text-white text-sm font-semibold rounded-lg hover:bg-indigo-700 disabled:opacity-50">
        {running ? 'Starting…' : `Run Migration · ${wiz.testType}${pairs.length > 1 ? ` (${pairs.length} users)` : ''}`}
      </button>
      {pairs.length === 0 && <p className="text-xs text-amber-600">Select at least one user pair in the Map Users step.</p>}
    </div>
  );
}

function SummarySection({ title, subtitle, children }) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
      <div className="px-4 py-2.5 border-b border-gray-100">
        <p className="text-xs font-semibold text-gray-700 uppercase tracking-wide">{title}</p>
        {subtitle && <p className="text-[11px] text-gray-400 mt-0.5">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

// ── Small shared bits ───────────────────────────────────────────────────────────
function Field({ label, children }) {
  return <div><label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>{children}</div>;
}
function Pill({ c, t }) {
  const colors = { indigo: 'bg-indigo-50 text-indigo-700', purple: 'bg-purple-50 text-purple-700', green: 'bg-green-50 text-green-700', yellow: 'bg-yellow-50 text-yellow-700' };
  return <span className={`${colors[c]} px-3 py-1 rounded-full font-medium`}>{t}</span>;
}
function SummaryCard({ title, lines }) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{title}</p>
      {lines.map((l, i) => <p key={i} className={`mt-1 text-sm ${i === 0 ? 'font-semibold text-gray-900' : 'text-gray-600 truncate'}`}>{l}</p>)}
    </div>
  );
}
function Err({ msg }) {
  return <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-600">{msg}</div>;
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
      <rect x="1" y="1" width="10" height="10" fill="#F25022" /><rect x="12" y="1" width="10" height="10" fill="#7FBA00" />
      <rect x="1" y="12" width="10" height="10" fill="#00A4EF" /><rect x="12" y="12" width="10" height="10" fill="#FFB900" />
    </svg>
  );
}
function BoxIcon({ className }) {
  return (
    <svg viewBox="0 0 24 24" className={className}>
      <rect width="24" height="24" rx="5" fill="#0061D5" />
      <text x="12" y="15.5" textAnchor="middle" fontSize="8.5" fontWeight="700" fill="#fff" fontFamily="Arial, sans-serif">box</text>
    </svg>
  );
}
function GmailIcon({ className }) {
  return (
    <svg viewBox="0 0 24 24" className={className}>
      <path fill="#fff" d="M3 5h18v14H3z" />
      <path fill="#EA4335" d="M3 6.5L12 13 21 6.5V5l-9 6.5L3 5z" />
      <path fill="#34A853" d="M3 5v14h2.7V8.3L12 13 3 5z" />
      <path fill="#FBBC04" d="M21 5v14h-2.7V8.3L12 13l9-8z" />
      <path fill="#C5221F" d="M3 5l9 6.5L21 5h-2.2L12 9.8 5.2 5H3z" />
    </svg>
  );
}
function OutlookIcon({ className }) {
  return (
    <svg viewBox="0 0 24 24" className={className}>
      <rect x="9" y="4" width="13" height="16" rx="1.5" fill="#0A2767" />
      <rect x="9" y="4" width="13" height="8" fill="#0364B8" />
      <rect x="2" y="6" width="11" height="12" rx="2" fill="#0078D4" />
      <text x="7.5" y="15" textAnchor="middle" fontSize="9" fontWeight="700" fill="#fff" fontFamily="Arial, sans-serif">O</text>
    </svg>
  );
}
function DriveIcon({ className }) {
  return (
    <svg viewBox="0 0 88 78" className={className}>
      <path fill="#0066DA" d="M6.6 66.85l3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3L27.5 53H0c0 1.55.4 3.1 1.2 4.5z" />
      <path fill="#00AC47" d="M43.65 25L29.9 1.2c-1.35.8-2.5 1.9-3.3 3.3L1.2 48.5C.4 49.9 0 51.45 0 53h27.5z" />
      <path fill="#EA4335" d="M73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75L86.8 57c.8-1.4 1.2-2.95 1.2-4.5H60.5l5.85 11.5z" />
      <path fill="#00832D" d="M43.65 25L57.4 1.2C56.05.4 54.5 0 52.9 0H34.4c-1.6 0-3.15.45-4.5 1.2z" />
      <path fill="#2684FC" d="M60.5 53H27.5L13.75 76.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z" />
      <path fill="#FFBA00" d="M73.4 26.5L60.75 4.5c-.8-1.4-1.95-2.5-3.3-3.3L43.65 25 60.5 53H88c0-1.55-.4-3.1-1.2-4.5z" />
    </svg>
  );
}
function SharedDriveIcon({ className }) {
  // Drive triangle (greyed) with a "shared/people" badge to distinguish from My Drive.
  return (
    <svg viewBox="0 0 24 24" className={className}>
      <path fill="#5F6368" d="M8.8 3.2h6.4l5.4 9.3h-6.4zM7.7 4.1L2.3 13.4l3.2 5.5 5.4-9.3zM7.1 14.4l-3 5.2h11.2l3-5.2z" opacity="0.5" />
      <circle cx="18" cy="18" r="5" fill="#1A73E8" />
      <path fill="#fff" d="M18 15.4a1.5 1.5 0 110 3 1.5 1.5 0 010-3zm-2.6 5.1c0-1.1 1.2-1.7 2.6-1.7s2.6.6 2.6 1.7v.5h-5.2z" />
    </svg>
  );
}
function OneDriveIcon({ className }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="#0078D4">
      <path d="M13.5 7a5.5 5.5 0 015.42 4.6A4 4 0 0118 19.5H7a4.5 4.5 0 01-1.06-8.87A5.5 5.5 0 0113.5 7z" />
    </svg>
  );
}
function SharePointIcon({ className }) {
  return (
    <svg viewBox="0 0 24 24" className={className}>
      <circle cx="12" cy="12" r="11" fill="#036C70" />
      <text x="12" y="16.5" textAnchor="middle" fontSize="12" fontWeight="700" fill="#fff" fontFamily="Segoe UI, Arial, sans-serif">S</text>
    </svg>
  );
}
function DropboxIcon({ className }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="#0061FF">
      <path d="M6 2L0 6l6 4 6-4-6-4zm12 0l-6 4 6 4 6-4-6-4zM0 14l6 4 6-4-6-4-6 4zm18-4l-6 4 6 4 6-4-6-4zM6 19.34l6 4 6-4-6-4-6 4z" />
    </svg>
  );
}
function EgnyteIcon({ className }) {
  return (
    <svg viewBox="0 0 24 24" className={className}>
      <rect width="24" height="24" rx="5" fill="#00AEC7" />
      <text x="12" y="16.5" textAnchor="middle" fontSize="12" fontWeight="700" fill="#fff" fontFamily="Arial, sans-serif">e</text>
    </svg>
  );
}
function CitrixIcon({ className }) {
  return (
    <svg viewBox="0 0 24 24" className={className}>
      <rect width="24" height="24" rx="5" fill="#452D82" />
      <text x="12" y="16" textAnchor="middle" fontSize="11" fontWeight="700" fill="#fff" fontFamily="Arial, sans-serif">C</text>
    </svg>
  );
}
function GenericCloudIcon({ className }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={1.6}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15a4.5 4.5 0 0 0 4.5 4.5H18a3.75 3.75 0 0 0 1.332-7.257 3 3 0 0 0-3.758-3.848 5.25 5.25 0 0 0-10.233 2.33A4.502 4.502 0 0 0 2.25 15Z" />
    </svg>
  );
}
