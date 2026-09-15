/**
 * Complete a ShareFile connection by hand, from the URL the browser was redirected to.
 *
 * WHY THIS EXISTS
 * ---------------
 * ShareFile delivers the authorization code to the app's REGISTERED redirect URI. The app in use
 * here (`staging`) is registered against https://staging.cloudfuze.com/oauth/oauth.html — a host
 * this backend does not own — so the popup flow in Connect Clouds cannot complete: the code is
 * delivered to CloudFuze's staging page and our callback route is never reached.
 *
 * The code is nonetheless visible to YOU. OAuth's authorization-code delivery is front-channel: the
 * browser is redirected, so the code sits in the address bar even when the server behind that URL
 * is not ours. Copy that whole URL, pass it here, and this script performs the back-channel token
 * exchange — which is a direct server-to-server call to ShareFile and needs no listener on the
 * redirect host at all.
 *
 * The exchange still sends `redirect_uri`, because ShareFile requires it to match the value used in
 * the authorize request. Matching is all it checks; it does not verify that we control the host.
 *
 * Usage (from backend/):
 *   node scripts/sharefile-exchange-code.js "<the full URL you landed on>"
 *
 * The URL looks like:
 *   https://staging.cloudfuze.com/oauth/oauth.html?code=abc123&subdomain=syncgalaxy&apicp=sf-api.com
 *
 * On success the account is stored in oauthTokenStore exactly as the popup flow would have stored
 * it — same provider key, same fields — so Connect Clouds, the wizard and the validator all see a
 * normally connected ShareFile account afterwards.
 */
const axios = require('axios');
const env = require('../src/config/env');
const tokenStore = require('../src/clients/oauthTokenStore');

const DEFAULT_APICP = 'sf-api.com';

function fail(msg) {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
}

function parseRedirect(raw) {
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    fail('That is not a URL. Paste the whole address bar contents, in quotes.');
  }
  const q = u.searchParams;
  const err = q.get('error') || q.get('error_description');
  if (err) fail(`ShareFile returned an error instead of a code: ${err}`);

  const code = q.get('code');
  if (!code) {
    fail('No `code` parameter in that URL. Either sign-in did not complete, or you pasted the '
      + 'authorize URL rather than the one you were redirected TO.');
  }
  return {
    code,
    // ShareFile returns the account host on the callback. It is the only place it comes from —
    // there is no subdomain setting — so a callback without it leaves the account unusable.
    subdomain: q.get('subdomain') || '',
    apicp: q.get('apicp') || DEFAULT_APICP,
  };
}

/** `--flag=value` from argv, or ''. */
function flag(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3).trim() : '';
}

/**
 * Store an already-obtained token, skipping the exchange entirely.
 *
 * Exists because an authorization code is single-use: if the exchange succeeds but storing fails
 * (an unknown account email, say), the token is still good and must not be thrown away — re-running
 * the whole browser round trip to recover from a naming problem is pure waste.
 */
async function storeDirect() {
  const email = flag('email').toLowerCase();
  const accessToken = flag('token');
  const refreshToken = flag('refresh') || null;
  const host = flag('host');
  if (!email || !accessToken || !host) {
    fail('--token requires --email and --host as well, e.g.\n'
      + '    npm run sharefile-connect -- --email=zara@storefuze.com --token=… --host=syncgalaxy.sf-api.com');
  }
  tokenStore.setShareFileToken({
    email,
    accessToken,
    refreshToken,
    expiresAt: null,
    subdomain: host.split('.')[0],
    apiHost: host,
  });
  console.log(`\n  ✓ Stored ${email} on ${host}`);
  console.log(`    refresh token ${refreshToken ? 'stored' : 'NOT provided — the connection will expire in ~1h'}\n`);
}

