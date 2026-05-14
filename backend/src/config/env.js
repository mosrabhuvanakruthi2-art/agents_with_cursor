const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const requiredVars = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GRAPH_CLIENT_ID',
  'GRAPH_CLIENT_SECRET',
  'GRAPH_TENANT_ID',
];

function validateEnv() {
  const missing = requiredVars.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    console.warn(
      `[env] WARNING: Missing environment variables: ${missing.join(', ')}. Some features may not work.`
    );
  }
}

/** No trailing slash — paths like /mail/login join cleanly. */
function normalizeMigrationApiUrl(url) {
  const s = String(url ?? '')
    .trim()
    .replace(/\/+$/, '');
  return s || 'http://localhost:8080';
}

/**
 * Parse GOOGLE_ACCOUNTS from env.
 * Format: "email1=token1,email2=token2"
 * Returns a Map<email, refreshToken>
 */
function parseGoogleAccounts() {
  const accounts = new Map();
  const raw = process.env.GOOGLE_ACCOUNTS || '';
  if (!raw) return accounts;

  const pairs = raw.split(',');
  for (const pair of pairs) {
    const eqIndex = pair.indexOf('=');
    if (eqIndex === -1) continue;
    const email = pair.substring(0, eqIndex).trim().toLowerCase();
    const token = pair.substring(eqIndex + 1).trim();
    if (email && token) {
      accounts.set(email, token);
    }
  }

  console.log(`[env] Loaded ${accounts.size} Google account(s): ${Array.from(accounts.keys()).join(', ')}`);
  return accounts;
}

validateEnv();

/** Trim, strip wrapping quotes, remove accidental newlines (common .env paste issues). */
function cleanEnvValue(v) {
  let s = String(v ?? '').trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  return s.replace(/\r\n|\r|\n/g, '').trim();
}

const googleAccounts = parseGoogleAccounts();

const {
  pickCorrespondentEmail: pickCorrespondentFromMap,
  pickCcEmail: pickCcFromMap,
  pickBccEmail: pickBccFromMap,
  buildInboundSenderRotation,
} = require('../utils/googleAccountsPicker');

/** Extract the domain portion of an email address (lowercase). */
function domainOf(email) {
  const at = String(email || '').lastIndexOf('@');
  return at === -1 ? '' : String(email).slice(at + 1).toLowerCase();
}

/**
 * Return only those accounts that share the same domain as sourceEmail.
 * Works with both Map<email, *> and string[].
 * If no same-domain accounts exist after filtering, returns an empty collection
 * (callers fall back to FALLBACK_EXTERNAL_SENDERS / fallback logic).
 */
function filterAccountsByDomain(accounts, sourceEmail) {
  const srcDomain = domainOf(sourceEmail);
  if (!srcDomain) return accounts;
  if (accounts instanceof Map) {
    const filtered = new Map();
    for (const [k, v] of accounts) {
      if (domainOf(k) === srcDomain) filtered.set(k, v);
    }
    return filtered;
  }
  return accounts.filter((e) => domainOf(e) === srcDomain);
}

/** Convert an array of emails to a Map<email, true> for use with picker functions. */
function emailArrayToMap(emails) {
  return new Map(emails.map((e) => [e, true]));
}

/** Another GOOGLE_ACCOUNTS address for To: / attendees — same domain as source. */
function pickCorrespondentEmail(sourceEmail) {
  return pickCorrespondentFromMap(filterAccountsByDomain(googleAccounts, sourceEmail), sourceEmail);
}

/** Distinct Cc address from GOOGLE_ACCOUNTS — same domain as source. */
function pickCcEmail(sourceEmail, toEmail) {
  return pickCcFromMap(filterAccountsByDomain(googleAccounts, sourceEmail), sourceEmail, toEmail);
}

/** Distinct Bcc address from GOOGLE_ACCOUNTS — same domain, never source/to/cc. */
function pickBccEmail(sourceEmail, toEmail, ccEmail) {
  return pickBccFromMap(filterAccountsByDomain(googleAccounts, sourceEmail), sourceEmail, toEmail, ccEmail);
}

/**
 * Sorted GOOGLE_ACCOUNTS addresses (same domain, excluding source) to rotate as inbound senders.
 * Returns [] when no same-domain accounts are configured; callers fall back to a correspondent address.
 */
function buildGoogleInboundSenders(sourceEmail) {
  return buildInboundSenderRotation(filterAccountsByDomain(googleAccounts, sourceEmail), sourceEmail);
}

