/**
 * OAuth2 routes for Google Workspace and Microsoft 365.
 *
 * Google:  GET /api/auth/google/url  →  redirect to Google consent
 *          GET /api/auth/google/callback  →  exchange code, store token
 *          POST /api/auth/google/signout  →  remove stored token
 *
 * Microsoft:  GET /api/auth/microsoft/url  →  redirect to Microsoft consent
 *             GET /api/auth/microsoft/callback  →  exchange code, store token
 *             POST /api/auth/microsoft/signout  →  remove stored token
 *
 * GET /api/auth/status  →  connection status for both providers
 */
const express = require('express');
const { google } = require('googleapis');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const tokenStore = require('../clients/oauthTokenStore');
// Used to verify Domain-Wide Delegation actually works before registering an account as DWD.
const driveClient = require('../clients/driveClient');
const { retryWithBackoff } = require('../utils/retry');
const logger = require('../utils/logger');

const router = express.Router();

// ─── Helpers ─────────────────────────────────────────────────────────────────

const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'http://localhost:3000';
const BACKEND_BASE = process.env.BACKEND_BASE || `http://localhost:${env.PORT || 5000}`;

function googleOAuthClient(tenant) {
  let clientId, clientSecret;
  if (tenant === '3') {
    clientId = env.GOOGLE_CLIENT_ID_3;
    clientSecret = env.GOOGLE_CLIENT_SECRET_3;
  } else if (tenant === '2') {
    clientId = env.GOOGLE_CLIENT_ID_2;
    clientSecret = env.GOOGLE_CLIENT_SECRET_2;
  } else {
    clientId = env.GOOGLE_CLIENT_ID;
    clientSecret = env.GOOGLE_CLIENT_SECRET;
  }
  return new google.auth.OAuth2(
    clientId,
    clientSecret,
    `${BACKEND_BASE}/api/auth/google/callback`
  );
}

const MS_REDIRECT_URI = `${BACKEND_BASE}/api/auth/microsoft/callback`;

function getMsTenantCreds(tenant) {
  if (tenant === '2') {
    return {
      clientId: env.GRAPH_CLIENT_ID_2,
      clientSecret: env.GRAPH_CLIENT_SECRET_2,
      oauthBase: `https://login.microsoftonline.com/${env.GRAPH_TENANT_ID_2 || 'common'}/oauth2/v2.0`,
    };
  }
  return {
    clientId: env.GRAPH_CLIENT_ID,
    clientSecret: env.GRAPH_CLIENT_SECRET,
    oauthBase: `https://login.microsoftonline.com/${env.GRAPH_TENANT_ID || 'common'}/oauth2/v2.0`,
  };
}
// Request mail + calendar + user-read delegated scopes (same as application permissions already in Azure AD).
const MS_SCOPES = [
  'openid',
  'email',
  'profile',
  'offline_access',
  'User.Read',
  'User.ReadBasic.All',   // allows listing all tenant users (delegated, admin consent)
  'Mail.ReadWrite',
  'Calendars.ReadWrite',
].join(' ');

// Microsoft Teams scopes for the message product (agent=message).
const MS_SCOPES_MESSAGE = [
  'openid', 'email', 'profile', 'offline_access',
  'User.Read', 'User.ReadBasic.All',
  'Team.ReadBasic.All', 'Channel.ReadBasic.All', 'ChannelMember.Read.All',
  'ChannelMessage.Send', 'ChannelMessage.Read.All',
  'Chat.Read', 'Chat.ReadWrite', 'ChatMessage.Send',
  'Files.ReadWrite.All',
].join(' ');

// ─── Status ──────────────────────────────────────────────────────────────────

router.get('/status', (_req, res) => {
  res.json({
    google: tokenStore.getGoogleStatus(),
    microsoft: tokenStore.getMicrosoftStatus(),
    box: tokenStore.getBoxStatus(),
    dropbox: tokenStore.getDropboxStatus(),
    sharepoint: tokenStore.getSharePointStatus(),
    sharefile: tokenStore.getShareFileStatus(),
  });
});

/** List all connected accounts for the dropdown UI. */
router.get('/accounts', (_req, res) => {
  res.json({ accounts: tokenStore.getAllConnectedAccounts() });
});

// ─── Google OAuth ─────────────────────────────────────────────────────────────

router.get('/google/url', (req, res) => {
  const tenant = ['2', '3'].includes(req.query.tenant) ? req.query.tenant : '1';
  const clientId = tenant === '3' ? env.GOOGLE_CLIENT_ID_3 : tenant === '2' ? env.GOOGLE_CLIENT_ID_2 : env.GOOGLE_CLIENT_ID;
  const clientSecret = tenant === '3' ? env.GOOGLE_CLIENT_SECRET_3 : tenant === '2' ? env.GOOGLE_CLIENT_SECRET_2 : env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return res.status(400).json({ error: `Google OAuth not configured for tenant ${tenant} (GOOGLE_CLIENT_ID_${tenant} / GOOGLE_CLIENT_SECRET_${tenant} missing)` });
  }
  const isPopup = req.query.source === 'popup';
  // agent=message → Google Chat scopes (message product); agent=content → Drive scopes (content
  // product); else mail scopes (Gmail/Calendar). Without the content option a Drive migration could
  // only ever authenticate through Domain-Wide Delegation, because no OAuth path requested the Drive
  // scope at all.
  const agent = ['message', 'content'].includes(req.query.agent) ? req.query.agent : 'mail';
  // Encode source + tenant + agent in state so the callback reconstructs the right client/tag.
  const state = `${isPopup ? 'popup' : 'default'}:${tenant}:${agent}`;
  const identityScopes = [
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/directory.readonly',
  ];
  const mailScopes = [
    'https://mail.google.com/',
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/calendar',
    ...identityScopes,
  ];
  const messageScopes = [
    ...identityScopes,
    'https://www.googleapis.com/auth/chat.spaces.readonly',
    'https://www.googleapis.com/auth/chat.spaces',
    'https://www.googleapis.com/auth/chat.memberships.readonly',
    'https://www.googleapis.com/auth/chat.memberships',
    'https://www.googleapis.com/auth/chat.messages.readonly',
    'https://www.googleapis.com/auth/chat.messages',
    'https://www.googleapis.com/auth/chat.messages.reactions',
    'https://www.googleapis.com/auth/chat.delete',
    'https://www.googleapis.com/auth/drive.file',
  ];
  // Content product: full Drive access, covering My Drive AND Shared Drives (a Shared Drive is not a
  // separate scope — it needs `drive`, plus supportsAllDrives on each call).
  const contentScopes = [
    'https://www.googleapis.com/auth/drive',
    ...identityScopes,
  ];
  const scopeFor = { message: messageScopes, content: contentScopes, mail: mailScopes };

  const oAuth2Client = googleOAuthClient(tenant);
  const url = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopeFor[agent] || mailScopes,
    prompt: 'consent',
    state,
  });
  res.json({ url });
});

