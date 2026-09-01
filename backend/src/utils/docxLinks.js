/**
 * Read the hyperlink targets out of a .docx, using only Node built-ins.
 *
 * Feature 6.1 (Embedded Links) asks whether CloudFuze rewrote the links held INSIDE a migrated
 * document so they point at the SharePoint copy instead of the original Drive file. Answering it
 * means looking inside the file, and a .docx is a ZIP archive — so this was left unautomated with
 * the note "needs an archive library this project does not use".
 *
 * It does not need one. A .docx stores each part with DEFLATE (or stored), and `zlib.inflateRawSync`
 * is in the standard library, so the two parts that matter can be extracted directly:
 *
 *   word/_rels/document.xml.rels  — the real hyperlink targets, as Relationship/@Target
 *   word/document.xml            — the visible text, which may also spell a URL out
 *
 * Deliberately NOT a general-purpose unzip: it reads named entries out of a small, well-formed
 * Office file and gives up cleanly on anything it does not recognise. Every failure returns "I could
 * not read this" rather than an empty result, because "no links found" and "could not look" must
 * never reach a report as the same thing.
 */
const zlib = require('zlib');

/** ZIP signatures, little-endian as stored. */
const SIG_EOCD = 0x06054b50; // end of central directory
const SIG_CD = 0x02014b50;   // central directory file header
const MAX_COMMENT = 0xffff;  // the EOCD can sit up to 64KB from the end

/**
 * Locate the End Of Central Directory record. It is at the end of the file, but a trailing comment
 * may push it back, so scan backwards for the signature rather than assuming the last 22 bytes.
 * @returns {{ entries: number, offset: number } | null}
 */
function findCentralDirectory(buf) {
  const from = Math.max(0, buf.length - MAX_COMMENT - 22);
  for (let i = buf.length - 22; i >= from; i -= 1) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      return { entries: buf.readUInt16LE(i + 10), offset: buf.readUInt32LE(i + 16) };
    }
  }
  return null;
}

/**
 * Every entry in the archive: name, compression method, sizes, and where its data starts.
 * Read from the CENTRAL directory rather than the local headers — a streamed entry writes zero
 * sizes into its local header, so the local ones cannot be trusted.
 */
function readEntries(buf) {
  const eocd = findCentralDirectory(buf);
  if (!eocd) return null;

  const entries = [];
  let p = eocd.offset;
  for (let i = 0; i < eocd.entries; i += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CD) return null;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    entries.push({ name, method, compSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * Inflate one entry to a string, or null when it cannot be read.
 * The local header is consulted only to skip past its variable-length name and extra fields.
 */
function readEntry(buf, entry) {
  const lo = entry.localOffset;
  if (lo + 30 > buf.length) return null;
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const start = lo + 30 + nameLen + extraLen;
  const data = buf.slice(start, start + entry.compSize);
  try {
    if (entry.method === 0) return data.toString('utf8');       // stored
    if (entry.method === 8) return zlib.inflateRawSync(data).toString('utf8'); // deflate
    return null;                                                // anything else: not ours to guess
  } catch {
    return null;
  }
}

/**
 * Hyperlink targets and visible text from a .docx buffer.
 *
 * @param {Buffer} buf
 * @returns {{ ok: boolean, reason: string|null, targets: string[], text: string }}
 *   ok=false means the file could not be read — never confuse that with "it has no links".
 */
function extractDocxLinks(buf) {
  const empty = { ok: false, reason: null, targets: [], text: '' };
  if (!Buffer.isBuffer(buf) || buf.length < 22) {
    return { ...empty, reason: 'not a readable file' };
  }
  const entries = readEntries(buf);
  if (!entries) return { ...empty, reason: 'not a valid .docx archive' };

  const relsEntry = entries.find((e) => e.name === 'word/_rels/document.xml.rels');
  const bodyEntry = entries.find((e) => e.name === 'word/document.xml');
  if (!relsEntry && !bodyEntry) {
    return { ...empty, reason: 'no Word document part inside the archive' };
  }

  const rels = relsEntry ? readEntry(buf, relsEntry) : null;
  const body = bodyEntry ? readEntry(buf, bodyEntry) : null;
  if (rels === null && body === null) {
    return { ...empty, reason: 'the document parts could not be decompressed' };
  }

  // Only External relationships are hyperlinks a migration would rewrite; internal ones point at
  // other parts of the same file (styles, fonts) and are not links to content.
  const targets = [];
  for (const m of String(rels || '').matchAll(/Target="([^"]+)"[^>]*TargetMode="External"/g)) {
    targets.push(m[1]);
  }
  for (const m of String(rels || '').matchAll(/TargetMode="External"[^>]*Target="([^"]+)"/g)) {
    targets.push(m[1]);
  }

  // Visible text, tags stripped — the seeded document also prints its URL as plain text so a human
  // can compare without tooling, and that copy is worth reporting too.
  const text = String(body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  return { ok: true, reason: null, targets: [...new Set(targets)], text };
}

module.exports = { extractDocxLinks };
