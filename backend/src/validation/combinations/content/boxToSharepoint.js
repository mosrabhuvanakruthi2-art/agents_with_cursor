const ContentReportValidationAgent = require('../../../agents/content/ContentReportValidationAgent');
const sharepointClient = require('../../../clients/sharepointClient');
const boxClient = require('../../../clients/boxClient');
const roleMap = require('../../contentRoleMap');
const env = require('../../../config/env');
const logger = require('../../../utils/logger');

const SP_HOSTNAME  = 'filefuze.sharepoint.com';
const SP_SITE_PATH = '/sites/SANITYDATAA';

// Characters SharePoint disallows in item names — CloudFuze replaces each with "_" on migration.
const SP_INVALID_CHARS = /[~"#%&*:<>?/\\{|}]/g;
const TS_TOLERANCE_MS = 5 * 60 * 1000;  // modified-time drift treated as "preserved"
const TREE_DEPTH = 4;                    // cap recursion (avoids the 120-level long-path scenario)
const DEDUP_MAX = 5;                     // how many "name N" dedup variants to probe

/** The name SharePoint should end up with: invalid chars → "_" (rule #11). Case preserved. */
function spRename(name) {
  return String(name || '').replace(SP_INVALID_CHARS, '_');
}
/** Normalised key for matching: SharePoint-renamed + lower-cased + trimmed. */
function normKey(name) {
  return spRename(name).toLowerCase().trim();
}
/** Match two names allowing the SharePoint truncation of very long names (prefix match ≥60 chars). */
function namesMatch(boxName, spName) {
  const a = normKey(boxName);
  const b = normKey(spName);
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer  = a.length <= b.length ? b : a;
  return shorter.length >= 60 && longer.startsWith(shorter);
}

function lastSegment(path) {
  const segs = String(path || '').split('/').map((s) => s.trim()).filter(Boolean);
  return segs[segs.length - 1] || '';
}
function joinPath(parent, child) {
  const p = `/${String(parent || '').replace(/^\/+|\/+$/g, '')}`;
  const c = String(child || '').replace(/^\/+|\/+$/g, '');
  return (p === '/' ? '' : p) + (c ? `/${c}` : '') || '/';
}
/**
 * CloudFuze dest path ("/SANITY DATAA/Documents[/sub]") → path WITHIN the SharePoint default
 * drive. The Graph default drive IS the Documents library, so everything up to and including
 * "Documents" collapses to the drive root.
 */
function inDrivePath(destinationPath) {
  const segs = String(destinationPath || '').split('/').map((s) => s.trim()).filter(Boolean);
  const docIdx = segs.findIndex((s) => /^documents$/i.test(s));
  const sub = docIdx >= 0 ? segs.slice(docIdx + 1) : segs;
  return `/${sub.join('/')}`;
}

/** Strip a leading prefix from each item.path so two trees compare on a common relative root. */
function relativize(items, prefix) {
  const pfx = String(prefix || '').replace(/\/+$/, '');
  return items.map((i) => {
    let rel = i.path;
    if (pfx && rel.startsWith(pfx)) rel = rel.slice(pfx.length) || '/';
    return { ...i, path: rel.startsWith('/') ? rel : `/${rel}` };
  });
}

/**
 * Folder-only structure comparison (validation rules: exact names, parent-child relationships,
 * depth, no missing, no extra). Returns counts + missing/extra/misplaced lists + PASS/FAIL,
 * plus the relative folder paths of each side for the ASCII trees in the PDF.
 */
function compareFolders(boxTree, spTree, spRootPath, boxRootName, spRootName) {
  const norm = (p) => p.split('/').filter(Boolean).map((s) => normKey(s)).join('/');
  const base = (p) => normKey(p.split('/').filter(Boolean).pop() || '');

  const boxPaths = boxTree.filter((i) => i.type === 'folder').map((i) => i.path);
  const spPaths  = relativize(spTree.filter((i) => i.type === 'folder'), spRootPath).map((i) => i.path);

  const boxSet = new Map(boxPaths.map((p) => [norm(p), p]));
  const spSet  = new Map(spPaths.map((p) => [norm(p), p]));

  const matched    = [...boxSet.keys()].filter((k) => spSet.has(k));
  const rawMissing = [...boxSet.entries()].filter(([k]) => !spSet.has(k)).map(([, p]) => p);
  const rawExtra   = [...spSet.entries()].filter(([k]) => !boxSet.has(k)).map(([, p]) => p);

  // Misplaced = same folder name present on both sides but under a different parent (moved).
  const extraByBase = {};
  for (const p of rawExtra) (extraByBase[base(p)] = extraByBase[base(p)] || []).push(p);
  const misplaced = []; const misMiss = new Set(); const misExtra = new Set();
  for (const mp of rawMissing) {
    const b = base(mp);
    if (extraByBase[b] && extraByBase[b].length) {
      const ep = extraByBase[b].shift();
      misplaced.push({ name: mp.split('/').filter(Boolean).pop(), source: mp, dest: ep });
      misMiss.add(mp); misExtra.add(ep);
    }
  }
  const missing = rawMissing.filter((p) => !misMiss.has(p));
  const extra   = rawExtra.filter((p) => !misExtra.has(p));
  const status  = (missing.length === 0 && extra.length === 0 && misplaced.length === 0) ? 'PASS' : 'FAIL';

  return {
    totalSource: boxPaths.length, totalDest: spPaths.length,
    matched: matched.length, missing, extra, misplaced, status,
    boxRootName: boxRootName || '(root)', spRootName: spRootName || '(root)',
    boxFolderPaths: boxPaths.slice().sort(), spFolderPaths: spPaths.slice().sort(),
  };
}

/** Build a source→destination email map from Map-Users, the permission mapping, and migrated units. */
function buildEmailMap(context) {
  const map = {};
  const add = (s, d) => { if (s && d) map[String(s).toLowerCase()] = String(d).toLowerCase(); };
  for (const m of (context.userEmailMappings || [])) add(m?.sourceEmail, m?.destinationEmail);
  for (const m of (context.migratedUsers || [])) add(m?.sourceEmail, m?.destinationEmail);
  const pm = context.permissionMapping;
  if (Array.isArray(pm)) {
    for (const m of pm) add(m?.sourceEmail || m?.fromMailId || m?.from, m?.destinationEmail || m?.toMailId || m?.to);
  } else if (pm && typeof pm === 'object') {
    for (const [s, d] of Object.entries(pm)) add(s, typeof d === 'string' ? d : d?.destinationEmail);
  }
  return map;
}

function resolveUnits(context) {
  const migrated = Array.isArray(context.migratedUsers) ? context.migratedUsers : [];
  if (migrated.length > 0) {
    return migrated.map((m) => ({
      sourceEmail: m.sourceEmail || context.sourceEmail,
      destinationEmail: m.destinationEmail || context.destinationEmail,
      sourcePath: m.sourcePath || context.sourceTestDataPath || '',
      destinationPath: m.destinationPath || context.destinationPath || '/',
    }));
  }
  const folders = Array.isArray(context.userFolderMappings) ? context.userFolderMappings : [];
  if (folders.length > 0) {
    return folders.map((f) => ({
      sourceEmail: f.sourceEmail || context.sourceEmail,
      destinationEmail: f.destinationEmail || context.destinationEmail,
      sourcePath: f.sourcePath || context.sourceTestDataPath || '',
      destinationPath: f.destinationPath || context.destinationPath || '/',
    }));
  }
  return [{
    sourceEmail: context.sourceEmail,
    destinationEmail: context.destinationEmail,
    sourcePath: context.sourceTestDataPath || context.sourcePath || '',
    destinationPath: context.destinationPath || '/',
  }];
}

class BoxToSharepointValidationAgent extends ContentReportValidationAgent {
  static supportsDeepValidation = true;

  constructor() {
    super('BoxToSharepointValidationAgent');
  }

  async execute(context) {
    const globalChecks = [];
    const gPush = (status, name, detail) => globalChecks.push({ name, status, detail });

    // CloudFuze migration report
    const report   = context.contentMigrationReport || context.migrationJobDetails;
    const cfStatus = String(report?.status || report?.cfStatus || '').toUpperCase();
    const processed = Number(report?.processedCount) || 0;
    const total     = Number(report?.totalCount) || 0;
    if (['PROCESSED', 'PROCESS', 'VERSION_PROCESSED'].includes(cfStatus)) gPush('PASS', 'CloudFuze migration status', `${cfStatus} — ${processed}/${total} items`);
    else if (['PROCESSED_WITH_CONFLICTS', 'PROCESS_WITH_CONFLICTS'].includes(cfStatus)) gPush('WARN', 'CloudFuze migration status', `${cfStatus} — ${processed}/${total} (conflicts present)`);
    else if (!cfStatus) gPush('WARN', 'CloudFuze migration status', 'Status unknown — proceeding with file-level checks');
    else gPush('FAIL', 'CloudFuze migration status', `${cfStatus} — expected PROCESSED`);

    const skipped = Array.isArray(context.skippedUsers) ? context.skippedUsers : [];
    if (skipped.length > 0) gPush('WARN', `Skipped pairs (${skipped.length})`, skipped.map((s) => `${s.sourceEmail} "${s.sourcePath}" — ${s.reason || 'not migrated'}`).join(' | '));

    // SharePoint site
    let siteId = null;
    try {
      const site = await sharepointClient.getSite(SP_HOSTNAME, SP_SITE_PATH, context.destinationEmail);
      siteId = site?.id || null;
      gPush(siteId ? 'PASS' : 'FAIL', 'SharePoint site accessible', siteId ? `${SP_HOSTNAME}${SP_SITE_PATH}` : 'getSite returned no id');
    } catch (err) { gPush('FAIL', 'SharePoint site accessible', err.message); }

    // Box token
    let boxToken = null;
    const adminEmail = context.sourceAdminEmail || env.BOX_ADMIN_EMAIL || context.sourceEmail;
    try { boxToken = await boxClient.getValidToken(adminEmail); }
    catch (err) { gPush('FAIL', 'Box access', `Could not get a Box token: ${err.message}`); }

    const emailMap = buildEmailMap(context);
    const units = resolveUnits(context);
    logger.info(`[BoxToSharepoint validation] validating ${units.length} user unit(s)`);

    const perUser = [];
    if (siteId && boxToken) {
      for (const unit of units) {
        try { perUser.push(await validateUnit(unit, { context, boxToken, adminEmail, siteId, emailMap })); }
        catch (err) {
          perUser.push({
            sourceEmail: unit.sourceEmail, destinationEmail: unit.destinationEmail,
            sourcePath: unit.sourcePath, destinationPath: unit.destinationPath,
            mapping: { sourceEmail: unit.sourceEmail, sourceLocation: unit.sourcePath, destEmail: unit.destinationEmail, destLocation: unit.destinationPath },
            status: 'FAIL', summary: 'Validation error',
            checks: [{ name: 'Validation error', status: 'FAIL', detail: err.message }],
          });
        }
      }
    }
    return buildResult(globalChecks, perUser);
  }
}

async function validateUnit(unit, deps) {
  const { context, boxToken, adminEmail, siteId, emailMap } = deps;
  const checks = [];
  const push = (status, name, detail) => checks.push({ name, status, detail });
  const mapEmail = (e) => emailMap[String(e || '').toLowerCase()] || String(e || '').toLowerCase();
  // Per-item detail rows — drive the full folder-structure tree printed in the PDF.
  const itemDetails = new Map();
  const depthOf = (p) => String(p).split('/').filter(Boolean).length;
  let folderStructure = null;

  const sourceFolderName = lastSegment(unit.sourcePath);
  const destBase = inDrivePath(unit.destinationPath || '/');

  // Resolve As-User for the source Box account (needs admin token to list users; best-effort).
  let asUserId = null;
  try {
    const u = await boxClient.getBoxUserByEmail(adminEmail, unit.sourceEmail);
    if (u && String(u.login).toLowerCase() !== String(adminEmail).toLowerCase()) asUserId = u.id;
  } catch (_) { /* single account / no admin token — use the owner's own token */ }

  // ── #1 Location + #2 Name (incl. CloudFuze "name N" dedup-append) ────────────
  // Probe the expected folder, then the SharePoint-renamed name, then dedup variants.
  let spRootItem = null;
  let spRootPath = null;
  let dedupNote = '';
  if (sourceFolderName) {
    const baseRenamed = spRename(sourceFolderName);
    const candidates = [joinPath(destBase, sourceFolderName)];
    if (baseRenamed !== sourceFolderName) candidates.push(joinPath(destBase, baseRenamed));
    for (let n = 1; n <= DEDUP_MAX; n++) candidates.push(joinPath(destBase, `${baseRenamed} ${n}`));
    for (const cand of candidates) {
      const item = await sharepointClient.getFolderItem(siteId, cand, unit.destinationEmail).catch(() => null);
      if (item) {
        spRootItem = item; spRootPath = cand;
        if (/ \d+$/.test(item.name) && normKey(item.name) !== normKey(sourceFolderName)) dedupNote = ` (CloudFuze appended a counter — a folder named "${baseRenamed}" already existed)`;
        break;
      }
    }
  } else {
    // Whole-account / root migration — items land directly under the in-drive dest path.
    spRootPath = destBase || '/';
    spRootItem = await sharepointClient.getFolderItem(siteId, spRootPath, unit.destinationEmail).catch(() => null) || { name: '(root)' };
  }

  const destLocationLabel = `${unit.destinationPath || '/'}${sourceFolderName ? ` → ${spRootPath || '(not found)'}` : ''}`;
  if (spRootItem && spRootPath) push('PASS', '1. Destination location', `"${sourceFolderName || '(root)'}" found at ${spRootPath}${dedupNote}`);
  else { push('FAIL', '1. Destination location', `"${sourceFolderName}" not found under ${destBase} in SharePoint`); }

  if (sourceFolderName) {
    if (spRootItem && namesMatch(sourceFolderName, spRootItem.name)) push('PASS', '2. Folder name preserved', `"${spRootItem.name}" matches source "${sourceFolderName}"${dedupNote ? ` — renamed per CloudFuze dedup${dedupNote}` : ''}`);
    else if (spRootItem) push('WARN', '2. Folder name preserved', `Source "${sourceFolderName}" → SharePoint "${spRootItem.name}"`);
    else push('FAIL', '2. Folder name preserved', `Source "${sourceFolderName}" not found in destination`);
  }

  // Build both trees
  let boxTree = [];
  let boxRootId = null;
  try {
    const resolved = await boxClient.resolveFolderByPath(unit.sourcePath, boxToken, asUserId);
    if (!resolved) push('WARN', 'Box source tree', `Source path "${unit.sourcePath}" not found — skipping content comparison`);
    else {
      boxRootId = resolved.id;
      boxTree = await boxClient.buildFolderTree(boxRootId, boxToken, asUserId, TREE_DEPTH);
    }
  } catch (err) { push('WARN', 'Box source tree', `Could not read Box source: ${err.message}`); }

  let spTree = [];
  if (spRootItem && spRootPath) {
    try { spTree = await sharepointClient.buildFolderTree(siteId, spRootPath, unit.destinationEmail, TREE_DEPTH); }
    catch (err) { push('WARN', 'SharePoint destination tree', `Could not read SharePoint tree: ${err.message}`); }
  }

  // Structure + matched-item map (for time/author/timestamp checks on items that exist)
  let matchedPairs = new Map(); // box relative path → { box, sp }
  if (boxTree.length > 0 && spTree.length > 0) {
    const spRel = relativize(spTree, spRootPath);
    // index SP by (parent, normKey) and match each Box item, allowing truncation
    const spByParent = new Map();
    for (const i of spRel) {
      const parent = i.path.slice(0, i.path.lastIndexOf('/'));
      (spByParent.get(parent) || spByParent.set(parent, []).get(parent)).push(i);
    }
    const missing = [];
    for (const b of boxTree) {
      const parent = b.path.slice(0, b.path.lastIndexOf('/'));
      const sp = (spByParent.get(parent) || []).find((s) => namesMatch(b.name, s.name) && (s.type === b.type));
      if (sp) matchedPairs.set(b.path, { box: b, sp });
      else missing.push(b);
    }
    const matchRate = boxTree.length ? (matchedPairs.size / boxTree.length) * 100 : 100;
    const filesMissing = missing.filter((i) => i.type === 'file');
    const foldersMissing = missing.filter((i) => i.type === 'folder');
    if (matchRate >= 90) push('PASS', 'File/folder structure', `${matchRate.toFixed(0)}% — ${matchedPairs.size}/${boxTree.length} items found in SharePoint`);
    else if (matchRate >= 70) push('WARN', 'File/folder structure', `${matchRate.toFixed(0)}% — ${missing.length} missing (${filesMissing.length} files, ${foldersMissing.length} folders)`);
    else push('FAIL', 'File/folder structure', `${matchRate.toFixed(0)}% — ${missing.length} missing (${filesMissing.length} files, ${foldersMissing.length} folders)`);
    if (missing.length > 0) {
      const lines = missing.slice(0, 30).map((i) => `${i.type === 'folder' ? '[folder]' : '[file]'} ${i.path}`).join(' | ');
      push(foldersMissing.length > 0 ? 'FAIL' : 'WARN', `Missing items (${filesMissing.length} files, ${foldersMissing.length} folders)`, lines);
    }
  }

  // ── Folder structure validation (folders only — names, parent-child, depth, extras) ──
  if (boxTree.length > 0 || spTree.length > 0) {
    folderStructure = compareFolders(boxTree, spTree, spRootPath, sourceFolderName, spRootItem?.name);
    const fsx = folderStructure;
    const detail = `Source ${fsx.totalSource}, Dest ${fsx.totalDest}, matched ${fsx.matched}, missing ${fsx.missing.length}, extra ${fsx.extra.length}, misplaced ${fsx.misplaced.length}`;
    if (fsx.status === 'PASS') push('PASS', 'Folder structure (recursive, folders only)', `Identical — ${detail}`);
    else {
      const diffs = [];
      if (fsx.missing.length) diffs.push(`MISSING: ${fsx.missing.slice(0, 15).join(', ')}`);
      if (fsx.extra.length) diffs.push(`EXTRA: ${fsx.extra.slice(0, 15).join(', ')}`);
      if (fsx.misplaced.length) diffs.push(`MISPLACED: ${fsx.misplaced.slice(0, 15).map((m) => `${m.source}→${m.dest}`).join(', ')}`);
      push('FAIL', 'Folder structure (recursive, folders only)', `${detail} | ${diffs.join(' | ')}`);
    }
  }

  // Deep checks need the tree + resolved root
  if (boxTree.length > 0 && spRootItem && spRootPath) {
    const spPath = (item) => `${spRootPath}${item.path}`;
    const folders = boxTree.filter((i) => i.type === 'folder');
    const files = boxTree.filter((i) => i.type === 'file');

    // Seed the per-item tree: root folder + every item, with found/renamed status.
    itemDetails.set('/', { path: '/', name: sourceFolderName || '(root)', type: 'folder', depth: 0, found: Boolean(spRootItem), spName: spRootItem?.name || null, permissions: [] });
    for (const b of boxTree) {
      const m = matchedPairs.get(b.path);
      itemDetails.set(b.path, { path: b.path, name: b.name, type: b.type, depth: depthOf(b.path), found: Boolean(m), spName: m?.sp?.name || null, permissions: [] });
    }

    // ── #3 Root folder permissions (via permission mapping) ────────────────────
    if (boxRootId) {
      const rootCollabs = (await boxClient.getCollaborations('folder', boxRootId, boxToken, asUserId).catch(() => []))
        .filter((c) => c.accessibleByEmail && c.role !== 'owner');
      const rootPerm = await sharepointClient.getItemPermissions(siteId, spRootPath, unit.destinationEmail).catch(() => ({ permissions: [] }));
      const mism = [];
      for (const c of rootCollabs) {
        const expected = mapEmail(c.accessibleByEmail);
        const spRoles = (rootPerm.permissions || []).filter((p) => p.email === expected).flatMap((p) => p.roles);
        const cmp = roleMap.compareAccess(c.role, spRoles);
        itemDetails.get('/').permissions.push({ user: c.accessibleByEmail, mappedTo: expected, boxRole: c.role, spRoles, match: cmp.match });
        if (!cmp.match) mism.push(`${c.accessibleByEmail}${expected !== c.accessibleByEmail.toLowerCase() ? ` → ${expected}` : ''}: Box "${c.role}" (expect ${cmp.expectedSpLabel}) → SP ${spRoles.join('/') || 'no access'}`);
      }
      if (rootCollabs.length === 0) push('WARN', '3. Root folder permissions', 'No collaborators on the source root folder to verify');
      else if (mism.length === 0) push('PASS', '3. Root folder permissions', `${rootCollabs.length} collaborator(s) verified on the root folder — mapped correctly`);
      else push('FAIL', `3. Root folder permissions (${mism.length} mismatch)`, mism.slice(0, 20).join(' | '));
    }

    // ── #4 Subfolder / file permissions (via permission mapping) ───────────────
    const permMism = [];
    let permItems = 0;
    for (const item of [...folders, ...files]) {
      if (item.id === boxRootId) continue;
      const collabs = (await boxClient.getCollaborations(item.type, item.id, boxToken, asUserId).catch(() => []))
        .filter((c) => c.accessibleByEmail && c.role !== 'owner');
      if (collabs.length === 0) continue;
      permItems++;
      const spPerm = await sharepointClient.getItemPermissions(siteId, spPath(item), unit.destinationEmail).catch(() => ({ permissions: [] }));
      for (const c of collabs) {
        const expected = mapEmail(c.accessibleByEmail);
        const spRoles = (spPerm.permissions || []).filter((p) => p.email === expected).flatMap((p) => p.roles);
        const cmp = roleMap.compareAccess(c.role, spRoles);
        const det = itemDetails.get(item.path);
        if (det) det.permissions.push({ user: c.accessibleByEmail, mappedTo: expected, boxRole: c.role, spRoles, match: cmp.match });
        if (!cmp.match) permMism.push(`${item.path} — ${c.accessibleByEmail}${expected !== c.accessibleByEmail.toLowerCase() ? ` → ${expected}` : ''}: Box "${c.role}" (expect ${cmp.expectedSpLabel}) → SP ${spRoles.join('/') || 'no access'}`);
      }
    }
    if (permItems === 0) push('WARN', '4. Subfolder/file permissions', 'No collaborators on subfolders/files to verify');
    else if (permMism.length === 0) push('PASS', '4. Subfolder/file permissions', `${permItems} item(s) with collaborators verified — mapped correctly`);
    else push('FAIL', `4. Subfolder/file permissions (${permMism.length} mismatch)`, permMism.slice(0, 20).join(' | '));

    // ── #5 / #9 Created & modified time (timestamps) ───────────────────────────
    const tsOff = [];
    let tsChecked = 0;
    for (const { box, sp } of matchedPairs.values()) {
      if (box.type !== 'file') continue;
      const bMod = Date.parse(box.modifiedAt); const sMod = Date.parse(sp.modifiedAt);
      const bCre = Date.parse(box.createdAt);  const sCre = Date.parse(sp.createdAt);
      if (Number.isNaN(bMod) || Number.isNaN(sMod)) continue;
      tsChecked++;
      const modOff = Math.abs(bMod - sMod) > TS_TOLERANCE_MS;
      const creOff = !Number.isNaN(bCre) && !Number.isNaN(sCre) && Math.abs(bCre - sCre) > TS_TOLERANCE_MS;
      const det = itemDetails.get(box.path);
      if (det) det.timestamps = { boxMod: box.modifiedAt, spMod: sp.modifiedAt, match: !modOff && !creOff };
      if (modOff || creOff) tsOff.push(`${box.path}: ${modOff ? `modified Box ${box.modifiedAt}→SP ${sp.modifiedAt}` : ''}${modOff && creOff ? '; ' : ''}${creOff ? `created Box ${box.createdAt}→SP ${sp.createdAt}` : ''}`);
    }
    if (tsChecked === 0) push('WARN', '5. Created/modified time', 'No comparable timestamps on matched files');
    else if (tsOff.length === 0) push('PASS', '5. Created/modified time', `${tsChecked} file(s) — created & modified times preserved (±5 min)`);
    else push('WARN', `5. Created/modified time (${tsOff.length} differ)`, tsOff.slice(0, 15).join(' | '));

    // ── #6 Created by / modified by (via mapping) ──────────────────────────────
    const authOff = [];
    let authChecked = 0;
    for (const { box, sp } of matchedPairs.values()) {
      if (box.type !== 'file') continue;
      if (!box.modifiedBy && !box.createdBy) continue;
      authChecked++;
      const expMod = mapEmail(box.modifiedBy);
      const expCre = mapEmail(box.createdBy);
      const modBad = box.modifiedBy && sp.modifiedBy && sp.modifiedBy !== expMod;
      const creBad = box.createdBy && sp.createdBy && sp.createdBy !== expCre;
      const det = itemDetails.get(box.path);
      if (det) det.author = { boxModBy: box.modifiedBy, spModBy: sp.modifiedBy, boxCreBy: box.createdBy, spCreBy: sp.createdBy, match: !modBad && !creBad };
      if (modBad || creBad) authOff.push(`${box.path}: ${modBad ? `modifiedBy expect ${expMod}→SP ${sp.modifiedBy}` : ''}${modBad && creBad ? '; ' : ''}${creBad ? `createdBy expect ${expCre}→SP ${sp.createdBy}` : ''}`);
    }
    if (authChecked === 0) push('WARN', '6. Created by / modified by', 'No author info on matched files to verify');
    else if (authOff.length === 0) push('PASS', '6. Created by / modified by', `${authChecked} file(s) — author preserved per mapping`);
    else push('WARN', `6. Created by / modified by (${authOff.length} differ)`, authOff.slice(0, 15).join(' | '));

    // ── #7 Versions ────────────────────────────────────────────────────────────
    const verMism = [];
    let versioned = 0;
    for (const f of files) {
      const bv = await boxClient.getFileVersions(f.id, boxToken, asUserId).catch(() => ({ totalVersions: 1 }));
      if (bv.totalVersions <= 1) continue;
      versioned++;
      const m = matchedPairs.get(f.path);
      const spv = m ? await sharepointClient.getItemVersions(siteId, `${spRootPath}${m.box.path}`, unit.destinationEmail).catch(() => ({ totalVersions: 0 })) : { totalVersions: 0 };
      const det = itemDetails.get(f.path);
      if (det) det.versions = { box: bv.totalVersions, sp: spv.totalVersions };
      if (spv.totalVersions < bv.totalVersions) verMism.push(`${f.path}: Box ${bv.totalVersions} → SP ${spv.totalVersions}`);
    }
    if (versioned === 0) push('WARN', '7. Version history', `No multi-version files among ${files.length} file(s)`);
    else if (verMism.length === 0) push('PASS', '7. Version history', `${versioned} versioned file(s) — counts preserved`);
    else push('FAIL', `7. Version history (${verMism.length} mismatch)`, verMism.slice(0, 20).join(' | '));

    // ── #8 Embedded / shared links ─────────────────────────────────────────────
    const shareMiss = [];
    let shared = 0;
    for (const item of [...folders, ...files]) {
      const sharing = await boxClient.getItemSharing(item.type, item.id, boxToken, asUserId).catch(() => ({ sharedLink: null }));
      if (!sharing.sharedLink) continue;
      shared++;
      const spPerm = await sharepointClient.getItemPermissions(siteId, spPath(item), unit.destinationEmail).catch(() => ({ permissions: [] }));
      const onDest = (spPerm.permissions || []).some((p) => p.isLink);
      const det = itemDetails.get(item.path);
      if (det) det.sharedLink = { box: sharing.access || 'shared', onDest };
      if (!onDest) shareMiss.push(`${item.path} (${sharing.access || 'shared'})`);
    }
    if (shared === 0) push('WARN', '8. Embedded / shared links', `No shared links on the ${folders.length + files.length} item(s)`);
    else if (shareMiss.length === 0) push('PASS', '8. Embedded / shared links', `${shared} shared item(s) — links present on destination`);
    else push('WARN', `8. Embedded / shared links (${shareMiss.length} not on destination)`, shareMiss.slice(0, 20).join(' | '));

    // ── #10 Comments ───────────────────────────────────────────────────────────
    let commentFiles = 0; let commentTotal = 0;
    for (const f of files) {
      const cm = await boxClient.listComments(f.id, boxToken, asUserId).catch(() => ({ total: 0 }));
      if (cm.total > 0) {
        commentFiles++; commentTotal += cm.total;
        const det = itemDetails.get(f.path);
        if (det) det.comments = cm.total;
      }
    }
    if (commentFiles === 0) push('WARN', '10. Comments', `No comments on the ${files.length} file(s)`);
    else push('WARN', '10. Comments', `Box has ${commentTotal} comment(s) on ${commentFiles} file(s) — SharePoint comment parity is not exposed by the Graph drive API (manual check)`);

    // ── #11 Special characters → "_" ───────────────────────────────────────────
    const special = boxTree.filter((i) => SP_INVALID_CHARS.test(i.name));
    SP_INVALID_CHARS.lastIndex = 0;
    if (special.length === 0) push('PASS', '11. Special characters (→ "_")', 'No items with SharePoint-invalid characters');
    else {
      const renamedFound = special.filter((i) => matchedPairs.has(i.path)).length;
      const sample = special.slice(0, 8).map((i) => `"${i.name}" → "${spRename(i.name)}"`).join(' | ');
      if (renamedFound === special.length) push('PASS', `11. Special characters (→ "_") — ${special.length} item(s)`, `All renamed correctly. e.g. ${sample}`);
      else push('WARN', `11. Special characters (→ "_") — ${special.length} item(s)`, `${renamedFound}/${special.length} found after rename. e.g. ${sample}`);
    }
  }

  const status = checks.some((c) => c.status === 'FAIL') ? 'FAIL' : checks.some((c) => c.status === 'WARN') ? 'WARN' : 'PASS';
  return {
    sourceEmail: unit.sourceEmail,
    destinationEmail: unit.destinationEmail,
    sourcePath: unit.sourcePath,
    destinationPath: spRootPath || unit.destinationPath,
    mapping: { sourceEmail: unit.sourceEmail, sourceLocation: unit.sourcePath, destEmail: unit.destinationEmail, destLocation: destLocationLabel },
    status,
    summary: `${checks.filter((c) => c.status === 'PASS').length}/${checks.length} checks passed`,
    checks,
    // Folder-only structure comparison (counts + missing/extra/misplaced + ASCII trees).
    folderStructure,
    // Full folder structure with per-item validation — printed as a tree in the PDF.
    items: [...itemDetails.values()].sort((a, b) => a.path.localeCompare(b.path)),
  };
}

function buildResult(globalChecks, perUser) {
  const flat = [...globalChecks];
  for (const u of perUser) {
    const tag = u.sourceEmail || u.sourcePath || 'user';
    for (const c of u.checks) flat.push({ ...c, name: `[${tag}] ${c.name}` });
  }
  const hasFail = flat.some((c) => c.status === 'FAIL');
  const hasWarn = flat.some((c) => c.status === 'WARN');
  const overall = hasFail ? 'FAIL' : hasWarn ? 'WARN' : 'PASS';
  return {
    status: overall, overallStatus: overall,
    domain: 'content', sourceProvider: 'box', destinationProvider: 'sharepoint',
    checks: flat, perUser,
    summary: `${flat.filter((c) => c.status === 'PASS').length}/${flat.length} checks passed across ${perUser.length} user(s)`,
  };
}

module.exports = BoxToSharepointValidationAgent;
