/**
 * Slack Web API helpers (user token from OAuth).
 * File uploads use the newer files.getUploadURLExternal flow (files.upload deprecated March 2025).
 */
const axios = require('axios');
const tokenStore = require('./oauthTokenStore');

function normalizeMember(m) {
  const profile = m.profile || {};
  const real = profile.real_name || profile.display_name || m.name || '';
  const parts = real.trim().split(/\s+/);
  const firstName = profile.first_name || parts[0] || real || m.name || '';
  const email = (profile.email || '').trim() || null;
  return {
    id: m.id,
    email: email || `${m.id}@slack.workspace`,
    displayName: real || m.name,
    firstName,
    lastName: profile.last_name || (parts.length > 1 ? parts.slice(1).join(' ') : ''),
  };
}

function getToken(adminEmail) {
  const entry = tokenStore.getSlackToken(adminEmail);
  if (!entry?.userAccessToken) throw new Error(`Slack not connected for ${adminEmail}`);
  return entry.userAccessToken;
}

// ── Mention resolution caches (in-process, cleared on restart) ────────────────
const _userCache  = new Map(); // token → Map<lowerName, { id, name }>
const _chanCache  = new Map(); // token → Map<lowerName, { id, name }>
const _groupCache = new Map(); // token → Map<lowerHandle, { id, handle, name }>

async function _loadUsers(token) {
  if (_userCache.has(token)) return _userCache.get(token);
  const map = new Map();
  let cursor;
  do {
    const r = await axios.get('https://slack.com/api/users.list', {
      headers: { Authorization: `Bearer ${token}` },
      params: { limit: 200, cursor: cursor || undefined },
    });
    if (!r.data.ok) break;
    for (const m of r.data.members || []) {
      if (m.deleted || m.is_bot || m.id === 'USLACKBOT') continue;
      const profile = m.profile || {};
      const names = [
        profile.display_name,
        profile.real_name,
        profile.first_name,
        m.name,
      ].filter(Boolean).map(s => s.toLowerCase().trim());
      for (const n of names) {
        if (n) map.set(n, { id: m.id, name: profile.real_name || profile.display_name || m.name });
      }
    }
    cursor = r.data.response_metadata?.next_cursor;
  } while (cursor);
  _userCache.set(token, map);
  return map;
}

async function _loadChannels(token) {
  if (_chanCache.has(token)) return _chanCache.get(token);
  const map = new Map();
  let cursor;
  do {
    const r = await axios.get('https://slack.com/api/conversations.list', {
      headers: { Authorization: `Bearer ${token}` },
      params: { limit: 200, cursor: cursor || undefined, exclude_archived: true, types: 'public_channel,private_channel' },
    });
    if (!r.data.ok) break;
    for (const c of r.data.channels || []) {
      if (c.name) map.set(c.name.toLowerCase(), { id: c.id, name: c.name });
    }
    cursor = r.data.response_metadata?.next_cursor;
  } while (cursor);
  _chanCache.set(token, map);
  return map;
}

async function _loadGroups(token) {
  if (_groupCache.has(token)) return _groupCache.get(token);
  const map = new Map();
  try {
    const r = await axios.get('https://slack.com/api/usergroups.list', {
      headers: { Authorization: `Bearer ${token}` },
      params: { include_disabled: false },
    });
    if (r.data.ok) {
      for (const g of r.data.usergroups || []) {
        if (g.handle) map.set(g.handle.toLowerCase(), { id: g.id, handle: g.handle, name: g.name });
        if (g.name)   map.set(g.name.toLowerCase(),   { id: g.id, handle: g.handle, name: g.name });
      }
    }
  } catch { /* usergroups scope may not be granted yet */ }
  _groupCache.set(token, map);
  return map;
}

/**
 * Resolve Slack mention syntax in free-form text.
 *
 *   @here        → <!here>
 *   @channel     → <!channel>
 *   @everyone    → <!everyone>
 *   @username    → <@USERID>             (looks up by display name / real name)
 *   #channelname → <#CHANNELID|name>     (looks up by channel name)
 *   @grouphandle → <!subteam^ID|handle>  (looks up by user group handle or name)
 *
 * Falls back to plain text if the name cannot be resolved.
 */
async function resolveSlackMentions(adminEmail, rawText) {
  if (!rawText) return rawText;
  const token = getToken(adminEmail);
  const [users, channels, groups] = await Promise.all([
    _loadUsers(token),
    _loadChannels(token),
    _loadGroups(token),
  ]);

  // Replace @name and #name tokens; skip already-formatted Slack tokens like <@U…>
  return rawText.replace(/<[^>]+>|@([\w][\w.-]*)|#([\w][\w.-]*)/g, (match, atName, hashName) => {
    if (!atName && !hashName) return match; // already a proper <…> Slack token

    if (atName) {
      const lower = atName.toLowerCase();
      if (lower === 'here')     return '<!here>';
      if (lower === 'channel')  return '<!channel>';
      if (lower === 'everyone') return '<!everyone>';
      // User group mention
      const grp = groups.get(lower);
      if (grp) return `<!subteam^${grp.id}|${grp.handle}>`;
      // User mention
      const usr = users.get(lower);
      if (usr) return `<@${usr.id}>`;
      return `@${atName}`; // unresolved — keep as text
    }

    if (hashName) {
      const ch = channels.get(hashName.toLowerCase());
      if (ch) return `<#${ch.id}|${hashName}>`;
      return `#${hashName}`; // unresolved — keep as text
    }

    return match;
  });
}

