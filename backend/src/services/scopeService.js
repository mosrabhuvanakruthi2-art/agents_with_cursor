const fs   = require('fs');
const path = require('path');

const SCOPE_DIR = path.resolve(__dirname, '../../data/feature-scope');

/** Normalize combination key: "GmailToOutlook" | "gmail-to-outlook" → "gmail-to-outlook" */
function normalizeKey(combination) {
  return String(combination || '')
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/\s+/g, '-');
}

function filePath(combination, type) {
  return path.join(SCOPE_DIR, `${normalizeKey(combination)}-${type}.md`);
}

/** Return all combination keys (derived from file names, deduped) */
function listCombinations() {
  if (!fs.existsSync(SCOPE_DIR)) return [];
  const files = fs.readdirSync(SCOPE_DIR).filter((f) => f.endsWith('.md'));
  const keys  = new Set(files.map((f) => f.replace(/-(?:inscope|outscope)\.md$/, '')));
  return [...keys];
}

/** Read the in-scope or out-of-scope markdown for a combination. Returns null if not found. */
function getScope(combination, type = 'inscope') {
  const fp = filePath(combination, type);
  if (!fs.existsSync(fp)) return null;
  return fs.readFileSync(fp, 'utf8');
}

/** Write (full replace) the markdown content for a combination scope file. */
function saveScope(combination, type, content) {
  if (!fs.existsSync(SCOPE_DIR)) fs.mkdirSync(SCOPE_DIR, { recursive: true });
  const fp = filePath(combination, type);
  fs.writeFileSync(fp, content, 'utf8');
  return content;
}

module.exports = { listCombinations, getScope, saveScope, normalizeKey };
