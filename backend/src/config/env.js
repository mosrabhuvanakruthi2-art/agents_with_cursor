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
} = require('../utils/googleAccountsPicker');

/** Another GOOGLE_ACCOUNTS address for To: / attendees (falls back to source if sole account). */
function pickCorrespondentEmail(sourceEmail) {
  return pickCorrespondentFromMap(googleAccounts, sourceEmail);
}

/** Distinct Cc address from GOOGLE_ACCOUNTS when possible. */
function pickCcEmail(sourceEmail, toEmail) {
  return pickCcFromMap(googleAccounts, sourceEmail, toEmail);
}

function parseOutlookAccounts() {
  const raw = process.env.OUTLOOK_ACCOUNTS || '';
  if (!raw) return [];
  const emails = raw.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  console.log(`[env] Loaded ${emails.length} Outlook account(s): ${emails.join(', ')}`);
  return emails;
}

const outlookAccounts = parseOutlookAccounts();

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
  // Third Google tenant (cloudfuze.com — Message Agent admins like mia@cloudfuze.com)
  GOOGLE_CLIENT_ID_3: process.env.GOOGLE_CLIENT_ID_3,
  GOOGLE_CLIENT_SECRET_3: process.env.GOOGLE_CLIENT_SECRET_3,
  GOOGLE_TENANT_3_DOMAINS: (process.env.GOOGLE_TENANT_3_DOMAINS || 'cloudfuze.com').toLowerCase().split(',').map(s => s.trim()).filter(Boolean),
  // Fourth Google tenant (filefuze.co — Message Agent admins like erik@filefuze.co)
  GOOGLE_CLIENT_ID_4: process.env.GOOGLE_CLIENT_ID_4,
  GOOGLE_CLIENT_SECRET_4: process.env.GOOGLE_CLIENT_SECRET_4,
  GOOGLE_TENANT_4_DOMAINS: (process.env.GOOGLE_TENANT_4_DOMAINS || 'filefuze.co').toLowerCase().split(',').map(s => s.trim()).filter(Boolean),
  googleAccounts,
  pickCorrespondentEmail,
  pickCcEmail,
  outlookAccounts,
  GRAPH_CLIENT_ID: process.env.GRAPH_CLIENT_ID,
  GRAPH_CLIENT_SECRET: process.env.GRAPH_CLIENT_SECRET,
  GRAPH_TENANT_ID: process.env.GRAPH_TENANT_ID,
  // Message Agent dedicated Microsoft app (Teams scopes — same tenant as GRAPH_TENANT_ID)
  MS_MESSAGE_CLIENT_ID: process.env.MS_MESSAGE_CLIENT_ID || '',
  MS_MESSAGE_CLIENT_SECRET: process.env.MS_MESSAGE_CLIENT_SECRET || '',
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
   * Paste the token only or the full "Bearer …" value. When set, POST /auth/user is skipped.
   */
  MIGRATION_API_BEARER_TOKEN: cleanEnvValue(process.env.MIGRATION_API_BEARER_TOKEN || ''),
  /**
   * Base64(userId:apiSecret) from Email/Chat Migration UI Network → Authorization header.
   * When set, /auth/user login is skipped — this value is used directly as the Basic auth credential.
   * Copy from DevTools → Network → any API request → Authorization header (paste only the part after "Basic ").
   */
  MIGRATION_API_BASIC_AUTH: (process.env.MIGRATION_API_BASIC_AUTH || '').trim(),
  /**
   * CloudFuze login credentials for automatic two-step login via POST /auth/user.
   * Used only when MIGRATION_API_BASIC_AUTH and MIGRATION_API_BEARER_TOKEN are not set.
   */
  MIGRATION_API_USERNAME: (process.env.MIGRATION_API_USERNAME || '').trim(),
  MIGRATION_API_PASSWORD: (process.env.MIGRATION_API_PASSWORD || '').trim(),
  /**
   * Path segment(s) for start-migration POST, relative to MIGRATION_API_URL (no leading slash).
   * Default: mail/move/initiate. Copy from DevTools → Network → initiate → Request URL if you get HTTP 405.
   */
  MIGRATION_API_INITIATE_PATH: (process.env.MIGRATION_API_INITIATE_PATH || 'mail/move/initiate')
    .trim()
    .replace(/^\/+/, '')
    .replace(/\/+$/, ''),
  CLOUDFUZE_OWNER_EMAIL: process.env.CLOUDFUZE_OWNER_EMAIL || '',
  /**
   * All CloudFuze login accounts for browser automation.
   * Primary account first; extras parsed from CF_EXTRA_ACCOUNTS (email:password,...).
   */
  CF_ACCOUNTS: (() => {
    const primary = (process.env.MIGRATION_API_USERNAME || '').trim();
    const primaryPwd = (process.env.MIGRATION_API_PASSWORD || '').trim();
    const accounts = primary ? [{ email: primary, password: primaryPwd }] : [];
    const extras = (process.env.CF_EXTRA_ACCOUNTS || '').trim();
    if (extras) {
      for (const pair of extras.split(',')) {
        const idx = pair.indexOf(':');
        if (idx === -1) continue;
        const email = pair.substring(0, idx).trim();
        const password = pair.substring(idx + 1).trim();
        if (email && password && !accounts.find(a => a.email === email)) {
          accounts.push({ email, password });
        }
      }
    }
    return accounts;
  })(),
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
    String(process.env.TEST_REPOSITORY_TEST_DETAIL_LIVE_FALLBACK ?? 'true').trim().toLowerCase() !== 'false',
  /** Number of tests per batched GraphQL request during backfill. Default 5 (Xray limit: 25 ops/request). */
  BACKFILL_BATCH_SIZE: Math.max(1, Math.min(20, parseInt(process.env.BACKFILL_BATCH_SIZE || '5', 10) || 5)),
  /** Minimum ms between batch requests during backfill to avoid 429 rate limits. Default 1500. */
  BACKFILL_DELAY_MS: Math.max(0, parseInt(process.env.BACKFILL_DELAY_MS || '1500', 10) || 1500),
  /** OpenAI API key — required for the Test Case Generator feature. */
  OPENAI_API_KEY: (process.env.OPENAI_API_KEY || '').trim(),
  /** Base URL for the bulk calendar API (no trailing slash). Default: http://localhost:8080 */
  BULK_CALENDAR_API_URL: (process.env.BULK_CALENDAR_API_URL || 'http://localhost:8080').trim().replace(/\/+$/, ''),

  /**
   * Optional override for the CloudFuze chat migration initiate path (no leading slash).
   * Default candidates tried in order: chat/move/initiate, chat/initiate, message/move/initiate, message/initiate.
   * Copy from DevTools → Network → chat initiate → Request URL if you get HTTP 405.
   */
  CHAT_MIGRATION_API_INITIATE_PATH: (process.env.CHAT_MIGRATION_API_INITIATE_PATH || '').trim().replace(/^\/+/, '').replace(/\/+$/, ''),

  /** Slack OAuth (Message Agent) — create an app at https://api.slack.com/apps → OAuth & Permissions */
  SLACK_CLIENT_ID: cleanEnvValue(process.env.SLACK_CLIENT_ID || ''),
  SLACK_CLIENT_SECRET: cleanEnvValue(process.env.SLACK_CLIENT_SECRET || ''),
  /**
   * Optional: full redirect URL registered in Slack (must match oauth.v2.authorize exactly).
   * Default: http://localhost:{PORT}/api/auth/slack/callback
   */
  SLACK_REDIRECT_URI: cleanEnvValue(process.env.SLACK_REDIRECT_URI || ''),
  /**
   * Pre-issued Slack user token (xoxp-…).  When set, the backend auto-installs it
   * into the token store on startup — no OAuth popup required.
   */
  SLACK_USER_TOKEN: cleanEnvValue(process.env.SLACK_USER_TOKEN || ''),
};
