import CleanSource from './CleanSource';
import CleanDestination from './CleanDestination';
import usePersistedState from '../hooks/usePersistedState';

/** Merged Clean Up page — Gmail (source) and Outlook (destination) cleanup under tabs. */
export default function CleanUp({ embedded = false }) {
  const [tab, setTab] = usePersistedState('cleanup-tab', 'gmail');

  return (
    <div className="space-y-5">
      {!embedded && (
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Clean Up</h1>
          <p className="text-sm text-gray-500 mt-1">Wipe test mailboxes before a migration run</p>
        </div>
      )}

      <div className="flex items-center gap-1 border-b border-gray-200">
        <Tab label="Gmail" active={tab === 'gmail'} onClick={() => setTab('gmail')} />
        <Tab label="Outlook" active={tab === 'outlook'} onClick={() => setTab('outlook')} />
      </div>

      {tab === 'gmail' ? <CleanSource /> : <CleanDestination />}
    </div>
  );
}

function Tab({ label, active, onClick }) {
  return (
    <button type="button" onClick={onClick}
      className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${active ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
      {label}
    </button>
  );
}