router.get('/google/callback', async (req, res) => {
  const { code, error, state } = req.query;
  // State format: "<source>:<tenant>:<agent>" — fall back to legacy "popup"/"default"
  const [source = 'default', tenant = '1', agentRaw = 'mail'] = (state || 'default:1:mail').split(':');
  // 'content' tags a Drive-scoped token so the content product can tell it from a mail token.
  const agent = ['message', 'content'].includes(agentRaw) ? agentRaw : 'mail';
  const isPopup = source === 'popup';
  const successBase = isPopup ? `${FRONTEND_ORIGIN}/oauth-callback` : `${FRONTEND_ORIGIN}/connect`;
  const errorBase = isPopup ? `${FRONTEND_ORIGIN}/oauth-callback` : `${FRONTEND_ORIGIN}/connect`;

  if (error) {
    logger.warn(`[auth] Google OAuth error: ${error}`);
    return res.redirect(`${errorBase}?error=google&message=${encodeURIComponent(error)}`);
  }
  if (!code) return res.status(400).send('Missing code');

  try {
    const oAuth2Client = googleOAuthClient(tenant);
    const { tokens } = await oAuth2Client.getToken(code);

    if (!tokens.refresh_token) {
      logger.warn('[auth] Google OAuth: no refresh_token in response.');
      return res.redirect(`${errorBase}?error=google&message=${encodeURIComponent('No refresh token received. Revoke app access in Google Account → Security → Third-party apps, then reconnect.')}`);
    }

    oAuth2Client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: oAuth2Client });
    const { data: userInfo } = await oauth2.userinfo.get();
    const email = userInfo.email;

    tokenStore.setGoogleToken(email, tokens.refresh_token, agent);
    logger.info(`[auth] Google account connected: ${email} (agent=${agent})`);

    res.redirect(`${successBase}?connected=google&email=${encodeURIComponent(email)}`);
  } catch (err) {
    logger.error(`[auth] Google callback error: ${err.message}`);
    res.redirect(`${errorBase}?error=google&message=${encodeURIComponent(err.message)}`);
  }
});

router.post('/google/signout', (req, res) => {
  const { email } = req.body;
  if (email) {
    tokenStore.removeGoogleToken(email);
    logger.info(`[auth] Google account disconnected: ${email}`);
  }
  res.json({ success: true });
});

// Registering DWD without checking it is how a dead Google account gets created: the claim is stored,
// every later Drive call fails with `unauthorized_client`, and the cause is invisible at the point of
// the mistake. Verify the service account can really impersonate the user first, and when it cannot,
// say so and point at the OAuth route that does work — /api/auth/google/url?agent=content.
router.post('/dwd', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });
  const normalized = email.trim().toLowerCase();

  const check = await driveClient.verifyDwd(normalized);
  if (!check.ok) {
    logger.warn(`[auth] DWD registration refused for ${normalized}: ${check.reason}`);
    return res.status(400).json({
      error: `${normalized} cannot be connected via Domain-Wide Delegation: ${check.reason}. `
        + 'Grant the service-account client id the Drive scope in the Google Admin console, or connect '
        + 'this account with OAuth instead — open /api/auth/google/url?agent=content and sign in as '
        + `${normalized}.`,
    });
  }

  tokenStore.setDwdAccount(normalized);
  logger.info(`[auth] DWD account registered (impersonation verified): ${normalized}`);
  res.json({ success: true });
});

router.delete('/dwd/:email', (req, res) => {
  const email = decodeURIComponent(req.params.email);
  tokenStore.removeGoogleToken(email);
  logger.info(`[auth] DWD account removed: ${email}`);
  res.json({ success: true });
});

// ─── Microsoft admin consent (app-only) ────────────────────────────────────────

const MS_ADMIN_CONSENT_REDIRECT = `${BACKEND_BASE}/api/auth/microsoft/admin-consent/callback`;
// Sign-in + admin-consent in one popup. `.default` against the `organizations`
// authority makes the signing-in admin consent to ALL the app's configured
// permissions (incl. application permissions) tenant-wide, while the code flow
// lets us read who signed in (email) and their tenant id from the returned token.
const MS_CONNECT_SCOPE = 'openid profile email offline_access https://graph.microsoft.com/.default';

function decodeJwt(token) {
  try {
    const p = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(p, 'base64').toString('utf8'));
  } catch { return {}; }
}

router.get('/microsoft/admin-consent', (req, res) => {
  if (!env.GRAPH_CLIENT_ID) {
    return res.status(400).json({ error: 'GRAPH_CLIENT_ID not configured' });
  }
  const isPopup = req.query.source === 'popup';
  const params = new URLSearchParams({
    client_id: env.GRAPH_CLIENT_ID,
    response_type: 'code',
    redirect_uri: MS_ADMIN_CONSENT_REDIRECT,
    response_mode: 'query',
    scope: MS_CONNECT_SCOPE,
    prompt: 'select_account',
    state: isPopup ? 'popup' : 'default',
  });
  res.json({ url: `https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?${params}` });
});

