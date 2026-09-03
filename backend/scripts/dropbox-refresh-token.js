/**
 * One-off helper: obtain a Dropbox refresh token for the Dropbox → Google combinations.
 *
 * Dropbox access tokens expire after 4 hours, which is shorter than a full content validation run.
 * The refresh-token trio (DROPBOX_APP_KEY + DROPBOX_APP_SECRET + DROPBOX_REFRESH_TOKEN) is what
 * dropboxClient.js prefers; DROPBOX_ACCESS_TOKEN is only a short-lived fallback.
 *
 * Usage:
 *   cd backend
 *   node scripts/dropbox-refresh-token.js
 *
 * The app key and secret are read from the root .env if present, otherwise prompted for. The
 * resulting refresh token is PRINTED, never written — copy it into the root .env yourself. It is a
 * long-lived credential: do not paste it into a chat, a ticket, or a commit.
 */
const readline = require('readline');
const axios = require('axios');
const env = require('../src/config/env');

const AUTHORIZE_URL = 'https://www.dropbox.com/oauth2/authorize';
const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';

function ask(question, { mask = false } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      if (mask) process.stdout.write('\n');
      resolve(String(answer || '').trim());
    });
    if (mask) {
      // Suppress echo for secrets typed at the prompt.
      rl._writeToOutput = function () {};
    }
  });
}

async function main() {
  console.log('\nDropbox refresh-token setup');
  console.log('───────────────────────────\n');
  console.log('Before starting, create the app at https://www.dropbox.com/developers/apps');
  console.log('  Scoped access → Full Dropbox, then on the Permissions tab enable:');
  console.log('    files.metadata.read  files.content.read  files.content.write');
  console.log('    sharing.read  sharing.write');
  console.log('  For a Business team also: team_data.member  team_info.read');
  console.log('    members.read  groups.read');
  console.log('  Submit the permission changes before continuing, or the token will lack scopes.\n');

  const appKey = env.DROPBOX_APP_KEY || (await ask('App key: '));
  if (!appKey) throw new Error('App key is required.');

  const appSecret = env.DROPBOX_APP_SECRET || (await ask('App secret (hidden): ', { mask: true }));
  if (!appSecret) throw new Error('App secret is required.');

  const authorizeUrl =
    `${AUTHORIZE_URL}?client_id=${encodeURIComponent(appKey)}`
    + '&response_type=code'
    + '&token_access_type=offline';

  console.log('\n1. Open this URL, sign in as the QA Dropbox account, and click Allow:\n');
  console.log(`   ${authorizeUrl}\n`);
  console.log('2. Dropbox shows a short access code on the page. Copy it.\n');

  const code = await ask('3. Paste the access code here: ');
  if (!code) throw new Error('No code entered.');

  const body = new URLSearchParams({
    code,
    grant_type: 'authorization_code',
    client_id: appKey,
    client_secret: appSecret,
  });

  let data;
  try {
    ({ data } = await axios.post(TOKEN_URL, body.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 20000,
    }));
  } catch (err) {
    const detail = err.response && err.response.data;
    // invalid_grant here almost always means the code was reused or typed after it expired.
    console.error('\nToken exchange failed.');
    console.error(detail ? JSON.stringify(detail, null, 2) : err.message);
    console.error('\nAn "invalid_grant" means the code was already used or has expired.');
    console.error('Codes are single-use — rerun this script to get a fresh one.');
    process.exitCode = 1;
    return;
  }

  if (!data.refresh_token) {
    console.error('\nDropbox returned no refresh_token.');
    console.error('This happens when token_access_type=offline is missing from the authorize URL.');
    process.exitCode = 1;
    return;
  }

  console.log('\nDone. Add these three lines to the ROOT .env (not .env.example):\n');
  console.log(`DROPBOX_APP_KEY=${appKey}`);
  console.log('DROPBOX_APP_SECRET=<the secret you just entered>');
  console.log(`DROPBOX_REFRESH_TOKEN=${data.refresh_token}`);
  console.log(`\nScopes granted: ${data.scope || '(not reported)'}`);
  console.log(`Account id: ${data.account_id || '(not reported)'}`);
  console.log('\nThe refresh token does not expire, but it is a credential — keep it out of git,');
  console.log('logs, tickets and chat. The root .env is gitignored.\n');
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exitCode = 1;
});
