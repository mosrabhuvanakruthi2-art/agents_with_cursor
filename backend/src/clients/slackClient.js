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
 *
 * Performance: all user-info lookups are parallelised in batches of 10
 * (Slack Tier-4 limit ≈ 100 req/min) so the total round-trips are
 * ceil(uniqueUsers / 10) instead of N sequential calls.
 */
async function listConversations(adminEmail) {
  const token = getToken(adminEmail);
  const headers = { Authorization: `Bearer ${token}` };
  const TIMEOUT = 20_000; // 20 s per request
  const USER_BATCH = 10;  // parallel users.info calls per batch

  // ── 1. Paginate conversations.list ─────────────────────────────────────────
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
      timeout: TIMEOUT,
    });
    if (!res.data.ok) throw new Error(res.data.error || 'conversations.list failed');
    all.push(...(res.data.channels || []));
    cursor = res.data.response_metadata?.next_cursor;
  } while (cursor);

  const slackAcct = tokenStore.getSlackToken(adminEmail);
  const workSpaceName = slackAcct?.teamName || '';

  // ── 2. Categorise without any extra API calls ──────────────────────────────
  const publicChannels = [], privateChannels = [];
  const imRaw = [], mpimRaw = []; // DMs/group-DMs needing enrichment

  for (const c of all) {
    if (c.is_channel && !c.is_private) {
      publicChannels.push({
        id: c.id, name: c.name ? `#${c.name}` : c.id, channelName: c.name || c.id,
        type: 'public_channel', memberCount: c.num_members || 0,
        workSpaceName, destTeamName: workSpaceName || c.name || c.id,
      });
    } else if (c.is_group || (c.is_channel && c.is_private) || c.is_private) {
      privateChannels.push({
        id: c.id, name: c.name ? `🔒 ${c.name}` : c.id, channelName: c.name || c.id,
        type: 'private_channel', memberCount: c.num_members || 0,
        workSpaceName, destTeamName: workSpaceName || c.name || c.id,
      });
    } else if (c.is_im) {
      imRaw.push(c);
    } else if (c.is_mpim) {
      mpimRaw.push(c);
    }
  }

  // ── 3. Collect all user IDs needed for DMs (known from conversations.list) ─
  const userCache = new Map();

  async function batchFetchUsers(uids) {
    const toFetch = uids.filter((uid) => uid && !userCache.has(uid));
    for (let i = 0; i < toFetch.length; i += USER_BATCH) {
      await Promise.all(
        toFetch.slice(i, i + USER_BATCH).map(async (uid) => {
          try {
            const r = await axios.get('https://slack.com/api/users.info', {
              headers, params: { user: uid }, timeout: TIMEOUT,
            });
            if (r.data.ok && r.data.user) {
              const u = r.data.user;
              const p = u.profile || {};
              userCache.set(uid, { id: u.id, name: p.real_name || p.display_name || u.name || u.id, email: p.email || null });
              return;
            }
          } catch { /* ignore */ }
          userCache.set(uid, { id: uid, name: uid, email: null });
        })
      );
    }
  }

  function cachedUser(uid) {
    return userCache.get(uid) || { id: uid, name: uid, email: null };
  }

  // Prefetch all DM counterpart users in parallel batches
  await batchFetchUsers(imRaw.map((c) => c.user).filter(Boolean));

  // Build DM list (all user data already in cache)
  const dms = imRaw.map((c) => {
    const info = cachedUser(c.user);
    return { id: c.id, name: info.name || info.email || c.user || c.id, type: 'dm', members: [info] };
  });

  // ── 4. Group DMs — fetch members in parallel, then batch-lookup user info ──
  // Cap at 50 group DMs to bound total fetch time.
  const mpimSample = mpimRaw.slice(0, 50);
  const MPIM_BATCH = 5;
  const groupDms = [];

  for (let i = 0; i < mpimSample.length; i += MPIM_BATCH) {
    const results = await Promise.all(
      mpimSample.slice(i, i + MPIM_BATCH).map(async (c) => {
        let memberIds = [];
        try {
          const mem = await axios.get('https://slack.com/api/conversations.members', {
            headers, params: { channel: c.id, limit: 100 }, timeout: TIMEOUT,
          });
          if (mem.data.ok) memberIds = mem.data.members || [];
        } catch { /* ignore */ }

        // Fetch any members not yet in cache
        await batchFetchUsers(memberIds.slice(0, 8));

        const members = memberIds.slice(0, 8).map(cachedUser);
        return {
          id: c.id,
          name: c.name || members.map((m) => m.name).join(', ') || c.id,
          type: 'group_dm',
          members,
        };
      })
    );
    groupDms.push(...results);
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

const SLACK_SYSTEM_SUBTYPES = new Set([
  'channel_join', 'channel_leave', 'channel_name', 'channel_purpose', 'channel_topic',
  'channel_archive', 'channel_unarchive', 'pinned_item', 'unpinned_item',
  'group_join', 'group_leave', 'group_name', 'group_purpose', 'group_topic',
  'group_archive', 'group_unarchive', 'bot_add', 'bot_remove',
]);

/**
 * Comprehensive feature inventory for a Slack channel/DM (all history, epoch 0 → now).
 * Counts every feature that appears in the CF Slack→Teams migration documentation
 * so the validation agent can produce a per-feature bug report.
 */
async function getChannelStats(adminEmail, channelId) {
  const token = getToken(adminEmail);
  const s = {
    // Core
    messageCount: 0,
    fileCount: 0,
    // Threads
    threadParentCount: 0,
    totalReplyCount: 0,
    // Reactions (known CF limitation — not migrated)
    reactionMsgCount: 0,
    totalReactionCount: 0,
    // Mentions
    userMentionMsgCount: 0,    // <@U…>
    channelMentionMsgCount: 0, // <#C…>
    groupMentionMsgCount: 0,   // <!subteam^…>
    hereMentionCount: 0,       // <!here>, <!channel>, <!everyone>
    // Text formatting (in-scope)
    boldMsgCount: 0,
    italicMsgCount: 0,
    strikethroughMsgCount: 0,
    inlineCodeMsgCount: 0,
    codeBlockMsgCount: 0,
    blockQuoteMsgCount: 0,
    orderedListMsgCount: 0,
    bulletListMsgCount: 0,
    formattedMsgCount: 0,     // messages with ANY Slack markdown (aggregate)
    // Text formatting (out-of-scope)
    underlinedMsgCount: 0, // not detectable via API
    // Files by type
    audioFileCount: 0,
    videoFileCount: 0,
    imageFileCount: 0,
    gifMsgCount: 0,
    snippetFileCount: 0,
    canvaFileCount: 0,
    googleDriveFileCount: 0,
    // Special content
    emojiMsgCount: 0,
    customEmojiMsgCount: 0,
    stickerMsgCount: 0,
    linkMsgCount: 0,
    slackPermalinkCount: 0,  // links to other Slack messages (not supported)
    // Message state
    editedMsgCount: 0,
    pinnedCount: 0,          // from pins.list
    // Known-limitation types
    pollyMsgCount: 0,
    workflowMsgCount: 0,
    forwardedMsgCount: 0,
    error: null,
  };

  let cursor;
  try {
    do {
      const r = await axios.get('https://slack.com/api/conversations.history', {
        headers: { Authorization: `Bearer ${token}` },
        params: { channel: channelId, limit: 200, oldest: '0', cursor: cursor || undefined },
      });
      if (!r.data.ok) { s.error = r.data.error || 'api_error'; break; }

      for (const msg of (r.data.messages || [])) {
        if (msg.subtype && SLACK_SYSTEM_SUBTYPES.has(msg.subtype)) continue;
        s.messageCount++;

        const text      = msg.text || '';
        const blocks    = msg.blocks || [];
        const files     = msg.files || [];
        const atts      = msg.attachments || [];

        // ── Files ─────────────────────────────────────────────────────
        for (const f of files) {
          s.fileCount++;
          const mime  = (f.mimetype || '').toLowerCase();
          const ftype = (f.filetype || '').toLowerCase();
          if (mime.startsWith('audio/') || ['wav','mp3','m4a','ogg','flac','aac'].includes(ftype)) {
            s.audioFileCount++;
          } else if (mime.startsWith('video/') || ['mp4','mov','avi','mkv','webm','wmv'].includes(ftype)) {
            s.videoFileCount++;
          } else if (ftype === 'gif') {
            s.gifMsgCount++;
          } else if (mime.startsWith('image/') || ['jpg','jpeg','png','webp','bmp','svg'].includes(ftype)) {
            s.imageFileCount++;
          } else if (ftype === 'snippet' || f.mode === 'snippet') {
            s.snippetFileCount++;
          }
          if ((f.external_type || '') === 'canva' || (f.url_private || '').includes('canva.com')) {
            s.canvaFileCount++;
          }
          if ((f.external_type || '') === 'gdrive' ||
              (f.url_private || '').includes('docs.google.com')) {
            s.googleDriveFileCount++;
          }
        }

        // ── Threads ────────────────────────────────────────────────────
        if ((msg.reply_count || 0) > 0) {
          s.threadParentCount++;
          s.totalReplyCount += msg.reply_count;
        }

        // ── Reactions ─────────────────────────────────────────────────
        if (Array.isArray(msg.reactions) && msg.reactions.length > 0) {
          s.reactionMsgCount++;
          for (const rx of msg.reactions) s.totalReactionCount += (rx.count || 0);
        }

        // ── Mentions ──────────────────────────────────────────────────
        if (/<@[A-Z0-9]+>/i.test(text))             s.userMentionMsgCount++;
        if (/<#[A-Z0-9]+>/i.test(text))             s.channelMentionMsgCount++;
        if (/<!subteam\^[A-Z0-9]+/i.test(text))    s.groupMentionMsgCount++;
        if (/<!here>|<!channel>|<!everyone>/i.test(text)) s.hereMentionCount++;

        // ── Text formatting ───────────────────────────────────────────
        let hasFmt = false;
        if (/\*[^*\n]+\*/m.test(text))              { s.boldMsgCount++;          hasFmt = true; }
        if (/_[^_\n]+_/m.test(text))               { s.italicMsgCount++;        hasFmt = true; }
        if (/~[^~\n]+~/m.test(text))               { s.strikethroughMsgCount++; hasFmt = true; }
        if (/`[^`\n]+`/.test(text) && !text.includes('```')) { s.inlineCodeMsgCount++; hasFmt = true; }
        if (/```[\s\S]*?```/.test(text))            { s.codeBlockMsgCount++;     hasFmt = true; }
        if (/^>/m.test(text))                       { s.blockQuoteMsgCount++;    hasFmt = true; }

        // ── Lists (from blocks) ────────────────────────────────────────
        let hasOL = false, hasUL = false;
        for (const block of blocks) {
          if (block.type === 'rich_text') {
            for (const section of (block.elements || [])) {
              if (section.type === 'rich_text_list') {
                if (section.style === 'ordered') hasOL = true;
                else                             hasUL = true;
              }
            }
          }
        }
        if (hasOL) { s.orderedListMsgCount++; hasFmt = true; }
        if (hasUL) { s.bulletListMsgCount++;  hasFmt = true; }
        if (hasFmt) s.formattedMsgCount++;

        // ── Emojis (standard + custom) ─────────────────────────────────
        let hasEmoji = /\p{Emoji_Presentation}/u.test(text);
        let hasCustom = false;
        for (const block of blocks) {
          if (block.type !== 'rich_text') continue;
          for (const section of (block.elements || [])) {
            for (const el of (section.elements || [])) {
              if (el.type === 'emoji') {
                hasEmoji = true;
                if (!el.unicode) hasCustom = true; // no unicode = custom emoji
              }
            }
          }
        }
        if (hasEmoji) s.emojiMsgCount++;
        if (hasCustom) s.customEmojiMsgCount++;

        // ── GIFs via Giphy bot ─────────────────────────────────────────
        if (msg.subtype === 'bot_message') {
          const bn = (msg.username || msg.bot_profile?.name || '').toLowerCase();
          if (bn.includes('giphy')) s.gifMsgCount++;
        }

        // ── Links ─────────────────────────────────────────────────────
        if (/<https?:\/\/[^>]+>/i.test(text)) s.linkMsgCount++;
        if (/slack\.com\/archives\//i.test(text)) s.slackPermalinkCount++;

        // ── Edited messages ────────────────────────────────────────────
        if (msg.edited) s.editedMsgCount++;

        // ── Polly ──────────────────────────────────────────────────────
        const appName = (msg.username || msg.bot_profile?.name || '').toLowerCase();
        if (appName.includes('polly')) s.pollyMsgCount++;

        // ── Forwarded (message unfurl) ──────────────────────────────────
        if (atts.some((a) => a.is_msg_unfurl)) s.forwardedMsgCount++;

        // ── Stickers ───────────────────────────────────────────────────
        // Slack stickers appear as bot messages with specific app IDs
        if (msg.subtype === 'bot_message' && msg.app_id === 'A01BKSJM5B7') s.stickerMsgCount++;
      }
      cursor = r.data.response_metadata?.next_cursor;
    } while (cursor);
  } catch (err) {
    s.error = err.message;
  }

  // ── Pinned messages (separate API call) ───────────────────────────────
  try {
    const pr = await axios.get('https://slack.com/api/pins.list', {
      headers: { Authorization: `Bearer ${token}` },
      params: { channel: channelId },
    });
    if (pr.data.ok) {
      const items = pr.data.items || [];
      s.pinnedCount = items.length;
      s.pinnedMessages = items.map(item => {
        const msg  = item.message || {};
        const file = item.file   || {};
        return {
          ts:        msg.ts || '',
          text:      (msg.text || file.title || file.name || '').substring(0, 300),
          type:      item.type,
          userId:    msg.user || msg.bot_id || '',
          timestamp: item.created ? new Date(item.created * 1000).toISOString() : null,
          hasFiles:  !!(msg.files?.length || msg.attachments?.length),
        };
      });
    }
  } catch { /* best effort */ }

  s.totalMessagesWithReplies = s.messageCount + s.totalReplyCount;
  // Alias: validation agent reads mentionMsgCount; Slack stores it as userMentionMsgCount
  s.mentionMsgCount = s.userMentionMsgCount;

  return s;
}

/**
 * Fetch all actual messages from a Slack channel for deep validation comparison.
 * Returns both top-level messages and thread replies with full content.
 */
async function getChannelMessages(adminEmail, channelId) {
  const token = getToken(adminEmail);
  const messages = [];
  let cursor;
  do {
    const r = await axios.get('https://slack.com/api/conversations.history', {
      headers: { Authorization: `Bearer ${token}` },
      params: { channel: channelId, limit: 200, oldest: '0', cursor: cursor || undefined },
    });
    if (!r.data.ok) break;
    for (const msg of (r.data.messages || [])) {
      const tsMs = Math.round(parseFloat(msg.ts || '0') * 1000);
      const isSystem = !!(msg.subtype && SLACK_SYSTEM_SUBTYPES.has(msg.subtype));
      messages.push({
        ts: msg.ts,
        timestampMs: tsMs,
        timestampISO: new Date(tsMs).toISOString(),
        text: msg.text || '',
        userId: msg.user || msg.bot_id || '',
        subtype: msg.subtype || null,
        isSystem,
        hasFiles: !!(msg.files && msg.files.length > 0),
        fileCount: (msg.files || []).length,
        reactionCount: (msg.reactions || []).reduce((s, rx) => s + (rx.count || 0), 0),
        isThreadParent: (msg.reply_count || 0) > 0,
        threadReplyCount: msg.reply_count || 0,
        edited: !!msg.edited,
        replies: [],
      });
    }
    cursor = r.data.response_metadata?.next_cursor;
  } while (cursor);

  // Fetch thread replies for each parent in parallel batches
  const parents = messages.filter((m) => m.isThreadParent && !m.isSystem);
  const BATCH = 8;
  for (let i = 0; i < parents.length; i += BATCH) {
    const batch = parents.slice(i, i + BATCH);
    await Promise.all(batch.map(async (parent) => {
      try {
        const rr = await axios.get('https://slack.com/api/conversations.replies', {
          headers: { Authorization: `Bearer ${token}` },
          params: { channel: channelId, ts: parent.ts, limit: 200 },
        });
        if (!rr.data.ok) return;
        for (const reply of (rr.data.messages || []).slice(1)) {
          const rtsMs = Math.round(parseFloat(reply.ts || '0') * 1000);
          parent.replies.push({
            ts: reply.ts,
            timestampMs: rtsMs,
            timestampISO: new Date(rtsMs).toISOString(),
            text: reply.text || '',
            userId: reply.user || reply.bot_id || '',
            hasFiles: !!(reply.files && reply.files.length > 0),
            fileCount: (reply.files || []).length,
          });
        }
      } catch { /* best effort */ }
    }));
  }

  const userMessages = messages.filter((m) => !m.isSystem);
  const totalReplies = userMessages.reduce((s, m) => s + m.replies.length, 0);
  return {
    messages,
    userMessages,
    userMessageCount: userMessages.length,
    totalCount: userMessages.length + totalReplies,
    replies: totalReplies,
  };
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
  getChannelStats,
  getChannelMessages,
};