router.get('/microsoft/admin-consent/callback', async (req, res) => {
  const { code, error, error_description, state } = req.query;
  const isPopup = String(state || '').startsWith('popup');
  const base = isPopup ? `${FRONTEND_ORIGIN}/oauth-callback` : `${FRONTEND_ORIGIN}/connect`;

  if (error) {
    logger.warn(`[auth] Microsoft connect error: ${error} — ${error_description}`);
    return res.redirect(`${base}?error=microsoft&message=${encodeURIComponent(error_description || error)}`);
  }
  if (!code) return res.redirect(`${base}?error=microsoft&message=${encodeURIComponent('No authorization code returned')}`);

  try {
    const tokenRes = await axios.post(
      'https://login.microsoftonline.com/organizations/oauth2/v2.0/token',
      new URLSearchParams({
        client_id: env.GRAPH_CLIENT_ID,
        client_secret: env.GRAPH_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: MS_ADMIN_CONSENT_REDIRECT,
        scope: MS_CONNECT_SCOPE,
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const claims = decodeJwt(tokenRes.data.id_token || '');
    const email = String(claims.preferred_username || claims.email || claims.upn || '').toLowerCase();
    const tenant = claims.tid || null;
    if (!email) {
      return res.redirect(`${base}?error=microsoft&message=${encodeURIComponent('Signed in but could not read the admin email')}`);
    }
    tokenStore.setMicrosoftConsent(email, tenant);
    logger.info(`[auth] Microsoft connected: ${email}${tenant ? ` (tenant ${tenant})` : ''}`);
    return res.redirect(`${base}?connected=microsoft&email=${encodeURIComponent(email)}`);
  } catch (err) {
    logger.error(`[auth] Microsoft connect callback error: ${err.response?.data?.error_description || err.message}`);
    return res.redirect(`${base}?error=microsoft&message=${encodeURIComponent(err.response?.data?.error_description || err.message)}`);
  }
});

// ─── Microsoft OAuth ──────────────────────────────────────────────────────────

router.get('/microsoft/url', (req, res) => {
  const tenant = req.query.tenant === '2' ? '2' : '1';
  const { clientId, oauthBase } = getMsTenantCreds(tenant);
  if (!clientId) {
    return res.status(400).json({ error: `Microsoft OAuth not configured for tenant ${tenant} (GRAPH_CLIENT_ID${tenant === '2' ? '_2' : ''} missing)` });
  }
  const isPopup = req.query.source === 'popup';
  const agent = req.query.agent === 'message' ? 'message' : 'mail';
  const state = `${isPopup ? 'popup' : 'default'}:${tenant}:${agent}`;
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: MS_REDIRECT_URI,
    scope: agent === 'message' ? MS_SCOPES_MESSAGE : MS_SCOPES,
    response_mode: 'query',
    prompt: 'select_account',
    state,
  });
  res.json({ url: `${oauthBase}/authorize?${params}` });
});

router.get('/microsoft/callback', async (req, res) => {
  const { code, error, error_description, state } = req.query;
  const [source = 'default', tenant = '1', agentRaw = 'mail'] = (state || 'default:1:mail').split(':');
  const agent = agentRaw === 'message' ? 'message' : 'mail';
  const isPopup = source === 'popup';
  const successBase = isPopup ? `${FRONTEND_ORIGIN}/oauth-callback` : `${FRONTEND_ORIGIN}/connect`;
  const errorBase = isPopup ? `${FRONTEND_ORIGIN}/oauth-callback` : `${FRONTEND_ORIGIN}/connect`;

  if (error) {
    logger.warn(`[auth] Microsoft OAuth error: ${error} — ${error_description}`);
    return res.redirect(`${errorBase}?error=microsoft&message=${encodeURIComponent(error_description || error)}`);
  }
  if (!code) return res.status(400).send('Missing code');

  try {
    const { clientId, clientSecret, oauthBase } = getMsTenantCreds(tenant);
    const params = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: MS_REDIRECT_URI,
      grant_type: 'authorization_code',
    });

    const tokenRes = await axios.post(
      `${oauthBase}/token`,
      params.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token, refresh_token, expires_in } = tokenRes.data;

    const userRes = await axios.get('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const email = userRes.data.mail || userRes.data.userPrincipalName;

    tokenStore.setMicrosoftToken({
      email,
      accessToken: access_token,
      refreshToken: refresh_token,
      expiresAt: Date.now() + expires_in * 1000,
      agent, // 'message' tags a Teams-scoped token so hasTeamsToken() recognizes it
    });
    logger.info(`[auth] Microsoft account connected: ${email} (agent=${agent})`);

    res.redirect(`${successBase}?connected=microsoft&email=${encodeURIComponent(email)}`);
  } catch (err) {
    logger.error(`[auth] Microsoft callback error: ${err.message}`);
    res.redirect(`${errorBase}?error=microsoft&message=${encodeURIComponent(err.message)}`);
  }
});

router.post('/microsoft/signout', (req, res) => {
  const { email } = req.body;
  logger.info(`[auth] Microsoft account disconnected: ${email || 'all'}`);
  tokenStore.removeMicrosoftToken(email || null);
  res.json({ success: true });
});

