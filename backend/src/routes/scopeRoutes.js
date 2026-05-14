const express = require('express');
const router  = express.Router();
const scopeService = require('../services/scopeService');

/** GET /api/scope — list all available combinations */
router.get('/', (_req, res) => {
  try {
    res.json(scopeService.listCombinations());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/scope/:combination/:type
 * type = "inscope" | "outscope"
 * Returns the raw Markdown document as plain text.
 */
router.get('/:combination/:type', (req, res) => {
  try {
    const { combination, type } = req.params;
    if (type !== 'inscope' && type !== 'outscope') {
      return res.status(400).json({ error: 'type must be "inscope" or "outscope"' });
    }
    const content = scopeService.getScope(combination, type);
    if (content === null) {
      return res.status(404).json({ error: `No ${type} document found for combination: ${combination}` });
    }
    res.type('text/markdown').send(content);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * PUT /api/scope/:combination/:type
 * type = "inscope" | "outscope"
 * Body: plain text Markdown content (Content-Type: text/plain or text/markdown)
 * Replaces the entire document.
 */
router.put('/:combination/:type', (req, res) => {
  try {
    const { combination, type } = req.params;
    if (type !== 'inscope' && type !== 'outscope') {
      return res.status(400).json({ error: 'type must be "inscope" or "outscope"' });
    }
    // Accept raw text body (middleware must parse text/plain — see server.js note)
    const content = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    scopeService.saveScope(combination, type, content);
    res.json({ ok: true, combination, type });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