/** Same idea for Outlook — rotate inbound senders from the same domain as source. */
function buildOutlookInboundSenders(sourceEmail) {
  return buildInboundSenderRotation(filterAccountsByDomain(outlookAccounts, sourceEmail), sourceEmail);
}

/** Another OUTLOOK_ACCOUNTS address for To: — same domain as source. */
function pickOutlookCorrespondentEmail(sourceEmail) {
  return pickCorrespondentFromMap(emailArrayToMap(filterAccountsByDomain(outlookAccounts, sourceEmail)), sourceEmail);
}

/** Distinct Cc address from OUTLOOK_ACCOUNTS — same domain as source. */
function pickOutlookCcEmail(sourceEmail, toEmail) {
  return pickCcFromMap(emailArrayToMap(filterAccountsByDomain(outlookAccounts, sourceEmail)), sourceEmail, toEmail);
}

/** Distinct Bcc address from OUTLOOK_ACCOUNTS — same domain, never source/to/cc. */
function pickOutlookBccEmail(sourceEmail, toEmail, ccEmail) {
  return pickBccFromMap(emailArrayToMap(filterAccountsByDomain(outlookAccounts, sourceEmail)), sourceEmail, toEmail, ccEmail);
}

function parseOutlookAccounts() {
  const raw = process.env.OUTLOOK_ACCOUNTS || '';
  if (!raw) return [];
  const emails = raw.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  console.log(`[env] Loaded ${emails.length} Outlook account(s): ${emails.join(', ')}`);
  return emails;
}

/**
 * Parse USER_EMAIL_MAPPINGS from env.
 * Format: "source1@dom:dest1@dom,source2@dom:dest2@dom"
 * Returns [{sourceEmail, destinationEmail}]
 */
function parseUserEmailMappings() {
  const raw = process.env.USER_EMAIL_MAPPINGS || '';
  if (!raw) return [];
  const pairs = raw.split(',').map((s) => s.trim()).filter(Boolean).map((pair) => {
    const colonIdx = pair.lastIndexOf(':');
    if (colonIdx === -1) return null;
    return {
      sourceEmail: pair.substring(0, colonIdx).trim().toLowerCase(),
      destinationEmail: pair.substring(colonIdx + 1).trim().toLowerCase(),
    };
  }).filter((p) => p && p.sourceEmail && p.destinationEmail);
  if (pairs.length > 0) {
    console.log(`[env] Loaded ${pairs.length} USER_EMAIL_MAPPINGS pair(s)`);
  }
  return pairs;
}

const outlookAccounts = parseOutlookAccounts();
const userEmailMappings = parseUserEmailMappings();

