import { useState } from 'react';
import MessageUserMapping from './MessageUserMapping';
import usePersistedState from '../hooks/usePersistedState';
import { MESSAGE_COMBINATIONS, PLATFORM_CARDS } from '../constants/messageAgentConfig';

export default function MessageAgentForm({ onSubmit, loading }) {
  const [form, setForm] = useState({
    testType: 'SANITY',
    migrationType: 'FULL',
    includeMail: true,
    includeCalendar: false,
    productType: 'Message',
    messageCombination: 'Slack → Google Chat',
  });
  const [slackAdmin, setSlackAdmin] = usePersistedState('msg-agent-slack-admin', '');
  const [googleChatAdmin, setGoogleChatAdmin] = usePersistedState('msg-agent-gchat-admin', '');
  const [teamsAdmin, setTeamsAdmin] = usePersistedState('msg-agent-teams-admin', '');
  const [mappedPairs, setMappedPairs] = useState(null);

  function handleChange(e) {
    const { name, value, type, checked } = e.target;
    setForm((prev) => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value,
    }));
  }

  function handleMappingComplete(pairs) {
    setMappedPairs(pairs);
  }

  function clearMapping() {
    setMappedPairs(null);
  }

  function handleSubmit(e) {
    e.preventDefault();
    if (!mappedPairs || mappedPairs.length === 0) return;
    const messageAdmins = {
      slack: slackAdmin.trim() || undefined,
      googleChat: googleChatAdmin.trim() || undefined,
      teams: teamsAdmin.trim() || undefined,
    };
    const base = {
      ...form,
      productType: 'Message',
      messageCombination: form.messageCombination,
      includeCalendar: false,
      messageAdmins,
    };
    if (mappedPairs.length === 1) {
      onSubmit({
        ...base,
        sourceEmail: mappedPairs[0].sourceEmail,
        destinationEmail: mappedPairs[0].destinationEmail,
      });
    } else {
      onSubmit({ ...base, mappedPairs });
    }
  }

  const hasBulkMapping = mappedPairs && mappedPairs.length > 1;

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="rounded-xl p-5 space-y-4" style={{ border: '1px solid #c5cef5', backgroundColor: '#f5f7fd' }}>
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold" style={{ color: '#0129ac' }}>Auto-Map Users</h3>
            <p className="text-xs mt-0.5" style={{ color: '#4a65c0' }}>
              Pick <strong>Slack</strong>, <strong>Microsoft Teams</strong>, or <strong>Google Chat</strong> for each side. Teams and Chat use Microsoft / Google sign-in to list users; Slack uses manual email pairs.
            </p>
          </div>
          {mappedPairs && (
            <button type="button" onClick={clearMapping} className="text-xs transition-colors" style={{ color: '#4a65c0' }}>
              Clear mapping
            </button>
          )}
        </div>
        <MessageUserMapping onMappingComplete={handleMappingComplete} />

        <div className="mt-4 pt-4 space-y-3" style={{ borderTop: '1px solid #c5cef5' }}>
          <h3 className="text-sm font-semibold" style={{ color: '#0129ac' }}>Message migration — platform setup</h3>
          <p className="text-xs" style={{ color: '#4a65c0' }}>
            Record who approves apps and tokens per vendor. Seeding uses the <strong>source</strong> side of your migration route; configure matching keys in <code className="text-[11px]">backend/.env</code>.
          </p>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            {PLATFORM_CARDS.map((p) => (
              <div
                key={p.id}
                className="rounded-xl p-4 text-left flex flex-col"
                style={{ border: '1px solid #c5cef5', backgroundColor: '#fff' }}
              >
                <div className="flex items-center gap-2 mb-2">
                  <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: p.color }} />
                  <span className="text-sm font-semibold" style={{ color: '#0129ac' }}>{p.name}</span>
                </div>
                <label className="block text-[11px] font-medium mb-1" style={{ color: '#4a65c0' }}>
                  {p.adminLabel}
                </label>
                <input
                  type="email"
                  autoComplete="off"
                  placeholder={p.adminPlaceholder}
                  value={
                    p.id === 'slack' ? slackAdmin : p.id === 'googleChat' ? googleChatAdmin : teamsAdmin
                  }
                  onChange={(e) => {
                    const v = e.target.value;
                    if (p.id === 'slack') setSlackAdmin(v);
                    else if (p.id === 'googleChat') setGoogleChatAdmin(v);
                    else setTeamsAdmin(v);
                  }}
                  className="w-full px-3 py-2 rounded-lg text-sm outline-none mb-2"
                  style={{ border: '1px solid #c5cef5', color: '#0129ac' }}
                />
                <ul className="text-[11px] space-y-1.5 mt-auto pt-2" style={{ color: '#2a40a8', borderTop: '1px solid #eef1fb' }}>
                  {p.requirements.map((line, i) => (
                    <li key={i} className="flex gap-1.5">
                      <span style={{ color: '#7a8fd4' }}>•</span>
                      <span>{line}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        {mappedPairs && (
          <div className="rounded-lg p-3 text-sm" style={{ backgroundColor: '#eef1fb', border: '1px solid #c5cef5', color: '#0129ac' }}>
            {mappedPairs.length} pair{mappedPairs.length > 1 ? 's' : ''} mapped.
            {mappedPairs.length === 1 && ` Source: ${mappedPairs[0].sourceEmail} → Destination: ${mappedPairs[0].destinationEmail}`}
            {mappedPairs.length > 1 && ' All pairs will run together.'}
          </div>
        )}
      </div>

      <div>
        <label htmlFor="msgCombo" className="block text-sm font-medium mb-1" style={{ color: '#0129ac' }}>
          Migration combination (sets source platform for seed messages)
        </label>
        <select
          id="msgCombo"
          value={form.messageCombination}
          onChange={(e) => setForm((prev) => ({ ...prev, messageCombination: e.target.value }))}
          className="w-full px-4 py-2.5 rounded-lg text-sm outline-none bg-white"
          style={{ border: '1px solid #c5cef5', color: '#0129ac' }}
        >
          {MESSAGE_COMBINATIONS.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-sm font-medium mb-2" style={{ color: '#0129ac' }}>Test Type</label>
        <div className="grid grid-cols-2 gap-3">
          {[
            { value: 'SMOKE', label: 'Smoke', desc: 'Quick connectivity check' },
            { value: 'SANITY', label: 'Sanity', desc: 'Core feature validation' },
          ].map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setForm((prev) => ({ ...prev, testType: opt.value }))}
              className="relative rounded-xl p-4 text-left transition-all"
              style={{
                border: form.testType === opt.value ? '2px solid #0129ac' : '2px solid #c5cef5',
                backgroundColor: form.testType === opt.value ? '#eef1fb' : '#ffffff',
              }}
            >
              <p className="text-sm font-semibold" style={{ color: '#0129ac' }}>{opt.label}</p>
              <p className="text-xs mt-0.5" style={{ color: '#4a65c0' }}>{opt.desc}</p>
              {form.testType === opt.value && (
                <span className="absolute top-2 right-2 w-2 h-2 rounded-full" style={{ backgroundColor: '#0129ac' }} />
              )}
            </button>
          ))}
        </div>
        <div className="mt-2 text-xs" style={{ color: '#4a65c0' }}>
          {form.testType === 'SMOKE' && 'Posts 1 seed message (or your saved Smoke Message cases in Test Case Generator).'}
          {form.testType === 'SANITY' && 'Posts multiple seed messages (or saved Sanity Message custom cases).'}
        </div>
      </div>

      <div>
        <label htmlFor="migrationType" className="block text-sm font-medium mb-1" style={{ color: '#0129ac' }}>
          Migration Type
        </label>
        <select
          id="migrationType"
          name="migrationType"
          value={form.migrationType}
          onChange={handleChange}
          className="w-full px-4 py-2.5 rounded-lg text-sm outline-none bg-white"
          style={{ border: '1px solid #c5cef5', color: '#0129ac' }}
        >
          <option value="FULL">One Time Migration</option>
          <option value="DELTA">Delta Migration</option>
        </select>
      </div>

      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          name="includeMail"
          checked={form.includeMail}
          onChange={handleChange}
          className="w-4 h-4 rounded"
          style={{ accentColor: '#0129ac' }}
        />
        <span className="text-sm" style={{ color: '#0129ac' }}>Seed source messages</span>
      </label>

      <button
        type="submit"
        disabled={loading || !mappedPairs || mappedPairs.length === 0}
        className="w-full md:w-auto px-8 py-3 text-white text-sm font-semibold rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-all"
        style={{ backgroundColor: '#0129ac' }}
        onMouseEnter={(e) => { if (!e.currentTarget.disabled) e.currentTarget.style.backgroundColor = '#011e8a'; }}
        onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = '#0129ac'; }}
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
          `Run Message Agent (${mappedPairs.length} pairs)`
        ) : (
          'Run Message Agent'
        )}
      </button>
    </form>
  );
}
