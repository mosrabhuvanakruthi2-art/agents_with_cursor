'use strict';

/**
 * Phase A of the ShareFile → SharePoint Online combination: the connect layer only.
 * Requirements: ai-sdlc/requirements/specs/003-sharefile-to-sharepoint.md, rules 3-5, 7, 9, 12, 13.
 *
 * What is asserted here, and why each case exists:
 *
 *   Rules 3-4  Two DISTINCT named 400s, one per half of the app credential. The requirements
 *              asked for the second to name a subdomain setting; per
 *              https://api.sharefile.com/gettingstarted/oauth2 the account subdomain is an
 *              OUTPUT of sign-in (it arrives on the callback with `apicp`), so there is no such
 *              setting to be missing. The second 400 names SHAREFILE_CLIENT_SECRET instead —
 *              a real value, needed before a user types a password into a flow that cannot
 *              otherwise finish. The callback's own host failures are covered below.
 *   Rule 7     No client secret in any payload the browser can see, and no token, refresh token or
 *              account host in the accounts list. The Winston logger masks email addresses only —
 *              credentials are not masked, so they must never be put there in the first place.
 *   Rule 9     'sharefile' is in CONTENT_PROVIDERS. Masked for this pair (the destination
 *              `sharepoint` already matches) but not for a future ShareFile→ShareFile pair.
 *   Rules 12-13 Cloud resolution. Measured against the live qarelease list on 2026-09-09:
 *              SHAREFILE_BUSINESS / zara@storefuze.com / 6aa10605b17d0e315c812361.
 *
 * The token store writes to backend/data/oauth-tokens.json, which holds real connected accounts.
 * fs is intercepted for that one filename before the store is required, so this test reads a
 * fixture and captures writes in memory. Every other path is delegated to the real fs.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TOKEN_FILE = path.join(__dirname, '../data/oauth-tokens.json');
const isTokenFile = (p) => String(p).endsWith('oauth-tokens.json');

let fakeTokens = JSON.stringify({});

const realReadFileSync = fs.readFileSync;
const realWriteFileSync = fs.writeFileSync;
const realExistsSync = fs.existsSync;

fs.readFileSync = function (p, ...rest) {
  if (isTokenFile(p)) return fakeTokens;
  return realReadFileSync.call(fs, p, ...rest);
};
fs.writeFileSync = function (p, data, ...rest) {
  if (isTokenFile(p)) {
    fakeTokens = String(data);
    return undefined;
  }
  return realWriteFileSync.call(fs, p, data, ...rest);
};
fs.existsSync = function (p, ...rest) {
  if (isTokenFile(p)) return true;
  return realExistsSync.call(fs, p, ...rest);
};

const env = require('../src/config/env');
const tokenStore = require('../src/clients/oauthTokenStore');
const router = require('../src/routes/authRoutes');
const mc = require('../src/clients/migrationClient');
const orchestrator = require('../src/orchestrator/AgentOrchestrator');

// ── Test doubles for the Express layer ───────────────────────────────────────

/** Pull one route handler out of the mounted router, by method and path. */
function handlerFor(method, routePath) {
  for (const layer of router.stack) {
    const route = layer.route;
    if (route && route.path === routePath && route.methods[method]) {
      const stack = route.stack;
      return stack[stack.length - 1].handle;
    }
  }
  throw new Error(`no ${method.toUpperCase()} ${routePath} route is mounted`);
}

function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    redirectedTo: null,
    sent: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    send(payload) { this.sent = payload; return this; },
    redirect(url) { this.redirectedTo = url; return this; },
  };
}

async function call(method, routePath, req) {
  const res = fakeRes();
  await handlerFor(method, routePath)({ query: {}, body: {}, ...req }, res);
  return res;
}

// Restore the real configuration after the route cases, so nothing later in the chain sees the
// values this test pokes in.
const savedEnv = {
  SHAREFILE_CLIENT_ID: env.SHAREFILE_CLIENT_ID,
  SHAREFILE_CLIENT_SECRET: env.SHAREFILE_CLIENT_SECRET,
};

const FAKE_SECRET = 'sf-client-secret-must-never-appear-DO-NOT-LOG';

// Resolved exactly as authRoutes does, so the asserted redirect_uri is the real one for this
// environment rather than a hardcoded localhost guess.
const BACKEND_BASE = process.env.BACKEND_BASE || `http://localhost:${env.PORT || 5000}`;

// Snapshot of the real store file, read through the untouched fs functions.
const diskBefore = realExistsSync.call(fs, TOKEN_FILE)
  ? realReadFileSync.call(fs, TOKEN_FILE, 'utf8')
  : null;

