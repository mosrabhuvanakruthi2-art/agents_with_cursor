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
 *   }
 * }
 */
const fs = require('fs');
const path = require('path');

const TOKEN_FILE = path.join(__dirname, '../../data/oauth-tokens.json');
const COLLECTION = 'connected_accounts';

// ─── JSON helpers ─────────────────────────────────────────────────────────────

function read() {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return migrateIfNeeded({});
    const raw = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (!raw) return migrateIfNeeded({});
    const data = JSON.parse(raw);
    return migrateIfNeeded(data);
  } catch {
    return migrateIfNeeded({});
  }
}

/** Migrate old single-microsoft shape { microsoft: { email, accessToken, … } } to new accounts map. */
function migrateIfNeeded(data) {
  if (data.microsoft && !data.microsoft.accounts && data.microsoft.email) {
    const { email, ...rest } = data.microsoft;
    data.microsoft = { accounts: { [email.toLowerCase()]: { ...rest, connectedAt: rest.connectedAt || new Date().toISOString() } } };
  }
  if (!data.google) data.google = { accounts: {} };
  if (!data.google.accounts) data.google.accounts = {};
  if (!data.microsoft) data.microsoft = { accounts: {} };
  if (!data.microsoft.accounts) data.microsoft.accounts = {};
  if (!data.box) data.box = { accounts: {} };
  if (!data.box.accounts) data.box.accounts = {};
  if (!data.sharepoint) data.sharepoint = { accounts: {} };
  if (!data.sharepoint.accounts) data.sharepoint.accounts = {};
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
        if (rest.isDwd) {
          data.google.accounts[email.toLowerCase()] = { isDwd: true, connectedAt: rest.connectedAt };
        } else {
          data.google.accounts[email.toLowerCase()] = { refreshToken: rest.refreshToken, connectedAt: rest.connectedAt };
        }
        loaded++;
      } else if (provider === 'microsoft') {
        // Preserve ALL stored fields — notably `tenantId` and `consented`, which the
        // tenant resolver (getMicrosoftTenantMap) needs to route a mailbox to the right
        // Azure tenant. Dropping tenantId here makes cross-tenant accounts resolve to the
        // default tenant after every restart.
        data.microsoft.accounts[email.toLowerCase()] = { ...rest };
        loaded++;
      } else if (provider === 'box') {
        data.box.accounts[email.toLowerCase()] = {
          accessToken: rest.accessToken, refreshToken: rest.refreshToken,
          expiresAt: rest.expiresAt, connectedAt: rest.connectedAt,
        };
        loaded++;
      } else if (provider === 'sharepoint') {
        data.sharepoint.accounts[email.toLowerCase()] = {
          accessToken: rest.accessToken, refreshToken: rest.refreshToken,
          expiresAt: rest.expiresAt, connectedAt: rest.connectedAt,
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

function setGoogleToken(email, refreshToken) {
  const data = read();
  const key = email.toLowerCase();
  const entry = { refreshToken, connectedAt: data.google.accounts[key]?.connectedAt || new Date().toISOString() };
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

function setDwdAccount(email) {
  const data = read();
  const key = email.toLowerCase();
  const entry = { isDwd: true, connectedAt: data.google.accounts[key]?.connectedAt || new Date().toISOString() };
  data.google.accounts[key] = entry;
  write(data);
  syncToMongo('google', key, { isDwd: true, connectedAt: entry.connectedAt });
}

function getGoogleStatus() {
  const data = read();
  const emails = Object.keys(data.google.accounts);
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
  const { email, ...rest } = tokenData;
  if (!email) return;
  const data = read();
  const key = email.toLowerCase();
  const existing = data.microsoft.accounts[key];
  const entry = { ...rest, connectedAt: existing?.connectedAt || new Date().toISOString() };
  data.microsoft.accounts[key] = entry;
  write(data);
  syncToMongo('microsoft', key, { email: key, ...entry });
}

/**
 * Register a Microsoft account that was granted via tenant ADMIN CONSENT (app-only).
 * No user token is stored — operations use app-only tokens; this just records the
 * connected admin/tenant for the UI account list.
 */
function setMicrosoftConsent(email, tenantId) {
  const data = read();
  const key = email.toLowerCase();
  const existing = data.microsoft.accounts[key];
  const entry = {
    consented: true,
    tenantId: tenantId || existing?.tenantId,
    connectedAt: existing?.connectedAt || new Date().toISOString(),
  };
  data.microsoft.accounts[key] = entry;
  write(data);
  syncToMongo('microsoft', key, { email: key, ...entry });
}

/**
 * Map of email-domain → tenant id, built from consented Microsoft accounts that
 * recorded their tenant. Lets the app resolve which Azure tenant a mailbox lives in
 * for any customer added via admin consent — no static .env mapping needed.
 */
function getMicrosoftTenantMap() {
  const data = read();
  const map = {};
  for (const [email, entry] of Object.entries(data.microsoft.accounts)) {
    if (!entry.tenantId) continue;
    const domain = email.split('@')[1]?.toLowerCase();
    if (domain) map[domain] = entry.tenantId;
  }
  return map;
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

function getMicrosoftStatus() {
  const data = read();
  const emails = Object.keys(data.microsoft.accounts);
  return {
    connected: emails.length > 0,
    emails,
    email: emails[0] || null, // backward-compat primary
    count: emails.length,
  };
}

// ─── Box ─────────────────────────────────────────────────────────────────────

function getBoxToken(email) {
  const data = read();
  return data.box.accounts[email.toLowerCase()] || null;
}

function setBoxToken({ email, accessToken, refreshToken, expiresAt }) {
  const data = read();
  const key = email.toLowerCase();
  const existing = data.box.accounts[key];
  const entry = { accessToken, refreshToken, expiresAt, connectedAt: existing?.connectedAt || new Date().toISOString() };
  data.box.accounts[key] = entry;
  write(data);
  syncToMongo('box', key, { email: key, ...entry });
}

function removeBoxToken(email) {
  const data = read();
  const key = email.toLowerCase();
  delete data.box.accounts[key];
  write(data);
  removeFromMongo('box', key);
}

function getBoxStatus() {
  const data = read();
  const emails = Object.keys(data.box.accounts);
  return { connected: emails.length > 0, emails, email: emails[0] || null, count: emails.length };
}

// ─── SharePoint Online ────────────────────────────────────────────────────────

function getSharePointToken(email) {
  const data = read();
  return data.sharepoint.accounts[email.toLowerCase()] || null;
}

function setSharePointToken({ email, accessToken, refreshToken, expiresAt }) {
  const data = read();
  const key = email.toLowerCase();
  const existing = data.sharepoint.accounts[key];
  const entry = { accessToken, refreshToken, expiresAt, connectedAt: existing?.connectedAt || new Date().toISOString() };
  data.sharepoint.accounts[key] = entry;
  write(data);
  syncToMongo('sharepoint', key, { email: key, ...entry });
}

function removeSharePointToken(email) {
  const data = read();
  const key = email.toLowerCase();
  delete data.sharepoint.accounts[key];
  write(data);
  removeFromMongo('sharepoint', key);
}

function getSharePointStatus() {
  const data = read();
  const emails = Object.keys(data.sharepoint.accounts);
  return { connected: emails.length > 0, emails, email: emails[0] || null, count: emails.length };
}

// ─── All accounts ─────────────────────────────────────────────────────────────

/** Return all connected accounts across all providers, sorted by connectedAt desc. */
function getAllConnectedAccounts() {
  const data = read();
  const accounts = [];
  for (const [email, entry] of Object.entries(data.google.accounts)) {
    accounts.push({ provider: 'google', email, connectedAt: entry.connectedAt, isDwd: !!entry.isDwd });
  }
  for (const [email, entry] of Object.entries(data.microsoft.accounts)) {
    accounts.push({ provider: 'microsoft', email, connectedAt: entry.connectedAt });
  }
  for (const [email, entry] of Object.entries(data.box.accounts)) {
    accounts.push({ provider: 'box', email, connectedAt: entry.connectedAt });
  }
  for (const [email, entry] of Object.entries(data.sharepoint.accounts)) {
    accounts.push({ provider: 'sharepoint', email, connectedAt: entry.connectedAt });
  }
  return accounts.sort((a, b) => (b.connectedAt || '').localeCompare(a.connectedAt || ''));
}

module.exports = {
  loadFromMongo,
  // Google
  getGoogleToken,
  setGoogleToken,
  removeGoogleToken,
  setDwdAccount,
  getGoogleStatus,
  getGoogleAccountsMap,
  // Microsoft
  getMicrosoftToken,
  setMicrosoftToken,
  setMicrosoftConsent,
  getMicrosoftTenantMap,
  removeMicrosoftToken,
  getMicrosoftStatus,
  // Box
  getBoxToken,
  setBoxToken,
  removeBoxToken,
  getBoxStatus,
  // SharePoint
  getSharePointToken,
  setSharePointToken,
  removeSharePointToken,
  getSharePointStatus,
  // Combined
  getAllConnectedAccounts,
};
