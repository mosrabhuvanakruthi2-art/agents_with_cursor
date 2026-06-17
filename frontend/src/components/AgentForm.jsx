import { useState } from 'react';
import UserMapping from './UserMapping';
import usePersistedState from '../hooks/usePersistedState';

/** Aligns with backend MigrationContext defaults: FULL = mail + labels only; DELTA adds calendar + contacts. Deep validation is server-side always on. */
function scopesForMigrationType(migrationType, mode) {
  if (mode === 'content') {
    return { includeMail: false, includeCalendar: true, includeContacts: true };
  }
  if (migrationType === 'DELTA') {
    return { includeMail: true, includeCalendar: true, includeContacts: true };
  }
  return { includeMail: true, includeCalendar: false, includeContacts: false };
}

export default function AgentForm({ onSubmit, loading, mode = 'email' }) {
  const [form, setForm] = useState({
    testType: 'E2E',
    migrationType: 'FULL',
  });
  // Separate persisted server config per mode — content defaults to qarelease, email to devemail
  const [emailServerUrl,  setEmailServerUrl]  = usePersistedState('migration-server-url-email',    'https://devemail.cloudfuze.com/proxyservices/v1');
  const [contentServerUrl, setContentServerUrl] = usePersistedState('migration-server-url-content', 'https://qarelease.cloudfuze.com/');
  const [emailServerEmail,  setEmailServerEmail]  = usePersistedState('migration-server-email-email',   '');
  const [contentServerEmail, setContentServerEmail] = usePersistedState('migration-server-email-content', 'soumya.gande@cloudfuze.com');
  const [emailServerPassword,  setEmailServerPassword]  = useState('');
  const [contentServerPassword, setContentServerPassword] = useState('CloudFuze@123');

  const migrationServerUrl      = mode === 'content' ? contentServerUrl      : emailServerUrl;
  const setMigrationServerUrl   = mode === 'content' ? setContentServerUrl   : setEmailServerUrl;
  const migrationServerEmail    = mode === 'content' ? contentServerEmail    : emailServerEmail;
  const setMigrationServerEmail = mode === 'content' ? setContentServerEmail : setEmailServerEmail;
  const migrationServerPassword    = mode === 'content' ? contentServerPassword    : emailServerPassword;
  const setMigrationServerPassword = mode === 'content' ? setContentServerPassword : setEmailServerPassword;
  const [mappedPairs, setMappedPairs] = useState(null);
  const [userEmailMappings, setUserEmailMappings] = useState(null);
  const [sourceAdminEmail, setSourceAdminEmail] = useState('');
  const [destAdminEmail, setDestAdminEmail] = useState('');

  function handleChange(e) {
    const { name, value } = e.target;
    setForm((prev) => ({
      ...prev,
      [name]: value,
    }));
  }

  function handleMappingComplete(selectedPairs, allMappedForRecipients, directory = null) {
    setMappedPairs(selectedPairs);
    const all = Array.isArray(allMappedForRecipients)
      ? allMappedForRecipients
      : selectedPairs.map((p) => ({
          sourceEmail: p.sourceEmail,
          destinationEmail: p.destinationEmail,
        }));
    setUserEmailMappings(all);
    if (directory?.sourceAdminEmail) setSourceAdminEmail(directory.sourceAdminEmail);
    if (directory?.destAdminEmail) setDestAdminEmail(directory.destAdminEmail);
  }

  function clearMapping() {
    setMappedPairs(null);
    setUserEmailMappings(null);
  }

  function handleSubmit(e) {
    e.preventDefault();
    if (!mappedPairs || mappedPairs.length === 0) return;
    const mappingPayload = userEmailMappings && userEmailMappings.length > 0
      ? userEmailMappings
      : mappedPairs.map((p) => ({ sourceEmail: p.sourceEmail, destinationEmail: p.destinationEmail }));
    const scope = scopesForMigrationType(form.migrationType, mode);
    const serverFields = {
      ...(migrationServerUrl ? { migrationServerUrl } : {}),
      ...(migrationServerEmail ? { migrationServerEmail } : {}),
      ...(migrationServerPassword ? { migrationServerPassword } : {}),
    };
    const payloadBase = { ...form, ...scope, sourceAdminEmail, destAdminEmail, ...serverFields, mode };
    if (mappedPairs.length === 1) {
      onSubmit({
        ...payloadBase,
        sourceEmail: mappedPairs[0].sourceEmail,
        destinationEmail: mappedPairs[0].destinationEmail,
        sourceProvider: mappedPairs[0].sourceProvider || 'google',
        destinationProvider: mappedPairs[0].destinationProvider || 'microsoft',
        userEmailMappings: mappingPayload,
      });
    } else {
      onSubmit({ ...payloadBase, mappedPairs, userEmailMappings: mappingPayload });
    }
  }

  const hasBulkMapping = mappedPairs && mappedPairs.length > 1;

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="border border-gray-200 rounded-xl p-5 space-y-4 bg-gray-50/50">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-gray-900">Auto-Map Users</h3>
            <p className="text-xs text-gray-500 mt-0.5">Enter admin email to fetch and auto-map users by first name</p>
          </div>
          {mappedPairs && (
            <button type="button" onClick={clearMapping} className="text-xs text-gray-500 hover:text-red-500 transition-colors">
              Clear mapping
            </button>
          )}
        </div>
        <UserMapping onMappingComplete={handleMappingComplete} mode={mode} />
        {mappedPairs && (
          <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-sm text-green-700">
            {mappedPairs.length} pair{mappedPairs.length > 1 ? 's' : ''} mapped.
            {mappedPairs.length === 1 && ` Source: ${mappedPairs[0].sourceEmail} → Destination: ${mappedPairs[0].destinationEmail}`}
            {mappedPairs.length > 1 && ' All pairs will be migrated together.'}
          </div>
        )}
      </div>

      <div className="border border-gray-200 rounded-xl p-5 space-y-4 bg-gray-50/50">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-gray-900">Migration Server</h3>
            <p className="text-xs text-gray-500 mt-0.5">CloudFuze server to run the migration against</p>
          </div>
          {/* Mode badge */}
          {migrationServerEmail && migrationServerPassword ? (
            <span className="shrink-0 inline-flex items-center gap-1 rounded-full bg-indigo-50 border border-indigo-200 px-2.5 py-0.5 text-xs font-medium text-indigo-700">
              <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 inline-block" />
              New server (email + password)
            </span>
          ) : (
            <span className="shrink-0 inline-flex items-center gap-1 rounded-full bg-amber-50 border border-amber-200 px-2.5 py-0.5 text-xs font-medium text-amber-700">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 inline-block" />
              Legacy server (Basic auth)
            </span>
          )}
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Server URL</label>
          <input
            type="url"
            value={migrationServerUrl}
            onChange={(e) => setMigrationServerUrl(e.target.value)}
            placeholder="https://devemail.cloudfuze.com/proxyservices/v1"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none bg-white font-mono"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Email <span className="text-gray-400 font-normal">(new server only)</span>
            </label>
            <input
              type="email"
              value={migrationServerEmail}
              onChange={(e) => setMigrationServerEmail(e.target.value)}
              placeholder="Leave empty for devemail"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none bg-white"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Password <span className="text-gray-400 font-normal">(new server) / Basic Auth Token (legacy)</span>
            </label>
            <input
              type="password"
              value={migrationServerPassword}
              onChange={(e) => setMigrationServerPassword(e.target.value)}
              placeholder="New server: password. Legacy: paste Basic auth token"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none bg-white"
            />
          </div>
        </div>

        <div className="rounded-lg bg-blue-50 border border-blue-100 px-3 py-2 text-xs text-blue-700 space-y-0.5">
          <p><span className="font-semibold">devemail (legacy):</span> use URL <code className="bg-blue-100 px-1 rounded">https://devemail.cloudfuze.com/proxyservices/v1</code> — leave Email &amp; Password empty. Auth uses Basic credentials from <code className="bg-blue-100 px-1 rounded">.env</code>.</p>
          <p><span className="font-semibold">qarelease (content):</span> use URL <code className="bg-blue-100 px-1 rounded">https://qarelease.cloudfuze.com/</code> — leave Email empty, paste the Basic auth token in Password field.</p>
          <p><span className="font-semibold">newtestemail5 (new):</span> use URL <code className="bg-blue-100 px-1 rounded">https://newtestemail5.cloudfuze.com</code> — fill in Email &amp; Password.</p>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">Test Type</label>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {[
            { value: 'SMOKE', label: 'Smoke', emailDesc: 'Quick connectivity check', contentDesc: 'Quick connectivity check' },
            { value: 'SANITY', label: 'Sanity', emailDesc: 'Core feature validation', contentDesc: 'Core content validation' },
            { value: 'E2E', label: 'E2E', emailDesc: 'Full Gmail seed + calendar (slow)', contentDesc: 'Full calendar & contacts (slow)' },
          ].map((opt) => {
            const isActive = form.testType === opt.value;
            const activeColor = mode === 'content' ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-500' : 'border-indigo-500 bg-indigo-50 ring-1 ring-indigo-500';
            const activeText = mode === 'content' ? 'text-blue-700' : 'text-indigo-700';
            const activeDot = mode === 'content' ? 'bg-blue-500' : 'bg-indigo-500';
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => setForm((prev) => ({ ...prev, testType: opt.value }))}
                className={`relative rounded-xl border-2 p-4 text-left transition-all ${
                  isActive ? activeColor : 'border-gray-200 bg-white hover:border-gray-300'
                }`}
              >
                <p className={`text-sm font-semibold ${isActive ? activeText : 'text-gray-900'}`}>
                  {opt.label}
                </p>
                <p className="text-xs text-gray-500 mt-0.5">
                  {mode === 'content' ? opt.contentDesc : opt.emailDesc}
                </p>
                {isActive && <span className={`absolute top-2 right-2 w-2 h-2 rounded-full ${activeDot}`} />}
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-2">
        <label htmlFor="migrationType" className="block text-sm font-medium text-gray-700">
          Migration Type
        </label>
        <select
          id="migrationType"
          name="migrationType"
          value={form.migrationType}
          onChange={handleChange}
          className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none bg-white"
        >
          <option value="FULL">One Time Migration</option>
          <option value="DELTA">Delta Migration</option>
        </select>
        <p className="text-xs text-gray-500 leading-relaxed">
          {mode === 'content' ? (
            form.migrationType === 'FULL' ? (
              <><strong>One Time</strong> — initial transfer of calendar events and contacts.</>
            ) : (
              <><strong>Delta</strong> — incremental calendar and contacts changes after the initial migration.</>
            )
          ) : (
            form.migrationType === 'FULL' ? (
              <><strong>One Time</strong> — initial transfer: email, folders/labels, threads, and metadata (mail scope). Calendar and contacts are not part of this run.</>
            ) : (
              <><strong>Delta</strong> — incremental email and folder/label changes after the initial migration, plus contacts and calendars.</>
            )
          )}
        </p>
      </div>

      <button
        type="submit"
        disabled={loading || !mappedPairs || mappedPairs.length === 0}
        className={`w-full md:w-auto px-8 py-3 text-white text-sm font-semibold rounded-lg focus:ring-4 disabled:opacity-50 disabled:cursor-not-allowed transition-all ${
          mode === 'content'
            ? 'bg-blue-600 hover:bg-blue-700 focus:ring-blue-200'
            : 'bg-indigo-600 hover:bg-indigo-700 focus:ring-indigo-200'
        }`}
      >
        {loading ? (
          <span className="flex items-center gap-2">
            <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            Running...
          </span>
        ) : hasBulkMapping ? (
          `Run Migration Agent · ${form.testType} (${mappedPairs.length} pairs)`
        ) : (
          `Run Migration Agent · ${form.testType}`
        )}
      </button>
    </form>
  );
}
