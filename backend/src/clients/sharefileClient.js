/**
 * Citrix ShareFile client — SOURCE side for the `sharefile → sharepoint` content combination.
 *
 * Phase B (the combination). Phase A — the connect layer: env vars, OAuth routes, token store — was
 * built separately and is the contract this file obeys. See
 * `ai-sdlc/requirements/specs/003-sharefile-to-sharepoint.md`.
 *
 * ── The account host is an OUTPUT of sign-in, never an input ───────────────────────────────────
 *
 * There is deliberately no SHAREFILE_SUBDOMAIN setting. Sign-in goes to one well-known host
 * (https://secure.sharefile.com/oauth/authorize) and the callback returns `subdomain` and `apicp`;
 * https://{subdomain}.{apicp} is the only place that account's API calls can go. The connect layer
 * persists it per-account in oauthTokenStore as `subdomain` + `apiHost`, and THIS FILE READS IT
 * FROM THERE. Per https://api.sharefile.com/gettingstarted/oauth2.
 *
 * That is why every function here takes an `email`: it identifies which connected ShareFile account
 * to act as, and therefore which host and refresh token to use. A client that assumed one global
 * host would call the wrong tenant the moment a second account was connected.
 *
 * ⚠️ UNVERIFIED AGAINST A LIVE TENANT. The OAuth contract above comes from the Phase A spec, which
 * was measured against a real ShareFile cloud. The Items API paths and response field names below
 * are from ShareFile's documented v3 surface and have NOT been executed. Everything most likely to
 * be wrong is centralised in ENDPOINTS and FIELD, so a correction is one edit. Run
 * `verifyConnection(email)` first — it exercises the stored host, the token refresh, root resolution
 * and a child listing in one call and reports what it got.
 */
const axios = require('axios');
const env = require('../config/env');
const logger = require('../utils/logger');
const tokenStore = require('./oauthTokenStore');
const { retryWithBackoff } = require('../utils/retry');

/** Fallback control plane, used only when a stored account somehow carries no host. */
const DEFAULT_APICP = 'sf-api.com';

const ENDPOINTS = {
  /** Host-scoped token endpoint, assembled from the account's own stored host. */
  token: (host) => `https://${host}/oauth/token`,
  /** API base under the account host. */
  apiBase: (host) => `https://${host}/sf/v3`,

  root: '/Items',
  item: (id) => `/Items(${id})`,
  children: (id) => `/Items(${id})/Children`,
  accessControls: (id) => `/Items(${id})/AccessControls`,
  versions: (id) => `/Items(${id})/PreviousVersions`,
  download: (id) => `/Items(${id})/Download`,
  createFolder: (parentId) => `/Items(${parentId})/Folder`,
  deleteItem: (id) => `/Items(${id})`,
  uploadRequest: (parentId) => `/Items(${parentId})/Upload`,
  /**
   * `/Users` returns only the CALLER — verified on the live tenant: one row, zara@storefuze.com.
   * The account's actual licensed users are Employees, and the count matches what the ShareFile
   * admin screen reports under "User Licenses" (5 of 5 on syncgalaxy). Using /Users for the run
   * wizard's Map Users step showed "0 source" once the caller was filtered out, which is why this
   * distinction is spelled out rather than left to whoever reads the API docs next.
   */
  users: '/Users',
  employees: '/Accounts/Employees',
  /** External share recipients — not licensed users. Listed separately, never merged into Employees. */
  clients: '/Accounts/Clients',
  groups: '/Groups',
  /** Shared links. Out of scope for ShareFile → SharePoint — seeded only as a negative control. */
  shares: '/Shares',
};

