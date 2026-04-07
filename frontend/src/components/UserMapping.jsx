import { useState } from 'react';
import { getSourceUsers, getDestinationUsers } from '../services/api';
import usePersistedState from '../hooks/usePersistedState';

export default function UserMapping({ onMappingComplete }) {
  const [sourceAdmin, setSourceAdmin] = usePersistedState('map-srcAdmin', '');
  const [destAdmin, setDestAdmin] = usePersistedState('map-destAdmin', '');
  const [sourceUsers, setSourceUsers] = usePersistedState('map-srcUsers', []);
  const [destUsers, setDestUsers] = usePersistedState('map-destUsers', []);
  const [mappings, setMappings] = usePersistedState('map-mappings', []);
  const [unmappedSource, setUnmappedSource] = usePersistedState('map-unmapSrc', []);
  const [unmappedDest, setUnmappedDest] = usePersistedState('map-unmapDest', []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [fetched, setFetched] = usePersistedState('map-fetched', false);

  async function fetchUsers() {
    if (!sourceAdmin || !destAdmin) return;
    setLoading(true);
    setError(null);
    setFetched(false);
    setMappings([]);
    setUnmappedSource([]);
    setUnmappedDest([]);
    try {
      const [srcRes, destRes] = await Promise.all([
        getSourceUsers(sourceAdmin),
        getDestinationUsers(destAdmin),
      ]);
      const src = srcRes.data.users || [];
      const dest = destRes.data.users || [];
      setSourceUsers(src);
      setDestUsers(dest);
      autoMap(src, dest);
      setFetched(true);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  }

  function autoMap(src, dest) {
    const mapped = [];
    const usedDestIds = new Set();
    const unmatchedSrc = [];
    for (const s of src) {
      const srcFirst = s.firstName.toLowerCase().trim();
      if (!srcFirst) { unmatchedSrc.push(s); continue; }
      const match = dest.find((d) => !usedDestIds.has(d.id) && d.firstName.toLowerCase().trim() === srcFirst);
      if (match) { mapped.push({ source: s, destination: match, autoMatched: true }); usedDestIds.add(match.id); }
      else { unmatchedSrc.push(s); }
    }
    setMappings(mapped);
    setUnmappedSource(unmatchedSrc);
    setUnmappedDest(dest.filter((d) => !usedDestIds.has(d.id)));
  }

  function manualMap(srcUser, destEmail) {
    const destUser = unmappedDest.find((d) => d.email === destEmail);
    if (!destUser) return;
    setMappings((prev) => [...prev, { source: srcUser, destination: destUser, autoMatched: false }]);
    setUnmappedSource((prev) => prev.filter((u) => u.id !== srcUser.id));
    setUnmappedDest((prev) => prev.filter((u) => u.id !== destUser.id));
  }

  function removeMapping(index) {
    const removed = mappings[index];
    setMappings((prev) => prev.filter((_, i) => i !== index));
    setUnmappedSource((prev) => [...prev, removed.source]);
    setUnmappedDest((prev) => [...prev, removed.destination]);
  }

  function handleConfirm() {
    onMappingComplete(mappings.map((m) => ({
      sourceEmail: m.source.email, destinationEmail: m.destination.email,
      sourceName: m.source.displayName, destinationName: m.destination.displayName, autoMatched: m.autoMatched,
    })));
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Source Admin Email (Gmail)</label>
          <input type="email" value={sourceAdmin} onChange={(e) => setSourceAdmin(e.target.value)} placeholder="granger@cloudfuze.us" className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Destination Admin Email (Outlook)</label>
          <input type="email" value={destAdmin} onChange={(e) => setDestAdmin(e.target.value)} placeholder="granger@gajha.com" className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none" />
        </div>
      </div>
      <button type="button" onClick={fetchUsers} disabled={loading || !sourceAdmin || !destAdmin} className="px-6 py-2.5 bg-gray-900 text-white text-sm font-semibold rounded-lg hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-all">
        {loading ? 'Fetching...' : 'Fetch & Auto-Map Users'}
      </button>
      {error && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-600">{error}</div>}
      {fetched && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="bg-indigo-50 text-indigo-700 px-3 py-1 rounded-full font-medium">{sourceUsers.length} source users</span>
            <span className="bg-purple-50 text-purple-700 px-3 py-1 rounded-full font-medium">{destUsers.length} destination users</span>
            <span className="bg-green-50 text-green-700 px-3 py-1 rounded-full font-medium">{mappings.length} auto-mapped</span>
            {unmappedSource.length > 0 && <span className="bg-yellow-50 text-yellow-700 px-3 py-1 rounded-full font-medium">{unmappedSource.length} unmatched source</span>}
            {unmappedDest.length > 0 && <span className="bg-orange-50 text-orange-700 px-3 py-1 rounded-full font-medium">{unmappedDest.length} unmatched destination</span>}
          </div>
          {mappings.length > 0 && (
            <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
              <div className="px-4 py-3 bg-gray-50 border-b border-gray-200"><h3 className="text-sm font-semibold text-gray-900">Mapped Pairs ({mappings.length})</h3></div>
              <div className="divide-y divide-gray-100 max-h-72 overflow-y-auto">
                {mappings.map((m, idx) => (
                  <div key={idx} className="px-4 py-2.5 flex items-center gap-3 text-sm">
                    <input type="checkbox" checked readOnly className="w-4 h-4 text-indigo-600 border-gray-300 rounded" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-gray-900 truncate">{m.source.email}</span>
                        <span className="text-gray-400 flex-shrink-0">&rarr;</span>
                        <span className="font-medium text-gray-900 truncate">{m.destination.email}</span>
                      </div>
                      <div className="text-xs text-gray-500 mt-0.5">{m.source.displayName} &rarr; {m.destination.displayName}</div>
                    </div>
                    <span className={'text-xs px-2 py-0.5 rounded-full flex-shrink-0 ' + (m.autoMatched ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700')}>{m.autoMatched ? 'auto' : 'manual'}</span>
                    <button type="button" onClick={() => removeMapping(idx)} className="text-gray-400 hover:text-red-500 transition-colors flex-shrink-0">
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
          {unmappedSource.length > 0 && (
            <div className="bg-white border border-yellow-200 rounded-xl overflow-hidden">
              <div className="px-4 py-3 bg-yellow-50 border-b border-yellow-200">
                <h3 className="text-sm font-semibold text-yellow-800">Unmatched Source Users ({unmappedSource.length})</h3>
                <p className="text-xs text-yellow-600 mt-0.5">Select a destination user to map manually</p>
              </div>
              <div className="divide-y divide-gray-100 max-h-60 overflow-y-auto">
                {unmappedSource.map((s) => (
                  <div key={s.id} className="px-4 py-2.5 flex items-center gap-3 text-sm">
                    <div className="flex-1 min-w-0">
                      <span className="font-medium text-gray-900">{s.email}</span>
                      <span className="text-xs text-gray-500 ml-2">({s.displayName})</span>
                    </div>
                    <span className="text-gray-400 flex-shrink-0">&rarr;</span>
                    <select defaultValue="" onChange={(e) => { if (e.target.value) manualMap(s, e.target.value); }} className="min-w-48 px-3 py-1.5 border border-gray-300 rounded-lg text-sm bg-white focus:ring-2 focus:ring-indigo-500 outline-none">
                      <option value="">Select destination...</option>
                      {unmappedDest.map((d) => (<option key={d.id} value={d.email}>{d.email} ({d.firstName})</option>))}
                    </select>
                  </div>
                ))}
              </div>
            </div>
          )}
          {mappings.length > 0 && (
            <button type="button" onClick={handleConfirm} className="px-6 py-2.5 bg-indigo-600 text-white text-sm font-semibold rounded-lg hover:bg-indigo-700 transition-colors">
              Use {mappings.length} Mapped Pair{mappings.length > 1 ? 's' : ''}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
