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
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
  googleAccounts,
  pickCorrespondentEmail,
  pickCcEmail,
  outlookAccounts,
  GRAPH_CLIENT_ID: process.env.GRAPH_CLIENT_ID,
  GRAPH_CLIENT_SECRET: process.env.GRAPH_CLIENT_SECRET,
  GRAPH_TENANT_ID: process.env.GRAPH_TENANT_ID,
  MIGRATION_API_URL: process.env.MIGRATION_API_URL || 'http://localhost:8080',
  MIGRATION_API_KEY: process.env.MIGRATION_API_KEY || '',
  /** Base64(userId:apiSecret) from Email Migration UI Network → Authorization (optional; overrides MIGRATION_API_KEY for Basic auth) */
  MIGRATION_API_BASIC_AUTH: (process.env.MIGRATION_API_BASIC_AUTH || '').trim(),
  CLOUDFUZE_OWNER_EMAIL: process.env.CLOUDFUZE_OWNER_EMAIL || '',
  SCHEDULER_ENABLED: process.env.SCHEDULER_ENABLED === 'true',
  DEFAULT_SOURCE_EMAIL: process.env.DEFAULT_SOURCE_EMAIL || '',
  DEFAULT_DEST_EMAIL: process.env.DEFAULT_DEST_EMAIL || '',
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  /** Optional path to gmail-test-cases.xlsx (mail + draft matrix). Empty = backend/data/gmail-test-cases.xlsx */
  GMAIL_TEST_CASES_XLSX: (process.env.GMAIL_TEST_CASES_XLSX || '').trim(),
};
