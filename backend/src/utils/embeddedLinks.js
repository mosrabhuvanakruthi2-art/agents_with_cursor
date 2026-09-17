/**
 * Read the hyperlink targets out of a migrated document, whatever format it is.
 *
 * Feature 8.1 asks whether CloudFuze rewrote the links held INSIDE a file so they point at the
 * destination copy. Until now only `.docx` could be read, so the whole feature rested on one file
 * type — and a product that rewrites Word documents but not spreadsheets would have passed.
 *
 * Four readers, one rule: every failure says "I could not look", never "there were no links".
 * Those two must never reach a report as the same thing, because the second is a verdict and the
 * first is the absence of one.
 *
 *   .docx  word/_rels/document.xml.rels          — Relationship/@Target, TargetMode="External"
 *   .xlsx  xl/worksheets/_rels/sheetN.xml.rels   — the same shape, different folder
 *   .pdf   /URI (…) or /URI<…> link annotations  — read from the raw bytes
 *   .txt   a bare URL in the text
 *
 * The .txt case is deliberately reported as UNJUDGED by the caller. A plain text file cannot hold a
 * hyperlink — only characters that look like one — so a migration that leaves it untouched is not
 * misbehaving. It is seeded to show what happens, not to produce a verdict.
 */
const { extractDocxLinks, readEntries, readEntry } = require('./docxLinks');

/** Formats whose links a migration can be expected to rewrite. `.txt` is observed, not judged. */
const JUDGEABLE = new Set(['docx', 'xlsx', 'pdf']);

function extensionOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

/** Decode the handful of XML entities an Office relationship target can carry. */
function decodeXml(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/**
 * External relationship targets from an Office container, given the folder its rels live under.
 *
 * Only TargetMode="External" entries are links out of the document; internal ones address other
 * parts of the same file and are not what 8.1 is about.
 */
function officeRelLinks(buf, relsPathMatcher) {
  const entries = readEntries(buf);
  if (!entries) return { ok: false, reason: 'the file is not a readable Office container' };
  const relsEntries = entries.filter((e) => relsPathMatcher.test(e.name));
  if (relsEntries.length === 0) {
    // No relationship part at all is a legitimate "no links", not a read failure: Office omits it
    // when a document has none.
    return { ok: true, links: [] };
  }
  const links = [];
  for (const entry of relsEntries) {
    const xml = readEntry(buf, entry);
    if (xml == null) return { ok: false, reason: `could not inflate ${entry.name}` };
    const text = xml.toString('utf8');
    for (const m of text.matchAll(/<Relationship\b[^>]*>/gi)) {
      const tag = m[0];
      if (!/TargetMode\s*=\s*"External"/i.test(tag)) continue;
      const t = /Target\s*=\s*"([^"]*)"/i.exec(tag);
      if (t && t[1]) links.push(decodeXml(t[1]));
    }
  }
  return { ok: true, links };
}

/**
 * Link annotations in a PDF.
 *
 * pdfkit writes them as `/URI (https://…)`. The raw scan is deliberate: parsing PDF properly would
 * need a library this project does not carry, and an annotation URI is unambiguous in the byte
 * stream. A PDF whose object streams are compressed would hide them, which is why an empty result
 * on a file that has no /Annots is reported as "no links" while a malformed file is a read failure.
 */
function pdfLinks(buf) {
  const text = buf.toString('latin1');
  const links = [];
  for (const m of text.matchAll(/\/URI\s*\(([^)]*)\)/g)) {
    const url = m[1].replace(/\\([()\\])/g, '$1').trim();
    if (url) links.push(url);
  }
  if (links.length === 0 && !/%PDF-/.test(text.slice(0, 1024))) {
    return { ok: false, reason: 'not a PDF (no %PDF- header)' };
  }
  return { ok: true, links };
}

/** URLs spelled out in plain text. Observed only — a .txt cannot hold a real hyperlink. */
function plainTextLinks(buf) {
  const text = buf.toString('utf8');
  const links = [...text.matchAll(/https?:\/\/[^\s"'<>)\]]+/g)].map((m) => m[0]);
  return { ok: true, links };
}

/**
 * Hyperlink targets in a migrated document.
 *
 * @param {Buffer} buf       the file's bytes
 * @param {string} filename  used only to choose the reader
 * @returns {{ ok: boolean, links?: string[], reason?: string, format: string, judgeable: boolean }}
 */
function extractLinks(buf, filename) {
  const format = extensionOf(filename);
  const judgeable = JUDGEABLE.has(format);
  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    return { ok: false, reason: 'the file was empty or could not be downloaded', format, judgeable };
  }
  let res;
  switch (format) {
    case 'docx':
      // Reuse the existing reader so the .docx verdict cannot drift from what it produced before.
      res = extractDocxLinks(buf);
      // extractDocxLinks reports { ok, links } already; normalise a legacy shape defensively.
      if (res && Array.isArray(res.links)) res = { ok: res.ok !== false, links: res.links };
      else if (Array.isArray(res)) res = { ok: true, links: res };
      else res = { ok: false, reason: (res && res.reason) || 'the .docx could not be read' };
      break;
    case 'xlsx':
      res = officeRelLinks(buf, /^xl\/(worksheets\/_rels\/.*\.rels|_rels\/.*\.rels)$/i);
      break;
    case 'pdf':
      res = pdfLinks(buf);
      break;
    case 'txt':
    case 'csv':
      res = plainTextLinks(buf);
      break;
    default:
      return { ok: false, reason: `no reader for .${format || '(no extension)'}`, format, judgeable };
  }
  return { ...res, format, judgeable };
}

module.exports = { extractLinks, JUDGEABLE, officeRelLinks, pdfLinks, plainTextLinks };
