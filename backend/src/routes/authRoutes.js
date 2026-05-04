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
 * Slack:      GET /api/auth/slack/url  →  redirect to Slack OAuth
 *             GET /api/auth/slack/callback  →  exchange code, store user token
 *             POST /api/auth/slack/signout  →  remove stored token
 *
 * GET /api/auth/status  →  connection status (Google, Microsoft, Slack)
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
const BACKEND_BASE = `http://localhost:${env.PORT || 5000}`;

/** Return {clientId, clientSecret} for tenant "1" | "2" | "3" | "4". */
function getGoogleTenantCreds(tenant) {
  switch (String(tenant)) {
    case '2': return { clientId: env.GOOGLE_CLIENT_ID_2, clientSecret: env.GOOGLE_CLIENT_SECRET_2 };
    case '3': return { clientId: env.GOOGLE_CLIENT_ID_3, clientSecret: env.GOOGLE_CLIENT_SECRET_3 };
    case '4': return { clientId: env.GOOGLE_CLIENT_ID_4, clientSecret: env.GOOGLE_CLIENT_SECRET_4 };
    default:  return { clientId: env.GOOGLE_CLIENT_ID,   clientSecret: env.GOOGLE_CLIENT_SECRET };
  }
}

function googleOAuthClient(tenant) {
  const { clientId, clientSecret } = getGoogleTenantCreds(tenant);
  return new google.auth.OAuth2(
    clientId,
    clientSecret,
    `${BACKEND_BASE}/api/auth/google/callback`
  );
}

const MS_REDIRECT_URI = `${BACKEND_BASE}/api/auth/microsoft/callback`;

/**
 * Return OAuth credentials for a given tenant + agent.
 * agent='message' on tenant '1' → uses the dedicated Teams app (MS_MESSAGE_CLIENT_ID)
 * so the resulting token has Teams scopes instead of mail scopes.
 */
function getMsTenantCreds(tenant, agent) {
  if (tenant === '2') {
    return {
      clientId: env.GRAPH_CLIENT_ID_2,
      clientSecret: env.GRAPH_CLIENT_SECRET_2,
      oauthBase: `https://login.microsoftonline.com/${env.GRAPH_TENANT_ID_2 || 'common'}/oauth2/v2.0`,
    };
  }
  // Message Agent on tenant 1 — use dedicated Teams app when configured
  if (agent === 'message' && env.MS_MESSAGE_CLIENT_ID && env.MS_MESSAGE_CLIENT_SECRET) {
    return {
      clientId: env.MS_MESSAGE_CLIENT_ID,
      clientSecret: env.MS_MESSAGE_CLIENT_SECRET,
      oauthBase: `https://login.microsoftonline.com/${env.GRAPH_TENANT_ID || 'common'}/oauth2/v2.0`,
    };
  }
  return {
    clientId: env.GRAPH_CLIENT_ID,
    clientSecret: env.GRAPH_CLIENT_SECRET,
    oauthBase: `https://login.microsoftonline.com/${env.GRAPH_TENANT_ID || 'common'}/oauth2/v2.0`,
  };
}
// Mail/Run Agent — mail + calendar + user-read delegated scopes.
const MS_IDENTITY_SCOPES = [
  'openid',
  'email',
  'profile',
  'offline_access',
  'User.Read',
  'User.ReadBasic.All',
];
const MS_SCOPES_MAIL = [
  ...MS_IDENTITY_SCOPES,
  'Mail.ReadWrite',
  'Calendars.ReadWrite',
].join(' ');
// Message Agent — Teams channels + chats (no mail/calendar).
const MS_SCOPES_MESSAGE = [
  ...MS_IDENTITY_SCOPES,
  // ── Teams / Channels ───────────────────────────────────────────────────
  'Team.ReadBasic.All',          // list teams
  'TeamMember.Read.All',         // read team members
  'Channel.ReadBasic.All',       // list channels in a team
  'ChannelMember.Read.All',      // read channel members
  // ── Channel Messages ───────────────────────────────────────────────────
  'ChannelMessage.Send',         // post messages to team channels
  'ChannelMessage.Read.All',     // read channel messages (source validation)
  // ── Chats (1:1 + group) ────────────────────────────────────────────────
  'Chat.Read',                   // read chats
  'Chat.ReadWrite',              // create / manage chats
  'ChatMessage.Send',            // post messages to chats
  'ChatMember.Read',             // read chat members (delegated)
  // ── Files (SharePoint / OneDrive attachments) ──────────────────────────
  'Files.ReadWrite.All',         // upload / read files in Teams channels
  'Sites.ReadWrite.All',         // access SharePoint sites (Teams file storage)
  // ── Reactions / Activity ───────────────────────────────────────────────
  'TeamsActivity.Send',          // send activity notifications
].join(' ');
// Backwards-compat alias used elsewhere if any.
const MS_SCOPES = MS_SCOPES_MAIL;