// ─── Microsoft LOGIN for the QA tool (PKCE) — issues our own app JWT ───────────
// The browser runs the PKCE flow and redirects to Microsoft; it then POSTs the
// returned { code, verifier, redirectUri } here. We exchange the code for a
// Microsoft token (confidential client + PKCE), read the signed-in user's profile
// from Graph, and return an app JWT the frontend stores to gate the UI. This is
// the "Azure AD Cloudfuze domain" app, separate from the Graph cloud-connection app.
router.post('/microsoft/exchange', async (req, res) => {
  const { code, verifier, redirectUri } = req.body || {};
  if (!code || !verifier || !redirectUri) {
    return res.status(400).json({ error: 'code, verifier and redirectUri are required' });
  }
  if (!env.AZURE_CLIENT_ID || !env.AZURE_CLIENT_SECRET) {
    return res.status(500).json({ error: 'Microsoft login not configured (AZURE_CLIENT_ID / AZURE_CLIENT_SECRET missing)' });
  }
  if (!env.JWT_SECRET) {
    return res.status(500).json({ error: 'JWT_SECRET not configured on the server' });
  }
  const tenant = env.AZURE_TENANT_ID || 'common';
  try {
    // 1. Exchange the authorization code for a Microsoft access token.
    const tokenRes = await axios.post(
      `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: env.AZURE_CLIENT_ID,
        client_secret: env.AZURE_CLIENT_SECRET,
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, validateStatus: () => true }
    );
    if (tokenRes.status !== 200 || !tokenRes.data.access_token) {
      const msg = tokenRes.data?.error_description || tokenRes.data?.error || 'Token exchange failed';
      logger.warn(`[auth] Microsoft login token exchange failed: ${msg}`);
      return res.status(401).json({ error: msg });
    }

    // 2. Read the signed-in user's profile from Microsoft Graph.
    const graphRes = await axios.get('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${tokenRes.data.access_token}` },
      validateStatus: () => true,
    });
    if (graphRes.status !== 200) {
      return res.status(401).json({ error: 'Could not fetch user from Microsoft Graph' });
    }
    const email = String(graphRes.data.mail || graphRes.data.userPrincipalName || '').toLowerCase().trim();
    const name = graphRes.data.displayName || '';
    if (!email) return res.status(400).json({ error: 'Could not retrieve email from Microsoft account' });

    // 3. Issue our own short-lived app JWT.
    const token = jwt.sign({ email, name }, env.JWT_SECRET, { expiresIn: '8h' });
    logger.info(`[auth] Microsoft login: ${email} signed in`);
    res.json({ success: true, token, user: { email, name } });
  } catch (err) {
    logger.error(`[auth] Microsoft login exchange error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── Box OAuth ────────────────────────────────────────────────────────────────

const BOX_AUTH_URL = 'https://account.box.com/api/oauth2/authorize';
const BOX_TOKEN_URL = 'https://api.box.com/oauth2/token';
const BOX_API_ME = 'https://api.box.com/2.0/users/me';

router.get('/box/url', (req, res) => {
  const clientId = process.env.BOX_CLIENT_ID;
  if (!clientId) return res.status(400).json({ error: 'BOX_CLIENT_ID not configured' });
  const isPopup = req.query.source === 'popup';
  const state = isPopup ? 'popup' : 'default';
  const redirectUri = `${BACKEND_BASE}/api/auth/box/callback`;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    state,
  });
  res.json({ url: `${BOX_AUTH_URL}?${params}` });
});

router.get('/box/callback', async (req, res) => {
  const { code, error, state } = req.query;
  const isPopup = state === 'popup';
  const successBase = isPopup ? `${FRONTEND_ORIGIN}/oauth-callback` : `${FRONTEND_ORIGIN}/connect`;
  const errorBase = isPopup ? `${FRONTEND_ORIGIN}/oauth-callback` : `${FRONTEND_ORIGIN}/connect`;

  if (error) {
    logger.warn(`[auth] Box OAuth error: ${error}`);
    return res.redirect(`${errorBase}?error=box&message=${encodeURIComponent(error)}`);
  }
  if (!code) return res.status(400).send('Missing code');

  try {
    const redirectUri = `${BACKEND_BASE}/api/auth/box/callback`;
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: process.env.BOX_CLIENT_ID,
      client_secret: process.env.BOX_CLIENT_SECRET,
      redirect_uri: redirectUri,
    });
    const tokenRes = await axios.post(BOX_TOKEN_URL, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const { access_token, refresh_token, expires_in } = tokenRes.data;

    const meRes = await axios.get(BOX_API_ME, {
      headers: { Authorization: `Bearer ${access_token}` },
      params: { fields: 'id,login,name' },
    });
    const email = meRes.data.login;

    tokenStore.setBoxToken({
      email,
      accessToken: access_token,
      refreshToken: refresh_token,
      expiresAt: Date.now() + expires_in * 1000,
    });
    logger.info(`[auth] Box account connected: ${email}`);

    res.redirect(`${successBase}?connected=box&email=${encodeURIComponent(email)}`);
  } catch (err) {
    logger.error(`[auth] Box callback error: ${err.message}`);
    res.redirect(`${errorBase}?error=box&message=${encodeURIComponent(err.message)}`);
  }
});

// ─── Dropbox OAuth ────────────────────────────────────────────────────────────
//
// Same shape as the Box flow above. Two Dropbox-specific details, both of which produce errors
// that point somewhere else when got wrong:
//
//   token_access_type=offline — without it Dropbox returns ONLY a 4-hour access token and no
//     refresh token. Four hours is shorter than a content validation run, so the run dies part way
//     through with a 401 that reads like a permissions problem.
//   users/get_current_account takes no arguments, and Dropbox rejects the call outright if a
//     Content-Type header is present. The header is stripped rather than set.

const DROPBOX_AUTH_URL = 'https://www.dropbox.com/oauth2/authorize';
const DROPBOX_TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
const DROPBOX_API_ME = 'https://api.dropboxapi.com/2/users/get_current_account';
// Team-scoped equivalents — a team token cannot answer users/get_current_account.
const DROPBOX_API_TEAM_ADMIN = 'https://api.dropboxapi.com/2/team/token/get_authenticated_admin';
const DROPBOX_API_TEAM_INFO = 'https://api.dropboxapi.com/2/team/get_info';

router.get('/dropbox/url', (req, res) => {
  const clientId = env.DROPBOX_APP_KEY;
  if (!clientId) return res.status(400).json({ error: 'DROPBOX_APP_KEY not configured' });
  const isPopup = req.query.source === 'popup';
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${BACKEND_BASE}/api/auth/dropbox/callback`,
    response_type: 'code',
    token_access_type: 'offline',
    state: isPopup ? 'popup' : 'default',
  });
  res.json({ url: `${DROPBOX_AUTH_URL}?${params}` });
});