/** ShareFile is PascalCase and varies by entity — isolated so a mismatch is one edit. */
const FIELD = {
  id: 'Id',
  name: 'Name',
  size: 'FileSizeBytes',
  createdAt: 'CreationDate',
  modifiedAt: 'ClientModifiedDate',
  /**
   * The modified date ShareFile ACTUALLY populates.
   *
   * `ClientModifiedDate` is the documented field and it comes back null on every item this account
   * holds — verified against the live API, where a seeded file carried only CreationDate,
   * ProgenyEditDate and ExpirationDate. With modifiedAt null on the source, deepContentCore's
   * compareTimestamps returns `comparable: false` for every pair, which is why feature 3.1 reported
   * "no item carried a modified timestamp on both sides — not assessed" on runs where the
   * destination had perfectly good timestamps.
   */
  modifiedAtFallback: 'ProgenyEditDate',
  odataType: 'odata.type',
  children: 'value',
  email: 'Email',
  folderType: 'ShareFile.Api.Models.Folder',
  /**
   * Principal types, and they are NOT decoration. Verified on the live tenant on 2026-09-11: a
   * grant posted with a bare `Principal: { Id }` resolves the id against USERS only, so a group id
   * comes back `404 "User not found: "` — with an empty name, which reads like a malformed request
   * rather than the type mismatch it is. Adding `odata.type` to the Principal makes the identical
   * call succeed (HTTP 200, the group row appears in the item's ACL with exactly the flags asked
   * for). `/Items(id)/AccessControls/Bulk` does not exist on this API version — 404 "Route not
   * found." — so this is the only working shape for a group grant.
   */
  userType: 'ShareFile.Api.Models.User',
  groupType: 'ShareFile.Api.Models.Group',
};

/** Per-principal access flags ShareFile exposes. Reported, never mapped — see roleMaps. */
const ACCESS_FLAGS = [
  'CanView', 'CanDownload', 'CanUpload', 'CanDelete', 'CanManagePermissions', 'CanAddFolder',
];

const tokenCache = new Map();
const refreshLocks = new Map();

/* ── Account resolution ─────────────────────────────────────────────────────*/

/**
 * True when the app credentials exist AND at least one ShareFile account is connected.
 *
 * Both halves matter and neither is sufficient. App credentials with nothing connected cannot name
 * a host; a connected account with no app credentials cannot refresh its token. The validator calls
 * this before comparing anything so an unusable configuration fails with a reason rather than a
 * wall of "missing at destination".
 */
function isConfigured(email) {
  if (!env.SHAREFILE_CLIENT_ID || !env.SHAREFILE_CLIENT_SECRET) return false;
  const acct = resolveAccount(email);
  return Boolean(acct && acct.host);
}

/**
 * The connected ShareFile account to act as, with its host resolved.
 *
 * `email` picks a specific account. Omitted, the single connected account is used — and when several
 * are connected, omitting it is an error rather than a silent pick, because acting as the wrong
 * ShareFile tenant reads a different file tree entirely.
 *
 * @returns {{email:string, host:string, refreshToken:string|null, accessToken:string|null}|null}
 */
function resolveAccount(email) {
  const status = tokenStore.getShareFileStatus();
  if (!status.connected) return null;

  const addr = String(email || '').toLowerCase().trim();

  // An exact match is always preferred: that address IS a connected account.
  if (addr) {
    const exact = tokenStore.getShareFileToken(addr);
    if (exact) return entryToAccount(addr, exact);
  }

  // Otherwise the address names the USER BEING MIGRATED, not the account we authenticate as.
  //
  // This returned null for anything that was not itself connected, and every caller then reported
  // "ShareFile is not connected" — which a run hit immediately, because the wizard passes
  // context.sourceEmail (one of the five ShareFile employees, e.g. alex@filefuze.co) while the
  // CONNECTED account is the admin who signed in (zara@storefuze.com). The message was doubly
  // misleading: ShareFile was connected, and the address it complained about was a perfectly valid
  // source user.
  //
  // One connected account is therefore used for any address. The admin's token is what reads the
  // account's items regardless of whose content is being migrated, exactly as the Dropbox client
  // uses one team credential for every member.
  if (status.emails.length === 1) {
    const only = status.email;
    const entry = tokenStore.getShareFileToken(only);
    if (!entry) return null;
    if (addr && addr !== only) {
      logger.info(`[sharefile] acting as the connected account ${only} for source user ${addr}`);
    }
    return entryToAccount(only, entry);
  }

  // Several accounts connected and none matched: refuse rather than guess. Acting as the wrong
  // ShareFile tenant reads a different file tree entirely, and the run would compare the wrong data
  // while looking healthy.
  throw new Error(
    `ShareFile: ${status.emails.length} accounts are connected (${status.emails.join(', ')}) and `
    + `none is "${addr || '(unspecified)'}". Name which connected account to act as — picking one `
    + 'silently would read a different tenant\'s files.'
  );
}