// ─── Status ──────────────────────────────────────────────────────────────────

/**
 * Normalize ?agent=… into 'mail' | 'message' | null.
 *
 * - `agent=message` → Message Agent view (Slack always, Google tenants 3/4,
 *   plus any account explicitly tagged 'message' or 'both').
 * - `agent=mail`    → Mail/Run Agent view (Gmail/Calendar tenants 1/2, legacy
 *   Microsoft accounts, plus any account tagged 'mail' or 'both').
 * - missing/empty   → Run Agent default (matches 'mail' for backwards compat,
 *   so the existing Connect Accounts page keeps behaving like before).
 */
function parseAgent(req, defaultAgent) {
  const raw = String(req.query.agent || '').toLowerCase();
  if (raw === 'message') return 'message';
  if (raw === 'mail') return 'mail';
  return defaultAgent || null;
}

router.get('/status', (req, res) => {
  const filter = parseAgent(req, 'mail');
  res.json({
    google: tokenStore.getGoogleStatus(filter),
    microsoft: tokenStore.getMicrosoftStatus(filter),
    slack: tokenStore.getSlackStatus(filter),
  });
});

/** List all connected accounts for the dropdown UI. */
router.get('/accounts', (req, res) => {
  try {
    const filter = parseAgent(req, null);
    res.json({ accounts: tokenStore.getAllConnectedAccounts({ agent: filter }) });
  } catch (err) {
    logger.error(`[auth] /accounts failed: ${err.message}`);
    res.status(500).json({ error: 'Could not load connected accounts', accounts: [] });
  }
});

// ─── Google OAuth ─────────────────────────────────────────────────────────────

router.get('/google/url', (req, res) => {
  const raw = String(req.query.tenant || '1');
  const tenant = ['1', '2', '3', '4'].includes(raw) ? raw : '1';
  const { clientId, clientSecret } = getGoogleTenantCreds(tenant);
  if (!clientId || !clientSecret) {
    const suffix = tenant === '1' ? '' : `_${tenant}`;
    return res.status(400).json({
      error: `Google OAuth not configured for tenant ${tenant}. Set GOOGLE_CLIENT_ID${suffix} / GOOGLE_CLIENT_SECRET${suffix} in agents_with_cursor/backend/.env, then restart the backend.`,
    });
  }
  const isPopup = req.query.source === 'popup';
  // agent=message → Google Chat scopes only (no Gmail/Calendar).
  // anything else  → legacy mail-agent scopes (Gmail + Calendar). Keeps existing Mail Agent working.
  const agent = req.query.agent === 'message' ? 'message' : 'mail';
  // Encode source, tenant, and agent so the callback can reconstruct the right client
  const state = `${isPopup ? 'popup' : 'default'}:${tenant}:${agent}`;
  const identityScopes = [
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/directory.readonly',
  ];
  const messageScopes = [
    ...identityScopes,
    // ── Spaces ──────────────────────────────────────────────────────────────
    'https://www.googleapis.com/auth/chat.spaces.readonly',   // list joined spaces
    'https://www.googleapis.com/auth/chat.spaces',            // create / update spaces
    // ── Memberships ─────────────────────────────────────────────────────────
    'https://www.googleapis.com/auth/chat.memberships.readonly',
    'https://www.googleapis.com/auth/chat.memberships',
    // ── Messages ────────────────────────────────────────────────────────────
    'https://www.googleapis.com/auth/chat.messages.readonly', // read messages (source validation)
    'https://www.googleapis.com/auth/chat.messages',          // post + read messages
    // ── Reactions ───────────────────────────────────────────────────────────
    'https://www.googleapis.com/auth/chat.messages.reactions.readonly',
    'https://www.googleapis.com/auth/chat.messages.reactions',
    // ── Delete ──────────────────────────────────────────────────────────────
    'https://www.googleapis.com/auth/chat.delete',            // delete messages / spaces
    // ── Admin (useAdminAccess: true — user must be a Google Workspace Admin) ─
    'https://www.googleapis.com/auth/chat.admin.spaces.readonly',
    'https://www.googleapis.com/auth/chat.admin.spaces',
    'https://www.googleapis.com/auth/chat.admin.memberships.readonly',
    'https://www.googleapis.com/auth/chat.admin.memberships',
    'https://www.googleapis.com/auth/chat.admin.delete',
    // ── Drive (file attachments stored in Google Drive) ──────────────────────
    'https://www.googleapis.com/auth/drive.file',
  ];
  const mailScopes = [
    ...identityScopes,
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/calendar',
  ];
  const oAuth2Client = googleOAuthClient(tenant);
  const url = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: agent === 'message' ? messageScopes : mailScopes,
    prompt: 'consent',
    state,
  });
  res.json({ url });
});