router.get('/dropbox/callback', async (req, res) => {
  const { code, error, state } = req.query;
  const isPopup = state === 'popup';
  const base = isPopup ? `${FRONTEND_ORIGIN}/oauth-callback` : `${FRONTEND_ORIGIN}/connect`;

  if (error) {
    logger.warn(`[auth] Dropbox OAuth error: ${error}`);
    return res.redirect(`${base}?error=dropbox&message=${encodeURIComponent(error)}`);
  }
  if (!code) return res.status(400).send('Missing code');

  try {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: env.DROPBOX_APP_KEY,
      client_secret: env.DROPBOX_APP_SECRET,
      redirect_uri: `${BACKEND_BASE}/api/auth/dropbox/callback`,
    });
    const tokenRes = await axios.post(DROPBOX_TOKEN_URL, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const { access_token: accessToken, refresh_token: refreshToken, expires_in: expiresIn } = tokenRes.data;

    // Who is this token for?
    //
    // A TEAM-scoped app (this one — it holds team_data.member/members.read, which is what makes
    // Dropbox-API-Select-User work) gets a token for the whole team, and users/get_current_account
    // refuses it outright: "This API function operates on a single Dropbox account, but the OAuth 2
    // access token you provided is for an entire Dropbox Business team." The team equivalent is
    // team/token/get_authenticated_admin, which names the admin who authorised the app.
    //
    // An individually-scoped app answers the other way round, so both are tried.
    //
    // Both calls take no arguments, and Dropbox is strict about how that is expressed. Measured
    // against the live API: `Content-Type: application/json` with a null body is accepted; removing
    // the header (axios re-adds its form default) and `text/plain; charset=dropbox-cors-hack` are
    // both rejected — the first for a bad Content-Type, the second for an undecodable body.
    const noBody = { 'Content-Type': 'application/json' };
    const auth = { Authorization: `Bearer ${accessToken}` };
    let email = null;
    let teamName = null;
    let accountId = null;
    try {
      const adminRes = await axios.post(DROPBOX_API_TEAM_ADMIN, null, { headers: { ...auth, ...noBody } });
      const profile = adminRes.data.admin_profile || {};
      email = profile.email || null;
      accountId = profile.team_member_id || null;
      const infoRes = await axios.post(DROPBOX_API_TEAM_INFO, null, { headers: { ...auth, ...noBody } });
      teamName = infoRes.data.name || null;
    } catch {
      const meRes = await axios.post(DROPBOX_API_ME, null, { headers: { ...auth, ...noBody } });
      email = meRes.data.email || null;
      accountId = meRes.data.account_id || null;
      teamName = meRes.data.team ? meRes.data.team.name : null;
    }
    if (!email) throw new Error('Dropbox did not report an account email for this token');

    tokenStore.setDropboxToken({
      email,
      accessToken,
      refreshToken: refreshToken || null,
      expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : null,
      accountId,
      teamName,
    });
    logger.info(`[auth] Dropbox account connected: ${email}${teamName ? ` (team ${teamName})` : ''}`);

    res.redirect(`${base}?connected=dropbox&email=${encodeURIComponent(email)}`);
  } catch (err) {
    const detail = err.response && err.response.data;
    const msg = typeof detail === 'string'
      ? detail
      : ((detail && detail.error_description) || err.message);
    // Dropbox puts the actual reason in the response body — `error` plus `error_description`.
    // Logging only err.message reduces every failure to "status code 400", which names nothing.
    logger.error(
      `[auth] Dropbox callback error: ${err.message}`
      + (detail ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : '')
    );
    res.redirect(`${base}?error=dropbox&message=${encodeURIComponent(msg)}`);
  }
});

router.post('/dropbox/signout', (req, res) => {
  const { email } = req.body;
  if (email) {
    tokenStore.removeDropboxToken(email);
    logger.info(`[auth] Dropbox account disconnected: ${email}`);
  }
  res.json({ success: true });
});

// ─── Citrix ShareFile OAuth ───────────────────────────────────────────────────
//
// Same popup shape as the Box and Dropbox flows above. Provider key `sharefile`, label
// "Citrix ShareFile" — one product, and CloudFuze registers its cloud as SHAREFILE_BUSINESS.
//
// Endpoints per https://api.sharefile.com/gettingstarted/oauth2:
//
//   sign-in   GET  https://secure.sharefile.com/oauth/authorize
//                  ?response_type=code&client_id=…&redirect_uri=…&state=…
//   callback  the redirect_uri above, with code, state, subdomain, apicp, appcp, expires_in, h
//   token     POST https://{subdomain}.{apicp}/oauth/token
//                  grant_type=authorization_code&code=…&client_id=…&client_secret=…
//
// The authorize host is a SINGLE well-known host, not a per-account one. An earlier draft of this
// file used https://<subdomain>.sharefile.com and required a SHAREFILE_SUBDOMAIN env var to build
// it; both were wrong. The account subdomain is an OUTPUT of the flow — it arrives on the callback
// together with `apicp`, the API control plane — so the token host is assembled from those two
// values and the env var was deleted rather than left as required-looking dead config.
//
// `h` is an HMAC signature that the documented callback carries. The getting-started page lists the
// parameter but does NOT publish a verification algorithm or the key to verify it with, so nothing
// here verifies it — implementing a guessed signature check would either reject valid callbacks or
// provide false assurance. What stands in for it: the token POST goes only to an ALLOW-LISTED
// control plane (see below), the code is worthless without our client secret, and no account is
// stored until both the token exchange and the profile read succeed against a ShareFile host.
// If Citrix documents the algorithm, verifying `h` belongs here, before the token exchange.
//
// STILL UNVERIFIED against a live tenant (no ShareFile OAuth application exists yet —
// requirements 003, blocker P3): every response shape. Specifically the token response field names
// (access_token / refresh_token / expires_in / subdomain / apicp), and the profile call
// GET /sf/v3/Users(me) → { Email, Id }. The getting-started page shows only Items(home) as an
// example call, so Users(me) comes from the v3 API surface rather than from that page, and no
// response from it has been observed.