/**
 * Return the first human user ID from the workspace (used to build demo user mention blocks).
 */
async function getFirstUserId(adminEmail) {
  const token = getToken(adminEmail);
  const users = await _loadUsers(token);
  for (const [, u] of users) return u.id;
  return null;
}

/**
 * Return the first user group from the workspace (used to build demo group mention blocks).
 */
async function getFirstUserGroup(adminEmail) {
  const token = getToken(adminEmail);
  const groups = await _loadGroups(token);
  for (const [, g] of groups) return g;
  return null;
}

/**
 * Post a message to a Slack channel/DM using the user's OAuth token.
 * Supports plain text or rich Block Kit blocks.
 */
async function postMessage(adminEmail, channel, text, blocks) {
  const token = getToken(adminEmail);
  const body = { channel, text };
  if (blocks && blocks.length > 0) body.blocks = blocks;
  const res = await axios.post(
    'https://slack.com/api/chat.postMessage',
    body,
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' } }
  );
  if (!res.data.ok) throw new Error(res.data.error || 'chat.postMessage failed');
  return { ok: true, ts: res.data.ts, channel: res.data.channel };
}

/**
 * Post a reply inside a thread.
 */
async function postThreadReply(adminEmail, channel, parentTs, text) {
  const token = getToken(adminEmail);
  const res = await axios.post(
    'https://slack.com/api/chat.postMessage',
    { channel, text, thread_ts: parentTs },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' } }
  );
  if (!res.data.ok) throw new Error(res.data.error || 'chat.postMessage (reply) failed');
  return { ok: true, ts: res.data.ts, thread_ts: res.data.message?.thread_ts };
}

/**
 * Upload a file to a Slack channel using the new (March 2025+) upload flow:
 *   1. files.getUploadURLExternal  — get a pre-signed S3 URL
 *   2. HTTP PUT to the S3 URL      — upload raw bytes
 *   3. files.completeUploadExternal — share to channel + add initial comment
 */
