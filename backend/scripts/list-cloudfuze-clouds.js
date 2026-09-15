/**
 * List the clouds registered on a CloudFuze server, with their migration cloud IDs.
 *
 * READ-ONLY. It logs in and issues one GET. It initiates nothing, migrates nothing and deletes
 * nothing — unlike most of backend/scripts/, which hit live mailboxes destructively.
 *
 * Why this exists: MigrationAgent resolves the source/destination cloud id by matching the account
 * email against the registered clouds (migrationClient.findCloudId). When two registrations share an
 * email, or the wrong cloud family answers first, the run migrates into the wrong cloud — the
 * failure `CONTENT_SOURCE_CLOUD_ID` / `CONTENT_DEST_CLOUD_ID` exist to pin. To pin one you first
 * have to see it, and the CloudFuze UI's Clouds page is the only other place these ids appear.
 *
 * Usage (from backend/):
 *   node scripts/list-cloudfuze-clouds.js                      # content server, from .env
 *   node scripts/list-cloudfuze-clouds.js <url> <email> <pass> # any server, explicit
 *
 * Defaults come from CONTENT_MIGRATION_SERVER_URL / _EMAIL / _PASSWORD in the root .env.
 */
const env = require('../src/config/env');
const migrationClient = require('../src/clients/migrationClient');

const [, , argUrl, argEmail, argPassword] = process.argv;

const baseUrl = argUrl || env.CONTENT_MIGRATION_SERVER_URL;
const email = argEmail || env.CONTENT_MIGRATION_SERVER_EMAIL;
const password = argPassword || env.CONTENT_MIGRATION_SERVER_PASSWORD;

function fail(msg) {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
}

/** Cloud ids arrive under several key names depending on server version — check each. */
function idOf(c) {
  return c?.id || c?.cloudId || c?._id || c?.cloudID || (c?._id && c._id.$oid) || '(no id field)';
}

/** Likewise the account email. */
function emailOf(c) {
  return c?.emailId || c?.email || c?.cloudEmail || c?.userName || c?.accountEmail || '';
}

async function main() {
  if (!baseUrl) fail('No server URL. Set CONTENT_MIGRATION_SERVER_URL in the root .env, or pass one as the first argument.');
  if (!email || !password) {
    fail('No credentials. Set CONTENT_MIGRATION_SERVER_EMAIL and CONTENT_MIGRATION_SERVER_PASSWORD '
      + 'in the root .env, or pass them as the second and third arguments.');
  }

  console.log(`\n  Server : ${baseUrl}`);
  console.log(`  User   : ${email}\n`);

  migrationClient.setRuntimeConfig({ baseUrl, email, password });

  let clouds;
  try {
    clouds = await migrationClient.getClouds();
  } catch (err) {
    fail(`Could not list clouds: ${err?.response?.status ? `HTTP ${err.response.status} — ` : ''}${err.message}`);
  }

  if (!Array.isArray(clouds) || clouds.length === 0) {
    console.log('  No clouds registered for this account.');
    console.log('  Add one in the CloudFuze web app (Manage Clouds), then re-run this.\n');
    return;
  }

  // Widest-column formatting, so long SharePoint site names stay readable.
  const rows = clouds.map((c) => ({
    name: String(c.cloudName || c.name || c.cloudType || '?'),
    email: String(emailOf(c)),
    id: String(idOf(c)),
  }));
  const w = (k, min) => Math.max(min, ...rows.map((r) => r[k].length));
  const wName = w('name', 12);
  const wEmail = w('email', 20);

  console.log(`  ${'CLOUD'.padEnd(wName)}  ${'ACCOUNT'.padEnd(wEmail)}  MIGRATION CLOUD ID`);
  console.log(`  ${'-'.repeat(wName)}  ${'-'.repeat(wEmail)}  ${'-'.repeat(24)}`);
  for (const r of rows) {
    console.log(`  ${r.name.padEnd(wName)}  ${r.email.padEnd(wEmail)}  ${r.id}`);
  }
  console.log(`\n  ${rows.length} cloud(s).`);

  // Duplicate emails are the actual hazard: findCloudId matches on email, so two registrations
  // sharing one address is exactly when it picks the wrong cloud and the run migrates into it.
  const byEmail = new Map();
  for (const r of rows) {
    if (!r.email) continue;
    byEmail.set(r.email, (byEmail.get(r.email) || 0) + 1);
  }
  const dupes = [...byEmail.entries()].filter(([, n]) => n > 1);
  if (dupes.length > 0) {
    console.log('\n  ⚠ More than one cloud is registered under the same account email:');
    for (const [addr, n] of dupes) console.log(`      ${addr} — ${n} registrations`);
    console.log('    findCloudId() matches on email, so pin the ones you want with');
    console.log('    CONTENT_SOURCE_CLOUD_ID / CONTENT_DEST_CLOUD_ID rather than relying on the match.');
  }
  console.log();
}

main().catch((err) => fail(err.message));