const SHAREFILE_AUTHORIZE_URL = 'https://secure.sharefile.com/oauth/authorize';
// The API control plane is the host SUFFIX the callback supplies. It is allow-listed, not merely
// pattern-checked, because the token POST carries our client_secret: a callback arriving with
// apicp=attacker.example would otherwise make this server post the secret to that host. Every
// documented example uses sf-api.com. A tenant on another control plane fails with the value named
// in the log, which is a one-line addition here once it has been confirmed with Citrix — a far
// better outcome than mailing the secret to whatever the query string asked for.
const SHAREFILE_ALLOWED_APICP = new Set(['sf-api.com']);
const SHAREFILE_DEFAULT_APICP = 'sf-api.com';
// A subdomain is one host label: letters, digits and hyphens. Anything else (a dot, a slash, a
// whole URL) would be pasted straight into a request host.
const SHAREFILE_HOST_LABEL_RE = /^[A-Za-z0-9-]+$/;

/** A validated single host label, or null when the value is absent or not a bare label. */
function shareFileLabel(value) {
  const s = String(value == null ? '' : value).trim();
  return SHAREFILE_HOST_LABEL_RE.test(s) ? s : null;
}

/**
 * The ShareFile REST/token host for a callback-supplied subdomain and control plane.
 * Returns null when the control plane is not allow-listed — the caller must fail, not guess.
 */
function shareFileApiHost(subdomain, apicp) {
  const raw = String(apicp == null ? '' : apicp).trim();
  // Absent apicp falls back to the documented default; a PRESENT but unknown one does not.
  const cp = raw || SHAREFILE_DEFAULT_APICP;
  if (!SHAREFILE_ALLOWED_APICP.has(cp)) return null;
  return `https://${subdomain}.${cp}`;
}

/**
 * Strip the configured client secret out of anything about to be logged or redirected.
 * ShareFile echoes the submitted form back in some token-endpoint errors, and the logger's
 * masking covers email addresses only — a secret in a log line or in a callback query string
 * would be a real leak, not a cosmetic one.
 */
function scrubShareFileSecret(text) {
  const s = String(text == null ? '' : text);
  const secret = env.SHAREFILE_CLIENT_SECRET;
  if (!secret) return s;
  return s.split(secret).join('<redacted>');
}

// The redirect URI, in one place. This exact string must be registered in Citrix's API Key
// Generator; a mismatch makes the key unusable, and the failure surfaces at the end of sign-in
// rather than at the start.
//
// SHAREFILE_REDIRECT_URI overrides it, and exists because ShareFile appears to require an HTTPS
// callback — every app registered on the live tenant uses one (an ngrok tunnel, or
// https://staging.cloudfuze.com/...), never http://localhost. So local development needs a tunnel.
//
// The override is ShareFile-ONLY on purpose. The obvious alternative — repointing BACKEND_BASE at
// the tunnel — would move the redirect for Google, Microsoft, Box, Dropbox and Slack too, all of
// which are registered against http://localhost:5000. That would silently break every already
// connected cloud to fix the one that is not.
//
// Set it to the tunnel URL that is registered on the ShareFile app, e.g.
//   SHAREFILE_REDIRECT_URI=https://<your-domain>.ngrok-free.dev/api/auth/sharefile/callback
// and point the tunnel at this backend's port. Unset, the localhost default is kept so nothing
// changes for anyone not using ShareFile.
const SHAREFILE_REDIRECT_URI =
  env.SHAREFILE_REDIRECT_URI || `${BACKEND_BASE}/api/auth/sharefile/callback`;

router.get('/sharefile/url', (req, res) => {
  // Both halves of the app credential are checked here, and named separately. The secret is not
  // used until the callback, but starting a sign-in without it guarantees the exchange fails after
  // the user has already typed their ShareFile password — so it is reported before the popup opens.
  if (!env.SHAREFILE_CLIENT_ID) {
    return res.status(400).json({ error: 'SHAREFILE_CLIENT_ID not configured' });
  }
  if (!env.SHAREFILE_CLIENT_SECRET) {
    return res.status(400).json({ error: 'SHAREFILE_CLIENT_SECRET not configured' });
  }
  const isPopup = req.query.source === 'popup';
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: env.SHAREFILE_CLIENT_ID,
    redirect_uri: SHAREFILE_REDIRECT_URI,
    state: isPopup ? 'popup' : 'default',
  });
  res.json({ url: `${SHAREFILE_AUTHORIZE_URL}?${params}` });
});

