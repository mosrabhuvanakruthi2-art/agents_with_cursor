// ── Message product routes ──────────────────────────────────────────────────────
// Routes for the message-migration vertical (Slack / Google Chat / Teams).
// Mounted at the same /api/agents prefix as the mail/content routes, but kept in
// its own file + controller so the message product stays cleanly separate.
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const controller = require('../controllers/messageController');

router.post('/message-run', controller.runMessageAgent);
router.post('/message-seed', controller.seedMessageAgent);
router.post('/message-migrate', controller.migrateMessageAgent);
router.post('/upload-mapping-csv', controller.uploadMappingCsv);
router.get('/message-targets', controller.getMessageTargets);
router.get('/message-user-status', controller.getMessageUserStatus);
router.get('/debug-google-chat', controller.debugGoogleChat);
router.get('/debug-teams', controller.debugTeams);
router.get('/cf-cloud-accounts', controller.getCFCloudAccounts);

// ── CF server login accounts (email/password for the chat-migration CF server) ──
const CF_EXTRA_FILE = path.join(__dirname, '../../data/cf-extra-accounts.json');
function readExtraCFAccounts() {
  try { return JSON.parse(fs.readFileSync(CF_EXTRA_FILE, 'utf8')); } catch { return []; }
}
function writeExtraCFAccounts(list) {
  fs.writeFileSync(CF_EXTRA_FILE, JSON.stringify(list, null, 2), 'utf8');
}

router.get('/cf-login-accounts', (req, res) => {
  const env = require('../config/env');
  const envAccounts   = (env.CF_ACCOUNTS || []).map((a) => ({ email: a.email, source: 'env' }));
  const extraAccounts = readExtraCFAccounts().map((a) => ({ email: a.email, source: 'user' }));
  const seen = new Set(envAccounts.map((a) => a.email));
  const merged = [...envAccounts, ...extraAccounts.filter((a) => !seen.has(a.email))];
  res.json({ accounts: merged });
});

router.post('/cf-login-accounts', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });
  const list = readExtraCFAccounts();
  if (!list.find((a) => a.email === email)) { list.push({ email, password }); writeExtraCFAccounts(list); }
  res.json({ ok: true, email });
});

router.delete('/cf-login-accounts/:email', (req, res) => {
  const email = decodeURIComponent(req.params.email);
  writeExtraCFAccounts(readExtraCFAccounts().filter((a) => a.email !== email));
  res.json({ ok: true });
});

router.get('/cf-channels', controller.getCFChannels);
router.get('/cf-dms', controller.getCFDMs);
router.get('/cf-channels-all', controller.getCFChannelsAll);
router.get('/cf-channels-cache', controller.getCFChannelsCache);
router.get('/cf-reports', controller.getCFReports);
router.post('/cf-close-migration', controller.closeCFChatJobs);
router.post('/cf-validate-migration', controller.validateCFChatMigration);
// CF browser-automation (requires playwright — returns an error if not installed)
router.post('/cf-browser-migrate', controller.startCFBrowserMigration);
router.post('/cf-browser-abort', controller.abortCFBrowserMigration);
router.get('/cf-browser-events', controller.getCFBrowserEvents);

module.exports = router;