async function uploadFile(adminEmail, channel, filename, { content, fileBuffer, mimeType, initialComment } = {}) {
  const token = getToken(adminEmail);
  const buf = (fileBuffer instanceof Buffer) ? fileBuffer
    : Buffer.from(content || `Test file: ${filename}`);

  // Step 1 — get upload URL
  const urlRes = await axios.post(
    'https://slack.com/api/files.getUploadURLExternal',
    { filename, length: buf.length },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
  if (!urlRes.data.ok) throw new Error(urlRes.data.error || 'files.getUploadURLExternal failed');
  const { upload_url, file_id } = urlRes.data;

  // Step 2 — upload raw bytes to pre-signed URL
  await axios.post(upload_url, buf, {
    headers: { 'Content-Type': mimeType || 'application/octet-stream' },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });

  // Step 3 — complete upload: share to channel + optional comment
  const completeRes = await axios.post(
    'https://slack.com/api/files.completeUploadExternal',
    {
      files: [{ id: file_id, title: filename }],
      channel_id: channel,
      ...(initialComment ? { initial_comment: initialComment } : {}),
    },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
  if (!completeRes.data.ok) throw new Error(completeRes.data.error || 'files.completeUploadExternal failed');
  return { ok: true, fileId: file_id, permalink: completeRes.data.files?.[0]?.permalink };
}

/**
 * Add an emoji reaction to a message.
 * emoji — name without colons, e.g. 'thumbsup', 'heart'
 */
async function addReaction(adminEmail, channel, ts, emoji) {
  const token = getToken(adminEmail);
  const res = await axios.post(
    'https://slack.com/api/reactions.add',
    { channel, timestamp: ts, name: emoji },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
  if (!res.data.ok && res.data.error !== 'already_reacted') {
    throw new Error(res.data.error || 'reactions.add failed');
  }
  return { ok: true };
}

/**
 * Pin a message to a channel.
 */
async function pinMessage(adminEmail, channel, ts) {
  const token = getToken(adminEmail);
  const res = await axios.post(
    'https://slack.com/api/pins.add',
    { channel, timestamp: ts },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
  if (!res.data.ok && res.data.error !== 'already_pinned' && res.data.error !== 'too_many_pins') {
    throw new Error(res.data.error || 'pins.add failed');
  }
  return { ok: true };
}

/** Is Slack connected for this admin email? (no-throw) */
function hasSlackToken(adminEmail) {
  try {
    const entry = tokenStore.getSlackToken(adminEmail);
    return !!(entry && entry.userAccessToken);
  } catch {
    return false;
  }
}

/**
 * List channels and DMs visible to the admin's Slack user token.
 */
async function listConversations(adminEmail) {
  const token = getToken(adminEmail);
  const headers = { Authorization: `Bearer ${token}` };

  const all = [];
  let cursor;
  do {
    const res = await axios.get('https://slack.com/api/conversations.list', {
      headers,
      params: {
        limit: 200,
        cursor: cursor || undefined,
        exclude_archived: true,
        types: 'public_channel,private_channel,mpim,im',
      },
    });
    if (!res.data.ok) throw new Error(res.data.error || 'conversations.list failed');
    all.push(...(res.data.channels || []));
    cursor = res.data.response_metadata?.next_cursor;
  } while (cursor);

  const userCache = new Map();
  async function userInfo(uid) {
    if (!uid) return null;
    if (userCache.has(uid)) return userCache.get(uid);
    try {
      const r = await axios.get('https://slack.com/api/users.info', { headers, params: { user: uid } });
      if (r.data.ok && r.data.user) {
        const u = r.data.user;
        const profile = u.profile || {};
        const info = { id: u.id, name: profile.real_name || profile.display_name || u.name || u.id, email: profile.email || null };
        userCache.set(uid, info);
        return info;
      }
    } catch { /* ignore */ }
    const fallback = { id: uid, name: uid, email: null };
    userCache.set(uid, fallback);
    return fallback;
  }

  const publicChannels = [], privateChannels = [], dms = [], groupDms = [];

  for (const c of all) {
    if (c.is_channel && !c.is_private) {
      publicChannels.push({ id: c.id, name: c.name ? `#${c.name}` : c.id, type: 'public_channel', memberCount: c.num_members || 0 });
    } else if (c.is_group || (c.is_channel && c.is_private) || c.is_private) {
      privateChannels.push({ id: c.id, name: c.name ? `🔒 ${c.name}` : c.id, type: 'private_channel', memberCount: c.num_members || 0 });
    } else if (c.is_im) {
      const info = await userInfo(c.user);
      dms.push({ id: c.id, name: info?.name || info?.email || c.user || c.id, type: 'dm', members: info ? [info] : [] });
    } else if (c.is_mpim) {
      let memberIds = [];
      try {
        const mem = await axios.get('https://slack.com/api/conversations.members', { headers, params: { channel: c.id, limit: 100 } });
        if (mem.data.ok) memberIds = mem.data.members || [];
      } catch { /* ignore */ }
      const members = [];
      for (const uid of memberIds.slice(0, 8)) {
        const u = await userInfo(uid);
        if (u) members.push(u);
      }
      groupDms.push({ id: c.id, name: c.name || members.map((m) => m.name).join(', ') || c.id, type: 'group_dm', members });
    }
  }

  publicChannels.sort((a, b) => a.name.localeCompare(b.name));
  privateChannels.sort((a, b) => a.name.localeCompare(b.name));
  dms.sort((a, b) => a.name.localeCompare(b.name));
  groupDms.sort((a, b) => a.name.localeCompare(b.name));

  return { publicChannels, privateChannels, dms, groupDms };
}

/**
 * List all workspace members.
 */
async function listWorkspaceUsers(adminEmail) {
  const token = getToken(adminEmail);
  const all = [];
  let cursor;
  do {
    const res = await axios.get('https://slack.com/api/users.list', {
      headers: { Authorization: `Bearer ${token}` },
      params: { limit: 200, cursor: cursor || undefined },
    });
    if (!res.data.ok) throw new Error(res.data.error || 'users.list failed');
    all.push(...(res.data.members || []));
    cursor = res.data.response_metadata?.next_cursor;
  } while (cursor);

  return all
    .filter((m) => !m.is_bot && !m.deleted && m.id !== 'USLACKBOT')
    .map(normalizeMember);
}

/**
 * Count messages posted in a channel since `sinceMinutes` ago.
 * Used by MessageMigrationAgent to poll destination for migration completion.
 */
async function getChannelMessageCount(adminEmail, channelId, sinceMinutes = 240) {
  const token = getToken(adminEmail);
  const oldest = String(Math.floor((Date.now() - sinceMinutes * 60 * 1000) / 1000));
  let count = 0;
  let cursor;
  do {
    const r = await axios.get('https://slack.com/api/conversations.history', {
      headers: { Authorization: `Bearer ${token}` },
      params: { channel: channelId, limit: 200, oldest, cursor: cursor || undefined },
    });
    if (!r.data.ok) break;
    count += (r.data.messages || []).length;
    cursor = r.data.response_metadata?.next_cursor;
  } while (cursor);
  return count;
}

module.exports = {
  listWorkspaceUsers,
  postMessage,
  postThreadReply,
  uploadFile,
  addReaction,
  pinMessage,
  hasSlackToken,
  listConversations,
  resolveSlackMentions,
  getFirstUserId,
  getFirstUserGroup,
  getChannelMessageCount,
};
