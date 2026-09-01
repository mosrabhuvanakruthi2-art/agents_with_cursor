/**
 * Dropbox (Business) API v2 client.
 *
 * Added for the Dropbox → Google combinations. Plain axios against the documented HTTP endpoints —
 * no SDK, because the repo adds no dependency for a client it can express in ~40 calls, and the two
 * existing third-party content clients (boxClient, sharepointClient) are built the same way.
 *
 * Three things about this API differ from Box and Drive and are the source of most mistakes:
 *
 *   1. Paths, not ids. Dropbox addresses items by path ("/QA/file.txt"), and the path IS the
 *      identity — a rename changes it. An `id:...` form exists and is stable, so both are kept on
 *      every item: `path` for the comparison, `id` for follow-up calls that survive a rename.
 *   2. The root is the empty string, NOT "/". `files/list_folder` with path "/" is an error;
 *      it wants "". `dbxPath()` below is the only place that conversion happens.
 *   3. Content endpoints live on a different host (content.dropboxapi.com) and take their arguments
 *      in a `Dropbox-API-Arg` HEADER rather than a JSON body, which must be ASCII-escaped or a
 *      non-Latin filename produces a 400 that reads like an auth failure.
 *
 * Team (Business) calls additionally need a member context: `Dropbox-API-Select-User` with a
 * `dbmid:` team_member_id. Without it an admin token reads the ADMIN's own Dropbox, silently, and a
 * seeding run reports success having written to the wrong account.
 */
const axios = require('axios');
const logger = require('../utils/logger');
const env = require('../config/env');
const { retryWithBackoff } = require('../utils/retry');

const RPC = 'https://api.dropboxapi.com/2';
const CONTENT = 'https://content.dropboxapi.com/2';
const TOKEN_URL = 'https://api.dropbox.com/oauth2/token';

/** Cached access tokens by cache key, with their expiry. */
const tokenCache = new Map();
/** One in-flight refresh per key, so N parallel callers do not each burn a refresh. */
const refreshLocks = new Map();

/**
 * Dropbox wants "" for the root and "/Sub/Folder" for everything else.
 *
 * Every caller in this repo passes paths in the normal "/a/b" form, so this is applied centrally
 * rather than at each call site — passing "/" straight through is the single most common cause of
 * `path/malformed_path` and it is not obvious from the error which argument was wrong.
 */
function dbxPath(p) {
  const s = String(p == null ? '' : p).trim().replace(/\\/g, '/');
  if (!s || s === '/' || s === '.') return '';
  return s.startsWith('/') ? s.replace(/\/+$/, '') : `/${s.replace(/\/+$/, '')}`;
}

/**
 * Serialise the Dropbox-API-Arg header value.
 *
 * The header must be ASCII: Dropbox documents that non-ASCII has to be \uXXXX-escaped. A file named
 * "Rapport-Été.pdf" otherwise returns 400 with a message about a malformed argument, which reads as
 * though the path were wrong.
 */