router.get('/google/callback', async (req, res) => {
  const { code, error, state } = req.query;
  // State format: "<source>:<tenant>:<agent>" (e.g. "popup:3:message").
  // Falls back cleanly for legacy state values that only had source[:tenant].
  const [source = 'default', tenant = '1', agentRaw = 'mail'] = (state || 'default:1:mail').split(':');
  const agent = agentRaw === 'message' ? 'message' : 'mail';
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

// ─── Microsoft OAuth ──────────────────────────────────────────────────────────

router.get('/microsoft/url', (req, res) => {
  const tenant = req.query.tenant === '2' ? '2' : '1';
  const agent = req.query.agent === 'message' ? 'message' : 'mail';
  const isPopup = req.query.source === 'popup';
  const { clientId, oauthBase } = getMsTenantCreds(tenant, agent);
  if (!clientId) {
    return res.status(400).json({
      error: `Microsoft OAuth not configured for tenant ${tenant}. ` +
        (agent === 'message'
          ? 'Set MS_MESSAGE_CLIENT_ID + MS_MESSAGE_CLIENT_SECRET in backend/.env for the Teams app.'
          : `Set GRAPH_CLIENT_ID${tenant === '2' ? '_2' : ''} / GRAPH_CLIENT_SECRET${tenant === '2' ? '_2' : ''} in backend/.env.`),
    });
  }
  // State: "<source>:<tenant>:<agent>" — keeps Run Agent (mail) and Message Agent installs separate
  const state = `${isPopup ? 'popup' : 'default'}:${tenant}:${agent}`;
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: MS_REDIRECT_URI,
    scope: agent === 'message' ? MS_SCOPES_MESSAGE : MS_SCOPES_MAIL,
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
    const { clientId, clientSecret, oauthBase } = getMsTenantCreds(tenant, agent);
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
      agent,
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

/**
 * App-only ("admin email") install — skips the OAuth popup entirely.
 * Accepts { email, tenant }, verifies via Microsoft Graph using client_credentials,
 * and stores a Microsoft account entry so the Message Agent can list/use it just
 * like an OAuth-connected account. Needs User.Read.All APPLICATION permission on
 * the Azure app with admin consent.
 */
router.post('/microsoft/admin', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim();
    const tenant = req.body?.tenant === '2' ? '2' : '1';
    const agent = req.body?.agent === 'message' ? 'message' : 'mail';
    if (!email) return res.status(400).json({ error: 'email is required' });

    const { clientId, clientSecret } = getMsTenantCreds(tenant);
    const tenantId = tenant === '2' ? env.GRAPH_TENANT_ID_2 : env.GRAPH_TENANT_ID;
    if (!clientId || !clientSecret || !tenantId) {
      return res.status(400).json({
        error: `Microsoft app credentials missing for tenant ${tenant}. Check GRAPH_CLIENT_ID${tenant === '2' ? '_2' : ''} / GRAPH_CLIENT_SECRET${tenant === '2' ? '_2' : ''} / GRAPH_TENANT_ID${tenant === '2' ? '_2' : ''} in backend/.env.`,
      });
    }

    // 1. Acquire app-only token via client_credentials.
    const tokenRes = await axios.post(
      `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
      new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
        scope: 'https://graph.microsoft.com/.default',
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const accessToken = tokenRes.data?.access_token;
    const expiresIn = tokenRes.data?.expires_in || 3600;
    if (!accessToken) {
      return res.status(400).json({ error: 'Azure returned no access_token. Check client secret and tenant ID.' });
    }

    // 2. Verify the admin email exists in the tenant (also validates User.Read.All).
    let user;
    try {
      const graphRes = await axios.get(
        `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(email)}?$select=id,displayName,mail,userPrincipalName`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      user = graphRes.data;
    } catch (err) {
      const status = err.response?.status;
      const azErr = err.response?.data?.error;
      if (status === 403 || azErr?.code === 'Authorization_RequestDenied') {
        return res.status(403).json({
          error:
            'Azure app is missing the User.Read.All APPLICATION permission (with admin consent). ' +
            'Go to Azure Portal → App Registrations → ' + clientId +
            ' → API permissions → add Microsoft Graph → Application permissions → User.Read.All → Grant admin consent.',
        });
      }
      if (status === 404) {
        return res.status(404).json({ error: `User "${email}" not found in tenant ${tenantId}.` });
      }
      return res.status(500).json({ error: azErr?.message || err.message });
    }

    // 3. Store in token store. No refreshToken — getAccessToken() will mint a
    //    fresh app-only token every hour via getAppAccessToken(tenant).
    tokenStore.setMicrosoftToken({
      email: user.mail || user.userPrincipalName || email,
      accessToken,
      expiresAt: Date.now() + (expiresIn - 60) * 1000,
      refreshToken: null,
      tenant,
      mode: 'app-only',
      displayName: user.displayName || '',
      userId: user.id,
      agent,
    });
    logger.info(`[auth] Microsoft admin installed (app-only) for ${user.mail || email} in tenant ${tenantId} (agent=${agent})`);

    res.json({
      success: true,
      email: user.mail || user.userPrincipalName || email,
      displayName: user.displayName || '',
      tenantId,
      mode: 'app-only',
    });
  } catch (err) {
    const msg = err.response?.data?.error_description || err.response?.data?.error?.message || err.message;
    logger.error(`[auth] /microsoft/admin failed: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

// ─── Slack OAuth (user token; Message Agent / Slack Cloud) ───────────────────

const SLACK_REDIRECT_PATH = '/api/auth/slack/callback';
/** Slack user scopes: full read + write for all message types, files, reactions, pins. */
const SLACK_USER_SCOPES = [
  // ── Users ──────────────────────────────────────────────────────────────
  'users:read',              // list workspace users
  'users:read.email',        // get user email addresses
  'users.profile:read',      // read full user profile (display name, avatar, title)
  'team:read',               // read workspace name, icon, domain

  // ── Channels / conversations (list) ────────────────────────────────────
  'channels:read',           // list public channels
  'groups:read',             // list private channels
  'im:read',                 // list 1:1 DMs
  'mpim:read',               // list group DMs

  // ── Message history (read / validate migration) ─────────────────────────
  'channels:history',        // read messages in public channels
  'groups:history',          // read messages in private channels
  'im:history',              // read 1:1 DM messages
  'mpim:history',            // read group DM messages

  // ── Posting messages ────────────────────────────────────────────────────
  'chat:write',              // post messages to channels/DMs the user is in
  'chat:write.customize',    // post with custom username/avatar

  // ── Files (attachments) ─────────────────────────────────────────────────
  'files:read',              // read / download files and attachments
  'files:write',             // upload files and post as attachments

  // ── Reactions ───────────────────────────────────────────────────────────
  'reactions:read',          // read emoji reactions on messages
  'reactions:write',         // add / remove emoji reactions

  // ── Pinned messages ─────────────────────────────────────────────────────
  'pins:read',               // read pinned messages in channels
  'pins:write',              // pin / unpin messages

  // ── Bookmarks ───────────────────────────────────────────────────────────
  'bookmarks:read',          // read channel bookmarks
  'bookmarks:write',         // add / remove bookmarks

  // ── Channel management (archive / close for clean-space) ────────────────
  'channels:write',          // archive / manage public channels
  'groups:write',            // archive / manage private channels
  'im:write',                // close 1:1 DMs
  'mpim:write',              // close group DMs

  // ── Search ──────────────────────────────────────────────────────────────
  'search:read',             // search messages, files, channels
].join(',');

function slackRedirectUri() {
  const override = env.SLACK_REDIRECT_URI;
  if (override && String(override).trim()) {
    return String(override).trim().replace(/\/+$/, '');
  }
  return `${BACKEND_BASE}${SLACK_REDIRECT_PATH}`;
}

router.get('/slack/url', (req, res) => {
  const { SLACK_CLIENT_ID, SLACK_CLIENT_SECRET } = env;
  if (!SLACK_CLIENT_ID || !SLACK_CLIENT_SECRET) {
    return res.status(400).json({
      error:
        'Slack OAuth not configured. Set SLACK_CLIENT_ID and SLACK_CLIENT_SECRET in backend/.env (Redirect URL must match /api/auth/slack/callback).',
    });
  }
  const isPopup = req.query.source === 'popup';
  // Slack is only used by the Message Agent, but we still encode the agent
  // explicitly so future callers (and already-stored accounts) stay correct.
  const agent = req.query.agent === 'mail' ? 'mail' : 'message';
  const state = `${isPopup ? 'popup' : 'default'}:${agent}`;
  const params = new URLSearchParams({
    client_id: SLACK_CLIENT_ID,
    user_scope: SLACK_USER_SCOPES,
    redirect_uri: slackRedirectUri(),
    state,
  });
  const url = `https://slack.com/oauth/v2/authorize?${params}`;
  const redirectUriUsed = slackRedirectUri();
  res.json({ url, redirectUriUsed });
});

router.get('/slack/callback', async (req, res) => {
  const { code, error, state } = req.query;
  const [source = 'default', agentRaw = 'message'] = String(state || 'default:message').split(':');
  const agent = agentRaw === 'mail' ? 'mail' : 'message';
  const isPopup = source === 'popup';
  const successBase = isPopup ? `${FRONTEND_ORIGIN}/oauth-callback` : `${FRONTEND_ORIGIN}/connect`;
  const errorBase = isPopup ? `${FRONTEND_ORIGIN}/oauth-callback` : `${FRONTEND_ORIGIN}/connect`;

  if (error) {
    logger.warn(`[auth] Slack OAuth error: ${error}`);
    return res.redirect(`${errorBase}?error=slack&message=${encodeURIComponent(error)}`);
  }
  if (!code) return res.status(400).send('Missing code');

  const { SLACK_CLIENT_ID, SLACK_CLIENT_SECRET } = env;
  if (!SLACK_CLIENT_ID || !SLACK_CLIENT_SECRET) {
    return res.redirect(`${errorBase}?error=slack&message=${encodeURIComponent('Slack not configured')}`);
  }

  try {
    const tokenParams = new URLSearchParams({
      client_id: SLACK_CLIENT_ID,
      client_secret: SLACK_CLIENT_SECRET,
      code,
      redirect_uri: slackRedirectUri(),
    });
    const tokenRes = await axios.post('https://slack.com/api/oauth.v2.access', tokenParams.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const payload = tokenRes.data;
    if (!payload.ok) {
      throw new Error(payload.error || 'oauth.v2.access failed');
    }

    const userToken = payload.authed_user?.access_token;
    const userId = payload.authed_user?.id;
    const teamId = payload.team?.id;
    const teamName = payload.team?.name || '';
    const userScope = payload.authed_user?.scope || '';

    if (!userToken || !userId) {
      throw new Error('Slack did not return a user token. Reinstall the app with User Token Scopes enabled.');
    }

    let email = '';
    const infoRes = await axios.get('https://slack.com/api/users.info', {
      headers: { Authorization: `Bearer ${userToken}` },
      params: { user: userId },
    });
    if (infoRes.data?.ok && infoRes.data?.user?.profile?.email) {
      email = infoRes.data.user.profile.email;
    }
    if (!email) {
      const testRes = await axios.post(
        'https://slack.com/api/auth.test',
        new URLSearchParams({ token: userToken }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
      if (testRes.data?.ok && testRes.data?.user_id) {
        email = `${testRes.data.user_id}@slack-local.invalid`;
        logger.warn('[auth] Slack users.info had no email; using placeholder. Ensure users:read.email is granted.');
      }
    }
    if (!email) {
      throw new Error('Could not resolve Slack user email. Check app User Token Scopes.');
    }

    tokenStore.setSlackToken({
      email,
      userAccessToken: userToken,
      userId,
      teamId: teamId || '',
      teamName,
      scope: userScope,
      agent,
    });
    logger.info(`[auth] Slack workspace user connected: ${email} (${teamName || teamId}) agent=${agent}`);

    res.redirect(`${successBase}?connected=slack&email=${encodeURIComponent(email)}`);
  } catch (err) {
    logger.error(`[auth] Slack callback error: ${err.message}`);
    res.redirect(`${errorBase}?error=slack&message=${encodeURIComponent(err.message)}`);
  }
});

router.post('/slack/signout', (req, res) => {
  const { email } = req.body;
  if (email) {
    tokenStore.removeSlackToken(email);
    logger.info(`[auth] Slack account disconnected: ${email}`);
  }
  res.json({ success: true });
});

/**
 * Direct token install — accepts a pre-issued Slack user OAuth token (xoxp-…)
 * and stores it in the same shape as the OAuth callback, so the Message Agent
 * can use it without running the browser popup flow. Useful when the Slack app
 * Redirect URL / consent is still being configured.
 */
router.post('/slack/token', async (req, res) => {
  try {
    const rawToken = (req.body?.token || '').trim();
    const agent = req.body?.agent === 'mail' ? 'mail' : 'message';
    if (!rawToken) return res.status(400).json({ error: 'token is required' });
    if (!rawToken.startsWith('xox')) {
      return res.status(400).json({ error: 'Token must be a Slack OAuth token (starts with xoxp- or xoxb-).' });
    }

    // Resolve identity (team + user id + email) via auth.test + users.info.
    const authTest = await axios.post(
      'https://slack.com/api/auth.test',
      new URLSearchParams({ token: rawToken }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    if (!authTest.data?.ok) {
      return res.status(400).json({
        error: `Slack auth.test failed: ${authTest.data?.error || 'unknown'}. Reinstall the app or issue a new token.`,
      });
    }
    const userId = authTest.data.user_id;
    const teamId = authTest.data.team_id || '';
    const teamName = authTest.data.team || '';

    let email = '';
    try {
      const infoRes = await axios.get('https://slack.com/api/users.info', {
        headers: { Authorization: `Bearer ${rawToken}` },
        params: { user: userId },
      });
      if (infoRes.data?.ok && infoRes.data?.user?.profile?.email) {
        email = infoRes.data.user.profile.email;
      }
    } catch {
      // fall through to placeholder
    }
    if (!email) {
      email = `${userId}@slack-local.invalid`;
      logger.warn(
        '[auth] Slack direct token: users.info returned no email; using placeholder. Grant users:read.email for a real email.'
      );
    }

    tokenStore.setSlackToken({
      email,
      userAccessToken: rawToken,
      userId,
      teamId,
      teamName,
      scope: 'manual',
      agent,
    });
    logger.info(`[auth] Slack token installed directly for ${email} (${teamName || teamId}) agent=${agent}`);

    res.json({ success: true, email, teamId, teamName, userId });
  } catch (err) {
    const msg = err.response?.data?.error || err.message;
    logger.error(`[auth] Slack /slack/token failed: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

module.exports = router;