router.get('/sharefile/callback', async (req, res) => {
  const { code, error, state, subdomain: cbSubdomain, apicp } = req.query;
  const isPopup = state === 'popup';
  const base = isPopup ? `${FRONTEND_ORIGIN}/oauth-callback` : `${FRONTEND_ORIGIN}/connect`;
  const fail = (message) => res.redirect(
    `${base}?error=sharefile&message=${encodeURIComponent(scrubShareFileSecret(message))}`
  );

  if (error) {
    logger.warn(`[auth] ShareFile OAuth error: ${error}`);
    return fail(String(error));
  }
  if (!code) return res.status(400).send('Missing code');

  if (!env.SHAREFILE_CLIENT_ID || !env.SHAREFILE_CLIENT_SECRET) {
    logger.error('[auth] ShareFile callback: SHAREFILE_CLIENT_ID / SHAREFILE_CLIENT_SECRET are '
      + 'not configured, so the authorization code cannot be exchanged');
    return fail('SHAREFILE_CLIENT_ID not configured');
  }

  // The token host comes from the callback and nowhere else. There is no env fallback by design:
  // guessing an account host would send the code and the client secret somewhere unrelated.
  const subdomain = shareFileLabel(cbSubdomain);
  if (!subdomain) {
    logger.error('[auth] ShareFile callback carried no usable `subdomain` parameter, so there is '
      + 'no account host to exchange the code against. Expected one host label (e.g. "storefuze") '
      + 'alongside the code; got '
      + (cbSubdomain ? `"${String(cbSubdomain).slice(0, 40)}"` : 'nothing'));
    return fail('ShareFile did not return an account subdomain on the callback, so the sign-in '
      + 'could not be completed');
  }
  const apiHost = shareFileApiHost(subdomain, apicp);
  if (!apiHost) {
    logger.error('[auth] ShareFile callback asked for an unrecognised API control plane '
      + `"${String(apicp).slice(0, 60)}". Refusing to post the client secret to it. Add the value `
      + 'to SHAREFILE_ALLOWED_APICP in authRoutes.js once Citrix has confirmed it is theirs.');
    return fail('ShareFile returned an unrecognised API host, so the sign-in was stopped before '
      + 'any credential was sent');
  }

  try {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code: String(code),
      client_id: env.SHAREFILE_CLIENT_ID,
      client_secret: env.SHAREFILE_CLIENT_SECRET,
    });
    // retryWithBackoff stops on 4xx (429 excepted), so a bad or already-spent code fails at once
    // instead of being replayed.
    const tokenRes = await retryWithBackoff(
      () => axios.post(`${apiHost}/oauth/token`, params.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }),
      { label: 'ShareFile token exchange', maxRetries: 3 }
    );
    const {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: expiresIn,
    } = tokenRes.data || {};
    if (!accessToken) throw new Error('ShareFile returned no access token for this code');

    // The token response repeats subdomain/apicp. Honoured when both are usable, because it is the
    // more authoritative of the two — but it goes through the same allow-list as the callback.
    const tokenSub = shareFileLabel(tokenRes.data.subdomain);
    const host = (tokenSub && shareFileApiHost(tokenSub, tokenRes.data.apicp || apicp)) || apiHost;

    const meRes = await retryWithBackoff(
      () => axios.get(`${host}/sf/v3/Users(me)`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
      { label: 'ShareFile Users(me)', maxRetries: 3 }
    );
    const profile = meRes.data || {};
    const email = profile.Email || profile.email || null;
    if (!email) throw new Error('ShareFile did not report an account email for this token');

    tokenStore.setShareFileToken({
      email,
      accessToken,
      refreshToken: refreshToken || null,
      expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : null,
      subdomain: tokenSub || subdomain,
      apiHost: host,
      accountId: profile.Id || null,
    });
    logger.info(`[auth] ShareFile account connected: ${email} (host ${host})`);

    res.redirect(`${base}?connected=sharefile&email=${encodeURIComponent(email)}`);
  } catch (err) {
    // Name the host that was tried. A wrong subdomain fails as ENOTFOUND or 404, and without the
    // host in the message that reads as a credential problem rather than a routing one.
    const detail = err.response && err.response.data;
    const body = typeof detail === 'string'
      ? detail
      : ((detail && (detail.error_description || detail.message)) || '');
    const rendered = typeof body === 'string' ? body : JSON.stringify(body);
    const msg = scrubShareFileSecret(
      `${err.message}${rendered ? ` — ${rendered}` : ''} (host ${apiHost})`
    );
    logger.error(`[auth] ShareFile callback error: ${msg}`);
    fail(msg);
  }
});

router.post('/sharefile/signout', (req, res) => {
  const { email } = req.body;
  if (email) {
    tokenStore.removeShareFileToken(email);
    logger.info(`[auth] ShareFile account disconnected: ${email}`);
  }
  res.json({ success: true });
});

/** Simple email-only connect (no OAuth required — uses BOX_DEVELOPER_TOKEN from env). */
router.post('/box/connect', (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });
  const key = email.trim().toLowerCase();
  const existing = tokenStore.getBoxToken(key);
  tokenStore.setBoxToken({
    email: key,
    accessToken: existing?.accessToken || null,
    refreshToken: existing?.refreshToken || null,
    expiresAt: existing?.expiresAt || null,
  });
  logger.info(`[auth] Box account registered: ${key}`);
  res.json({ success: true, email: key });
});

router.post('/box/signout', (req, res) => {
  const { email } = req.body;
  if (email) {
    tokenStore.removeBoxToken(email);
    logger.info(`[auth] Box account disconnected: ${email}`);
  }
  res.json({ success: true });
});

// ─── SharePoint Online ────────────────────────────────────────────────────────

/** Email-only connect — uses same Microsoft Graph credentials already configured. */
router.post('/sharepoint/connect', (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });
  const key = email.trim().toLowerCase();
  const existing = tokenStore.getSharePointToken(key);
  tokenStore.setSharePointToken({
    email: key,
    accessToken: existing?.accessToken || null,
    refreshToken: existing?.refreshToken || null,
    expiresAt: existing?.expiresAt || null,
  });
  logger.info(`[auth] SharePoint account registered: ${key}`);
  res.json({ success: true, email: key });
});

