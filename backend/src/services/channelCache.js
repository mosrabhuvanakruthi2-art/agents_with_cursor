const fs   = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, '../../data/channel-cache.json');

function read() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return {};
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) || {};
  } catch { return {}; }
}

function write(data) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) { console.error('[channelCache] write error:', e.message); }
}

function cacheKey(combination, srcCloudId, dstCloudId) {
  return `${combination || 'unknown'}::${srcCloudId || ''}::${dstCloudId || ''}`;
}

/** Return cached entry or null. */
function get(combination, srcCloudId, dstCloudId) {
  const cache = read();
  return cache[cacheKey(combination, srcCloudId, dstCloudId)] || null;
}

/** Save all channels + DMs for a combination. */
function set(combination, srcCloudId, dstCloudId, { publicChannels = [], privateChannels = [], dms = [] } = {}) {
  const cache = read();
  cache[cacheKey(combination, srcCloudId, dstCloudId)] = {
    combination, srcCloudId, dstCloudId,
    publicChannels, privateChannels, dms,
    fetchedAt: new Date().toISOString(),
  };
  write(cache);
}

/** List all cached combination keys (for debug / status). */
function listKeys() {
  return Object.keys(read());
}

module.exports = { get, set, listKeys };