module.exports = {
  PORT: process.env.PORT || 5000,
  /** Atlas SRV URI; optional — if unset, server skips MongoDB */
  MONGODB_URI: cleanEnvValue(process.env.MONGODB_URI || ''),
  /** Optional second URI (e.g. standard mongodb:// replica list) if primary fails — same DB user. */
  MONGODB_URI_FALLBACK: cleanEnvValue(process.env.MONGODB_URI_FALLBACK || ''),
  /** Database name for app data (Test Repository snapshot, etc.); default migration_qa */
  MONGODB_DB_NAME: (process.env.MONGODB_DB_NAME || 'migration_qa').trim() || 'migration_qa',
  /**
   * Optional DNS IP family for MongoClient: "4" = IPv4 only, "6" = IPv6 only.
   * Omit for driver default (recommended). Set to "4" only if you need the old SRV/Windows workaround.
   */
  MONGODB_DNS_FAMILY: (process.env.MONGODB_DNS_FAMILY || '').trim(),
  /**
   * Lab only: set true to allow invalid TLS certificates to MongoDB (corporate SSL inspection).
   * Do not use on untrusted networks.
   */
  MONGODB_TLS_INSECURE:
    String(process.env.MONGODB_TLS_INSECURE ?? '')
      .trim()
      .toLowerCase() === 'true' || process.env.MONGODB_TLS_INSECURE === '1',
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
  // Second Google tenant (storefuze.com)
  GOOGLE_CLIENT_ID_2: process.env.GOOGLE_CLIENT_ID_2,
  GOOGLE_CLIENT_SECRET_2: process.env.GOOGLE_CLIENT_SECRET_2,
  GOOGLE_TENANT_2_DOMAINS: (process.env.GOOGLE_TENANT_2_DOMAINS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean),
  /**
   * Known user emails for tenant 2 (storefuze.com). When set, GmailTestDataAgent uses these
   * directly as correspondent/cc/bcc/inbound-senders instead of calling Admin SDK listDomainUsers.
   * Format: comma-separated emails. Include admin + all users; the agent filters out the source.
   */
  GOOGLE_TENANT_2_KNOWN_USERS: (process.env.GOOGLE_TENANT_2_KNOWN_USERS || '').toLowerCase().split(',').map(s => s.trim()).filter(s => s.includes('@')),
  /** Absolute or relative-to-cwd path to the service account JSON key for tenant 2 (storefuze.com DWD). */
  GOOGLE_SERVICE_ACCOUNT_KEY_2: (() => {
    const raw = (process.env.GOOGLE_SERVICE_ACCOUNT_KEY_2 || '').trim();
    if (!raw) return '';
    if (path.isAbsolute(raw)) return raw;
    return path.resolve(__dirname, '../../', raw);
  })(),
  // Third Google tenant (migrationn.com)
  GOOGLE_CLIENT_ID_3: process.env.GOOGLE_CLIENT_ID_3,
  GOOGLE_CLIENT_SECRET_3: process.env.GOOGLE_CLIENT_SECRET_3,
  GOOGLE_TENANT_3_DOMAINS: (process.env.GOOGLE_TENANT_3_DOMAINS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean),
  /**
   * Known user emails for tenant 3 (migrationn.com). When set, GmailTestDataAgent uses these
   * directly as correspondent/cc/bcc/inbound-senders instead of calling Admin SDK listDomainUsers.
   * Format: comma-separated emails. Include admin + all users; the agent filters out the source.
   */
  GOOGLE_TENANT_3_KNOWN_USERS: (process.env.GOOGLE_TENANT_3_KNOWN_USERS || '').toLowerCase().split(',').map(s => s.trim()).filter(s => s.includes('@')),
  /** Absolute or relative-to-cwd path to the service account JSON key for tenant 3 (migrationn.com DWD). */
  GOOGLE_SERVICE_ACCOUNT_KEY_3: (() => {
    const raw = (process.env.GOOGLE_SERVICE_ACCOUNT_KEY_3 || '').trim();
    if (!raw) return '';
    if (path.isAbsolute(raw)) return raw;
    return path.resolve(__dirname, '../../', raw);
  })(),
  googleAccounts,
  pickCorrespondentEmail,
  pickCcEmail,
  pickBccEmail,
  buildGoogleInboundSenders,
  pickOutlookCorrespondentEmail,
  pickOutlookCcEmail,
  pickOutlookBccEmail,
  buildOutlookInboundSenders,
  outlookAccounts,
  userEmailMappings,
  GRAPH_CLIENT_ID: process.env.GRAPH_CLIENT_ID,
  GRAPH_CLIENT_SECRET: process.env.GRAPH_CLIENT_SECRET,
  GRAPH_TENANT_ID: process.env.GRAPH_TENANT_ID,
  // Second Microsoft tenant (filefuze.co)
  GRAPH_CLIENT_ID_2: process.env.GRAPH_CLIENT_ID_2,
  GRAPH_CLIENT_SECRET_2: process.env.GRAPH_CLIENT_SECRET_2,
  GRAPH_TENANT_ID_2: process.env.GRAPH_TENANT_ID_2,
  GRAPH_TENANT_2_DOMAINS: (process.env.GRAPH_TENANT_2_DOMAINS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean),
  MIGRATION_API_URL: normalizeMigrationApiUrl(process.env.MIGRATION_API_URL || 'http://localhost:8080'),
  /**
   * When true, HTTPS calls to MIGRATION_API_URL skip TLS certificate verification (self-signed / wrong hostname for IP).
   * Lab only — do not enable against untrusted networks.
   */
  MIGRATION_API_TLS_INSECURE:
    String(process.env.MIGRATION_API_TLS_INSECURE ?? '')
      .trim()
      .toLowerCase() === 'true' || process.env.MIGRATION_API_TLS_INSECURE === '1',
  MIGRATION_API_KEY: process.env.MIGRATION_API_KEY || '',
  /**
   * Optional JWT from Migration UI: DevTools → Network → initiate (or login) → Authorization.
   * Paste the token only or the full "Bearer …" value. When set, POST /mail/login is skipped.
   */
  MIGRATION_API_BEARER_TOKEN: cleanEnvValue(process.env.MIGRATION_API_BEARER_TOKEN || ''),
  /** Base64(userId:apiSecret) from Email Migration UI Network → Authorization (optional; overrides MIGRATION_API_KEY for Basic auth) */
  MIGRATION_API_BASIC_AUTH: (process.env.MIGRATION_API_BASIC_AUTH || '').trim(),
  /**
   * Path segment(s) for start-migration POST, relative to MIGRATION_API_URL (no leading slash).
   * Default: mail/move/initiate. Copy from DevTools → Network → initiate → Request URL if you get HTTP 405.
   */
  MIGRATION_API_INITIATE_PATH: (process.env.MIGRATION_API_INITIATE_PATH || 'mail/move/initiate')
    .trim()
    .replace(/^\/+/, '')
    .replace(/\/+$/, ''),
  CLOUDFUZE_OWNER_EMAIL: process.env.CLOUDFUZE_OWNER_EMAIL || '',
  /** Admin email for the source cloud in /mail/clouds (e.g. granger@cloudfuze.us). Falls back to domain-matching. */
  CLOUDFUZE_SOURCE_ADMIN_EMAIL: (process.env.CLOUDFUZE_SOURCE_ADMIN_EMAIL || '').trim().toLowerCase(),
  /** Admin email for the destination cloud in /mail/clouds (e.g. erik@filefuze.co). Falls back to domain-matching. */
  CLOUDFUZE_DEST_ADMIN_EMAIL: (process.env.CLOUDFUZE_DEST_ADMIN_EMAIL || '').trim().toLowerCase(),
  /** Direct cloud ID for source — bypasses GET /mail/clouds entirely. Get from DevTools → /mail/clouds response → id field. */
  CLOUDFUZE_SOURCE_CLOUD_ID: (process.env.CLOUDFUZE_SOURCE_CLOUD_ID || '').trim(),
  /** Direct cloud ID for destination — bypasses GET /mail/clouds entirely. */
  CLOUDFUZE_DEST_CLOUD_ID: (process.env.CLOUDFUZE_DEST_CLOUD_ID || '').trim(),
  /**
   * Direction-aware cloud IDs — preferred over SOURCE/DEST when set.
   * MigrationAgent picks source/dest automatically based on sourceProvider/destinationProvider,
   * so the same IDs work for both Gmail→Outlook AND Outlook→Gmail without any env change.
   */
  CLOUDFUZE_GMAIL_CLOUD_ID:   (process.env.CLOUDFUZE_GMAIL_CLOUD_ID   || '').trim(),
  CLOUDFUZE_OUTLOOK_CLOUD_ID: (process.env.CLOUDFUZE_OUTLOOK_CLOUD_ID || '').trim(),
  SCHEDULER_ENABLED: process.env.SCHEDULER_ENABLED === 'true',
  DEFAULT_SOURCE_EMAIL: process.env.DEFAULT_SOURCE_EMAIL || '',
  DEFAULT_DEST_EMAIL: process.env.DEFAULT_DEST_EMAIL || '',
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  /** Optional path to gmail-test-cases.xlsx (mail + draft matrix). Empty = backend/data/gmail-test-cases.xlsx */
  GMAIL_TEST_CASES_XLSX: (process.env.GMAIL_TEST_CASES_XLSX || '').trim(),

  /** Xray Server/DC + Jira: site base URL, no trailing slash */
  JIRA_BASE_URL: (process.env.JIRA_BASE_URL || '').trim().replace(/\/+$/, '').replace(/\/jira\/?$/i, ''),
  /** Basic auth user (Jira Server username or Jira Cloud email) */
  JIRA_USER: cleanEnvValue(process.env.JIRA_USER),
  JIRA_API_TOKEN: cleanEnvValue(process.env.JIRA_API_TOKEN),
  /** Default project key for Test Repository import when not passed in POST body */
  JIRA_PROJECT_KEY: (process.env.JIRA_PROJECT_KEY || '').trim(),
  /** Optional Xray folder path prefill (e.g. /Box For Business…/Selective Versions) for GET /api/test-repository/defaults */
  TEST_REPOSITORY_ROOT_PATH: (process.env.TEST_REPOSITORY_ROOT_PATH || '').trim(),
  /**
   * Extra Jira REST field ids/names for getExpandedTest jira(fields: [...]) — site-specific (e.g. customfield_10020 for Sprint).
   * Comma-separated, appended to the built-in list used when caching test details.
   */
  JIRA_TEST_DETAIL_JIRA_FIELDS: (process.env.JIRA_TEST_DETAIL_JIRA_FIELDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  /**
   * Optional: Xray step custom field id for the Jira "Test Steps" column (e.g. customfield_10042).
   * If unset, we pick the longest step custom field text or one whose id contains "Test Steps".
   */
  JIRA_XRAY_STEP_TEST_STEPS_CUSTOMFIELD_ID: (process.env.JIRA_XRAY_STEP_TEST_STEPS_CUSTOMFIELD_ID || '')
    .trim(),
  /**
   * During Xray Cloud import, call getExpandedTest per issue and store as test.cachedDetail for offline modal (default on).
   * Set to "false" for faster imports (modal then shows summary-only partial view).
   */
  TEST_REPOSITORY_IMPORT_EXPANDED:
    String(process.env.TEST_REPOSITORY_IMPORT_EXPANDED ?? 'true').trim().toLowerCase() !== 'false',

  /** Xray Cloud GraphQL (Jira Cloud). Create under Xray → Global Settings → API Keys */
  XRAY_CLIENT_ID: (process.env.XRAY_CLIENT_ID || '').trim(),
  XRAY_CLIENT_SECRET: (process.env.XRAY_CLIENT_SECRET || '').trim(),
  /** Optional override: default https://xray.cloud.getxray.app (use EU/US regional host if required) */
  XRAY_CLOUD_BASE_URL: (process.env.XRAY_CLOUD_BASE_URL || '').trim().replace(/\/+$/, ''),
  /**
   * Xray GraphQL axios timeout (ms) per request.
   * - 0 or "unlimited" = no Axios timeout (wait until Xray responds or connection drops — best for huge imports).
   * - Positive: clamped 60_000–86_400_000 (1 min–24 h). Default when unset: 0 (unlimited).
   */
  XRAY_GRAPHQL_TIMEOUT_MS: (() => {
    const raw = String(process.env.XRAY_GRAPHQL_TIMEOUT_MS ?? '').trim().toLowerCase();
    if (
      raw === '' ||
      raw === '0' ||
      raw === 'unlimited' ||
      raw === 'none' ||
      raw === 'infinite'
    ) {
      return 0;
    }
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(86_400_000, Math.max(60_000, n));
  })(),
  /**
   * When MONGODB_URI is set, GET /api/test-repository/data reads the snapshot from MongoDB only (sync target for the UI).
   * Set to "true" to fall back to backend/data/test-repository.json if Mongo has no document (local dev only).
   */
  TEST_REPOSITORY_FRONTEND_FALLBACK_TO_FILE:
    String(process.env.TEST_REPOSITORY_FRONTEND_FALLBACK_TO_FILE ?? '')
      .trim()
      .toLowerCase() === 'true',
  /**
   * When expanded steps are missing in Mongo + snapshot, call Xray getExpandedTest once and cache to test_expanded_details (default on).
   * Set to "false" for strictly offline modals: no live Xray, and no Jira REST key→issue id lookup for GET /test-detail
   * (issue id is taken from the saved snapshot row when the request is key-only).
   */
  TEST_REPOSITORY_TEST_DETAIL_LIVE_FALLBACK:
    String(process.env.TEST_REPOSITORY_TEST_DETAIL_LIVE_FALLBACK ?? 'false').trim().toLowerCase() === 'true',
  /** Number of tests per batched GraphQL request during backfill. Default 5 (Xray limit: 25 ops/request). */
  BACKFILL_BATCH_SIZE: Math.max(1, Math.min(20, parseInt(process.env.BACKFILL_BATCH_SIZE || '5', 10) || 5)),
  /** Minimum ms between batch requests during backfill to avoid 429 rate limits. Default 1500. */
  BACKFILL_DELAY_MS: Math.max(0, parseInt(process.env.BACKFILL_DELAY_MS || '1500', 10) || 1500),
  /** OpenAI API key — required for the Test Case Generator feature. */
  OPENAI_API_KEY: (process.env.OPENAI_API_KEY || '').trim(),
  /** Base URL for the bulk calendar API (no trailing slash). Default: http://localhost:8080 */
  BULK_CALENDAR_API_URL: (process.env.BULK_CALENDAR_API_URL || 'http://localhost:8080').trim().replace(/\/+$/, ''),
  /** Base URL for the create-mails-outlook Spring Boot service. Default: http://localhost:8080 */
  OUTLOOK_DATA_API_URL: (process.env.OUTLOOK_DATA_API_URL || 'http://localhost:8080').trim().replace(/\/+$/, ''),
};
