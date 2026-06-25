/**
 * docsSyncController.js
 *
 * HTTP handlers for the documentation sync endpoints.
 *
 * Routes (registered in agentRoutes.js):
 *   POST /api/agents/docs-sync         — run sync, return results
 *   GET  /api/agents/docs-sync/status  — return last sync results
 *   GET  /api/agents/docs-sync/snapshot — return current feature snapshot
 */

const logger        = require('../utils/logger');
const docsSyncService = require('../services/docsSyncService');

/**
 * POST /api/agents/docs-sync
 *
 * Runs the full documentation sync:
 *   - Fetches live features from https://doc.cftools.live/api/features
 *   - Diffs against stored snapshot
 *   - Auto-adds new outscope features to cloudfuzeDocsClient.js
 *   - Generates GPT test case suggestions for new inscope features
 *   - Persists results and updated snapshot
 *
 * Response 200: sync results object
 * Response 500: error detail
 */
async function runDocsSync(req, res) {
  try {
    logger.info('[docsSyncController] POST /docs-sync received');
    const results = await docsSyncService.runSync();
    res.json(results);
  } catch (err) {
    logger.error(`[docsSyncController] runDocsSync error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

/**
 * GET /api/agents/docs-sync/status
 *
 * Returns the last sync results stored in docs-sync-results.json.
 * Returns 404 if no sync has been run yet.
 */
function getDocsSyncStatus(req, res) {
  try {
    const results = docsSyncService.getLastResults();
    if (!results) {
      return res.status(404).json({
        error: 'No sync results found. Run POST /api/agents/docs-sync first.',
      });
    }
    res.json(results);
  } catch (err) {
    logger.error(`[docsSyncController] getDocsSyncStatus error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

/**
 * GET /api/agents/docs-sync/snapshot
 *
 * Returns the current feature snapshot stored in docs-features-snapshot.json.
 * Returns the empty snapshot shape if no snapshot exists yet.
 */
function getDocsSyncSnapshot(req, res) {
  try {
    const snapshot = docsSyncService.getSnapshot();
    res.json(snapshot);
  } catch (err) {
    logger.error(`[docsSyncController] getDocsSyncSnapshot error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

module.exports = { runDocsSync, getDocsSyncStatus, getDocsSyncSnapshot };
