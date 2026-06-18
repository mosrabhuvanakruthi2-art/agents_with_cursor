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
const env = require('../config/env');
const tokenStore = require('../clients/oauthTokenStore');
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

// ─── Status ──────────────────────────────────────────────────────────────────

router.get('/status', (_req, res) => {
  res.json({
    google: tokenStore.getGoogleStatus(),
    microsoft: tokenStore.getMicrosoftStatus(),
    box: tokenStore.getBoxStatus(),
    sharepoint: tokenStore.getSharePointStatus(),
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
  // Encode both source and tenant in state so the callback can reconstruct the right client
  const state = `${isPopup ? 'popup' : 'default'}:${tenant}`;
  const oAuth2Client = googleOAuthClient(tenant);
  const url = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://mail.google.com/',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/directory.readonly',
    ],
    prompt: 'consent',
    state,
  });
  res.json({ url });
});

router.get('/google/callback', async (req, res) => {
  const { code, error, state } = req.query;
  // State format: "<source>:<tenant>" (e.g. "popup:2") — fall back to legacy "popup"/"default"
  const [source = 'default', tenant = '1'] = (state || 'default:1').split(':');
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

    tokenStore.setGoogleToken(email, tokens.refresh_token);
    logger.info(`[auth] Google account connected: ${email}`);

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

router.post('/dwd', (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });
  tokenStore.setDwdAccount(email.trim().toLowerCase());
  logger.info(`[auth] DWD account registered: ${email}`);
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
  const state = `${isPopup ? 'popup' : 'default'}:${tenant}`;
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: MS_REDIRECT_URI,
    scope: MS_SCOPES,
    response_mode: 'query',
    prompt: 'select_account',
    state,
  });
  res.json({ url: `${oauthBase}/authorize?${params}` });
});

router.get('/microsoft/callback', async (req, res) => {
  const { code, error, error_description, state } = req.query;
  const [source = 'default', tenant = '1'] = (state || 'default:1').split(':');
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
    });
    logger.info(`[auth] Microsoft account connected: ${email}`);

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

module.exports = router;
