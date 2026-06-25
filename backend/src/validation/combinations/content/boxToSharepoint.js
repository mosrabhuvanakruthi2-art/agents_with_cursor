const ContentReportValidationAgent = require('../../../agents/content/ContentReportValidationAgent');
const sharepointClient = require('../../../clients/sharepointClient');
const boxClient = require('../../../clients/boxClient');
const env = require('../../../config/env');
const logger = require('../../../utils/logger');

const SP_HOSTNAME  = 'filefuze.sharepoint.com';
const SP_SITE_PATH = '/sites/SANITYDATAA';

// SharePoint disallows these characters in item names — they get substituted during migration
const SP_INVALID_CHARS = /[~"#%&*:<>?/\\{|}]/g;

function normalizeForComparison(name) {
  return name.replace(SP_INVALID_CHARS, '_').toLowerCase().trim();
}

/**
 * Compare a Box flat tree against a SharePoint flat tree.
 * Returns { matched, missing, matchRate }.
 * "missing" = items in Box that couldn't be found in SharePoint (by normalised name at the same path level).
 */
function compareTreesByPath(boxItems, spItems) {
  // Build a set of (parentPath, normalizedName) tuples from SharePoint
  const spSet = new Set(
    spItems.map((i) => {
      const parent = i.path.slice(0, i.path.lastIndexOf('/'));
      return `${parent}::${normalizeForComparison(i.name)}`;
    })
  );

  const matched = [];
  const missing = [];

  for (const boxItem of boxItems) {
    const parent = boxItem.path.slice(0, boxItem.path.lastIndexOf('/'));
    const key = `${parent}::${normalizeForComparison(boxItem.name)}`;
    if (spSet.has(key)) {
      matched.push(boxItem);
    } else {
      missing.push(boxItem);
    }
  }

  const matchRate = boxItems.length > 0 ? (matched.length / boxItems.length) * 100 : 100;
  return { matched, missing, matchRate };
}

class BoxToSharepointValidationAgent extends ContentReportValidationAgent {
  static supportsDeepValidation = true;

  constructor() {
    super('BoxToSharepointValidationAgent');
  }

  async execute(context) {
    const checks = [];
    const pass = (name, detail) => checks.push({ name, status: 'PASS', detail });
    const fail = (name, detail) => checks.push({ name, status: 'FAIL', detail });
    const warn = (name, detail) => checks.push({ name, status: 'WARN', detail });

    // ── 1. CloudFuze migration report ──────────────────────────────────────────
    const report    = context.contentMigrationReport || context.migrationJobDetails;
    const cfStatus  = String(report?.status || report?.cfStatus || '').toUpperCase();
    const processed = Number(report?.processedCount) || 0;
    const total     = Number(report?.totalCount) || 0;

    if (cfStatus === 'PROCESSED' || cfStatus === 'PROCESS' || cfStatus === 'VERSION_PROCESSED') {
      pass('CloudFuze migration status', `${cfStatus} — ${processed}/${total} items`);
    } else if (cfStatus === 'PROCESSED_WITH_CONFLICTS' || cfStatus === 'PROCESS_WITH_CONFLICTS') {
      warn('CloudFuze migration status', `${cfStatus} — ${processed}/${total} (conflicts present)`);
    } else if (!cfStatus) {
      warn('CloudFuze migration status', 'Status unknown — proceeding with file-level checks');
    } else {
      fail('CloudFuze migration status', `${cfStatus} — expected PROCESSED`);
    }

    // ── 2. Resolve SharePoint site ─────────────────────────────────────────────
    let siteId;
    try {
      const site = await sharepointClient.getSite(SP_HOSTNAME, SP_SITE_PATH, context.destinationEmail);
      siteId = site?.id;
      if (siteId) {
        pass('SharePoint site accessible', `${SP_HOSTNAME}${SP_SITE_PATH}`);
      } else {
        fail('SharePoint site accessible', 'getSite returned no id');
      }
    } catch (err) {
      fail('SharePoint site accessible', err.message);
    }

    if (!siteId) return buildResult(checks);

    // ── 3. Locate root folder in SharePoint Documents ──────────────────────────
    const rawPath        = context.sourceTestDataPath || '/Agent Box Data';
    const rootFolderName = rawPath.replace(/^\/+/, '');
    const spRootPath     = `/${rootFolderName}`;

    let rootExists = false;
    try {
      const rootItem = await sharepointClient.getFolderItem(siteId, spRootPath, context.destinationEmail);
      if (rootItem) {
        rootExists = true;
        pass('Root folder in SharePoint', `"${rootFolderName}" found in Documents library`);
      } else {
        fail('Root folder in SharePoint', `"${rootFolderName}" not found in Documents root`);
      }
    } catch (err) {
      fail('Root folder in SharePoint', err.message);
    }

    if (!rootExists) return buildResult(checks);

    // ── 4. Build Box source tree ───────────────────────────────────────────────
    let boxTree = [];
    try {
      const adminEmail = context.sourceAdminEmail || env.BOX_ADMIN_EMAIL || context.sourceEmail;
      const token = await boxClient.getValidToken(adminEmail);

      // Find the root folder ID by looking up the name in Box root
      const rootItems = await boxClient.getFolderItems('0', token, null);
      const rootFolder = rootItems.find(
        (i) => i.type === 'folder' && i.name.toLowerCase() === rootFolderName.toLowerCase()
      );

      if (!rootFolder) {
        warn('Box source tree', `"${rootFolderName}" not found in Box root — skipping tree comparison`);
      } else {
        // Cap at depth 4 to avoid the intentional 120-level "long path" scenario
        boxTree = await boxClient.buildFolderTree(rootFolder.id, token, null, 4);
        pass('Box source tree read', `${boxTree.filter((i) => i.type === 'file').length} files, ${boxTree.filter((i) => i.type === 'folder').length} folders`);
      }
    } catch (err) {
      warn('Box source tree', `Could not read Box source: ${err.message}`);
    }

    // ── 5. Build SharePoint destination tree ──────────────────────────────────
    let spTree = [];
    try {
      spTree = await sharepointClient.buildFolderTree(siteId, spRootPath, context.destinationEmail, 4);
      pass('SharePoint destination tree read', `${spTree.filter((i) => i.type === 'file').length} files, ${spTree.filter((i) => i.type === 'folder').length} folders`);
    } catch (err) {
      warn('SharePoint destination tree', `Could not read SharePoint tree: ${err.message}`);
    }

    // ── 6. Tree comparison ─────────────────────────────────────────────────────
    if (boxTree.length > 0 && spTree.length > 0) {
      // Rebase paths so both trees start from the same relative root
      const rebase = (item) => ({ ...item, path: item.path.replace(item.path.split('/')[1] ? `/${item.path.split('/')[1]}` : '', '') || '/' });
      const boxRelative = boxTree.map(rebase);
      const spRelative  = spTree.map(rebase);

      const { matched, missing, matchRate } = compareTreesByPath(boxRelative, spRelative);

      const filesMissing   = missing.filter((i) => i.type === 'file');
      const foldersMissing = missing.filter((i) => i.type === 'folder');

      // Overall match check
      if (matchRate >= 90) {
        pass(
          'File/folder tree comparison',
          `${matchRate.toFixed(0)}% match — ${matched.length}/${boxTree.length} items found in SharePoint`
        );
      } else if (matchRate >= 70) {
        warn(
          'File/folder tree comparison',
          `${matchRate.toFixed(0)}% match — ${missing.length} missing (${filesMissing.length} files, ${foldersMissing.length} folders). See "Missing items" check for details.`
        );
      } else {
        fail(
          'File/folder tree comparison',
          `${matchRate.toFixed(0)}% match — ${missing.length} missing (${filesMissing.length} files, ${foldersMissing.length} folders). See "Missing items" check for details.`
        );
      }

      // Always emit the full missing-item list so the report has every detail
      if (missing.length > 0) {
        // Group by parent path for readability
        const byParent = {};
        for (const item of missing) {
          const parent = item.path.includes('/')
            ? item.path.slice(0, item.path.lastIndexOf('/')) || '/'
            : '/';
          if (!byParent[parent]) byParent[parent] = [];
          byParent[parent].push(`${item.type === 'folder' ? '[folder]' : '[file]'} ${item.name}`);
        }
        const lines = Object.entries(byParent)
          .map(([parent, names]) => `${parent || '/'}: ${names.join(', ')}`)
          .join(' | ');
        const checkName = missing.length === filesMissing.length + foldersMissing.length
          ? `Missing items (${filesMissing.length} files, ${foldersMissing.length} folders)`
          : `Missing items (${missing.length} total)`;
        // FAIL if any folders missing, WARN if only files (may be SharePoint char restrictions)
        if (foldersMissing.length > 0) {
          fail(checkName, lines);
        } else {
          warn(checkName, lines);
        }
      } else {
        pass('Missing items', 'None — all Box items found in SharePoint');
      }

      // ── 7. Count-level breakdown per folder ───────────────────────────────
      const boxFolders = boxTree.filter((i) => i.type === 'folder');
      let folderCountMismatches = 0;
      for (const boxFolder of boxFolders) {
        const boxChildren = boxTree.filter((i) => i.path.startsWith(boxFolder.path + '/') && i.path.split('/').length === boxFolder.path.split('/').length + 1);
        const spFolderPath = `/${rootFolderName}${boxFolder.path}`;
        const spChildren = spTree.filter((i) => i.path.startsWith(spFolderPath + '/') && i.path.split('/').length === spFolderPath.split('/').length + 1);
        if (boxChildren.length > 0 && spChildren.length === 0) folderCountMismatches++;
      }
      if (folderCountMismatches === 0) {
        pass('Per-folder content check', 'All sub-folders have content in SharePoint');
      } else {
        warn('Per-folder content check', `${folderCountMismatches} sub-folders appear empty in SharePoint`);
      }
    } else if (boxTree.length === 0) {
      // Box tree unavailable — fall back to basic counts
      const { files, folders } = await sharepointClient.countItemsRecursive(siteId, spRootPath, context.destinationEmail, 4).catch(() => ({ files: 0, folders: 0 }));
      if (files > 0) {
        warn('File/folder tree comparison', `Box tree unavailable — SharePoint has ${files} files, ${folders} sub-folders (manual check required)`);
      } else {
        fail('File/folder tree comparison', 'No files found in SharePoint destination');
      }
    }

    return buildResult(checks);
  }
}

function buildResult(checks) {
  const hasFail = checks.some((c) => c.status === 'FAIL');
  const hasWarn = checks.some((c) => c.status === 'WARN');
  const overall = hasFail ? 'FAIL' : hasWarn ? 'WARN' : 'PASS';
  return {
    status: overall,
    domain: 'content',
    sourceProvider: 'box',
    destinationProvider: 'sharepoint',
    checks,
    summary: `${checks.filter((c) => c.status === 'PASS').length}/${checks.length} checks passed`,
  };
}

module.exports = BoxToSharepointValidationAgent;
