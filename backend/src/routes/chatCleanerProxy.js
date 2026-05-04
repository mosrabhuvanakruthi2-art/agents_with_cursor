const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
const tokenStore = require('../clients/oauthTokenStore');
const env = require('../config/env');

const router = express.Router();

const CHAT_BASE  = 'https://chat.googleapis.com/v1';
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const SLACK_API  = 'https://slack.com/api';

// ─── SSE helpers ──────────────────────────────────────────────────────────────

function sseHeaders(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
}

function sseWrite(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ─── Date-range helper ────────────────────────────────────────────────────────

function inDateRange(isoOrNull, startDate, endDate) {
  if (!isoOrNull) return false;
  const start = new Date(startDate + 'T00:00:00Z');
  const end   = new Date(endDate   + 'T23:59:59Z');
  const d = new Date(isoOrNull);
  return d >= start && d <= end;
}

// ══════════════════════════════════════════════════════════════════════════════
// GOOGLE CHAT
// ══════════════════════════════════════════════════════════════════════════════

function getTenantCreds(tenant) {
  switch (String(tenant)) {
    case '2': return { clientId: env.GOOGLE_CLIENT_ID_2, clientSecret: env.GOOGLE_CLIENT_SECRET_2 };
    case '3': return { clientId: env.GOOGLE_CLIENT_ID_3, clientSecret: env.GOOGLE_CLIENT_SECRET_3 };
    case '4': return { clientId: env.GOOGLE_CLIENT_ID_4, clientSecret: env.GOOGLE_CLIENT_SECRET_4 };
    default:  return { clientId: env.GOOGLE_CLIENT_ID,   clientSecret: env.GOOGLE_CLIENT_SECRET };
  }
}

function getGoogleTenant(email) {
  const domain = (email || '').split('@')[1]?.toLowerCase() || '';
  if (!domain) return '1';
  if (env.GOOGLE_CLIENT_ID_2 && env.GOOGLE_TENANT_2_DOMAINS?.includes(domain)) return '2';
  if (env.GOOGLE_CLIENT_ID_3 && env.GOOGLE_TENANT_3_DOMAINS?.includes(domain)) return '3';
  if (env.GOOGLE_CLIENT_ID_4 && env.GOOGLE_TENANT_4_DOMAINS?.includes(domain)) return '4';
  return '1';
}

async function getGoogleAccessToken(adminEmail) {
  const stored = tokenStore.getGoogleToken(adminEmail);
  if (!stored?.refreshToken) {
    throw new Error(
      `Google account ${adminEmail} is not connected. Sign in via Message Agent (Step 1 → Google) first.`
    );
  }
  const tenant = getGoogleTenant(adminEmail);
  const { clientId, clientSecret } = getTenantCreds(tenant);
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
  oauth2.setCredentials({ refresh_token: stored.refreshToken });
  const { token } = await oauth2.getAccessToken();
  if (!token) throw new Error('Failed to refresh Google access token.');
  return token;
}

function getGchatAdmin() {
  const accounts = tokenStore.getAllConnectedAccounts({ agent: 'message' });
  return accounts.find((a) => a.provider === 'google')?.email || null;
}

async function gchatListAllSpaces(adminEmail) {
  const token = await getGoogleAccessToken(adminEmail);
  const headers = { Authorization: `Bearer ${token}` };
  const spaces = [];
  let pageToken;
  do {
    const res = await axios.get(`${CHAT_BASE}/spaces`, {
      headers,
      params: { pageSize: 100, useAdminAccess: true, ...(pageToken ? { pageToken } : {}) },
    });
    for (const s of res.data.spaces || []) {
      spaces.push({
        name:           s.name,
        displayName:    s.displayName || s.name,
        spaceType:      s.spaceType || (s.singleUserBotDm ? 'DIRECT_MESSAGE' : 'SPACE'),
        lastActiveTime: s.lastActiveTime || s.createTime || null,
      });
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return spaces;
}

async function gchatDeleteSpace(adminEmail, spaceName) {
  const token = await getGoogleAccessToken(adminEmail);
  await axios.delete(`${CHAT_BASE}/${spaceName}`, {
    headers: { Authorization: `Bearer ${token}` },
    params:  { useAdminAccess: true },
  });
}

function gchatToSpaceInfo(s) {
  let spaceType = 'SPACE';
  if (s.spaceType === 'DIRECT_MESSAGE') spaceType = 'DIRECT_MESSAGE';
  else if (s.spaceType === 'GROUP_CHAT') spaceType = 'GROUP_CHAT';
  return {
    name:         s.name,
    displayName:  s.displayName,
    spaceType,
    lastActivity: s.lastActiveTime ? s.lastActiveTime.slice(0, 10) : null,
  };
}

// GChat: preview
router.get('/preview', async (req, res) => {
  sseHeaders(res);
  const { startDate, endDate } = req.query;
  try {
    const adminEmail = getGchatAdmin();
    if (!adminEmail) {
      sseWrite(res, 'fail', 'No Google admin connected. Sign in via the Message Agent page first.');
      return res.end();
    }
    if (!startDate || !endDate) {
      sseWrite(res, 'fail', 'startDate and endDate query params are required.');
      return res.end();
    }
    sseWrite(res, 'progress', `Fetching all spaces as ${adminEmail}…`);
    const all = await gchatListAllSpaces(adminEmail);
    sseWrite(res, 'progress', `Fetched ${all.length} space(s). Filtering by date range ${startDate} → ${endDate}…`);
    const filtered = all.filter((s) => inDateRange(s.lastActiveTime, startDate, endDate));
    sseWrite(res, 'result', filtered.map(gchatToSpaceInfo));
  } catch (err) {
    sseWrite(res, 'fail', err.response?.data?.error?.message || err.message || 'Preview failed');
  }
  res.end();
});

// GChat: delete all in range
router.get('/delete', async (req, res) => {
  sseHeaders(res);
  const { startDate, endDate } = req.query;
  try {
    const adminEmail = getGchatAdmin();
    if (!adminEmail) {
      sseWrite(res, 'fail', 'No Google admin connected.');
      return res.end();
    }
    sseWrite(res, 'log', `Fetching spaces as ${adminEmail}…`);
    const all = await gchatListAllSpaces(adminEmail);
    const toDelete = all.filter((s) => inDateRange(s.lastActiveTime, startDate, endDate));
    sseWrite(res, 'log', `Found ${toDelete.length} space(s) in range ${startDate} → ${endDate}.`);
    let deleted = 0, failed = 0;
    for (const s of toDelete) {
      try {
        await gchatDeleteSpace(adminEmail, s.name);
        deleted++;
        sseWrite(res, 'deleted', { id: s.name, msg: `Deleted: ${s.displayName || s.name}` });
      } catch (err) {
        failed++;
        const reason = err.response?.data?.error?.message || err.message;
        sseWrite(res, 'failed', { msg: `Failed to delete "${s.displayName || s.name}": ${reason}` });
      }
    }
    sseWrite(res, 'done', `Finished. ${deleted} deleted, ${failed} failed.`);
  } catch (err) {
    sseWrite(res, 'fail', err.response?.data?.error?.message || err.message || 'Delete failed');
  }
  res.end();
});

// GChat: delete selected IDs
router.post('/delete-selected', async (req, res) => {
  sseHeaders(res);
  const ids = Array.isArray(req.body) ? req.body : [];
  try {
    const adminEmail = getGchatAdmin();
    if (!adminEmail) {
      sseWrite(res, 'fail', 'No Google admin connected.');
      return res.end();
    }
    sseWrite(res, 'log', `Deleting ${ids.length} selected space(s) as ${adminEmail}…`);
    let deleted = 0, failed = 0;
    for (const id of ids) {
      try {
        await gchatDeleteSpace(adminEmail, id);
        deleted++;
        sseWrite(res, 'deleted', { id, msg: `Deleted: ${id}` });
      } catch (err) {
        failed++;
        const reason = err.response?.data?.error?.message || err.message;
        sseWrite(res, 'failed', { msg: `Failed to delete "${id}": ${reason}` });
      }
    }
    sseWrite(res, 'done', `Finished. ${deleted} deleted, ${failed} failed.`);
  } catch (err) {
    sseWrite(res, 'fail', err.response?.data?.error?.message || err.message || 'Delete failed');
  }
  res.end();
});

// ══════════════════════════════════════════════════════════════════════════════
// MICROSOFT TEAMS  (app-only Graph — client_credentials)
// ══════════════════════════════════════════════════════════════════════════════

let _msToken = null;
let _msTokenExpiry = 0;

async function getGraphAppToken() {
  if (_msToken && Date.now() < _msTokenExpiry - 60_000) return _msToken;
  const { GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET, GRAPH_TENANT_ID } = env;
  if (!GRAPH_CLIENT_ID || !GRAPH_CLIENT_SECRET || !GRAPH_TENANT_ID) {
    throw new Error(
      'Microsoft Graph credentials not configured (GRAPH_CLIENT_ID / GRAPH_CLIENT_SECRET / GRAPH_TENANT_ID).'
    );
  }
  const res = await axios.post(
    `https://login.microsoftonline.com/${GRAPH_TENANT_ID}/oauth2/v2.0/token`,
    new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     GRAPH_CLIENT_ID,
      client_secret: GRAPH_CLIENT_SECRET,
      scope:         'https://graph.microsoft.com/.default',
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  _msToken = res.data.access_token;
  _msTokenExpiry = Date.now() + res.data.expires_in * 1000;
  return _msToken;
}

async function graphGet(urlOrPath) {
  const token = await getGraphAppToken();
  const url = urlOrPath.startsWith('http') ? urlOrPath : `${GRAPH_BASE}${urlOrPath}`;
  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}`, ConsistencyLevel: 'eventual' },
  });
  return res.data;
}

async function graphDelete(urlOrPath) {
  const token = await getGraphAppToken();
  const url = urlOrPath.startsWith('http') ? urlOrPath : `${GRAPH_BASE}${urlOrPath}`;
  await axios.delete(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function graphPost(urlOrPath, body) {
  const token = await getGraphAppToken();
  const url = urlOrPath.startsWith('http') ? urlOrPath : `${GRAPH_BASE}${urlOrPath}`;
  const res = await axios.post(url, body, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  return res.data;
}

async function teamsListGroups() {
  const groups = [];
  const filter = encodeURIComponent("resourceProvisioningOptions/Any(x:x eq 'Team')");
  let url =
    `/groups?$filter=${filter}` +
    `&$select=id,displayName,createdDateTime,renewedDateTime&$top=100&$count=true`;
  while (url) {
    const data = await graphGet(url);
    for (const g of data.value || []) groups.push(g);
    url = data['@odata.nextLink'] || null;
  }
  return groups;
}

async function teamsListUsers() {
  const users = [];
  let url = `/users?$select=id,displayName,mail&$top=999`;
  while (url) {
    const data = await graphGet(url);
    for (const u of data.value || []) users.push(u);
    url = data['@odata.nextLink'] || null;
    if (users.length >= 5000) break; // safety cap
  }
  return users;
}

async function teamsListUserChats(userId) {
  const chats = [];
  let url = `/users/${userId}/chats?$top=50&$select=id,chatType,topic,createdDateTime,lastUpdatedDateTime`;
  while (url) {
    let data;
    try { data = await graphGet(url); }
    catch { break; }
    for (const c of data.value || []) chats.push(c);
    url = data['@odata.nextLink'] || null;
  }
  return chats;
}

async function teamsDeleteGroup(groupId) {
  await graphDelete(`/groups/${groupId}`);
}

async function teamsSoftDeleteChatMessages(chatId) {
  let url = `/chats/${chatId}/messages?$top=50`;
  let count = 0;
  while (url) {
    let data;
    try { data = await graphGet(url); }
    catch { break; }
    for (const msg of data.value || []) {
      if (msg.messageType === 'message' || msg.messageType === 'reply') {
        try {
          await graphPost(`/chats/${chatId}/messages/${msg.id}/softDelete`, {});
          count++;
        } catch { /* skip individual failures */ }
      }
    }
    url = data['@odata.nextLink'] || null;
    if (count >= 500) break; // safety cap
  }
  return count;
}

function teamsGroupToSpaceInfo(g) {
  return {
    name:         `groups/${g.id}`,
    displayName:  g.displayName || g.id,
    spaceType:    'SPACE',
    lastActivity: (g.renewedDateTime || g.createdDateTime || '').slice(0, 10),
    _lastActive:  g.renewedDateTime || g.createdDateTime || null,
  };
}

function teamsChatToSpaceInfo(c) {
  const topic = (c.topic || '').trim();
  return {
    name:         `chats/${c.id}`,
    displayName:  topic || (c.chatType === 'oneOnOne' ? '1:1 Chat' : 'Group Chat'),
    spaceType:    c.chatType === 'oneOnOne' ? 'DIRECT_MESSAGE' : 'GROUP_CHAT',
    lastActivity: (c.lastUpdatedDateTime || c.createdDateTime || '').slice(0, 10),
    _lastActive:  c.lastUpdatedDateTime || c.createdDateTime || null,
  };
}

async function teamsCollectChats(users) {
  const chats = [];
  const seen = new Set();
  const BATCH = 5;
  for (let i = 0; i < users.length; i += BATCH) {
    const batch = users.slice(i, i + BATCH);
    const results = await Promise.all(batch.map((u) => teamsListUserChats(u.id)));
    for (const userChats of results) {
      for (const c of userChats) {
        if (!seen.has(c.id)) {
          seen.add(c.id);
          chats.push(c);
        }
      }
    }
  }
  return chats;
}

// Teams: preview
router.get('/teams/preview', async (req, res) => {
  sseHeaders(res);
  const { startDate, endDate } = req.query;
  try {
    if (!startDate || !endDate) {
      sseWrite(res, 'fail', 'startDate and endDate are required.');
      return res.end();
    }

    sseWrite(res, 'progress', 'Fetching Teams (groups)…');
    const groups = await teamsListGroups();
    const teamInfos = groups
      .map(teamsGroupToSpaceInfo)
      .filter((t) => inDateRange(t._lastActive, startDate, endDate))
      .map(({ _lastActive, ...rest }) => rest);

    // Send teams immediately — chats take longer
    sseWrite(res, 'partial', teamInfos);
    sseWrite(res, 'progress', `Found ${teamInfos.length} team(s). Scanning users for chats…`);

    const users = await teamsListUsers();
    sseWrite(res, 'progress', `Scanning chats for ${users.length} user(s)…`);

    const rawChats = await teamsCollectChats(users);
    const chatInfos = rawChats
      .map(teamsChatToSpaceInfo)
      .filter((c) => inDateRange(c._lastActive, startDate, endDate))
      .map(({ _lastActive, ...rest }) => rest);

    sseWrite(res, 'result', [...teamInfos, ...chatInfos]);
  } catch (err) {
    sseWrite(res, 'fail', err.response?.data?.error?.message || err.message || 'Teams preview failed');
  }
  res.end();
});

// Teams: delete all in range
router.get('/teams/delete', async (req, res) => {
  sseHeaders(res);
  const { startDate, endDate } = req.query;
  try {
    if (!startDate || !endDate) {
      sseWrite(res, 'fail', 'startDate and endDate are required.');
      return res.end();
    }
    sseWrite(res, 'log', 'Fetching Teams groups and chats…');

    const groups  = await teamsListGroups();
    const teamItems = groups
      .map(teamsGroupToSpaceInfo)
      .filter((t) => inDateRange(t._lastActive, startDate, endDate));

    const users    = await teamsListUsers();
    const rawChats = await teamsCollectChats(users);
    const chatItems = rawChats
      .map(teamsChatToSpaceInfo)
      .filter((c) => inDateRange(c._lastActive, startDate, endDate));

    const allItems = [...teamItems, ...chatItems];
    sseWrite(res, 'log', `Found ${allItems.length} item(s) in range ${startDate} → ${endDate}.`);

    let deleted = 0, failed = 0;
    for (const item of allItems) {
      const label = item.displayName || item.name;
      try {
        if (item.name.startsWith('groups/')) {
          await teamsDeleteGroup(item.name.slice('groups/'.length));
          deleted++;
          sseWrite(res, 'deleted', { id: item.name, msg: `Deleted team: ${label}` });
        } else if (item.name.startsWith('chats/')) {
          const n = await teamsSoftDeleteChatMessages(item.name.slice('chats/'.length));
          deleted++;
          sseWrite(res, 'deleted', { id: item.name, msg: `Soft-deleted ${n} message(s) in: ${label}` });
        }
      } catch (err) {
        failed++;
        const reason = err.response?.data?.error?.message || err.message;
        sseWrite(res, 'failed', { msg: `Failed to delete "${label}": ${reason}` });
      }
    }
    sseWrite(res, 'done', `Finished. ${deleted} deleted, ${failed} failed.`);
  } catch (err) {
    sseWrite(res, 'fail', err.response?.data?.error?.message || err.message || 'Teams delete failed');
  }
  res.end();
});

// Teams: delete selected IDs
router.post('/teams/delete-selected', async (req, res) => {
  sseHeaders(res);
  const ids = Array.isArray(req.body) ? req.body : [];
  try {
    sseWrite(res, 'log', `Deleting ${ids.length} selected Teams item(s)…`);
    let deleted = 0, failed = 0;
    for (const id of ids) {
      try {
        if (id.startsWith('groups/')) {
          await teamsDeleteGroup(id.slice('groups/'.length));
          deleted++;
          sseWrite(res, 'deleted', { id, msg: `Deleted team: ${id}` });
        } else if (id.startsWith('chats/')) {
          const n = await teamsSoftDeleteChatMessages(id.slice('chats/'.length));
          deleted++;
          sseWrite(res, 'deleted', { id, msg: `Soft-deleted ${n} message(s) in: ${id}` });
        } else {
          throw new Error(`Unknown Teams ID format: ${id}`);
        }
      } catch (err) {
        failed++;
        const reason = err.response?.data?.error?.message || err.message;
        sseWrite(res, 'failed', { msg: `Failed to delete "${id}": ${reason}` });
      }
    }
    sseWrite(res, 'done', `Finished. ${deleted} deleted, ${failed} failed.`);
  } catch (err) {
    sseWrite(res, 'fail', err.response?.data?.error?.message || err.message || 'Teams delete failed');
  }
  res.end();
});

// ══════════════════════════════════════════════════════════════════════════════
// SLACK  (stored xoxp user token)
// ══════════════════════════════════════════════════════════════════════════════

function getSlackAdmin() {
  const accounts = tokenStore.getAllConnectedAccounts({ agent: 'message' });
  return accounts.find((a) => a.provider === 'slack')?.email || null;
}

function getSlackUserToken(adminEmail) {
  const acct = tokenStore.getSlackToken(adminEmail);
  const token = acct?.userAccessToken;
  if (!token) throw new Error(`Slack token not found for ${adminEmail}. Re-connect via the Message Agent page.`);
  return token;
}

async function slackGet(token, method, params) {
  const res = await axios.get(`${SLACK_API}/${method}`, {
    headers: { Authorization: `Bearer ${token}` },
    params,
  });
  if (!res.data.ok) throw new Error(res.data.error || `Slack error: ${method}`);
  return res.data;
}

async function slackPost(token, method, body) {
  // Slack's Web API accepts both JSON and form-encoded; JSON is simpler
  const res = await axios.post(
    `${SLACK_API}/${method}`,
    new URLSearchParams(body),
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  if (!res.data.ok) throw new Error(res.data.error || `Slack error: ${method}`);
  return res.data;
}

async function slackListAllConversations(token) {
  const all = [];
  let cursor;
  do {
    const data = await slackGet(token, 'conversations.list', {
      types: 'public_channel,private_channel,mpim,im',
      exclude_archived: true,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    for (const ch of data.channels || []) all.push(ch);
    cursor = data.response_metadata?.next_cursor || null;
  } while (cursor);
  return all;
}

async function slackGetLastMsgTs(token, channelId) {
  try {
    const data = await slackGet(token, 'conversations.history', { channel: channelId, limit: 1 });
    const ts = data.messages?.[0]?.ts;
    if (ts) return new Date(parseFloat(ts) * 1000).toISOString();
  } catch { /* channel may be inaccessible */ }
  return null;
}

function slackToSpaceInfo(ch, lastActiveTime) {
  let spaceType = 'SPACE';
  if (ch.is_im)   spaceType = 'DIRECT_MESSAGE';
  else if (ch.is_mpim) spaceType = 'GROUP_CHAT';
  return {
    name:         `slack/${ch.id}`,
    displayName:  ch.name ? `#${ch.name}` : (ch.user ? `DM (${ch.user})` : ch.id),
    spaceType,
    lastActivity: lastActiveTime ? lastActiveTime.slice(0, 10) : null,
  };
}

async function slackEnrichAndFilter(token, channels, startDate, endDate) {
  const results = [];
  const BATCH = 10;
  for (let i = 0; i < channels.length; i += BATCH) {
    const batch = channels.slice(i, i + BATCH);
    const tsList = await Promise.all(batch.map((ch) => slackGetLastMsgTs(token, ch.id)));
    for (let j = 0; j < batch.length; j++) {
      const ch = batch[j];
      const lastTs = tsList[j];
      // fall back to channel creation time
      const lastActiveTime = lastTs || (ch.created ? new Date(ch.created * 1000).toISOString() : null);
      if (inDateRange(lastActiveTime, startDate, endDate)) {
        results.push({ ch, lastActiveTime });
      }
    }
  }
  return results;
}

// Error messages Slack returns when archive is not applicable to a DM/group-DM
const SLACK_ARCHIVE_DM_ERRORS = new Set([
  'cant_archive_dm_channel',
  'method_not_supported_for_channel_type',
  'user_is_not_in_channel',
  'cant_archive_general',
]);

async function slackArchiveOrClose(token, channelId) {
  try {
    await slackPost(token, 'conversations.archive', { channel: channelId });
  } catch (archErr) {
    if (SLACK_ARCHIVE_DM_ERRORS.has(archErr.message)) {
      // DM / group-DM — use close instead
      await slackPost(token, 'conversations.close', { channel: channelId });
    } else {
      throw archErr;
    }
  }
}

// Slack: preview
router.get('/slack/preview', async (req, res) => {
  sseHeaders(res);
  const { startDate, endDate } = req.query;
  try {
    const adminEmail = getSlackAdmin();
    if (!adminEmail) {
      sseWrite(res, 'fail', 'No Slack account connected. Sign in via the Message Agent page (Step 1 → Slack) first.');
      return res.end();
    }
    const token = getSlackUserToken(adminEmail);
    if (!startDate || !endDate) {
      sseWrite(res, 'fail', 'startDate and endDate are required.');
      return res.end();
    }

    sseWrite(res, 'progress', `Fetching Slack conversations as ${adminEmail}…`);
    const all = await slackListAllConversations(token);
    sseWrite(res, 'progress', `Fetched ${all.length} conversation(s). Enriching with last-activity…`);

    const enriched = await slackEnrichAndFilter(token, all, startDate, endDate);
    const result   = enriched.map(({ ch, lastActiveTime }) => slackToSpaceInfo(ch, lastActiveTime));
    sseWrite(res, 'result', result);
  } catch (err) {
    sseWrite(res, 'fail', err.response?.data?.error || err.message || 'Slack preview failed');
  }
  res.end();
});

// Slack: delete all in range
router.get('/slack/delete', async (req, res) => {
  sseHeaders(res);
  const { startDate, endDate } = req.query;
  try {
    const adminEmail = getSlackAdmin();
    if (!adminEmail) {
      sseWrite(res, 'fail', 'No Slack account connected.');
      return res.end();
    }
    const token = getSlackUserToken(adminEmail);
    if (!startDate || !endDate) {
      sseWrite(res, 'fail', 'startDate and endDate are required.');
      return res.end();
    }
    sseWrite(res, 'log', `Fetching Slack conversations as ${adminEmail}…`);
    const all     = await slackListAllConversations(token);
    const enriched = await slackEnrichAndFilter(token, all, startDate, endDate);
    sseWrite(res, 'log', `Found ${enriched.length} conversation(s) in range ${startDate} → ${endDate}.`);

    let deleted = 0, failed = 0;
    for (const { ch, lastActiveTime } of enriched) {
      const info = slackToSpaceInfo(ch, lastActiveTime);
      try {
        await slackArchiveOrClose(token, ch.id);
        deleted++;
        sseWrite(res, 'deleted', { id: info.name, msg: `Archived: ${info.displayName}` });
      } catch (err) {
        failed++;
        const reason = err.response?.data?.error || err.message;
        sseWrite(res, 'failed', { msg: `Failed to archive "${info.displayName}": ${reason}` });
      }
    }
    sseWrite(res, 'done', `Finished. ${deleted} archived, ${failed} failed.`);
  } catch (err) {
    sseWrite(res, 'fail', err.response?.data?.error || err.message || 'Slack delete failed');
  }
  res.end();
});

// Slack: delete selected IDs
router.post('/slack/delete-selected', async (req, res) => {
  sseHeaders(res);
  const ids = Array.isArray(req.body) ? req.body : [];
  try {
    const adminEmail = getSlackAdmin();
    if (!adminEmail) {
      sseWrite(res, 'fail', 'No Slack account connected.');
      return res.end();
    }
    const token = getSlackUserToken(adminEmail);

    sseWrite(res, 'log', `Archiving ${ids.length} selected Slack conversation(s)…`);
    let deleted = 0, failed = 0;
    for (const id of ids) {
      // id format: "slack/{channelId}"
      const channelId = id.startsWith('slack/') ? id.slice('slack/'.length) : id;
      try {
        await slackArchiveOrClose(token, channelId);
        deleted++;
        sseWrite(res, 'deleted', { id, msg: `Archived: ${id}` });
      } catch (err) {
        failed++;
        const reason = err.response?.data?.error || err.message;
        sseWrite(res, 'failed', { msg: `Failed to archive "${id}": ${reason}` });
      }
    }
    sseWrite(res, 'done', `Finished. ${deleted} archived, ${failed} failed.`);
  } catch (err) {
    sseWrite(res, 'fail', err.response?.data?.error || err.message || 'Slack delete failed');
  }
  res.end();
});

// ══════════════════════════════════════════════════════════════════════════════
// STATUS  (no Java dependency)
// ══════════════════════════════════════════════════════════════════════════════

router.get('/status', async (_req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');

  // Google Chat
  const gchatAdmin = getGchatAdmin();
  const gchat = gchatAdmin
    ? { configured: true, reason: null }
    : {
        configured: false,
        reason:
          'No Google admin connected for the Message Agent. ' +
          'Sign in via the Message Agent page (Step 1 → Google) first.',
      };

  // Teams — try app-only token to verify credentials
  let teams;
  if (!env.GRAPH_CLIENT_ID || !env.GRAPH_CLIENT_SECRET || !env.GRAPH_TENANT_ID) {
    teams = {
      configured: false,
      reason: 'Microsoft Graph credentials not configured (GRAPH_CLIENT_ID / GRAPH_CLIENT_SECRET / GRAPH_TENANT_ID in .env).',
    };
  } else {
    try {
      await getGraphAppToken();
      teams = { configured: true, reason: null };
    } catch (err) {
      teams = { configured: false, reason: `Teams auth failed: ${err.message}` };
    }
  }

  // Slack
  const slackAdmin = getSlackAdmin();
  let slack;
  if (!slackAdmin) {
    slack = {
      configured: false,
      reason: 'No Slack account connected. Sign in via the Message Agent page (Step 1 → Slack) first.',
    };
  } else {
    const acct = tokenStore.getSlackToken(slackAdmin);
    slack = acct?.userAccessToken
      ? { configured: true, reason: null }
      : { configured: false, reason: `Slack token missing for ${slackAdmin}. Re-connect via Message Agent.` };
  }

  res.json({ gchat, teams, slack });
});

module.exports = router;