/** Shape a stored token record into the account descriptor callers use. */
function entryToAccount(addr, entry) {
  // apiHost is what the connect layer stores; subdomain + the default plane is the fallback for an
  // older record written before apiHost existed.
  const host = entry.apiHost || (entry.subdomain ? `${entry.subdomain}.${DEFAULT_APICP}` : null);
  return { email: addr, host, refreshToken: entry.refreshToken, accessToken: entry.accessToken };
}

/* ── Auth ───────────────────────────────────────────────────────────────────*/

/**
 * A valid access token for one connected account, refreshed and cached per account.
 *
 * Single-flight per account: concurrent callers during a refresh await the same promise instead of
 * each firing their own, which is how a token endpoint gets rate-limited in the middle of a run.
 */
async function getAccessToken(email) {
  const acct = resolveAccount(email);
  if (!acct) {
    throw new Error(
      'ShareFile is not connected. Open Connect Clouds → Content → Citrix ShareFile and sign in. '
      + '(SHAREFILE_CLIENT_ID and SHAREFILE_CLIENT_SECRET must be set in the root .env first.)'
    );
  }
  if (!acct.host) {
    throw new Error(
      `ShareFile account ${acct.email} is stored without an API host. Disconnect and reconnect it — `
      + 'the host arrives on the OAuth callback and cannot be configured by hand.'
    );
  }

  const cacheKey = acct.email;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 120000) return cached.token;
  if (refreshLocks.has(cacheKey)) return refreshLocks.get(cacheKey);

  if (!acct.refreshToken) {
    // A stored access token with no refresh token is usable until it expires — roughly an hour,
    // which is shorter than a content run. Used, but said out loud.
    if (acct.accessToken) {
      logger.warn(`[sharefile] ${acct.email} has no refresh token — using the stored access token, `
        + 'which expires in ~1 hour and may die mid-run. Reconnect the account to fix this.');
      return acct.accessToken;
    }
    throw new Error(`ShareFile account ${acct.email} has neither a refresh nor an access token — reconnect it.`);
  }

  const p = (async () => {
    try {
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: env.SHAREFILE_CLIENT_ID,
        client_secret: env.SHAREFILE_CLIENT_SECRET,
        refresh_token: acct.refreshToken,
      });
      const res = await retryWithBackoff(
        () => axios.post(ENDPOINTS.token(acct.host), body.toString(), {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 30000,
        }),
        { label: 'ShareFile token refresh' }
      );
      const d = res.data || {};
      if (!d.access_token) throw new Error('token endpoint returned no access_token');

      const ttl = Number(d.expires_in || 3600) * 1000;
      tokenCache.set(cacheKey, { token: d.access_token, expiresAt: Date.now() + ttl });

      // Persist the rotated refresh token. ShareFile may return a new one, and dropping it would
      // make the account fail on the NEXT run with an invalid_grant that looks like a revocation.
      if (d.refresh_token && d.refresh_token !== acct.refreshToken) {
        tokenStore.setShareFileToken({
          email: acct.email,
          accessToken: d.access_token,
          refreshToken: d.refresh_token,
          expiresAt: Date.now() + ttl,
        });
        logger.info(`[sharefile] ${acct.email}: refresh token rotated and persisted`);
      }
      logger.info(`[sharefile] access token refreshed for ${acct.email}`);
      return d.access_token;
    } finally {
      refreshLocks.delete(cacheKey);
    }
  })();

  refreshLocks.set(cacheKey, p);
  return p;
}

/* ── Request helper ─────────────────────────────────────────────────────────*/