router.post('/sharepoint/signout', (req, res) => {
  const { email } = req.body;
  if (email) {
    tokenStore.removeSharePointToken(email);
    logger.info(`[auth] SharePoint account disconnected: ${email}`);
  }
  res.json({ success: true });
});

// ─── Slack (message product) ────────────────────────────────────────────────────
// OAuth popup (needs SLACK_CLIENT_ID/SECRET) + direct user-token install (xoxp-…),
// which works without a Slack app — used by the Connect Clouds "Slack" tile.
const SLACK_REDIRECT_PATH = '/api/auth/slack/callback';
// Valid Slack USER token scopes only. (chat:write.customize is bot-only; the bare
// *:write channel-management scopes are invalid as user scopes → "Invalid permissions".)
const SLACK_USER_SCOPES = [
  'users:read', 'users:read.email', 'users.profile:read', 'team:read',
  'channels:read', 'groups:read', 'im:read', 'mpim:read',
  'channels:history', 'groups:history', 'im:history', 'mpim:history',
  'chat:write',
  'files:read', 'files:write',
  'reactions:read', 'reactions:write',
  'pins:read', 'bookmarks:read',
  'search:read',
].join(',');

function slackRedirectUri() {
  const override = env.SLACK_REDIRECT_URI;
  if (override && String(override).trim()) return String(override).trim().replace(/\/+$/, '');
  return `${BACKEND_BASE}${SLACK_REDIRECT_PATH}`;
}

router.get('/slack/url', (req, res) => {
  const { SLACK_CLIENT_ID, SLACK_CLIENT_SECRET } = env;
  if (!SLACK_CLIENT_ID || !SLACK_CLIENT_SECRET) {
    return res.status(400).json({ error: 'Slack OAuth not configured. Set SLACK_CLIENT_ID/SLACK_CLIENT_SECRET in .env, or paste a user token instead.' });
  }
  const isPopup = req.query.source === 'popup';
  const origin = (req.query.origin || '').trim() || FRONTEND_ORIGIN;
  const state = `${isPopup ? 'popup' : 'default'}:message|${origin}`;
  const params = new URLSearchParams({
    client_id: SLACK_CLIENT_ID, user_scope: SLACK_USER_SCOPES, redirect_uri: slackRedirectUri(), state,
  });
  res.json({ url: `https://slack.com/oauth/v2/authorize?${params}` });
});

router.get('/slack/callback', async (req, res) => {
  const { code, error, state } = req.query;
  const [statePart = 'default:message', originPart = ''] = String(state || '').split('|');
  const [source = 'default'] = statePart.split(':');
  const isPopup = source === 'popup';
  const origin = originPart || FRONTEND_ORIGIN;
  const base = isPopup ? `${origin}/oauth-callback` : `${origin}/connect`;
  if (error) return res.redirect(`${base}?error=slack&message=${encodeURIComponent(error)}`);
  if (!code) return res.status(400).send('Missing code');
  try {
    const tokenParams = new URLSearchParams({
      client_id: env.SLACK_CLIENT_ID, client_secret: env.SLACK_CLIENT_SECRET, code, redirect_uri: slackRedirectUri(),
    });
    const tokenRes = await axios.post('https://slack.com/api/oauth.v2.access', tokenParams.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    const payload = tokenRes.data;
    if (!payload.ok) throw new Error(payload.error || 'oauth.v2.access failed');
    const userToken = payload.authed_user?.access_token;
    const userId = payload.authed_user?.id;
    if (!userToken || !userId) throw new Error('Slack did not return a user token (enable User Token Scopes).');
    let email = '';
    try {
      const infoRes = await axios.get('https://slack.com/api/users.info', { headers: { Authorization: `Bearer ${userToken}` }, params: { user: userId } });
      email = infoRes.data?.user?.profile?.email || '';
    } catch { /* ignore */ }
    if (!email) email = `${userId}@slack-local.invalid`;
    tokenStore.setSlackToken({ email, userAccessToken: userToken, userId, teamId: payload.team?.id || '', teamName: payload.team?.name || '', scope: payload.authed_user?.scope || '', agent: 'message' });
    res.redirect(`${base}?connected=slack&email=${encodeURIComponent(email)}`);
  } catch (err) {
    res.redirect(`${base}?error=slack&message=${encodeURIComponent(err.message)}`);
  }
});

router.post('/slack/signout', (req, res) => {
  const { email } = req.body || {};
  if (email) { tokenStore.removeSlackToken(email); logger.info(`[auth] Slack disconnected: ${email}`); }
  res.json({ success: true });
});

// Direct token install — paste a pre-issued Slack user token (xoxp-…); no Slack app needed.
router.post('/slack/token', async (req, res) => {
  try {
    const rawToken = (req.body?.token || '').trim();
    if (!rawToken) return res.status(400).json({ error: 'token is required' });
    if (!rawToken.startsWith('xox')) return res.status(400).json({ error: 'Token must be a Slack OAuth token (xoxp-… / xoxb-…).' });
    const authTest = await axios.post('https://slack.com/api/auth.test', new URLSearchParams({ token: rawToken }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    if (!authTest.data?.ok) return res.status(400).json({ error: `Slack auth.test failed: ${authTest.data?.error || 'unknown'}` });
    const userId = authTest.data.user_id;
    let email = '';
    try {
      const infoRes = await axios.get('https://slack.com/api/users.info', { headers: { Authorization: `Bearer ${rawToken}` }, params: { user: userId } });
      email = infoRes.data?.user?.profile?.email || '';
    } catch { /* ignore */ }
    if (!email) email = `${userId}@slack-local.invalid`;
    tokenStore.setSlackToken({ email, userAccessToken: rawToken, userId, teamId: authTest.data.team_id || '', teamName: authTest.data.team || '', scope: 'manual', agent: 'message' });
    logger.info(`[auth] Slack token installed for ${email}`);
    res.json({ success: true, email });
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.error || err.message });
  }
});

module.exports = router;
