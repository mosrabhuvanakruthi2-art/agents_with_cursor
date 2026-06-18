import { useState, useEffect } from 'react';

// ── Provider config + icons ──────────────────────────────────────────────────
const PROVIDERS = {
  google: { key: 'google', label: 'Google Workspace', short: 'Google', Icon: GoogleIcon },
  microsoft: { key: 'microsoft', label: 'Microsoft 365', short: 'Microsoft', Icon: MicrosoftIcon },
};

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
export function StepConnect({ wiz }) {
  const [gEmail, setGEmail] = useState('');
  const google = wiz.accounts.filter((a) => a.provider === 'google');
  const microsoft = wiz.accounts.filter((a) => a.provider === 'microsoft');

  return (
    <div className="space-y-5">
      <p className="text-sm text-gray-500">Connect the cloud accounts you'll migrate between. You'll assign which is source and which is destination next.</p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <ConnectCard
          provider="google" accounts={google} busy={wiz.busy}
          hint="Domain-Wide Delegation — enter a Workspace admin email; no sign-in needed."
          value={gEmail} onChange={setGEmail}
          onConnect={() => wiz.connectGoogle(gEmail).then(() => setGEmail(''))}
          onDisconnect={(e) => wiz.disconnect('google', e)}
        />
        <ConnectCard
          provider="microsoft" accounts={microsoft} busy={wiz.busy} popup
          hint="Sign in as a tenant admin in the popup — consent is granted there (one-time per tenant)."
          onConnect={() => wiz.connectMicrosoft()}
          onDisconnect={(e) => wiz.disconnect('microsoft', e)}
        />
      </div>
      {wiz.error && <Err msg={wiz.error} />}
    </div>
  );
}