/** Authenticated call against one account's host. All outbound traffic goes through here. */
async function apiRequest(email, pathname, { method = 'GET', params, data, responseType, label } = {}) {
  const acct = resolveAccount(email);
  const url = `${ENDPOINTS.apiBase(acct.host)}${pathname}`;

  const send = async (token) => retryWithBackoff(
    () => axios({
      url,
      method,
      params,
      data,
      responseType,
      headers: { Authorization: `Bearer ${token}` },
      timeout: 120000,
      maxRedirects: 5,
    }),
    { label: label || `ShareFile ${method} ${pathname}` }
  );

  try {
    return (await send(await getAccessToken(email))).data;
  } catch (err) {
    if (err?.response?.status !== 401) throw err;

    // A cached access token that ShareFile no longer honours.
    //
    // The cache trusts its own `expires_in`, so a token invalidated EARLY is never retried and every
    // call 401s until the process restarts. That is not hypothetical: ShareFile rotates the token on
    // refresh, so any other process refreshing the same account — a script, a second run — silently
    // kills the one this process is holding while its cached expiry still reads valid. The running
    // server returned 401 on every ShareFile call for exactly this reason while a fresh process
    // reading the same stored credentials worked.
    //
    // So a 401 is treated as "this token is dead", not "the account is broken": drop it, refresh,
    // retry ONCE. A second 401 is a genuine authorisation failure and is thrown with that stated,
    // because retrying further would just spin on a revoked grant.
    const acctEmail = acct.email;
    logger.warn(`[sharefile] 401 on ${method} ${pathname} — discarding the cached token for `
      + `${acctEmail} and retrying once with a fresh one`);
    tokenCache.delete(acctEmail);

    try {
      return (await send(await getAccessToken(email))).data;
    } catch (retryErr) {
      if (retryErr?.response?.status === 401) {
        throw new Error(
          `ShareFile returned 401 for ${acctEmail} even after refreshing the token. The grant has `
          + 'most likely been revoked, or the OAuth app\'s secret was rotated. Reconnect the account '
          + '(Connect Clouds → Content → Citrix ShareFile), or re-run the manual code exchange.'
        );
      }
      throw retryErr;
    }
  }
}

/* ── Normalisation ──────────────────────────────────────────────────────────*/

/**
 * ShareFile entity → the item shape `validation/shared/deepContentCore.js` compares.
 * `path` is assembled during the walk: ShareFile returns a parent reference, not a full path.
 */
function toItem(entity, parentPath = '') {
  if (!entity) return null;
  const type = String(entity[FIELD.odataType] || '').includes('Folder') ? 'folder' : 'file';
  const name = entity[FIELD.name] || '';
  const path = parentPath ? `${parentPath.replace(/\/+$/, '')}/${name}` : `/${name}`;
  return {
    id: entity[FIELD.id],
    name,
    path,
    type,
    size: type === 'file' ? Number(entity[FIELD.size] || 0) : 0,
    // No mimeType is invented. ShareFile has no native document format — no equivalent of a Google
    // Doc or a Box Note — so every item is an ordinary binary, which is exactly how deepContentCore
    // treats an absent mimeType. Inventing one would make isConverted()/isHashable() misjudge it.
    createdAt: entity[FIELD.createdAt] || null,
    modifiedAt: entity[FIELD.modifiedAt] || entity[FIELD.modifiedAtFallback] || null,
    raw: entity,
  };
}

/* ── Read ───────────────────────────────────────────────────────────────────*/

async function getRoot(email) {
  return toItem(await apiRequest(email, ENDPOINTS.root, { label: 'ShareFile getRoot' }), '');
}

async function listChildren(email, folderId, parentPath = '') {
  const d = await apiRequest(email, ENDPOINTS.children(folderId), { label: 'ShareFile listChildren' });
  const rows = Array.isArray(d?.[FIELD.children]) ? d[FIELD.children] : [];
  return rows.map((r) => toItem(r, parentPath)).filter(Boolean);
}

/**
 * Walk a folder into a flat item list.
 *
 * The depth cap is REPORTED, never silent: a truncated walk that looked complete would show every
 * un-walked item as "missing at the destination" — a run of false failures with no clue why.
 */
async function buildFolderTree(email, rootId, { rootPath = '', maxDepth = 25 } = {}) {
  const items = [];
  const truncatedAt = [];

  async function walk(id, path, depth) {
    if (depth > maxDepth) { truncatedAt.push(path); return; }
    const children = await listChildren(email, id, path);
    for (const child of children) {
      items.push(child);
      if (child.type === 'folder') await walk(child.id, child.path, depth + 1);
    }
  }

  await walk(rootId, rootPath, 1);
  if (truncatedAt.length > 0) {
    logger.warn(`[sharefile] tree walk hit the depth cap (${maxDepth}) at ${truncatedAt.length} path(s) — `
      + 'raise treeDepth in utils/contentTolerance/sharefileToSharepoint.js or these items will be '
      + `reported as missing: ${truncatedAt.slice(0, 3).join(', ')}`);
  }
  return { items, truncatedAt };
}