async function run() {
  // ── Rule 3: no client id → 400 naming SHAREFILE_CLIENT_ID ──────────────────
  env.SHAREFILE_CLIENT_ID = '';
  env.SHAREFILE_CLIENT_SECRET = FAKE_SECRET;

  const noClientId = await call('get', '/sharefile/url', {});
  assert.strictEqual(noClientId.statusCode, 400, 'a missing client id must be a 400, not a 500');
  assert.deepStrictEqual(noClientId.body, { error: 'SHAREFILE_CLIENT_ID not configured' },
    'the body must be flat { error } naming the missing setting');
  assert.strictEqual(noClientId.redirectedTo, null, 'no popup and no redirect on a config error');

  // ── Rule 4: client id present, no secret → a DISTINCT 400 ─────────────────
  //
  // The secret is not spent until the callback, but a sign-in started without it always dies
  // after the user has typed their ShareFile password. Naming it up front is the difference
  // between a 400 on a button click and an unexplained failed login.
  env.SHAREFILE_CLIENT_ID = 'sf-client-id';
  env.SHAREFILE_CLIENT_SECRET = '';

  const noSecret = await call('get', '/sharefile/url', {});
  assert.strictEqual(noSecret.statusCode, 400);
  assert.deepStrictEqual(noSecret.body, { error: 'SHAREFILE_CLIENT_SECRET not configured' });
  assert.notStrictEqual(noSecret.body.error, noClientId.body.error,
    'the two configuration failures must be told apart: one message covering both leaves the '
    + 'operator guessing which value is absent');
  assert.ok(/SHAREFILE_CLIENT_SECRET/.test(noSecret.body.error),
    'the second 400 must name its own setting');

  console.log('  two distinct named 400s, one per half of the app credential: ok');

  // ── The sign-in URL: ONE well-known host, no account host anywhere in it ──
  //
  // Documented at https://api.sharefile.com/gettingstarted/oauth2. An earlier draft built
  // https://<subdomain>.sharefile.com from an env var; that host is wrong and the env var is
  // gone. This case is what stops it coming back.
  env.SHAREFILE_CLIENT_SECRET = FAKE_SECRET;

  const ok = await call('get', '/sharefile/url', { query: { source: 'popup' } });
  assert.strictEqual(ok.statusCode, 200, 'a configured ShareFile app must produce a sign-in URL');
  const url = new URL(ok.body.url);
  assert.strictEqual(url.origin, 'https://secure.sharefile.com',
    'sign-in is served from the single documented host, not from a per-account subdomain');
  assert.strictEqual(url.pathname, '/oauth/authorize');
  assert.strictEqual(url.searchParams.get('response_type'), 'code');
  assert.strictEqual(url.searchParams.get('client_id'), 'sf-client-id');
  assert.strictEqual(url.searchParams.get('state'), 'popup');

  // Rule 5 of the Citrix setup, and the value the user must paste into the API Key Generator:
  // a mismatch makes the key unusable, and it fails at the END of sign-in.
  const redirectUri = url.searchParams.get('redirect_uri');
  assert.strictEqual(redirectUri, `${BACKEND_BASE}/api/auth/sharefile/callback`,
    'the redirect must be BACKEND_BASE + /api/auth/sharefile/callback, verbatim');
  console.log(`  redirect_uri to register with Citrix: ${redirectUri}`);

  // Rule 7 — the secret is a token-exchange credential and belongs nowhere near the browser.
  assert.ok(!JSON.stringify(ok.body).includes(FAKE_SECRET),
    'the client secret must not appear in the sign-in URL or anywhere else in the response');
  assert.ok(!url.searchParams.has('client_secret'),
    'an authorize URL carrying a client_secret hands the secret to the user agent');
  assert.ok(!/sharefile\.com\/oauth\/authorize\?.*subdomain/.test(ok.body.url),
    'the account subdomain is an output of sign-in, so it must not be sent as an input');

  console.log('  sign-in URL uses secure.sharefile.com and carries no secret: ok');

  // ── The callback builds the token host from what the callback supplies ────
  //
  // Both refusals below return before any network call, so they are testable without a tenant.
  // They are also the two ways the corrected flow can be attacked or misrouted: the token POST
  // carries our client_secret, so the host it goes to cannot be taken on trust. Citrix sends an
  // HMAC `h` on the callback but publishes no verification algorithm, so nothing here verifies
  // it — the allow-list is what stands in for that.
  const before = tokenStore.getAllConnectedAccounts().length;

  const noSub = await call('get', '/sharefile/callback', {
    query: { code: 'sf-auth-code', state: 'popup', apicp: 'sf-api.com' },
  });
  assert.ok(noSub.redirectedTo && /error=sharefile/.test(noSub.redirectedTo),
    'a callback with no subdomain must fail, not guess an account host');
  assert.ok(/subdomain/i.test(decodeURIComponent(noSub.redirectedTo)),
    'and must say which value was missing');

  const badApicp = await call('get', '/sharefile/callback', {
    query: {
      code: 'sf-auth-code', state: 'popup', subdomain: 'storefuze', apicp: 'attacker.example',
    },
  });
  assert.ok(badApicp.redirectedTo && /error=sharefile/.test(badApicp.redirectedTo),
    'an unrecognised API control plane must be refused — the token POST carries the client secret');
  const badApicpMsg = decodeURIComponent(badApicp.redirectedTo);
  assert.ok(!badApicpMsg.includes(FAKE_SECRET), 'and must not echo the secret back');
  assert.ok(!badApicpMsg.includes('attacker.example'),
    'the refusal message must not reflect the attacker-supplied host back into the browser');

  // A subdomain that is a whole URL is not a host label, so it is the same refusal.
  const urlAsSub = await call('get', '/sharefile/callback', {
    query: {
      code: 'sf-auth-code', state: 'popup', subdomain: 'https://evil.example/', apicp: 'sf-api.com',
    },
  });
  assert.ok(urlAsSub.redirectedTo && /error=sharefile/.test(urlAsSub.redirectedTo),
    'a subdomain that is not a bare host label must be refused');

  assert.strictEqual(tokenStore.getAllConnectedAccounts().length, before,
    'no partial account may be recorded by a callback that never reached ShareFile');

  console.log('  callback refuses a missing subdomain and a non-allow-listed apicp: ok');
  // ── Rule 5/7: the accounts list exposes email only ─────────────────────────
  tokenStore.setShareFileToken({
    email: 'Zara@Storefuze.com',
    accessToken: 'sf-access-token-value',
    refreshToken: 'sf-refresh-token-value',
    expiresAt: Date.now() + 3600000,
    subdomain: 'storefuze',
    apiHost: 'https://storefuze.sf-api.com',
    accountId: 'sf-user-id',
  });

  const accounts = tokenStore.getAllConnectedAccounts();
  const sf = accounts.filter((a) => a.provider === 'sharefile');
  assert.strictEqual(sf.length, 1, 'exactly one ShareFile account entry');
  assert.strictEqual(sf[0].email, 'zara@storefuze.com',
    'the account key is lowercased, so the same account connected twice is one entry, not two');
  assert.deepStrictEqual(Object.keys(sf[0]).sort(), ['connectedAt', 'email', 'provider'],
    'the accounts payload carries provider, email and connectedAt only');

  const accountsJson = JSON.stringify(accounts);
  for (const secret of ['sf-access-token-value', 'sf-refresh-token-value', 'storefuze.sf-api.com',
    FAKE_SECRET]) {
    assert.ok(!accountsJson.includes(secret),
      `GET /api/auth/accounts must not expose ${secret.slice(0, 12)}…`);
  }

  const status = tokenStore.getShareFileStatus();
  assert.strictEqual(status.connected, true);
  assert.deepStrictEqual(status.emails, ['zara@storefuze.com']);
  const statusJson = JSON.stringify(status);
  assert.ok(!statusJson.includes('sf-access-token-value')
    && !statusJson.includes('sf-refresh-token-value')
    && !statusJson.includes('sf-api.com'),
    'GET /api/auth/status must not expose a token or the account host');

  // The stored entry keeps the host the CALLBACK reported. A token with no host cannot be spent:
  // every ShareFile call goes to https://{subdomain}.{apicp}, and after this point that is the
  // only record of it — there is no env var to fall back on.
  const stored = tokenStore.getShareFileToken('zara@storefuze.com');
  assert.strictEqual(stored.subdomain, 'storefuze', 'the host is persisted, just not published');
  assert.strictEqual(stored.refreshToken, 'sf-refresh-token-value');

  console.log('  accounts and status payloads expose email only: ok');

  // ── Rule 7: signout returns nothing but success, and removes the account ───
  const signedOut = await call('post', '/sharefile/signout', {
    body: { email: 'zara@storefuze.com' },
  });
  assert.deepStrictEqual(signedOut.body, { success: true },
    'signout answers { success: true } and nothing else');
  assert.strictEqual(
    tokenStore.getAllConnectedAccounts().filter((a) => a.provider === 'sharefile').length, 0,
    'disconnecting must remove the account, so the wizard Source row disappears on the next poll'
  );
  assert.strictEqual(tokenStore.getShareFileToken('zara@storefuze.com'), null);

  // A signout with no email must not throw and must not clear anybody else.
  const emptySignout = await call('post', '/sharefile/signout', { body: {} });
  assert.deepStrictEqual(emptySignout.body, { success: true });

  console.log('  signout removes the account and leaks nothing: ok');

  // The real store file must be byte-identical: it holds live connected accounts.
  const diskAfter = realExistsSync.call(fs, TOKEN_FILE)
    ? realReadFileSync.call(fs, TOKEN_FILE, 'utf8')
    : null;
  assert.strictEqual(diskAfter, diskBefore,
    'this test must never write backend/data/oauth-tokens.json — it holds real accounts');

  Object.assign(env, savedEnv);

  // ── Rule 9: the content-provider list ─────────────────────────────────────
  //
  // Masked for THIS pair: isContentProvidersFor matches on the destination `sharepoint`, so
  // sharefile→sharepoint behaves the same either way. It bites on a pair with no listed side.
  assert.ok(orchestrator.CONTENT_PROVIDERS.includes('sharefile'),
    "CONTENT_PROVIDERS must contain 'sharefile'");
  assert.strictEqual(
    orchestrator.isContentProvidersFor({
      sourceProvider: 'sharefile', destinationProvider: 'sharefile',
    }),
    true,
    'a ShareFile source must be recognised as content regardless of destination — otherwise a '
    + 'future ShareFile→ShareFile run would be validated as mail'
  );
  assert.strictEqual(
    orchestrator.isContentProvidersFor({
      sourceProvider: 'google', destinationProvider: 'microsoft',
    }),
    false,
    'mail pairs are unaffected by the addition'
  );

  console.log('  sharefile is a recognised content provider: ok');

  // ── Rules 12-13: cloud resolution ─────────────────────────────────────────
  //
  // The live qarelease list on 2026-09-09.
  const CLOUDS = [
    {
      id: '6aa10605b17d0e315c812361',
      cloudName: 'SHAREFILE_BUSINESS',
      emailId: 'zara@storefuze.com',
    },
    {
      id: 'sp-gajha',
      cloudName: 'SHAREPOINT_ONLINE_BUSINESS',
      emailId: 'granger@gajha.com',
    },
  ];

  const resolved = mc.findCloudId(CLOUDS, 'zara@storefuze.com', 'sharefile');
  assert.ok(resolved, "the 'sharefile' hint must resolve the registered ShareFile cloud");
  assert.strictEqual(resolved.id, '6aa10605b17d0e315c812361',
    'squash("SHAREFILE_BUSINESS") is SHAREFILEBUSINESS, which starts with SHAREFILE — so the '
    + 'cloud resolves natively and needs no HINT_ALIASES entry');
  assert.strictEqual(resolved.cloudName, 'SHAREFILE_BUSINESS');

  // The destination half of the pair is untouched by the new hint.
  const dest = mc.findCloudId(CLOUDS, 'granger@gajha.com', 'sharepoint');
  assert.strictEqual(dest.id, 'sp-gajha', 'the SharePoint destination still resolves as before');

  // Rule 12 — the retired `citrix` key must not resolve. It is kept inside CONTENT_HINTS on
  // purpose: no cloud name matches CITRIX, so dropping it from that set would not make the hint
  // fail, it would make it fall through to the cross-type email fallback and return
  // SHAREFILE_BUSINESS with only a warning. Refusing is the required behaviour for a retired key.
  const viaCitrix = mc.findCloudId(CLOUDS, 'zara@storefuze.com', 'citrix');
  assert.strictEqual(viaCitrix, null,
    "the retired 'citrix' key must resolve nothing — never a cloud picked by email");

  // Rule 13 — with no ShareFile cloud registered, refuse rather than substitute a family.
  // Measured before the fix: this returned BOX_BUSINESS by email, with a warning only.
  const NO_SHAREFILE = [
    { id: 'box-zara', cloudName: 'BOX_BUSINESS', emailId: 'zara@storefuze.com' },
    { id: 'gsuite-zara', cloudName: 'G_SUITE', emailId: 'zara@storefuze.com' },
  ];
  const substituted = mc.findCloudId(NO_SHAREFILE, 'zara@storefuze.com', 'sharefile');
  assert.strictEqual(substituted, null,
    "an unregistered ShareFile cloud must refuse, not migrate into Box — 'SHAREFILE' has to be in "
    + 'CONTENT_HINTS for the cross-family guard to cover it at all');

  // The guard must not have broken the families that were already protected.
  assert.strictEqual(
    mc.findCloudId(NO_SHAREFILE, 'zara@storefuze.com', 'box').id, 'box-zara',
    'box resolution is unaffected');
  assert.strictEqual(
    mc.findCloudId(NO_SHAREFILE, 'zara@storefuze.com', 'googledrive').id, 'gsuite-zara',
    'the googledrive → G_SUITE alias is unaffected');

  console.log('  sharefile resolves SHAREFILE_BUSINESS; citrix and a missing cloud refuse: ok');

  console.log('sharefileConnect.test.js: ok');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
