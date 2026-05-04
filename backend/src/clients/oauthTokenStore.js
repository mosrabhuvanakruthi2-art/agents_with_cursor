/**
 * Persistent OAuth token store.
 *
 * Primary storage: backend/data/oauth-tokens.json  (always written, works offline)
 * Secondary storage: MongoDB `connected_accounts` collection (synced when available)
 *
 * JSON structure:
 * {
 *   "google": {
 *     "accounts": { "email": { "refreshToken": "...", "connectedAt": "..." } }
 *   },
 *   "microsoft": {
 *     "accounts": { "email": { "accessToken":"...", "refreshToken":"...", "expiresAt":0, "connectedAt":"..." } }
 *   },
 *   "slack": {
 *     "accounts": { "email": { "userAccessToken":"...", "userId":"...", "teamId":"...", "teamName":"...", "connectedAt":"..." } }
 *   }
 * }
 */
const fs = require('fs');
const path = require('path');

const TOKEN_FILE = path.join(__dirname, '../../data/oauth-tokens.json');
const COLLECTION = 'connected_accounts';

/**
 * Resolve which agent an account "belongs" to ('mail' | 'message' | 'both').
 *
 * Order of precedence:
 *   1. Explicit `entry.agent` field set when the account was written.
 *   2. Provider/domain heuristic for accounts stored before tagging existed.
 *      - Slack → always 'message' (Slack is only used by the Message Agent).
 *      - Google → 'message' when the email's domain is listed under
 *        GOOGLE_TENANT_3_DOMAINS or GOOGLE_TENANT_4_DOMAINS (the
 *        Message-Agent tenants).
 *      - Everything else defaults to 'mail'.
 */
function resolveAccountAgent(entry, provider, email) {
  if (entry && entry.agent === 'both') return 'both';
  if (entry && (entry.agent === 'mail' || entry.agent === 'message')) return entry.agent;
  try {
    if (provider === 'slack') return 'message';
    if (provider === 'google') {
      const domain = String(email || '').split('@')[1]?.toLowerCase() || '';
      const env = require('../config/env');
      const t3 = env.GOOGLE_TENANT_3_DOMAINS || [];
      const t4 = env.GOOGLE_TENANT_4_DOMAINS || [];
      if (domain && (t3.includes(domain) || t4.includes(domain))) return 'message';
    }
  } catch { /* ignore */ }
  return 'mail';
}

/** True if an account tagged `accountAgent` should surface under the `filter` view. */
function agentMatches(accountAgent, filter) {
  if (!filter) return true;            // no filter = show everything (legacy)
  if (accountAgent === 'both') return true;
  return accountAgent === filter;
}

/** When an account is re-connected by the other agent, promote it to 'both'. */
function mergeAgent(existingEntry, provider, email, newAgent) {
  const current = existingEntry ? resolveAccountAgent(existingEntry, provider, email) : null;
  if (!newAgent) return current || 'mail';
  if (!current || current === newAgent) return newAgent;
  return 'both';
}

// ─── JSON helpers ─────────────────────────────────────────────────────────────

function read() {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return {};
    const raw = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (!raw) return {};
    const data = JSON.parse(raw);
    return migrateIfNeeded(data);
  } catch {
    return {};
  }
}

/** Migrate old single-microsoft shape { microsoft: { email, accessToken, … } } to new accounts map. */
function migrateIfNeeded(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    data = {};
  }
  if (data.microsoft && !data.microsoft.accounts && data.microsoft.email) {
    const { email, ...rest } = data.microsoft;
    data.microsoft = { accounts: { [email.toLowerCase()]: { ...rest, connectedAt: rest.connectedAt || new Date().toISOString() } } };
  }
  if (!data.google) data.google = { accounts: {} };
  if (!data.google.accounts) data.google.accounts = {};
  if (!data.microsoft) data.microsoft = { accounts: {} };
  if (!data.microsoft.accounts) data.microsoft.accounts = {};
  if (!data.slack) data.slack = { accounts: {} };
  if (!data.slack.accounts) data.slack.accounts = {};
  return data;
}

function write(data) {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2));
}

// ─── MongoDB helpers ──────────────────────────────────────────────────────────

function getCollection() {
  try {
    const { getDb } = require('../db/mongo');
    const db = getDb();
    return db ? db.collection(COLLECTION) : null;
  } catch {
    return null;
  }
}

/** Fire-and-forget upsert one account document to MongoDB. */
function syncToMongo(provider, email, accountData) {
  const col = getCollection();
  if (!col) return;
  const doc = { _id: `${provider}:${email}`, provider, email, ...accountData };
  col.replaceOne({ _id: doc._id }, doc, { upsert: true }).catch((err) => {
    try { require('../utils/logger').warn(`[oauthStore] Mongo write failed: ${err.message}`); } catch {}
  });
}