/**
 * Per-principal access controls on an item.
 *
 * Returned as raw flag sets, NOT as a role. ShareFile grants access as independent booleans and this
 * combination publishes no role-mapping table, so naming a role here would be the guess that
 * validation/roleMaps/sharefile_to_sharepoint.js exists to refuse. `role` is a flag summary so the
 * report can state what the source had.
 */
async function listAccessControls(email, itemId) {
  const d = await apiRequest(email, ENDPOINTS.accessControls(itemId), { label: 'ShareFile listAccessControls' });
  const rows = Array.isArray(d?.[FIELD.children]) ? d[FIELD.children] : [];
  return rows.map((r) => {
    const principal = r.Principal || {};
    const flags = ACCESS_FLAGS.filter((f) => r[f] === true);
    const isGroup = String(principal[FIELD.odataType] || '').includes('Group');
    return {
      email: (principal[FIELD.email] || '').toLowerCase(),
      name: principal[FIELD.name] || '',
      type: isGroup ? 'group' : 'user',
      role: flags.join('+') || 'none',
      flags,
      raw: r,
    };
  });
}

async function listVersions(email, itemId) {
  const d = await apiRequest(email, ENDPOINTS.versions(itemId), { label: 'ShareFile listVersions' });
  const rows = Array.isArray(d?.[FIELD.children]) ? d[FIELD.children] : [];
  return rows.map((r) => ({
    id: r[FIELD.id],
    size: Number(r[FIELD.size] || 0),
    modifiedAt: r[FIELD.modifiedAt] || null,
  }));
}

async function downloadFile(email, itemId) {
  const data = await apiRequest(email, ENDPOINTS.download(itemId), {
    responseType: 'arraybuffer',
    label: 'ShareFile downloadFile',
  });
  return Buffer.from(data);
}

async function listUsers(email, { includeClients = false } = {}) {
  const map = (rows) => (Array.isArray(rows) ? rows : [])
    .map((r) => ({
      id: r[FIELD.id],
      email: String(r[FIELD.email] || '').toLowerCase(),
      name: r.FullName || r[FIELD.name] || '',
      kind: r.__kind,
    }))
    .filter((u) => u.email);

  const out = [];
  try {
    const d = await apiRequest(email, ENDPOINTS.employees, { label: 'ShareFile listEmployees' });
    const rows = (Array.isArray(d?.[FIELD.children]) ? d[FIELD.children] : []).map((r) => ({ ...r, __kind: 'employee' }));
    out.push(...map(rows));
  } catch (err) {
    logger.warn(`[sharefile] /Accounts/Employees failed (${err?.response?.status || err.message}) — falling back to /Users`);
  }

  if (includeClients) {
    try {
      const d = await apiRequest(email, ENDPOINTS.clients, { label: 'ShareFile listClients' });
      const rows = (Array.isArray(d?.[FIELD.children]) ? d[FIELD.children] : []).map((r) => ({ ...r, __kind: 'client' }));
      out.push(...map(rows));
    } catch (err) {
      logger.warn(`[sharefile] /Accounts/Clients failed: ${err.message}`);
    }
  }

  // Fallback only when Employees produced nothing: /Users still names the caller, which is better
  // than an empty list that reads as "this account has no users".
  if (out.length === 0) {
    const d = await apiRequest(email, ENDPOINTS.users, { label: 'ShareFile listUsers' });
    out.push(...map(Array.isArray(d?.[FIELD.children]) ? d[FIELD.children] : []));
  }

  // De-duplicate: an address can appear as both an employee and a client.
  const seen = new Set();
  return out.filter((u) => (seen.has(u.email) ? false : seen.add(u.email)));
}

async function listGroups(email) {
  const d = await apiRequest(email, ENDPOINTS.groups, { label: 'ShareFile listGroups' });
  const rows = Array.isArray(d?.[FIELD.children]) ? d[FIELD.children] : [];
  // Groups carry a NAME and usually no email — 53 rows on the live tenant, none with an Email
  // field. Filtering on email (as the user listing does) would drop every one of them, so the name
  // is the identity here and is what a group grant is matched on at the destination.
  return rows
    .map((r) => ({
      id: r[FIELD.id],
      email: String(r[FIELD.email] || '').toLowerCase(),
      name: r.Name || r[FIELD.name] || '',
    }))
    .filter((g) => g.name || g.email);
}

/**
 * Shared links on an item.
 *
 * Read so a negative control can prove the SOURCE holds a link before the destination is checked
 * for its absence. A control that was never planted must report "not exercised", never a pass.
 */
