const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

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
  /**
   * Single shared service account key (Domain-Wide Delegation) used for ALL Google
   * domains that don't have a tenant-specific key above. Authorize this one service
   * account's client ID + scopes in each Workspace domain's Admin Console, then set
   * this path and you can drop GOOGLE_SERVICE_ACCOUNT_KEY_2/_3 and the OAuth client IDs.
   */
  GOOGLE_SERVICE_ACCOUNT_KEY: (() => {
    const raw = (process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '').trim();
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
  /** Plaintext password for POST /app/login — agent sends this directly (server does MD5 hashing) */
  MIGRATION_APP_LOGIN_PASSWORD: (process.env.MIGRATION_APP_LOGIN_PASSWORD || '').trim(),
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
  CLOUDFUZE_GMAIL_CLOUD_ID:        (process.env.CLOUDFUZE_GMAIL_CLOUD_ID        || '').trim(),
  CLOUDFUZE_GMAIL_SOURCE_CLOUD_ID: (process.env.CLOUDFUZE_GMAIL_SOURCE_CLOUD_ID || '').trim(),
  CLOUDFUZE_GMAIL_DEST_CLOUD_ID:   (process.env.CLOUDFUZE_GMAIL_DEST_CLOUD_ID   || '').trim(),
  CLOUDFUZE_OUTLOOK_CLOUD_ID:           (process.env.CLOUDFUZE_OUTLOOK_CLOUD_ID           || '').trim(),
  CLOUDFUZE_DEVEMAIL_OUTLOOK_CLOUD_ID:  (process.env.CLOUDFUZE_DEVEMAIL_OUTLOOK_CLOUD_ID  || '').trim(),
  CLOUDFUZE_DEVEMAIL_GMAIL_CLOUD_ID:    (process.env.CLOUDFUZE_DEVEMAIL_GMAIL_CLOUD_ID    || '').trim(),
  SCHEDULER_ENABLED: process.env.SCHEDULER_ENABLED === 'true',
  DEFAULT_SOURCE_EMAIL: process.env.DEFAULT_SOURCE_EMAIL || '',
  DEFAULT_DEST_EMAIL: process.env.DEFAULT_DEST_EMAIL || '',
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  /** Optional path to gmail-test-cases.xlsx (mail + draft matrix). Empty = backend/data/gmail-test-cases.xlsx */
  GMAIL_TEST_CASES_XLSX: (process.env.GMAIL_TEST_CASES_XLSX || '').trim(),
  /**
   * Max UNREAD emails to leave in the Outlook Inbox after seeding. The test data creates
   * many unread messages; after seeding, the excess (oldest) are marked read so the Inbox
   * looks realistic while retaining enough unread mail to validate read-state. Default 12.
   */
  OUTLOOK_INBOX_MAX_UNREAD: (() => {
    const n = parseInt(process.env.OUTLOOK_INBOX_MAX_UNREAD ?? '', 10);
    return Number.isFinite(n) && n >= 0 ? n : 12;
  })(),
  /**
   * Address of a PRE-PROVISIONED Microsoft 365 shared mailbox (created once in the Admin Center;
   * Graph cannot create shared mailboxes). When set, the Outlook test-data agent seeds real content
   * INTO this shared mailbox via Graph app-only and uses it as the real sender for the shared-mailbox
   * test case. When empty, the agent falls back to a From-header simulation (no real shared mailbox).
   */
  SHARED_MAILBOX_ADDRESS: (process.env.SHARED_MAILBOX_ADDRESS || '').trim().toLowerCase(),

  /**
   * Address of a PRE-CREATED mail-enabled distribution list on the SOURCE user's domain
   * (created once in the Admin Center — Graph/our app cannot set a group's SMTP domain, it always
   * lands on the tenant default). When set, the Outlook test-data agent uses THIS address for the
   * distribution-list test case instead of creating a new group. When empty, it falls back to
   * creating a Graph group (which gets the tenant default domain).
   */
  DISTRIBUTION_LIST_ADDRESS: (process.env.DISTRIBUTION_LIST_ADDRESS || '').trim().toLowerCase(),

  /**
   * Path to a saved Playwright storageState JSON that carries an authenticated devemail portal
   * session (the portal uses Google/Office365 SSO, so headless password login doesn't work). When
   * set, the Workspace-ID reports scraper reuses this session instead of logging in. Capture it once
   * with: node scripts/capture-devemail-session.js
   */
  DEVEMAIL_STORAGE_STATE: (process.env.DEVEMAIL_STORAGE_STATE || '').trim(),

  /** Xray Server/DC + Jira: site base URL, no trailing slash */
  JIRA_BASE_URL: (process.env.JIRA_BASE_URL || '').trim().replace(/\/+$/, '').replace(/\/jira\/?$/i, ''),
  /** Basic auth user (Jira Server username or Jira Cloud email) */
  JIRA_USER: cleanEnvValue(process.env.JIRA_USER),
  JIRA_API_TOKEN: cleanEnvValue(process.env.JIRA_API_TOKEN),
  /** Default project key for Test Repository import when not passed in POST body */
  JIRA_PROJECT_KEY: (process.env.JIRA_PROJECT_KEY || '').trim(),
  /** Jira issue type used when auto-raising migration QA bugs (default: Bug) */
  JIRA_BUG_ISSUE_TYPE: (process.env.JIRA_BUG_ISSUE_TYPE || 'Bug').trim(),
  /** Jira accountId to set as reporter on auto-raised bugs (find via GET /rest/api/3/myself or /rest/api/3/user/search?query=email) */
  JIRA_REPORTER_ACCOUNT_ID: (process.env.JIRA_REPORTER_ACCOUNT_ID || '').trim(),
  /** Neutara Ticketing — new bug tracker replacing Jira for QA bug creation */
  NEUTARA_BASE_URL: (process.env.NEUTARA_BASE_URL || 'https://neutaraticketing.cftools.live').trim(),
  NEUTARA_API_KEY:  (process.env.NEUTARA_API_KEY  || '').trim(),
  NEUTARA_SPACE:    (process.env.NEUTARA_SPACE     || 'QT').trim(),
  NEUTARA_REPORTER_EMAIL: (process.env.NEUTARA_REPORTER_EMAIL || 'qaagent@cloudfuze.com').trim(),
  NEUTARA_ATTACH_PDF: (process.env.NEUTARA_ATTACH_PDF || 'true').trim(),
  NEUTARA_ATTACH_MODE: (process.env.NEUTARA_ATTACH_MODE || 'embed').trim(),
  // Interval (ms) between creating sibling sub-folders / nested labels at the source, so each gets a
  // distinct, increasing creation timestamp and the destination preserves folder order (matches manual
  // creation with natural gaps). Default 30s per QA. Set 0 to disable (faster seed, order may not hold).
  FOLDER_CREATE_INTERVAL_MS: Number(process.env.FOLDER_CREATE_INTERVAL_MS || 30000),
  /** Grafana base URL for log queries (default: http://logwatch.cloudfuze.com) */
  GRAFANA_BASE_URL: (process.env.GRAFANA_BASE_URL || 'http://logwatch.cloudfuze.com').trim(),
  /** Grafana Service Account Bearer token for programmatic API access */
  GRAFANA_TOKEN: (process.env.GRAFANA_TOKEN || '').trim(),
  /** Grafana basic auth (alternative to token) */
  GRAFANA_USER: (process.env.GRAFANA_USER || '').trim(),
  GRAFANA_PASSWORD: (process.env.GRAFANA_PASSWORD || '').trim(),
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
  /** Box OAuth 2.0 app credentials (Standard OAuth 2.0 app from Box Developer Console) */
  BOX_CLIENT_ID: (process.env.BOX_CLIENT_ID || '').trim(),
  BOX_CLIENT_SECRET: (process.env.BOX_CLIENT_SECRET || '').trim(),
  /**
   * Dropbox (Business) app credentials, for the Dropbox → Google combinations.
   *
   * Prefer the refresh-token trio: Dropbox access tokens are short-lived (4 hours), which is shorter
   * than a full content validation run, so a run configured with only DROPBOX_ACCESS_TOKEN can fail
   * partway through with a 401 that looks like a permissions problem.
   *
   * The app needs these scopes: files.metadata.read, files.content.read, files.content.write,
   * sharing.read, sharing.write — plus team_data.member, team_info.read and members.read for a
   * Business team (listing members, groups and team folders).
   */
  DROPBOX_APP_KEY: (process.env.DROPBOX_APP_KEY || '').trim(),
  DROPBOX_APP_SECRET: (process.env.DROPBOX_APP_SECRET || '').trim(),
  DROPBOX_REFRESH_TOKEN: (process.env.DROPBOX_REFRESH_TOKEN || '').trim(),
  /** Short-lived fallback token. Used only when the refresh trio above is absent. */
  DROPBOX_ACCESS_TOKEN: (process.env.DROPBOX_ACCESS_TOKEN || '').trim(),
  /**
   * Root path the QA flow seeds into and validates from, e.g. "/QA-Automation".
   * Kept configurable so a seeding run can never touch the rest of a shared QA Dropbox.
   */
  DROPBOX_TEST_ROOT: (process.env.DROPBOX_TEST_ROOT || '/QA-Automation').trim(),
  /**
   * Principals the seeding agent grants access to (scope 2.1–2.5).
   *
   * Dropbox rejects a grant to an address it cannot resolve, so these must be real. Each is
   * optional: an unset value SKIPS that class of grant with a warning rather than failing the run,
   * because a missing QA account is a configuration gap, not a product defect.
   *
   * DROPBOX_TEST_INTERNAL_USER — a second account inside the Dropbox team (user grants)
   * DROPBOX_TEST_EXTERNAL_USER — an address OUTSIDE the team (external shares, feature 2.5)
   * DROPBOX_TEST_GROUP         — the display name of an existing Dropbox team group. Looked up by
   *                              name; never created, because seeding must not alter team config.
   */
  DROPBOX_TEST_INTERNAL_USER: (process.env.DROPBOX_TEST_INTERNAL_USER || '').trim().toLowerCase(),
  DROPBOX_TEST_EXTERNAL_USER: (process.env.DROPBOX_TEST_EXTERNAL_USER || '').trim().toLowerCase(),
  DROPBOX_TEST_GROUP: (process.env.DROPBOX_TEST_GROUP || '').trim(),
  /**
   * Content migration server credentials (qarelease).
   * Used as fallback when the Migration Server password field is left empty in the form.
   * CONTENT_MIGRATION_SERVER_URL  — e.g. https://qarelease.cloudfuze.com/
   * CONTENT_MIGRATION_SERVER_EMAIL — app account email on that server
   * CONTENT_MIGRATION_SERVER_PASSWORD — app account password (plaintext; MD5-hashed before sending)
   */
  CONTENT_MIGRATION_SERVER_URL: (process.env.CONTENT_MIGRATION_SERVER_URL || '').trim(),
  CONTENT_MIGRATION_SERVER_EMAIL: (process.env.CONTENT_MIGRATION_SERVER_EMAIL || '').trim(),
  CONTENT_MIGRATION_SERVER_PASSWORD: (process.env.CONTENT_MIGRATION_SERVER_PASSWORD || '').trim(),
  /**
   * Pin the exact qarelease cloud registrations for content migration.
   * Multiple Box/SharePoint registrations exist for the same email/domain; only one
   * resolves path mappings. Captured from the working UI request. When set, MigrationAgent
   * overrides findCloudId's pick with these IDs.
   */
  CONTENT_SOURCE_CLOUD_ID: (process.env.CONTENT_SOURCE_CLOUD_ID || '').trim(),
  CONTENT_DEST_CLOUD_ID: (process.env.CONTENT_DEST_CLOUD_ID || '').trim(),
  /**
   * Diagnostic source-path pin. CONTENT_SOURCE_PATH_OVERRIDE forces the content migration
   * source path (e.g. /NEWDATA) and CONTENT_SOURCE_ROOT_ID_OVERRIDE its matching Box folder id.
   * Use to test whether the path-mapping CSV resolves for an already-indexed folder vs a
   * freshly-created one. Leave blank in normal operation.
   */
  CONTENT_SOURCE_PATH_OVERRIDE: (process.env.CONTENT_SOURCE_PATH_OVERRIDE || '').trim(),
  CONTENT_SOURCE_ROOT_ID_OVERRIDE: (process.env.CONTENT_SOURCE_ROOT_ID_OVERRIDE || '').trim(),
  /**
   * When the path-mapping CSV resolves 0 pairs, abort before creating a (0-pair) job.
   * Defaults to enabled; set to the string 'false' to proceed anyway (legacy behaviour).
   */
  CONTENT_REQUIRE_CSV_MAPPING: (process.env.CONTENT_REQUIRE_CSV_MAPPING || '').trim() || 'true',

  /**
   * Deep content validation (files/folders source↔destination comparison).
   * Feature reference: backend/data/feature-scope/google-shared-drive-to-sharepoint-*.md
   *
   * ENABLE_DEEP_CONTENT_VALIDATION   — master switch; off means content runs stay report-only
   * CONTENT_DEEP_VALIDATE_METADATA   — Tier C: permissions, links, versions, timestamps
   * CONTENT_DEEP_VALIDATE_LINKS      — shared-link scope/type comparison (part of Tier C)
   * CONTENT_DEEP_VALIDATE_FILE_HASH  — Tier B: SHA-256 of file bytes. Two full downloads per file,
   *                                    so it is OFF by default and capped by DEEP_CONTENT_MAX_FILES.
   * CONTENT_DEEP_VALIDATE_NOTIFICATIONS — checks the destination mailbox received no SharePoint
   *                                    sharing mail (features 9.1/9.2); needs mailbox access.
   */
  ENABLE_DEEP_CONTENT_VALIDATION: (process.env.ENABLE_DEEP_CONTENT_VALIDATION || '').trim().toLowerCase() !== 'false',
  CONTENT_DEEP_VALIDATE_METADATA: (process.env.CONTENT_DEEP_VALIDATE_METADATA || '').trim().toLowerCase() !== 'false',
  CONTENT_DEEP_VALIDATE_LINKS: (process.env.CONTENT_DEEP_VALIDATE_LINKS || '').trim().toLowerCase() !== 'false',
  CONTENT_DEEP_VALIDATE_FILE_HASH: (process.env.CONTENT_DEEP_VALIDATE_FILE_HASH || '').trim().toLowerCase() === 'true',
  CONTENT_DEEP_VALIDATE_NOTIFICATIONS: (process.env.CONTENT_DEEP_VALIDATE_NOTIFICATIONS || '').trim().toLowerCase() === 'true',
  // Did the MIGRATION JOB ask CloudFuze to suppress destination email? Features 9.1/9.2 compare
  // the destination mailbox, and the combination document is explicit that without suppression
  // "users receive standard SharePoint sharing notifications" — so mail is the CORRECT outcome
  // then, and failing on it reports a defect against normal Microsoft 365 behaviour. Nothing in
  // this repo requests suppression today, so the default is false and the features report as not
  // exercised. Declared explicitly, never inferred from "we found no mail".
  CONTENT_MIGRATION_SUPPRESSES_NOTIFICATIONS:
    (process.env.CONTENT_MIGRATION_SUPPRESSES_NOTIFICATIONS || '').trim().toLowerCase() === 'true',
  DEEP_CONTENT_MAX_FILES: (() => {
    const n = parseInt(process.env.DEEP_CONTENT_MAX_FILES ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : 500;
  })(),

  /**
   * CloudFuze content-job flags. These are read by migrationClient when it builds the
   * newmultiuser update call. They MUST be declared here: this module is an explicit whitelist and
   * never spreads process.env, so a var that is only referenced as env.FOO — without a line in this
   * object — is permanently `undefined`. That is not hypothetical: CONTENT_TEAM_FOLDERS_MIGRATE and
   * CONTENT_PICK_INSIDE_FOLDER were both introduced as opt-in flags guarded by
   * `env.X === 'true'` while missing from here, which made the opt-in unreachable and pinned both
   * flags to false on every run for as long as they existed.
   *
   * CONTENT_TEAM_FOLDERS_MIGRATE — "Team Folders" is Google's old name for Shared Drives. With it
   *   false against a GOOGLE_SHARED_DRIVES cloud, the scan finds the root folder but not its
   *   contents (one item scanned, an empty folder at the destination).
   * CONTENT_PICK_INSIDE_FOLDER — whether CloudFuze descends into the named folder rather than
   *   treating the pair as one opaque object.
   * CONTENT_MIGRATE_FOLDER_NAME — wrapper folder created at the destination; blank matches the
   *   wizard, which sends an empty value.
   * CONTENT_CSV_VALIDATION_* — how long to wait for path-CSV validation before giving up.
   */
  CONTENT_TEAM_FOLDERS_MIGRATE: (process.env.CONTENT_TEAM_FOLDERS_MIGRATE || '').trim().toLowerCase(),
  CONTENT_PICK_INSIDE_FOLDER: (process.env.CONTENT_PICK_INSIDE_FOLDER || '').trim().toLowerCase(),
  /**
   * CONTENT_STRIP_ROOT_ID_PREFIX — send `fromRootId` without a namespace prefix.
   *
   * Every CloudFuze job that ever scanned carries a bare id (Box "409671580491", Drive
   * "1KT09kJlRe5TZbFbI5Ldw8HtLBUIL23Yb"). Dropbox's is the only one shaped "id:9nIlEb3a…", so this
   * exists to compare the two forms rather than guess. Declared here because a flag read only as
   * `env.X` without a line in this object is permanently undefined — the same trap that silently
   * disabled the two flags above.
   */
  CONTENT_STRIP_ROOT_ID_PREFIX: (process.env.CONTENT_STRIP_ROOT_ID_PREFIX || '').trim().toLowerCase(),
  CONTENT_MIGRATE_FOLDER_NAME: (process.env.CONTENT_MIGRATE_FOLDER_NAME || '').trim(),

  /**
   * CONTENT_PRECREATE_GOOGLE_DESTINATION — create the destination folder for a GOOGLE destination
   * before the migration is triggered. Default OFF, deliberately.
   *
   * The SharePoint pre-create has been in place for a long time and SharePoint runs pass with it.
   * The Google branches are new, and the evidence against them is uncomfortable: on
   * dropbox -> googleshareddrive, all FOUR runs without the step reported
   * "PROCESSED, workspace scanned 67 item(s)", and BOTH runs with it were refused by CloudFuze at
   * poll 2 with "Migration not Allowed for wrong CSV paths" — on a byte-identical job payload, the
   * same 28 job options, the same path CSV, the same cached mapping row and the same destination
   * state. A 4/4 versus 2/2 split against the only thing that changed is not something to dismiss
   * as server-side flakiness, which is what it was called before anyone checked.
   *
   * No mechanism is established. The Google branches only READ (resolve the drive by name, then
   * create folders only when the path names one), so how they would affect CloudFuze's own view of
   * the CSV paths is genuinely unclear — it may yet be coincidence on a small sample. This flag
   * exists to settle that by experiment rather than argument: OFF reproduces the configuration that
   * worked, ON restores the step.
   *
   * Turn it ON only when a first-time destination folder is needed, and re-check the outcome.
   */
  CONTENT_PRECREATE_GOOGLE_DESTINATION:
    (process.env.CONTENT_PRECREATE_GOOGLE_DESTINATION || '').trim().toLowerCase() === 'true',
  /** Optional override for the job's 'migrate files up to' cutoff, 'YYYY-MM-DD HH:mm:ss'. */
  CONTENT_MIGRATION_TO_DATE: (process.env.CONTENT_MIGRATION_TO_DATE || '').trim(),
  CONTENT_CSV_VALIDATION_POLL_MS: (() => {
    const n = parseInt(process.env.CONTENT_CSV_VALIDATION_POLL_MS ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : 5000;
  })(),
  CONTENT_CSV_VALIDATION_MAX_POLLS: (() => {
    const n = parseInt(process.env.CONTENT_CSV_VALIDATION_MAX_POLLS ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : 60;
  })(),

  /**
   * CONTENT_PERMISSION_SETTLE_* — how long the content validator waits for CloudFuze to finish
   * applying item sharing before it calls a grant missing.
   *
   * CloudFuze copies the items first and applies sharing AFTER, so a validator that starts the
   * moment the job reports PROCESSED races that phase. Measured on run dbx-gsd-1788417784387:
   * five items reported no destination grants at validation time, and a direct read about 25
   * MINUTES later showed every grant present and correct.
   *
   * The defaults (2 x 8s) only ever caught the fast cases — they are two orders of magnitude short
   * of the delay actually observed — and they are hardcoded no longer, because the right budget is
   * a property of the run rather than of the code: a quick smoke run wants to finish, while a run
   * that has to produce real verdicts for features 2.1-2.5 can afford to wait. Raising this trades
   * wall-clock for a real answer instead of "not judgeable yet".
   *
   * The wait applies ONLY to items where the source has grants and the destination reports none,
   * so a fully-migrated tree is never slowed by it.
   */
  CONTENT_PERMISSION_SETTLE_ATTEMPTS: (() => {
    const n = parseInt(process.env.CONTENT_PERMISSION_SETTLE_ATTEMPTS ?? '', 10);
    return Number.isFinite(n) && n >= 0 ? n : 2;
  })(),
  CONTENT_PERMISSION_SETTLE_MS: (() => {
    const n = parseInt(process.env.CONTENT_PERMISSION_SETTLE_MS ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : 8000;
  })(),

  /**
   * Destination SharePoint target. These were hardcoded in the Box→SharePoint validator; the defaults
   * keep that behaviour so nothing changes for existing runs, while combinations beyond the first are
   * not pinned to one tenant.
   */
  SHAREPOINT_HOSTNAME: (process.env.SHAREPOINT_HOSTNAME || 'filefuze.sharepoint.com').trim(),
  SHAREPOINT_SITE_PATH: (process.env.SHAREPOINT_SITE_PATH || '/sites/SANITYDATAA').trim(),

  /** Name of the Google Shared Drive holding the source test data (Shared Drive → SharePoint runs). */
  GOOGLE_SHARED_DRIVE_NAME: (process.env.GOOGLE_SHARED_DRIVE_NAME || '').trim(),

  /**
   * Name of the Google Shared Drive that RECEIVES the data on dropbox → googleshareddrive runs.
   *
   * Separate from GOOGLE_SHARED_DRIVE_NAME above on purpose: that one names the SOURCE drive for the
   * Shared Drive → SharePoint combinations. Reusing it here would validate a Dropbox migration
   * against the drive a different combination reads from, and the report would look consistent while
   * comparing the wrong tree.
   *
   * Last resort only. The run's own destinationSharedDriveName, destinationFolderName, and the first
   * segment of destinationPath each take precedence — see
   * GoogleDriveValidationAgent.resolveDestinationRoot.
   */
  GOOGLE_DEST_SHARED_DRIVE_NAME: (process.env.GOOGLE_DEST_SHARED_DRIVE_NAME || '').trim(),

  /**
   * Extra grantees the content permission matrix seeds alongside the internal editor/viewer.
   * The manual QA suite treats these as first-class dimensions — group grants are the majority of
   * its Shared Drive → SharePoint cases, and external shares are feature 4.9. Leave blank and those
   * dimensions are reported "not exercised" rather than silently assumed to pass.
   */
  /**
   * Principals the permission matrix (in-scope features 4.2-4.8) grants access to. All four were
   * unset, so _createPermissionMatrix skipped every case and features 4.2-4.8 sat at NA on every
   * run — the machinery was built and never switched on.
   *
   * EDITOR/VIEWER must be users that already appear in the run's user mapping, or CloudFuze has
   * no destination principal to re-grant to and the check fails for a reason that is not a defect.
   * Note that some accounts cannot hold the `commenter` role at all — Google rejects it with
   * "lack the necessary license" — so the editor account should be a licensed one.
   */
  /**
   * Set to 'blocked' when the destination site refuses anonymous ("anyone with the link")
   * sharing. The combination document is explicit that this is expected rather than a defect:
   * "If external sharing is restricted or disabled in SharePoint, those permissions may not be
   * applied in the destination" (#13 External Shares). Verify before setting it — Graph
   * createLink with scope=anonymous answers "notAllowed: sharing has been disabled on this site".
   * Left unset, missing anonymous links are reported as failures.
   */
  /**
   * Extra source->destination principal pairs, appended to every run's user mapping.
   * Format: "source1:dest1,source2:dest2".
   *
   * Exists because the wizard can only map principals it fetched as MAILBOXES. A group, shared
   * mailbox or distribution list is never in that list, so its permissions could not be mapped —
   * CloudFuze had no destination principal to re-grant to, and the validator correctly reported
   * them out of scope ("no GROUP permissions were exercised"). Configuring the pairs here means
   * every run carries them without depending on someone importing a CSV by hand.
   */
  CONTENT_EXTRA_USER_MAPPINGS: (process.env.CONTENT_EXTRA_USER_MAPPINGS || '').trim(),
  CONTENT_DEST_ANONYMOUS_SHARING: (process.env.CONTENT_DEST_ANONYMOUS_SHARING || '').trim().toLowerCase(),
  GOOGLE_TEST_EDITOR_EMAIL: (process.env.GOOGLE_TEST_EDITOR_EMAIL || '').trim(),
  GOOGLE_TEST_VIEWER_EMAIL: (process.env.GOOGLE_TEST_VIEWER_EMAIL || '').trim(),
  GOOGLE_TEST_GROUP_EMAIL: (process.env.GOOGLE_TEST_GROUP_EMAIL || '').trim(),
  GOOGLE_TEST_EXTERNAL_EMAIL: (process.env.GOOGLE_TEST_EXTERNAL_EMAIL || '').trim(),

  // ── Message product (Slack / Google Chat / Teams) ──────────────────────────────
  /** 4th Google tenant (message product). */
  GOOGLE_CLIENT_ID_4: process.env.GOOGLE_CLIENT_ID_4,
  GOOGLE_CLIENT_SECRET_4: process.env.GOOGLE_CLIENT_SECRET_4,
  GOOGLE_TENANT_4_DOMAINS: (process.env.GOOGLE_TENANT_4_DOMAINS || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean),
  /** Azure app client id used for message (Teams) delegated tokens, if separate from GRAPH_CLIENT_ID. */
  MS_MESSAGE_CLIENT_ID: process.env.MS_MESSAGE_CLIENT_ID || '',
  /** CloudFuze chat-migration server credentials (email/password login). */
  MIGRATION_API_USERNAME: (process.env.MIGRATION_API_USERNAME || '').trim(),
  MIGRATION_API_PASSWORD: (process.env.MIGRATION_API_PASSWORD || '').trim(),
  /**
   * Dedicated CHAT-migration CloudFuze account. Chat (Slack/Teams/Google Chat) clouds
   * usually live in a DIFFERENT CloudFuze subscriber account than the mail account.
   * If set, chatMigrationClient logs into THIS account; otherwise it falls back to the
   * shared MIGRATION_API_* (mail) credentials. Any of URL / BASIC_AUTH / BEARER /
   * USERNAME+PASSWORD may be supplied (same precedence as the mail client).
   */
  CHAT_MIGRATION_API_URL: normalizeMigrationApiUrl(process.env.CHAT_MIGRATION_API_URL || process.env.MIGRATION_API_URL || 'http://localhost:8080'),
  CHAT_MIGRATION_API_BASIC_AUTH: (process.env.CHAT_MIGRATION_API_BASIC_AUTH || '').trim(),
  CHAT_MIGRATION_API_KEY: (process.env.CHAT_MIGRATION_API_KEY || '').trim(),
  CHAT_MIGRATION_API_BEARER_TOKEN: cleanEnvValue(process.env.CHAT_MIGRATION_API_BEARER_TOKEN || ''),
  CHAT_MIGRATION_API_USERNAME: (process.env.CHAT_MIGRATION_API_USERNAME || '').trim(),
  CHAT_MIGRATION_API_PASSWORD: (process.env.CHAT_MIGRATION_API_PASSWORD || '').trim(),
  /** When 'true', skip CloudFuze validateUser before triggering a chat migration. */
  CLOUDFUZE_SKIP_VALIDATE_USER: String(process.env.CLOUDFUZE_SKIP_VALIDATE_USER ?? '').trim().toLowerCase() === 'true',
  /** Optional Google Chat space id for seeding/validation. */
  GOOGLE_CHAT_SPACE: (process.env.GOOGLE_CHAT_SPACE || '').trim(),
  /** Optional overrides for the CloudFuze chat-migration initiate/close paths + wait. */
  CHAT_MIGRATION_API_INITIATE_PATH: (process.env.CHAT_MIGRATION_API_INITIATE_PATH || '').trim().replace(/^\/+/, '').replace(/\/+$/, ''),
  CHAT_MIGRATION_CLOSE_PATH: (process.env.CHAT_MIGRATION_CLOSE_PATH || '').trim().replace(/^\/+/, '').replace(/\/+$/, ''),
  CHAT_MIGRATION_MAX_WAIT_MINUTES: parseInt(process.env.CHAT_MIGRATION_MAX_WAIT_MINUTES || '30', 10) || 30,
  /** Slack tokens (message product). SLACK_USER_TOKEN (xoxp-…) auto-installs on startup. */
  SLACK_USER_TOKEN: cleanEnvValue(process.env.SLACK_USER_TOKEN || ''),
  SLACK_BOT_TOKEN: cleanEnvValue(process.env.SLACK_BOT_TOKEN || ''),
  SLACK_CHANNEL_ID: (process.env.SLACK_CHANNEL_ID || '').trim(),
  SLACK_CLIENT_ID: cleanEnvValue(process.env.SLACK_CLIENT_ID || ''),
  SLACK_CLIENT_SECRET: cleanEnvValue(process.env.SLACK_CLIENT_SECRET || ''),
  SLACK_REDIRECT_URI: cleanEnvValue(process.env.SLACK_REDIRECT_URI || ''),
  /** Teams target ids for seeding/validation. */
  TEAMS_TEAM_ID: (process.env.TEAMS_TEAM_ID || '').trim(),
  TEAMS_CHANNEL_ID: (process.env.TEAMS_CHANNEL_ID || '').trim(),
  /** CF chat-migration server accounts: primary (MIGRATION_API_USERNAME/PASSWORD) + CF_EXTRA_ACCOUNTS ("email:pwd,email:pwd"). */
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
        if (email && password && !accounts.find((a) => a.email === email)) accounts.push({ email, password });
      }
    }
    return accounts;
  })(),

  // ── Microsoft login for the QA tool itself (Azure AD "Cloudfuze domain" app) ──
  // Separate from the Graph cloud-connection app above — used ONLY to authenticate
  // users into the QA Agent UI (PKCE browser flow → backend code exchange → app JWT).
  AZURE_CLIENT_ID: cleanEnvValue(process.env.AZURE_CLIENT_ID || ''),
  AZURE_TENANT_ID: cleanEnvValue(process.env.AZURE_TENANT_ID || 'common'),
  AZURE_CLIENT_SECRET: cleanEnvValue(process.env.AZURE_CLIENT_SECRET || ''),
  JWT_SECRET: cleanEnvValue(process.env.JWT_SECRET || ''),
};