/** Fire-and-forget delete one account from MongoDB. */
function removeFromMongo(provider, email) {
  const col = getCollection();
  if (!col) return;
  col.deleteOne({ _id: `${provider}:${email}` }).catch(() => {});
}

/**
 * Load all accounts from MongoDB into the JSON file on startup.
 * No-op if MongoDB is not connected or collection is empty.
 */
async function loadFromMongo() {
  const col = getCollection();
  if (!col) return;
  try {
    const docs = await col.find({}).toArray();
    if (docs.length === 0) return;
    const data = read();
    let loaded = 0;
    for (const doc of docs) {
      const { _id, provider, email, ...rest } = doc;
      if (!provider || !email) continue;
      if (provider === 'google') {
        data.google.accounts[email.toLowerCase()] = {
          refreshToken: rest.refreshToken,
          connectedAt: rest.connectedAt,
          ...(rest.agent ? { agent: rest.agent } : {}),
        };
        loaded++;
      } else if (provider === 'microsoft') {
        data.microsoft.accounts[email.toLowerCase()] = {
          accessToken: rest.accessToken, refreshToken: rest.refreshToken,
          expiresAt: rest.expiresAt, connectedAt: rest.connectedAt,
          ...(rest.agent ? { agent: rest.agent } : {}),
        };
        loaded++;
      } else if (provider === 'slack') {
        data.slack.accounts[email.toLowerCase()] = {
          userAccessToken: rest.userAccessToken,
          userId: rest.userId,
          teamId: rest.teamId,
          teamName: rest.teamName,
          scope: rest.scope,
          connectedAt: rest.connectedAt,
          ...(rest.agent ? { agent: rest.agent } : {}),
        };
        loaded++;
      }
    }
    if (loaded > 0) {
      write(data);
      try { require('../utils/logger').info(`[oauthStore] Loaded ${loaded} account(s) from MongoDB`); } catch {}
    }
  } catch (err) {
    try { require('../utils/logger').warn(`[oauthStore] MongoDB load failed: ${err.message}`); } catch {}
  }
}

// ─── Google ───────────────────────────────────────────────────────────────────

function getGoogleToken(email) {
  const data = read();
  return data.google.accounts[email.toLowerCase()] || null;
}

function setGoogleToken(email, refreshToken, agent) {
  const data = read();
  const key = email.toLowerCase();
  const existing = data.google.accounts[key];
  const nextAgent = mergeAgent(existing, 'google', key, agent);
  const entry = {
    refreshToken,
    connectedAt: existing?.connectedAt || new Date().toISOString(),
    agent: nextAgent,
  };
  data.google.accounts[key] = entry;
  write(data);
  syncToMongo('google', key, entry);
}

function removeGoogleToken(email) {
  const data = read();
  const key = email.toLowerCase();
  delete data.google.accounts[key];
  write(data);
  removeFromMongo('google', key);
}

function getGoogleStatus(filter) {
  const data = read();
  const emails = Object.entries(data.google.accounts)
    .filter(([email, entry]) => agentMatches(resolveAccountAgent(entry, 'google', email), filter))
    .map(([email]) => email);
  return { connected: emails.length > 0, emails, count: emails.length };
}

/** All stored Google tokens as Map<email, refreshToken>. */
function getGoogleAccountsMap() {
  const data = read();
  const map = new Map();
  for (const [email, entry] of Object.entries(data.google.accounts)) {
    if (entry.refreshToken) map.set(email, entry.refreshToken);
  }
  return map;
}

// ─── Microsoft ────────────────────────────────────────────────────────────────

/** Return stored token object for a specific email, or the first account if no email given. */
function getMicrosoftToken(email) {
  const data = read();
  const accounts = data.microsoft.accounts;
  if (email) return accounts[email.toLowerCase()] ? { email, ...accounts[email.toLowerCase()] } : null;
  const entries = Object.entries(accounts);
  if (entries.length === 0) return null;
  const [firstEmail, firstData] = entries[0];
  return { email: firstEmail, ...firstData };
}

function setMicrosoftToken(tokenData) {
  const { email, agent, ...rest } = tokenData;
  if (!email) return;
  const data = read();
  const key = email.toLowerCase();
  const existing = data.microsoft.accounts[key];
  const nextAgent = mergeAgent(existing, 'microsoft', key, agent);
  const entry = {
    ...rest,
    connectedAt: existing?.connectedAt || new Date().toISOString(),
    agent: nextAgent,
  };
  data.microsoft.accounts[key] = entry;
  write(data);
  syncToMongo('microsoft', key, { email: key, ...entry });
}

