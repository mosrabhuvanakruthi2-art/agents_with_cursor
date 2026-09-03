const fs   = require('fs');
const path = require('path');

const SCOPE_DIR = path.resolve(__dirname, '../../data/feature-scope');

/**
 * The document types this service recognises, and the ONLY suffixes that mark a file in
 * SCOPE_DIR as belonging to a combination.
 *
 * `testdata` is the seeding specification: what data has to exist in the source account for a run
 * to exercise the in-scope features at all. The scope documents say what to validate; they do not
 * say what to create.
 *
 * listCombinations() derives keys from file names, so any suffix missing from this list turns its
 * file into a phantom combination: `dropbox-to-google-testdata.md` was listed as a combination of
 * its own, extension included, and every fetch against it 404d.
 */
const SCOPE_TYPES = ['inscope', 'outscope', 'testdata'];

/** Normalize combination key: "GmailToOutlook" | "gmail-to-outlook" → "gmail-to-outlook" */
function normalizeKey(combination) {
  return String(combination || '')
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/\s+/g, '-');
}

/**
 * A combination key may only be a slug: letters, digits and single hyphens.
 *
 * The key arrives from a URL parameter and is concatenated into a file path, so without this an
 * unauthenticated `PUT /api/scope/..%2F..%2F..%2Fanything/inscope` writes a caller-supplied file
 * outside the data directory. Verified: the key `../../../../pwned` resolved onto the user's
 * Desktop. GET has the read half of the same problem.
 *
 * An allow-list, not a blocklist of `..` — path traversal has too many encodings to enumerate.
 */
const SAFE_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** True when this combination key is safe to turn into a file name. */
function isValidCombination(combination) {
  return SAFE_KEY.test(normalizeKey(combination));
}

/**
 * Resolved path for a scope document, or null when the key or type is not allowed.
 *
 * The containment check is deliberate belt-and-braces behind SAFE_KEY: if that regex is ever
 * loosened, a path that leaves SCOPE_DIR still resolves to null rather than to a live file.
 */
function filePath(combination, type) {
  if (!SCOPE_TYPES.includes(type)) return null;
  const key = normalizeKey(combination);
  if (!SAFE_KEY.test(key)) return null;
  const fp = path.resolve(SCOPE_DIR, `${key}-${type}.md`);
  if (fp !== path.join(SCOPE_DIR, `${key}-${type}.md`)) return null;
  return fp;
}

/** Return all combination keys (derived from file names, deduped) */
function listCombinations() {
  if (!fs.existsSync(SCOPE_DIR)) return [];
  const keys = new Set();
  for (const f of fs.readdirSync(SCOPE_DIR)) {
    // A .md file with no recognised suffix is a note, not a combination. Matched with endsWith
    // rather than a built regex so nothing depends on escaping the dot correctly.
    for (const type of SCOPE_TYPES) {
      const suffix = `-${type}.md`;
      if (!f.endsWith(suffix)) continue;
      keys.add(f.slice(0, -suffix.length));
      break;
    }
  }
  return [...keys].sort();
}

/** Read the in-scope or out-of-scope markdown for a combination. Returns null if not found. */
function getScope(combination, type = 'inscope') {
  const fp = filePath(combination, type);
  // A rejected key reads as "no such document", not as an error: the caller learns nothing about
  // what does or does not exist outside the data directory.
  if (!fp || !fs.existsSync(fp)) return null;
  return fs.readFileSync(fp, 'utf8');
}

/** Write (full replace) the markdown content for a combination scope file. */
function saveScope(combination, type, content) {
  const fp = filePath(combination, type);
  // Throws rather than returning quietly: a write is a mutation, and a caller that asked to save
  // must not be told "ok" when nothing was written.
  if (!fp) throw new Error(`Invalid combination or type: ${combination}/${type}`);
  if (!fs.existsSync(SCOPE_DIR)) fs.mkdirSync(SCOPE_DIR, { recursive: true });
  fs.writeFileSync(fp, content, 'utf8');
  return content;
}

module.exports = {
  listCombinations,
  getScope,
  saveScope,
  normalizeKey,
  isValidCombination,
  SCOPE_TYPES,
};