async function listShares(email) {
  const d = await apiRequest(email, ENDPOINTS.shares, { label: 'ShareFile listShares' });
  const rows = Array.isArray(d?.[FIELD.children]) ? d[FIELD.children] : [];
  return rows.map((r) => ({
    id: r[FIELD.id],
    title: r.Title || '',
    uri: r.Uri || '',
    shareType: r.ShareType || '',
    raw: r,
  }));
}

/**
 * Create a shared link on one item.
 *
 * Shared Links are an OUT-OF-SCOPE feature for this combination, so this exists to plant something
 * that must NOT reach the destination — the mirror of every other seeding call in this client.
 *
 * `notify=false` for the same reason grants are written without it: seeding must not email anyone,
 * and in-scope feature 7.1 is specifically about notifications not being generated during a run.
 */
async function createShare(email, itemId, { title = 'QA negative control — shared link' } = {}) {
  if (!itemId) throw new Error('ShareFile createShare: an item id is required');
  const d = await apiRequest(email, ENDPOINTS.shares, {
    method: 'POST',
    params: { notify: false },
    data: {
      ShareType: 'Send',
      Title: title,
      Items: [{ Id: itemId }],
      RequireLogin: false,
      RequireUserInfo: false,
    },
    label: 'ShareFile createShare',
  });
  return { id: d?.[FIELD.id] || null, uri: d?.Uri || '', title };
}

/* ── Write (seeding) ────────────────────────────────────────────────────────*/

/**
 * Grant one principal a set of access flags on one item.
 *
 * ShareFile has no "role" to assign — access is a set of independent booleans — so the caller passes
 * the exact flags it wants and EVERY flag in ACCESS_FLAGS is written explicitly, the ungranted ones
 * as `false`. Omitting them would leave whatever the item inherited in place, and a rung of the
 * permission ladder that quietly carried a neighbouring rung's flags would make the whole ladder
 * untrustworthy: "view only" has to mean view only, or comparing rungs at the destination proves
 * nothing.
 *
 * `notify=false` matters. A grant normally emails the principal, and feature 7.1 is specifically
 * about notifications NOT being sent during a migration test — seeding the data must not be the thing
 * that fills a mailbox.
 *
 * The result is READ BACK rather than assumed: ShareFile silently ignores flags that do not apply to
 * an item type, so `applied` is what the server actually stored, not what was asked for.
 *
 * `principalType` must be `'group'` for a group id. See FIELD.groupType for why — without it the
 * call 404s with a message that names the wrong problem.
 */
async function setAccessControl(email, itemId, principalId, flags = {}, { notify = false, recursive = false, principalType = 'user' } = {}) {
  if (!itemId) throw new Error('ShareFile setAccessControl: an item id is required');
  if (!principalId) throw new Error('ShareFile setAccessControl: a principal id is required');

  const data = {
    Principal: {
      Id: principalId,
      // Always sent, for users too. The user case happens to work without it, but relying on that
      // means the one call in the codebase that grants access behaves differently for the two
      // principal kinds for no reason a reader could see.
      [FIELD.odataType]: principalType === 'group' ? FIELD.groupType : FIELD.userType,
    },
  };
  for (const f of ACCESS_FLAGS) data[f] = flags[f] === true;

  await apiRequest(email, ENDPOINTS.accessControls(itemId), {
    method: 'POST',
    params: { notify, recursive },
    data,
    label: 'ShareFile setAccessControl',
  });

  let applied = [];
  try {
    const acl = await listAccessControls(email, itemId);
    const row = acl.find((a) => String(a.raw?.Principal?.[FIELD.id] || '') === String(principalId));
    applied = row ? row.flags : [];
  } catch (err) {
    logger.warn(`[sharefile] grant written on ${itemId} but read-back failed: ${err.message}`);
  }

  const asked = ACCESS_FLAGS.filter((f) => flags[f] === true);
  return {
    itemId,
    principalId,
    asked,
    applied,
    /** Flags asked for that the server did not store — the ladder rung is weaker than intended. */
    dropped: asked.filter((f) => !applied.includes(f)),
  };
}

async function createFolder(email, parentId, name, { overwrite = false } = {}) {
  return toItem(await apiRequest(email, ENDPOINTS.createFolder(parentId), {
    method: 'POST',
    params: { overwrite },
    data: { Name: name },
    label: 'ShareFile createFolder',
  }));
}