function ConnectCard({ provider, accounts, busy, hint, value, onChange, onConnect, onDisconnect, popup }) {
  const p = PROVIDERS[provider];
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
export function StepSelect({ wiz }) {
  return (
    <div className="space-y-5">
      <p className="text-sm text-gray-500">Pick which connected account is the source and which is the destination.</p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <RolePicker label="Source" accounts={wiz.accounts}
          provider={wiz.srcProvider} onProvider={wiz.setSrcProvider}
          email={wiz.srcEmail} onEmail={wiz.setSrcEmail} />
        <RolePicker label="Destination" accounts={wiz.accounts}
          provider={wiz.dstProvider} onProvider={wiz.setDstProvider}
          email={wiz.dstEmail} onEmail={wiz.setDstEmail} />
      </div>
    </div>
  );
}

function RolePicker({ label, accounts, provider, onProvider, email, onEmail }) {
  const list = accounts.filter((a) => a.provider === provider);
  return (
    <div className="border border-gray-200 rounded-xl p-4 bg-gray-50/50 space-y-3">
      <h3 className="text-sm font-semibold text-gray-900">{label} Admin</h3>
      <div className="flex gap-1.5 p-1 bg-gray-100 rounded-lg">
        {Object.values(PROVIDERS).map((pv) => {
          const { Icon } = pv;
          const active = provider === pv.key;
          return (
            <button key={pv.key} type="button" onClick={() => { onProvider(pv.key); onEmail(''); }}
              className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-md text-xs font-medium transition-all ${active ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-700'}`}>
              <Icon className="w-3.5 h-3.5" />{pv.short}
            </button>
          );
        })}
      </div>
      {list.length > 0 ? (
        <div className="space-y-1.5">
          {list.map((a) => (
            <button key={a.email} type="button" onClick={() => onEmail(a.email)}
              className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-lg border text-xs text-left transition-colors ${email === a.email ? 'border-indigo-400 bg-indigo-50 text-indigo-700 font-semibold' : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300'}`}>
              <span className="truncate">{a.email}</span>
              {email === a.email && <span className="ml-auto w-1.5 h-1.5 rounded-full bg-indigo-500" />}
            </button>
          ))}
        </div>
      ) : (
        <>
          <p className="text-xs text-amber-600">No {PROVIDERS[provider].short} accounts connected — connect one in step 1, or type an admin email.</p>
          <input type="email" value={email} onChange={(e) => onEmail(e.target.value)} placeholder="admin@yourdomain.com"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 outline-none bg-white" />
        </>
      )}
    </div>
  );
}

// ── Step 3: Auto / manual map ──────────────────────────────────────────────────
export function StepMap({ wiz }) {
  // Auto-fetch + auto-map as soon as a source and destination are selected.
  useEffect(() => {
    if (wiz.srcEmail && wiz.dstEmail && wiz.needsFetch && !wiz.busy) wiz.fetchUsers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wiz.srcEmail, wiz.dstEmail, wiz.needsFetch]);

  if (!wiz.srcEmail || !wiz.dstEmail) {
    return <p className="text-sm text-amber-600">Choose a source and destination admin in the previous step first.</p>;
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-500">Users are mapped source → destination by first name. Map any unmatched users below and uncheck pairs you don't want to migrate.</p>
      {wiz.busy && !wiz.fetched && <div className="text-sm text-gray-400">Fetching &amp; auto-mapping users…</div>}
      {wiz.error && <Err msg={wiz.error} />}
      {wiz.fetched && (
        <>
          <div className="flex flex-wrap gap-2 text-xs">
            <Pill c="indigo" t={`${wiz.sourceUsers.length} source`} />
            <Pill c="purple" t={`${wiz.destUsers.length} destination`} />
            <Pill c="green" t={`${wiz.selectedIndices.size} selected`} />
            {wiz.unmappedSource.length > 0 && <Pill c="yellow" t={`${wiz.unmappedSource.length} unmatched`} />}
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
                {wiz.mappings.map((m, idx) => (
                  <label key={idx} className={`px-4 py-2.5 flex items-center gap-3 text-sm cursor-pointer ${wiz.selectedIndices.has(idx) ? 'bg-indigo-50/50' : 'hover:bg-gray-50'}`}>
                    <input type="checkbox" checked={wiz.selectedIndices.has(idx)} onChange={() => wiz.togglePair(idx)} className="w-4 h-4 text-indigo-600 rounded" />
                    <span className="flex-1 min-w-0 truncate">{m.source.email} <span className="text-gray-400">→</span> {m.destination.email}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${m.autoMatched ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}`}>{m.autoMatched ? 'auto' : 'manual'}</span>
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
                {wiz.unmappedSource.map((s) => (
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
    { value: 'SMOKE', label: 'Smoke', desc: 'Quick connectivity check' },
    { value: 'SANITY', label: 'Sanity', desc: 'Core feature validation' },
    { value: 'E2E', label: 'E2E', desc: 'Full seed + calendar (slow)' },
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
    </div>
  );
}

// ── Step 6: Summary ─────────────────────────────────────────────────────────────
export function StepSummary({ wiz, onRun, running }) {
  const pairs = wiz.selectedPairs;
  return (
    <div className="space-y-5">
      <p className="text-sm text-gray-500">Review your selections, then run the migration QA flow.</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <SummaryCard title="Source" lines={[`${PROVIDERS[wiz.srcProvider].short}`, wiz.srcEmail || '—']} />
        <SummaryCard title="Destination" lines={[`${PROVIDERS[wiz.dstProvider].short}`, wiz.dstEmail || '—']} />
        <SummaryCard title="User pairs" lines={[`${pairs.length} selected`, pairs.length === 1 ? `${pairs[0].source.email} → ${pairs[0].destination.email}` : 'bulk run']} />
        <SummaryCard title="Options" lines={[`Test: ${wiz.testType}`, `Type: ${wiz.migrationType === 'FULL' ? 'One Time' : 'Delta'}`]} />
        <SummaryCard title="Migration server" lines={[wiz.migrationServerUrl || '—', wiz.migrationServerEmail || '(.env credentials)']} />
      </div>
      {pairs.length > 1 && (
        <div className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100 max-h-48 overflow-y-auto text-sm">
          {pairs.map((p, i) => <div key={i} className="px-4 py-2 truncate">{p.source.email} <span className="text-gray-400">→</span> {p.destination.email}</div>)}
        </div>
      )}
      <button type="button" onClick={onRun} disabled={running || pairs.length === 0}
        className="w-full md:w-auto px-8 py-3 bg-indigo-600 text-white text-sm font-semibold rounded-lg hover:bg-indigo-700 disabled:opacity-50">
        {running ? 'Starting…' : `Run Migration · ${wiz.testType}${pairs.length > 1 ? ` (${pairs.length} pairs)` : ''}`}
      </button>
      {pairs.length === 0 && <p className="text-xs text-amber-600">Select at least one user pair in step 3.</p>}
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