function apiArg(obj) {
  // The range is written as \u escapes rather than literal high characters: a literal
  // range is invisible in a diff and is silently corrupted by any tool that re-encodes.
  return JSON.stringify(obj).replace(/[\u0080-\uffff]/g, (c) =>
    `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
}

/**
 * Turn a Dropbox error body into something a report can show.
 *
 * Dropbox returns its machine-readable reason in `error['.tag']` (often nested), and a human string
 * in `error_summary`. The summary alone is what makes a failed run diagnosable, so prefer it.
 */
function dbxError(err, label) {
  const data = err?.response?.data;
  const summary = typeof data === 'string' ? data : data?.error_summary;
  const status = err?.response?.status;
  const detail = summary || err?.message || 'unknown error';
  const e = new Error(`Dropbox ${label} failed${status ? ` (HTTP ${status})` : ''}: ${detail}`);
  e.status = status;
  e.dropboxTag = data?.error?.['.tag'] || null;
  e.dropboxSummary = summary || null;
  return e;
}

/**
 * True when a Dropbox failure is worth another attempt AFTER the shared retry gave up.
 *
 * `utils/retry.js` already handles 429 and 5xx and deliberately breaks on every other 4xx. That is
 * right for most APIs and wrong for one Dropbox case: `too_many_write_operations` arrives as a
 * **409**, not a 429. Dropbox serialises writes per account, so a burst of create_folder/upload
 * calls self-throttles with exactly that error — and under the shared helper's rules it is a hard
 * failure, leaving the seeded tree silently incomplete.
 *
 * Only that class of error qualifies. A genuine 409 conflict (`path/conflict`) must NOT be retried,
 * because retrying it forever would never succeed.
 */
function isRetryable(err) {
  const status = err?.status || err?.response?.status;
  if (status === 429 || (status >= 500 && status < 600)) return true;
  const summary = String(err?.dropboxSummary || err?.response?.data?.error_summary || '');
  return /too_many_requests|too_many_write_operations|internal_error/.test(summary);
}

/**
 * Run a Dropbox call, adding a bounded outer retry for the 409 write-throttle case above.
 *
 * The inner `retryWithBackoff` stays in place so this client follows the repo convention and keeps
 * 429/5xx/network handling identical to every other client; this wrapper only covers what that
 * helper is designed to reject. Shared code is left untouched on purpose — `utils/retry.js` is
 * imported by all four mail combinations and both live content ones.
 */
async function withWriteRetry(fn, label, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === attempts || !isRetryable(err)) throw err;
      const delay = Math.min(1000 * 2 ** (i - 1), 8000);
      logger.warn(`[dropbox] ${label} throttled (attempt ${i}/${attempts}), retrying in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

/**
 * Obtain a usable access token.
 *
 * Sources, in priority order:
 *   1. The account connected in the UI (Connect Clouds → Dropbox), when `email` names one. This is
 *      the normal path and the only one that supports more than one Dropbox account.
 *   2. DROPBOX_REFRESH_TOKEN + APP_KEY/APP_SECRET — the env equivalent, durable the same way.
 *   3. DROPBOX_ACCESS_TOKEN — a manually generated token, fine for a quick connectivity check. Used
 *      as-is and never refreshed, so it expires mid-run if it is a short-lived one.
 *
 * Dropbox access tokens last four hours, which is shorter than some validation runs, so anything
 * without a refresh token behind it will fail partway through a long run.
 *
 * @param {string|null} email  the connected Dropbox account to act as
 */
async function getAccessToken(email = null) {
  const appKey = env.DROPBOX_APP_KEY;
  const appSecret = env.DROPBOX_APP_SECRET;

  // An account connected through the UI (Connect Clouds → Dropbox) wins over the env credentials.
  // Required so the app is usable without editing .env, and so several Dropbox accounts can be
  // connected at once — which env vars cannot express.
  //
  // Required lazily: oauthTokenStore pulls in db/mongo, and a top-level require here would make this
  // client unloadable in a unit test that has no Mongo.
  let refreshToken = env.DROPBOX_REFRESH_TOKEN;
  if (email) {
    try {
      const stored = require('./oauthTokenStore').getDropboxToken(email);
      if (stored?.refreshToken) {
        refreshToken = stored.refreshToken;
      } else if (stored?.accessToken && stored.expiresAt > Date.now() + 60000) {
        // Connected without offline access. Usable now, but it will expire mid-run — say so once
        // rather than letting a 401 surface later looking like a permissions failure.
        logger.warn(
          `[dropbox] ${email} has no refresh token (connected without offline access); its access `
          + 'token expires within hours and a long run may fail partway. Reconnect the account.'
        );
        return stored.accessToken;
      }
    } catch (err) {
      logger.warn(`[dropbox] token store unavailable, falling back to env: ${err.message}`);
    }
  }

  if (!refreshToken || !appKey || !appSecret) {
    if (env.DROPBOX_ACCESS_TOKEN) return env.DROPBOX_ACCESS_TOKEN;
    throw new Error(
      'Dropbox is not configured. Connect a Dropbox account in the UI (Connect Clouds → Dropbox), '
      + 'or set DROPBOX_REFRESH_TOKEN + DROPBOX_APP_KEY + DROPBOX_APP_SECRET in the root .env '
      + '(DROPBOX_ACCESS_TOKEN works for a short check but expires in 4 hours). See .env.example.'
    );
  }

  // Keyed by the refresh token, not just the app key: two connected accounts share an app key and
  // would otherwise hand each other's access token back out of the cache.
  const cacheKey = `refresh:${appKey}:${refreshToken.slice(-12)}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 120000) return cached.token;

  if (refreshLocks.has(cacheKey)) return refreshLocks.get(cacheKey);

  const p = (async () => {
    try {
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      });
      const res = await retryWithBackoff(
        () => axios.post(TOKEN_URL, body.toString(), {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          auth: { username: appKey, password: appSecret },
          timeout: 30000,
        }),
        { label: 'Dropbox token refresh' }
      );
      const token = res.data?.access_token;
      if (!token) throw new Error('token endpoint returned no access_token');
      // Dropbox reports expires_in seconds (typically 14400). Cache slightly short.
      const ttl = Number(res.data.expires_in || 14400) * 1000;
      tokenCache.set(cacheKey, { token, expiresAt: Date.now() + ttl });
      logger.info('[dropbox] access token refreshed');
      return token;
    } catch (err) {
      throw dbxError(err, 'token refresh');
    } finally {
      refreshLocks.delete(cacheKey);
    }
  })();

  refreshLocks.set(cacheKey, p);
  return p;
}

/**
 * Headers for an RPC call.
 *
 * `asMemberId` selects a team member. Passed through on every call that touches content so a
 * Business admin token operates on the intended member's Dropbox rather than its own.
 */
function rpcHeaders(token, asMemberId, extra = {}) {
  const h = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...extra,
  };
  if (asMemberId) h['Dropbox-API-Select-User'] = asMemberId;
  return h;
}

/** POST to an RPC endpoint. `null` body is sent as literal null, which several endpoints require. */
async function rpc(endpoint, body, opts = {}) {
  const { asMemberId = null, label = endpoint, root = null, email = null } = opts;
  const token = await getAccessToken(email);
  const extra = {};
  // Team-space root selection. Needed to reach a TEAM FOLDER: a member-scoped call sees only the
  // member folder, so team folders appear to be missing entirely.
  if (root) extra['Dropbox-API-Path-Root'] = JSON.stringify(root);
  try {
    const res = await withWriteRetry(
      () => retryWithBackoff(
        () => axios.post(`${RPC}/${endpoint}`, body === undefined ? null : body, {
          headers: rpcHeaders(token, asMemberId, extra),
          timeout: 60000,
        }),
        { label: `Dropbox ${label}` }
      ),
      label
    );
    return res.data;
  } catch (err) {
    throw dbxError(err, label);
  }
}

// ── Identity / team ────────────────────────────────────────────────────────────

/** The account behind the token. Used to confirm configuration before a run. */
async function getCurrentAccount(asMemberId = null) {
  return rpc('users/get_current_account', null, { asMemberId, label: 'users/get_current_account' });
}

/**
 * Every member of the team, as `[{ teamMemberId, email, displayName, status }]`.
 *
 * Paginated — `has_more`/`cursor`. A team larger than one page silently truncated would make the
 * email→member lookup below miss real users, so the loop is not optional.
 */
async function listTeamMembers() {
  const out = [];
  let res = await rpc('team/members/list_v2', { limit: 1000 }, { label: 'team/members/list_v2' });
  for (;;) {
    for (const m of res.members || []) {
      out.push({
        teamMemberId: m.profile?.team_member_id || null,
        email: (m.profile?.email || '').toLowerCase(),
        displayName: m.profile?.name?.display_name || '',
        status: m.profile?.status?.['.tag'] || null,
      });
    }
    if (!res.has_more) break;
    res = await rpc('team/members/list/continue_v2', { cursor: res.cursor },
      { label: 'team/members/list/continue_v2' });
  }
  return out;
}

/** The `dbmid:` team_member_id for an email, or null. Case-insensitive. */
async function resolveTeamMemberId(email) {
  const want = String(email || '').toLowerCase().trim();
  if (!want) return null;
  const members = await listTeamMembers();
  return members.find((m) => m.email === want)?.teamMemberId || null;
}

/** Team groups, as `[{ groupId, name, memberCount }]`. Scope §2 grants to groups. */
async function listTeamGroups() {
  const out = [];
  let res = await rpc('team/groups/list', { limit: 1000 }, { label: 'team/groups/list' });
  for (;;) {
    for (const g of res.groups || []) {
      out.push({
        groupId: g.group_id,
        name: g.group_name,
        memberCount: g.member_count ?? null,
      });
    }
    if (!res.has_more) break;
    res = await rpc('team/groups/list/continue', { cursor: res.cursor },
      { label: 'team/groups/list/continue' });
  }
  return out;
}

// ── Reading the tree ──────────────────────────────────────────────────────────

const FOLDER_TAG = 'folder';

/**
 * Normalise a Dropbox metadata entry into this repo's canonical content item.
 *
 * The shape matches driveClient.toItem and boxClient's tree entries exactly, because
 * deepContentCore.compareTrees consumes all three interchangeably. Fields Dropbox does not have
 * are null rather than absent, so a comparison never sees `undefined` and treats it as a difference.
 *
 * `modifiedAt` uses server_modified, NOT client_modified: client_modified is supplied by whichever
 * client uploaded the file and can be arbitrary (or in the future), while server_modified is what
 * Dropbox itself recorded. Feature 4.1 compares timestamps, so picking the wrong one produces drift
 * findings that describe the uploading client rather than the migration.
 */
function toItem(entry, parentPath) {
  const tag = entry['.tag'];
  const isFolder = tag === FOLDER_TAG;
  const name = entry.name;
  const path = entry.path_display || `${parentPath === '/' ? '' : parentPath}/${name}`;
  return {
    id: entry.id || null,
    name,
    type: isFolder ? 'folder' : 'file',
    path,
    size: isFolder ? null : (entry.size != null ? Number(entry.size) : null),
    // Dropbox has no MIME type on metadata. Left null so extension-based logic in deepContentCore
    // (extensionOf/convertName) drives conversion decisions instead of a guessed type.
    mimeType: null,
    createdAt: null, // Dropbox exposes no creation time for files.
    modifiedAt: isFolder ? null : (entry.server_modified || null),
    createdBy: null,
    modifiedBy: null,
    shortcutTargetId: null,
    // Dropbox-specific, kept for follow-up calls and for Paper detection (feature 10.x).
    rev: entry.rev || null,
    contentHash: entry.content_hash || null,
    isDownloadable: entry.is_downloadable !== false,
    isPaper: isPaperEntry(entry),
  };
}

/**
 * Is this entry a Dropbox Paper document?
 *
 * Matters for the whole of scope §10: a Paper is converted to a Google Doc, so it must not be
 * compared as a byte-for-byte file. Paper appears either with a `.paper` extension or as an
 * exportable file whose export format is Paper — `is_downloadable: false` with a `.paper` name is
 * the reliable pair.
 */
function isPaperEntry(entry) {
  const name = String(entry?.name || '').toLowerCase();
  if (name.endsWith('.paper') || name.endsWith('.papert')) return true;
  return Boolean(entry?.export_info);
}

/**
 * List the immediate children of one folder.
 *
 * `recursive: false` deliberately — the caller walks depth-first so it can enforce a depth cap and
 * report progress. Dropbox's own recursive mode cannot be depth-limited, and on a large team folder
 * it returns tens of thousands of entries before the first callback.
 */
async function listFolder(path, opts = {}) {
  const { asMemberId = null, root = null } = opts;
  const entries = [];
  let res = await rpc('files/list_folder', {
    path: dbxPath(path),
    recursive: false,
    include_deleted: false,
    include_has_explicit_shared_members: true,
    include_non_downloadable_files: true,
    limit: 2000,
  }, { asMemberId, root, label: 'files/list_folder' });

  for (;;) {
    entries.push(...(res.entries || []));
    if (!res.has_more) break;
    res = await rpc('files/list_folder/continue', { cursor: res.cursor },
      { asMemberId, root, label: 'files/list_folder/continue' });
  }
  return entries;
}

/**
 * Walk a folder into a flat array of canonical items, depth-first.
 *
 * Returns paths RELATIVE to nothing — each item carries its full Dropbox path_display. The validator
 * relativizes against the migration's source root, the same as the Box and Drive flows, so this must
 * not pre-trim or the two sides relativize inconsistently.
 *
 * @param {string} rootPath   "" or "/" for the account root
 * @param {object} opts       { asMemberId, root, maxDepth }
 */
async function buildFolderTree(rootPath, opts = {}) {
  const { asMemberId = null, root = null, maxDepth = 25 } = opts;
  const items = [];
  const start = dbxPath(rootPath);

  async function walk(path, depth) {
    if (depth > maxDepth) {
      logger.warn(`[dropbox] depth cap ${maxDepth} reached at ${path} — not descending further`);
      return;
    }
    const entries = await listFolder(path, { asMemberId, root });
    for (const entry of entries) {
      const item = toItem(entry, path || '/');
      items.push(item);
      if (item.type === 'folder') await walk(item.path, depth + 1);
    }
  }

  await walk(start, 1);
  return items;
}

/** Metadata for one path, or null when it does not exist. */
async function getMetadata(path, opts = {}) {
  const { asMemberId = null, root = null } = opts;
  try {
    const data = await rpc('files/get_metadata', {
      path: dbxPath(path),
      include_has_explicit_shared_members: true,
    }, { asMemberId, root, label: 'files/get_metadata' });
    return toItem(data, '/');
  } catch (err) {
    if (/not_found/.test(String(err.dropboxSummary || ''))) return null;
    throw err;
  }
}

// ── Permissions (scope §2) ────────────────────────────────────────────────────

/**
 * Collaborators on one FILE, normalised to `[{ email, role, type, displayName }]`.
 *
 * `role` is Dropbox's access level tag — `editor` / `viewer` / `owner` — which is exactly what
 * roleMaps/dropbox_to_google.js keys on, so no translation happens here. Keeping the raw tag means
 * the role map stays the single place the Dropbox→Google table lives.
 */
async function listFileMembers(fileIdOrPath, opts = {}) {
  const { asMemberId = null, root = null } = opts;
  const out = [];
  let res = await rpc('sharing/list_file_members', {
    file: fileIdOrPath.startsWith('id:') ? fileIdOrPath : dbxPath(fileIdOrPath),
    include_inherited: true,
    limit: 300,
  }, { asMemberId, root, label: 'sharing/list_file_members' });

  for (;;) {
    for (const u of res.users || []) {
      out.push({
        email: (u.user?.email || '').toLowerCase(),
        displayName: u.user?.display_name || '',
        role: u.access_type?.['.tag'] || null,
        type: 'user',
        inherited: !u.is_inherited === false,
      });
    }
    for (const g of res.groups || []) {
      out.push({
        email: '',
        displayName: g.group?.group_name || '',
        groupId: g.group?.group_id || null,
        role: g.access_type?.['.tag'] || null,
        type: 'group',
      });
    }
    for (const i of res.invitees || []) {
      out.push({
        email: (i.invitee?.email || '').toLowerCase(),
        displayName: '',
        role: i.access_type?.['.tag'] || null,
        type: 'user',
        pending: true,
      });
    }
    if (!res.cursor) break;
    res = await rpc('sharing/list_file_members/continue', { cursor: res.cursor },
      { asMemberId, root, label: 'sharing/list_file_members/continue' });
  }
  return out;
}

/**
 * Collaborators on one FOLDER.
 *
 * Requires a shared_folder_id, not a path — an unshared folder has none, and that is not an error:
 * it means "no explicit permissions", which is a legitimate state the validator must see as an
 * empty list rather than a failure.
 */
async function listFolderMembers(sharedFolderId, opts = {}) {
  const { asMemberId = null, root = null } = opts;
  if (!sharedFolderId) return [];
  const out = [];
  let res = await rpc('sharing/list_folder_members', {
    shared_folder_id: sharedFolderId,
    limit: 300,
  }, { asMemberId, root, label: 'sharing/list_folder_members' });

  for (;;) {
    for (const u of res.users || []) {
      out.push({
        email: (u.user?.email || '').toLowerCase(),
        displayName: u.user?.display_name || '',
        role: u.access_type?.['.tag'] || null,
        type: 'user',
      });
    }
    for (const g of res.groups || []) {
      out.push({
        email: '',
        displayName: g.group?.group_name || '',
        groupId: g.group?.group_id || null,
        role: g.access_type?.['.tag'] || null,
        type: 'group',
      });
    }
    for (const i of res.invitees || []) {
      out.push({
        email: (i.invitee?.email || '').toLowerCase(),
        displayName: '',
        role: i.access_type?.['.tag'] || null,
        type: 'user',
        pending: true,
      });
    }
    if (!res.cursor) break;
    res = await rpc('sharing/list_folder_members/continue', { cursor: res.cursor },
      { asMemberId, root, label: 'sharing/list_folder_members/continue' });
  }
  return out;
}

/**
 * Permissions on any item, folder or file, in one call.
 *
 * Folders need their shared_folder_id resolved first; files do not. Hiding that difference here
 * keeps the validator from having to branch on item type for every permission check.
 */
async function listItemMembers(item, opts = {}) {
  if (!item) return [];
  if (item.type === 'folder') {
    const meta = await rpc('files/get_metadata', { path: dbxPath(item.path) },
      { ...opts, label: 'files/get_metadata (folder share id)' }).catch(() => null);
    const sharedFolderId = meta?.shared_folder_id || meta?.sharing_info?.shared_folder_id || null;
    return listFolderMembers(sharedFolderId, opts);
  }
  return listFileMembers(item.id || item.path, opts);
}

// ── Shared links (scope §3) ───────────────────────────────────────────────────

/**
 * Shared links on a path, normalised to the shape deepContentCore.compareSharedLinks expects:
 * `[{ url, type, role }]` where `type` is the audience and `role` the access level.
 *
 * Dropbox reports the audience in `link_permissions.resolved_visibility` — `public`, `team_only`,
 * `password`, `team_and_password`, `shared_folder_only`. The role map turns those into Google
 * scopes; the raw tag is preserved here for the same reason as roles above.
 */
async function listSharedLinks(path, opts = {}) {
  const { asMemberId = null, root = null } = opts;
  const out = [];
  let res = await rpc('sharing/list_shared_links', {
    path: dbxPath(path),
    direct_only: true,
  }, { asMemberId, root, label: 'sharing/list_shared_links' });

  for (;;) {
    for (const l of res.links || []) {
      const vis = l.link_permissions?.resolved_visibility?.['.tag']
        || l.link_permissions?.requested_visibility?.['.tag']
        || null;
      out.push({
        url: l.url,
        type: vis,
        // An editable link is reported through allow_download plus the access level; Dropbox exposes
        // the effective one as link_access_level.
        role: l.link_permissions?.link_access_level?.['.tag'] || 'viewer',
        expires: l.expires || null,
      });
    }
    if (!res.has_more) break;
    res = await rpc('sharing/list_shared_links', { path: dbxPath(path), cursor: res.cursor },
      { asMemberId, root, label: 'sharing/list_shared_links (continue)' });
  }
  return out;
}

// ── Versions (scope §9) ───────────────────────────────────────────────────────

/**
 * Revisions of a file, newest first, as `[{ rev, size, modifiedAt }]`.
 *
 * Only meaningful for real files. A Paper document has no source-visible version history at all
 * (scope 10.19), so callers must skip Paper rather than read this as zero versions.
 */
async function listRevisions(path, opts = {}) {
  const { asMemberId = null, root = null, limit = 100 } = opts;
  const data = await rpc('files/list_revisions', {
    path: dbxPath(path),
    mode: 'path',
    limit,
  }, { asMemberId, root, label: 'files/list_revisions' });
  return (data.entries || []).map((e) => ({
    rev: e.rev,
    size: e.size != null ? Number(e.size) : null,
    modifiedAt: e.server_modified || null,
  }));
}

// ── Content ───────────────────────────────────────────────────────────────────

/** Download a file's bytes as a Buffer. Backs Tier B hashing. */
async function downloadFile(path, opts = {}) {
  const { asMemberId = null, root = null, email = null } = opts;
  const token = await getAccessToken(email);
  const headers = {
    Authorization: `Bearer ${token}`,
    'Dropbox-API-Arg': apiArg({ path: dbxPath(path) }),
  };
  if (asMemberId) headers['Dropbox-API-Select-User'] = asMemberId;
  if (root) headers['Dropbox-API-Path-Root'] = JSON.stringify(root);
  try {
    const res = await retryWithBackoff(
      () => axios.post(`${CONTENT}/files/download`, null, {
        headers,
        responseType: 'arraybuffer',
        timeout: 120000,
      }),
      { label: 'Dropbox files/download' }
    );
    return Buffer.from(res.data);
  } catch (err) {
    throw dbxError(err, 'files/download');
  }
}

/**
 * Export a Paper document to a concrete format.
 *
 * Paper is not downloadable through files/download — that returns an error telling you to use
 * export. Needed for any content comparison of scope §10, where the destination is a Google Doc.
 */
async function exportPaper(path, format = 'markdown', opts = {}) {
  const { asMemberId = null, root = null, email = null } = opts;
  const token = await getAccessToken(email);
  const headers = {
    Authorization: `Bearer ${token}`,
    'Dropbox-API-Arg': apiArg({ path: dbxPath(path), export_format: format }),
  };
  if (asMemberId) headers['Dropbox-API-Select-User'] = asMemberId;
  if (root) headers['Dropbox-API-Path-Root'] = JSON.stringify(root);
  try {
    const res = await retryWithBackoff(
      () => axios.post(`${CONTENT}/files/export`, null, {
        headers,
        responseType: 'arraybuffer',
        timeout: 120000,
      }),
      { label: 'Dropbox files/export' }
    );
    return Buffer.from(res.data);
  } catch (err) {
    throw dbxError(err, 'files/export');
  }
}

// ── Writing (seeding) ─────────────────────────────────────────────────────────

/** Create a folder. An existing folder is returned rather than treated as an error. */
async function createFolder(path, opts = {}) {
  const { asMemberId = null, root = null } = opts;
  try {
    const data = await rpc('files/create_folder_v2', {
      path: dbxPath(path),
      autorename: false,
    }, { asMemberId, root, label: 'files/create_folder_v2' });
    return toItem(data.metadata, '/');
  } catch (err) {
    // Idempotent by design: seeding is re-run constantly during development, and a conflict here
    // means the folder is already how we want it.
    if (/conflict/.test(String(err.dropboxSummary || ''))) {
      return getMetadata(path, opts);
    }
    throw err;
  }
}

/**
 * Upload a file's bytes.
 *
 * `mode: 'overwrite'` so re-seeding replaces rather than autorenaming — an autorenamed
 * "file (1).txt" would look to the validator like an extra source item.
 *
 * `mode: 'add'` with a distinct `clientModified` is what creates a NEW VERSION (scope 9.1): each
 * overwrite of an existing path adds a revision, which is why seeding versions just calls this
 * repeatedly against the same path.
 */
async function uploadFile(path, buffer, opts = {}) {
  const { asMemberId = null, root = null, mode = 'overwrite', clientModified = null, email = null } = opts;
  const token = await getAccessToken(email);
  const arg = { path: dbxPath(path), mode, autorename: false, mute: true };
  // `mute: true` suppresses the member's own notification for this write — unrelated to scope 6.1,
  // which is about the DESTINATION's collaboration mail, but it keeps a seeding run from spamming
  // the QA account with hundreds of messages.
  if (clientModified) arg.client_modified = new Date(clientModified).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/octet-stream',
    'Dropbox-API-Arg': apiArg(arg),
  };
  if (asMemberId) headers['Dropbox-API-Select-User'] = asMemberId;
  if (root) headers['Dropbox-API-Path-Root'] = JSON.stringify(root);
  try {
    const res = await withWriteRetry(
      () => retryWithBackoff(
        () => axios.post(`${CONTENT}/files/upload`, buffer, { headers, timeout: 120000 }),
        { label: 'Dropbox files/upload' }
      ),
      'files/upload'
    );
    return toItem(res.data, '/');
  } catch (err) {
    throw dbxError(err, 'files/upload');
  }
}

/**
 * Share a folder so it can carry collaborators, returning its shared_folder_id.
 *
 * A folder must be shared BEFORE members can be added; add_folder_member on an unshared folder
 * fails. Dropbox may complete this asynchronously, reporting `async_job_id` — the caller then has
 * to poll, which `shareFolder` does here so callers never see the async form.
 */
async function shareFolder(path, opts = {}) {
  const { asMemberId = null, root = null } = opts;
  const data = await rpc('sharing/share_folder', {
    path: dbxPath(path),
    acl_update_policy: 'editors',
    force_async: false,
  }, { asMemberId, root, label: 'sharing/share_folder' });

  if (data['.tag'] === 'complete' || data.shared_folder_id) {
    return data.shared_folder_id || data.complete?.shared_folder_id || null;
  }
  const jobId = data.async_job_id;
  if (!jobId) return null;
  for (let i = 0; i < 30; i++) {
    const st = await rpc('sharing/check_share_job_status', { async_job_id: jobId },
      { asMemberId, root, label: 'sharing/check_share_job_status' });
    if (st['.tag'] === 'complete') return st.shared_folder_id || null;
    if (st['.tag'] === 'failed') throw new Error(`Dropbox share_folder failed: ${JSON.stringify(st)}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Dropbox share_folder did not complete for ${path}`);
}

/**
 * Grant a user or group access to a folder.
 *
 * `role` is 'editor' or 'viewer' — the Dropbox spelling, matching the role map.
 * `quiet` suppresses the invitation email; QA seeding always wants that.
 */
async function addFolderMember(sharedFolderId, member, role, opts = {}) {
  const { asMemberId = null, root = null, quiet = true } = opts;
  const selector = member.groupId
    ? { '.tag': 'dropbox_id', dropbox_id: member.groupId }
    : { '.tag': 'email', email: member.email };
  return rpc('sharing/add_folder_member', {
    shared_folder_id: sharedFolderId,
    members: [{ member: selector, access_level: role }],
    quiet,
  }, { asMemberId, root, label: 'sharing/add_folder_member' });
}

/** Grant a user or group access to a file. */
async function addFileMember(fileIdOrPath, member, role, opts = {}) {
  const { asMemberId = null, root = null, quiet = true } = opts;
  const selector = member.groupId
    ? { '.tag': 'dropbox_id', dropbox_id: member.groupId }
    : { '.tag': 'email', email: member.email };
  return rpc('sharing/add_file_member', {
    file: fileIdOrPath.startsWith('id:') ? fileIdOrPath : dbxPath(fileIdOrPath),
    members: [selector],
    access_level: role,
    quiet,
    add_message_as_comment: false,
  }, { asMemberId, root, label: 'sharing/add_file_member' });
}

/**
 * Create a shared link with an explicit audience.
 *
 * `audience` is 'public' (Anyone with the link, scope 3.1) or 'team' (Team members, scope 3.2).
 * `access` is 'viewer' or 'editor'. An existing link is returned instead of failing, because a
 * re-seed would otherwise stop on shared_link_already_exists.
 */
async function createSharedLink(path, opts = {}) {
  const { asMemberId = null, root = null, audience = 'public', access = 'viewer' } = opts;
  try {
    const data = await rpc('sharing/create_shared_link_with_settings', {
      path: dbxPath(path),
      settings: {
        // requested_visibility is the legacy field; audience is the current one. Sending both is
        // what the Dropbox docs show for compatibility across account types.
        requested_visibility: audience === 'team' ? 'team_only' : 'public',
        audience,
        access,
        allow_download: true,
      },
    }, { asMemberId, root, label: 'sharing/create_shared_link_with_settings' });
    return { url: data.url, type: data.link_permissions?.resolved_visibility?.['.tag'] || null };
  } catch (err) {
    if (/shared_link_already_exists/.test(String(err.dropboxSummary || ''))) {
      const existing = await listSharedLinks(path, opts);
      return existing[0] || null;
    }
    throw err;
  }
}

/**
 * Move or rename a path.
 *
 * Dropbox has no separate rename: a rename IS a move to a new path in the same parent. Both delta
 * change types (scope 1.3 — "renamed", 1,635 QA cases, and "moved", 39) go through here.
 */
async function movePath(fromPath, toPath, opts = {}) {
  const { asMemberId = null, root = null } = opts;
  return rpc('files/move_v2', {
    from_path: dbxPath(fromPath),
    to_path: dbxPath(toPath),
    autorename: false,
  }, { asMemberId, root, label: 'files/move_v2' });
}

/** Permanently remove a path. Used by cleanup before a re-seed. */
async function deletePath(path, opts = {}) {
  const { asMemberId = null, root = null } = opts;
  try {
    return await rpc('files/delete_v2', { path: dbxPath(path) },
      { asMemberId, root, label: 'files/delete_v2' });
  } catch (err) {
    if (/not_found/.test(String(err.dropboxSummary || ''))) return null;
    throw err;
  }
}

/**
 * Is Dropbox configured at all?
 *
 * Lets callers report "not configured" as a skip with instructions rather than throwing a stack
 * trace out of a run — the same courtesy `verifyDwd` gives the Drive flow.
 */
function isConfigured(email = null) {
  if (env.DROPBOX_ACCESS_TOKEN) return true;
  if (env.DROPBOX_REFRESH_TOKEN && env.DROPBOX_APP_KEY && env.DROPBOX_APP_SECRET) return true;
  // A UI-connected account counts as configured — it carries its own refresh token, and the app
  // key/secret needed to spend it come from env.
  if (!env.DROPBOX_APP_KEY || !env.DROPBOX_APP_SECRET) return false;
  try {
    const store = require('./oauthTokenStore');
    if (email) return Boolean(store.getDropboxToken(email));
    return store.getDropboxStatus().connected;
  } catch {
    return false;
  }
}

module.exports = {
  // helpers worth testing directly
  dbxPath,
  apiArg,
  toItem,
  isPaperEntry,
  isRetryable,
  isConfigured,
  // identity / team
  getAccessToken,
  getCurrentAccount,
  listTeamMembers,
  resolveTeamMemberId,
  listTeamGroups,
  // read
  listFolder,
  buildFolderTree,
  getMetadata,
  listFileMembers,
  listFolderMembers,
  listItemMembers,
  listSharedLinks,
  listRevisions,
  downloadFile,
  exportPaper,
  // write
  createFolder,
  uploadFile,
  shareFolder,
  addFolderMember,
  addFileMember,
  createSharedLink,
  movePath,
  deletePath,
};