async function main() {
  if (flag('token')) return storeDirect();

  const raw = process.argv[2];
  if (!raw || raw.startsWith('--')) {
    fail('Usage: node scripts/sharefile-exchange-code.js "<the full redirected URL>"\n'
      + '   or: node scripts/sharefile-exchange-code.js --email=… --token=… --host=… [--refresh=…]');
  }
  if (!env.SHAREFILE_CLIENT_ID || !env.SHAREFILE_CLIENT_SECRET) {
    fail('SHAREFILE_CLIENT_ID / SHAREFILE_CLIENT_SECRET are not set in the root .env.');
  }
  const redirectUri = env.SHAREFILE_REDIRECT_URI;
  if (!redirectUri) {
    fail('SHAREFILE_REDIRECT_URI is not set. It must be the EXACT URI registered on the ShareFile '
      + 'app, because the token exchange re-sends it and ShareFile compares the two.');
  }

  const { code, subdomain, apicp } = parseRedirect(raw);
  if (!subdomain) {
    console.warn('\n  ⚠ The callback carried no `subdomain`. Falling back to the account host being '
      + 'unknown, which will make API calls fail later. If the URL really had no subdomain '
      + 'parameter, say so — the app registration may be returning a different shape.\n');
  }
  const host = subdomain ? `${subdomain}.${apicp}` : null;

  console.log(`\n  Exchanging code for tokens`);
  console.log(`  redirect_uri : ${redirectUri}`);
  console.log(`  account host : ${host || '(unknown)'}\n`);

  const tokenUrl = `https://${host || `secure.${DEFAULT_APICP}`}/oauth/token`;
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: env.SHAREFILE_CLIENT_ID,
    client_secret: env.SHAREFILE_CLIENT_SECRET,
    code,
    redirect_uri: redirectUri,
  });

  let data;
  try {
    const res = await axios.post(tokenUrl, body.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 30000,
    });
    data = res.data || {};
  } catch (err) {
    const d = err?.response?.data;
    const detail = typeof d === 'string' ? d : (d ? JSON.stringify(d) : err.message);
    // An authorization code is single-use and short-lived; a stale one is the usual cause.
    fail(`Token exchange failed${err?.response?.status ? ` (HTTP ${err.response.status})` : ''}: ${detail}\n`
      + '  If this says the code is invalid or expired, redo the sign-in and paste the fresh URL — '
      + 'a code can only be exchanged once, and expires within minutes.');
  }

  if (!data.access_token) fail(`ShareFile returned no access_token. Response: ${JSON.stringify(data)}`);

  // The account email is not in the token response, so it is read from the API — it is the key the
  // account is stored under, and without it the connection would not appear anywhere in the UI.
  //
  // Several endpoints are tried because the shape varies: /Users(current) is the documented
  // "who am I", /Users/Info exists on some versions, and the /Users LIST needs admin rights and
  // returns everyone rather than the caller. Whatever each returns is printed, so a failure teaches
  // us the real shape instead of just saying no.
  //
  // A token that survives the exchange is NEVER discarded because identity lookup failed — the
  // authorization code behind it is single-use, so throwing the token away costs a whole round trip
  // through the browser. An explicit --email= wins over all of this.
  const argEmail = (process.argv.find((a) => a.startsWith('--email=')) || '').split('=')[1];
  let email = argEmail ? argEmail.trim().toLowerCase() : null;

  if (!email) {
    const auth = { Authorization: `Bearer ${data.access_token}` };
    const candidates = ['/sf/v3/Users(current)', '/sf/v3/Users/Info', '/sf/v3/Users'];
    for (const path of candidates) {
      try {
        const r = await axios.get(`https://${host}${path}`, { headers: auth, timeout: 30000 });
        const d = r.data;
        const rows = Array.isArray(d?.value) ? d.value : [d];
        const found = rows.map((x) => x?.Email || x?.email).find(Boolean);
        console.log(`  ${path} → ${found ? `email ${found}` : `no email field; keys: ${Object.keys(rows[0] || {}).slice(0, 12).join(', ') || '(empty)'}`}`);
        if (found) { email = String(found).toLowerCase(); break; }
      } catch (e) {
        console.log(`  ${path} → ${e?.response?.status ? `HTTP ${e.response.status}` : e.message}`);
      }
    }
  }

  if (!email) {
    console.error('\n  The token IS valid — the exchange worked. Only the account email could not be'
      + '\n  determined, and that is the key the account is stored under.'
      + '\n\n  The token is printed below so this code does not have to be re-fetched. Re-run with an'
      + '\n  explicit address to finish storing it:'
      + `\n\n    npm run sharefile-connect -- --email=zara@storefuze.com --token=${data.access_token}`
      + `${data.refresh_token ? ` --refresh=${data.refresh_token}` : ''} --host=${host}\n`);
    process.exit(1);
  }

  tokenStore.setShareFileToken({
    email,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    expiresAt: data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : null,
    subdomain: subdomain || null,
    apiHost: host,
  });

  console.log(`  ✓ Connected ${email}`);
  console.log(`    host          ${host}`);
  console.log(`    refresh token ${data.refresh_token ? 'stored' : 'NOT returned — the connection will expire in ~1h'}`);
  console.log('\n  Verify with:');
  console.log('    node -e "require(\'./src/clients/sharefileClient\').verifyConnection().then(r=>console.log(r))"\n');
}

main().catch((err) => fail(err.message));
