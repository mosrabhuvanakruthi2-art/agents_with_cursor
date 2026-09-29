const { MongoClient, ServerApiVersion } = require('mongodb');
const env = require('../config/env');

function mongoDbName() {
  const n = (env.MONGODB_DB_NAME || 'migration_qa').trim();
  return n || 'migration_qa';
}

/** @type {MongoClient | null} */
let client = null;

/**
 * Connects to MongoDB when MONGODB_URI is set. No-op otherwise.
 * @param {import('winston').Logger} log
 * @returns {Promise<MongoClient | null>}
 */
function buildMongoClientOptions() {
  /** @type {import('mongodb').MongoClientOptions} */
  const opts = {
    serverSelectionTimeoutMS: 20_000,
    connectTimeoutMS: 20_000,
    // Without this, an operation on an ALREADY-open socket that stalls mid-request (a flaky
    // network dropping packets after the handshake, not refusing the connection outright) has no
    // bound at all — the driver just waits. serverSelectionTimeoutMS/connectTimeoutMS only cover
    // establishing the connection, which is why `client.connect()` + the initial ping kept
    // succeeding fine while later operations (the executions hydration's find().toArray(), and
    // its per-item backfill writes) hung indefinitely. Measured live 2026-09-16: three consecutive
    // fresh server restarts each connected successfully within seconds and then hung for 4+
    // minutes with zero progress on `executionService.hydrateFromMongo()` — no error, no timeout,
    // just silence, because nothing was bounding that socket's read. Set to match the other two so
    // a stalled operation surfaces as a catchable error within a bounded time instead of hanging
    // the whole startup path — hydrateFromMongo already wraps its Mongo calls in try/catch and
    // logs+continues on failure, so this turns a silent hang into the graceful "hydrate failed"
    // warning path that already exists but could never be reached before.
    socketTimeoutMS: 20_000,
    serverApi: {
      version: ServerApiVersion.v1,
      strict: false,
      deprecationErrors: false,
    },
  };
  const fam = env.MONGODB_DNS_FAMILY;
  if (fam === '4' || fam === '6') {
    opts.family = parseInt(fam, 10);
  }
  if (env.MONGODB_TLS_INSECURE) {
    opts.tlsAllowInvalidCertificates = true;
    opts.tlsAllowInvalidHostnames = true;
  }
  return opts;
}

async function connectMongo(log) {
  const primary = env.MONGODB_URI;
  if (!primary) {
    log.info('MongoDB: MONGODB_URI not set — skipping');
    return null;
  }
  const fallback = env.MONGODB_URI_FALLBACK;
  const uris = [primary, fallback].filter(Boolean);
  const attemptLabels = ['MONGODB_URI', 'MONGODB_URI_FALLBACK'];
  /** @type {string[]} */
  const attemptErrors = [];
  try {
    for (let i = 0; i < uris.length; i += 1) {
      const uri = uris[i];
      try {
        client = new MongoClient(uri, buildMongoClientOptions());
        await client.connect();
        await client.db().admin().command({ ping: 1 });
        break;
      } catch (e) {
        const detail = e?.message || String(e);
        attemptErrors.push(`${attemptLabels[i] || `URI[${i}]`}: ${detail}`);
        log.debug(`MongoDB: ${attemptLabels[i] || `URI[${i}]`} failed — ${detail}`);
        if (uris.length > 1 && i < uris.length - 1) {
          log.info('MongoDB: trying fallback URI…');
        }
        try {
          if (client) await client.close();
        } catch {
          /* ignore */
        }
        client = null;
        if (i < uris.length - 1) continue;
        throw new Error(attemptErrors.join(' || '));
      }
    }
  } catch (e) {
    const msg = e?.message || String(e);
    const stack = e?.stack || '';
    const combined = `${msg} ${stack}`;
    if (/querySrv|ECONNREFUSED|ENOTFOUND|ETIMEOUT/i.test(msg)) {
      throw new Error(
        `${msg} — If this persists: copy the hostname letter-for-letter from Atlas → Connect (typos break SRV); ` +
          'try Atlas "standard connection string" (mongodb://… not mongodb+srv://) in MONGODB_URI; ' +
          'set PC DNS to 8.8.8.8; disable VPN; run ipconfig /flushdns. ' +
          'Test SRV: nslookup -type=SRV _mongodb._tcp.cluster0.YOURSUBDOMAIN.mongodb.net'
      );
    }
    if (/SSL|TLS|alert internal|0A000438|certificate/i.test(combined)) {
      throw new Error(
        `${msg} — MongoDB TLS failed. Try: (1) Atlas → Network Access → allow your current IP; ` +
          '(2) unset MONGODB_DNS_FAMILY in .env (we no longer force IPv4 by default — forcing only "4" can break TLS on some networks); ' +
          '(3) if behind SSL inspection, set MONGODB_TLS_INSECURE=true only in lab; ' +
          '(4) verify MONGODB_URI password is URL-encoded and the string is copied from Atlas → Connect.'
      );
    }
    throw e;
  }
  log.info('MongoDB: connected');
  return client;
}

function getMongoClient() {
  return client;
}

/** @returns {import('mongodb').Db | null} */
function getDb() {
  if (!client) return null;
  return client.db(mongoDbName());
}

/** Closes the client (e.g. after CLI scripts). Safe to call multiple times. */
async function closeMongo() {
  if (!client) return;
  try {
    await client.close();
  } finally {
    client = null;
  }
}

module.exports = {
  connectMongo,
  closeMongo,
  getMongoClient,
  getDb,
  mongoDbName,
};