/**
 * Delete an item (file or folder) permanently.
 *
 * Used by CleanupAgent to remove the seeding root before a run. The whole folder is deleted rather
 * than emptied item by item: ShareFile has no bulk-empty call, so this is one request instead of one
 * per item, and the seeder recreates the folder on its next pass.
 *
 * DESTRUCTIVE, and deliberately takes an explicit id — never a path or a name — so a caller cannot
 * accidentally target a whole account by passing a root.
 */
async function deleteItem(email, itemId) {
  if (!itemId) throw new Error('ShareFile deleteItem: an item id is required');
  await apiRequest(email, ENDPOINTS.deleteItem(itemId), {
    method: 'DELETE',
    label: 'ShareFile deleteItem',
  });
  return { id: itemId, deleted: true };
}

/**
 * Upload a file. Two-step: request an upload spec, then POST bytes to the ChunkUri it returns.
 *
 * The second POST goes to a storage host, not the API host, so it is issued directly — and
 * deliberately carries NO Authorization header. The ChunkUri is already an authenticated
 * short-lived URL, and forwarding a bearer token to a storage host is how a token ends up in
 * someone else's logs.
 */
async function uploadFile(email, parentId, name, buffer) {
  const spec = await apiRequest(email, ENDPOINTS.uploadRequest(parentId), {
    params: { method: 'standard', raw: true, fileName: name, fileSize: buffer.length, overwrite: true },
    label: 'ShareFile uploadRequest',
  });
  const chunkUri = spec?.ChunkUri;
  if (!chunkUri) throw new Error(`ShareFile upload: no ChunkUri returned for "${name}"`);

  await retryWithBackoff(
    () => axios.post(chunkUri, buffer, {
      headers: { 'Content-Type': 'application/octet-stream' },
      timeout: 300000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    }),
    { label: 'ShareFile uploadFile' }
  );
  return { name, size: buffer.length };
}

/* ── Diagnostics ────────────────────────────────────────────────────────────*/

/**
 * One-call smoke test. Run this FIRST against a live tenant — it is the fastest way to find which of
 * the unverified Items-API assumptions in this file are wrong.
 *
 * Exercises: app credentials → connected account → stored host → token refresh → root → children.
 * Reports rather than throws, so a partial success is still informative.
 */
async function verifyConnection(email) {
  const out = {
    appCredentials: false, account: null, host: null, token: false,
    root: null, childCount: null, errors: [],
  };
  try {
    out.appCredentials = Boolean(env.SHAREFILE_CLIENT_ID && env.SHAREFILE_CLIENT_SECRET);
    if (!out.appCredentials) {
      out.errors.push('SHAREFILE_CLIENT_ID / SHAREFILE_CLIENT_SECRET are not set in the root .env');
      return out;
    }

    const acct = resolveAccount(email);
    if (!acct) {
      out.errors.push('no ShareFile account connected — Connect Clouds → Content → Citrix ShareFile');
      return out;
    }
    out.account = acct.email;
    out.host = acct.host;
    if (!acct.host) {
      out.errors.push('the connected account carries no API host — disconnect and reconnect it');
      return out;
    }

    await getAccessToken(acct.email);
    out.token = true;

    const root = await getRoot(acct.email);
    out.root = root ? { id: root.id, name: root.name } : null;
    if (!root?.id) {
      out.errors.push(`root resolved but carried no ${FIELD.id} — check the FIELD map in this file`);
      return out;
    }

    out.childCount = (await listChildren(acct.email, root.id, '')).length;
  } catch (err) {
    out.errors.push(err?.response?.status ? `HTTP ${err.response.status}: ${err.message}` : err.message);
  }
  return out;
}

module.exports = {
  // helpers worth testing directly
  toItem,
  isConfigured,
  resolveAccount,
  ENDPOINTS,
  FIELD,
  ACCESS_FLAGS,
  // auth
  getAccessToken,
  // read
  getRoot,
  listChildren,
  buildFolderTree,
  listAccessControls,
  listVersions,
  downloadFile,
  listUsers,
  listGroups,
  listShares,
  // write
  createFolder,
  uploadFile,
  deleteItem,
  setAccessControl,
  createShare,
  // diagnostics
  verifyConnection,
};
