import TestCaseGenerator from './TestCaseGenerator';
import AgentRepo from './AgentRepo';
import usePersistedState from '../hooks/usePersistedState';

/**
 * Merged Test Cases page — "Generator" creates cases, "Agent Repo" browses/edits
 * the saved ones. Both read/write the same backend store (getCustomTestCases),
 * so anything saved in the Generator appears under the Agent Repo tab.
 */
export default function TestCases() {
  const [tab, setTab] = usePersistedState('testcases-tab', 'generate');

  return (
    <div className="-mx-6 -my-8 flex flex-col h-screen overflow-hidden">
      {/* Header + tabs */}
      <div className="px-6 pt-4 bg-white border-b border-gray-200 flex-shrink-0">
        <h1 className="text-2xl font-bold text-gray-900">Test Cases</h1>
        <p className="text-sm text-gray-500 mt-0.5">Generate test cases and manage your saved Agent Repository</p>
        <div className="flex items-center gap-1 mt-3 -mb-px">
          <Tab label="Generator" active={tab === 'generate'} onClick={() => setTab('generate')} />
          <Tab label="Agent Repo" active={tab === 'repo'} onClick={() => setTab('repo')} />
        </div>
      </div>

      {/* Active panel */}
      <div className="flex-1 overflow-hidden">
        {tab === 'generate'
          ? <div className="h-full overflow-y-auto px-6 py-6"><TestCaseGenerator /></div>
          : <AgentRepo />}
      </div>
    </div>
  );
}

function Tab({ label, active, onClick }) {
  return (
    <button type="button" onClick={onClick}
      className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${active ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
      {label}
    </button>
  );
}