function removeMicrosoftToken(email) {
  const data = read();
  if (email) {
    const key = email.toLowerCase();
    delete data.microsoft.accounts[key];
    removeFromMongo('microsoft', key);
  } else {
    // Remove all Microsoft accounts
    for (const key of Object.keys(data.microsoft.accounts)) {
      removeFromMongo('microsoft', key);
    }
    data.microsoft.accounts = {};
  }
  write(data);
}

function getMicrosoftStatus(filter) {
  const data = read();
  const emails = Object.entries(data.microsoft.accounts)
    .filter(([email, entry]) => agentMatches(resolveAccountAgent(entry, 'microsoft', email), filter))
    .map(([email]) => email);
  return {
    connected: emails.length > 0,
    emails,
    email: emails[0] || null, // backward-compat primary
    count: emails.length,
  };
}

// ─── Slack (user token — workspace install) ───────────────────────────────────

function getSlackToken(email) {
  const data = read();
  if (!email) return null;
  return data.slack.accounts[email.toLowerCase()] || null;
}

function setSlackToken({ email, userAccessToken, userId, teamId, teamName, scope, agent }) {
  if (!email || !userAccessToken) return;
  const data = read();
  const key = email.toLowerCase();
  const existing = data.slack.accounts[key];
  const nextAgent = mergeAgent(existing, 'slack', key, agent);
  const entry = {
    userAccessToken,
    userId,
    teamId,
    teamName: teamName || '',
    scope: scope || '',
    connectedAt: existing?.connectedAt || new Date().toISOString(),
    agent: nextAgent,
  };
  data.slack.accounts[key] = entry;
  write(data);
  syncToMongo('slack', key, { email: key, ...entry });
}

function removeSlackToken(email) {
  if (!email) return;
  const data = read();
  const key = email.toLowerCase();
  delete data.slack.accounts[key];
  write(data);
  removeFromMongo('slack', key);
}

function getSlackStatus(filter) {
  const data = read();
  const emails = Object.entries(data.slack?.accounts || {})
    .filter(([email, entry]) => agentMatches(resolveAccountAgent(entry, 'slack', email), filter))
    .map(([email]) => email);
  return { connected: emails.length > 0, emails, count: emails.length };
}

// ─── All accounts ─────────────────────────────────────────────────────────────

/**
 * Return all connected accounts across both providers, sorted by connectedAt desc.
 *
 * @param {Object} [opts]
 * @param {'mail'|'message'} [opts.agent] - when set, filter to accounts that
 *        belong to the given agent (matches 'both' too, and infers legacy
 *        untagged entries via provider/domain heuristic).
 */
function getAllConnectedAccounts(opts) {
  const filter = opts && (opts.agent === 'mail' || opts.agent === 'message') ? opts.agent : null;
  const data = read();
  const accounts = [];
  const gAcc = data.google?.accounts;
  const mAcc = data.microsoft?.accounts;
  const sAcc = data.slack?.accounts;
  if (gAcc && typeof gAcc === 'object') {
    for (const [email, entry] of Object.entries(gAcc)) {
      if (!agentMatches(resolveAccountAgent(entry, 'google', email), filter)) continue;
      accounts.push({ provider: 'google', email, connectedAt: entry?.connectedAt });
    }
  }
  if (mAcc && typeof mAcc === 'object') {
    for (const [email, entry] of Object.entries(mAcc)) {
      if (!agentMatches(resolveAccountAgent(entry, 'microsoft', email), filter)) continue;
      accounts.push({ provider: 'microsoft', email, connectedAt: entry?.connectedAt });
    }
  }
  if (sAcc && typeof sAcc === 'object') {
    for (const [email, entry] of Object.entries(sAcc)) {
      if (!agentMatches(resolveAccountAgent(entry, 'slack', email), filter)) continue;
      accounts.push({
        provider: 'slack',
        email,
        connectedAt: entry?.connectedAt,
        teamId: entry?.teamId,
        teamName: entry?.teamName,
      });
    }
  }
  return accounts.sort((a, b) => (b.connectedAt || '').localeCompare(a.connectedAt || ''));
}

module.exports = {
  loadFromMongo,
  // Google
  getGoogleToken,
  setGoogleToken,
  removeGoogleToken,
  getGoogleStatus,
  getGoogleAccountsMap,
  // Microsoft
  getMicrosoftToken,
  setMicrosoftToken,
  removeMicrosoftToken,
  getMicrosoftStatus,
  // Combined
  getAllConnectedAccounts,
  // Slack
  getSlackToken,
  setSlackToken,
  removeSlackToken,
  getSlackStatus,
};
