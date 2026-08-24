// Tolerance bands for Google Shared Drive → SharePoint. Edit only this file to tune
// googledrive_to_sharepoint tolerances.
//
// Bands are destination/source ratios read as: inside info = normal, inside warn = flag it,
// outside = fail. Feature reference: backend/data/feature-scope/google-shared-drive-to-sharepoint-*.md
module.exports = {
  combination: 'googledrive_to_sharepoint',

  // Formats migrated byte-for-byte (.pdf, .png, .zip, …). A correctly migrated file is the same size;
  // the small band absorbs storage-reporting rounding, nothing more.
  fileSize: {
    infoMin: 0.99, infoMax: 1.01,
    warnMin: 0.95, warnMax: 1.05,
    note: 'Pass-through formats migrate byte-for-byte — sizes should be identical.',
  },

  // Converted formats: Google native exports (Doc→.docx, Sheet→.xlsx, Slides→.pptx) and legacy Office
  // upgrades (.doc→.docx). A converter legitimately produces a very different size for the same
  // document, so this band is wide on purpose — size is a sanity check here, not a content check.
  // Content correctness for these files comes from the destination opening cleanly, which Tier B
  // cannot assert; they are reported as "not hashed" with the reason instead.
  convertedFileSize: {
    infoMin: 0.25, infoMax: 4.0,
    warnMin: 0.05, warnMax: 20.0,
    note: 'Converted file (Google native export or legacy Office upgrade) — the destination is produced by a converter, so its size legitimately differs from the source.',
  },

  // Created/modified time drift still counted as preserved (feature 10.1). Version timestamps are
  // out of scope and are not compared at all.
  timestampDriftMs: 5 * 60 * 1000,

  // SharePoint path limits (feature 11.1), measured on the URL-encoded path. Items over the limit are
  // expected to arrive as a placeholder link, not as the item.
  pathLengthLimit: 400,
  segmentLengthLimit: 255,

  // Recursion cap when walking either tree. DriveTestDataAgent seeds a 20-level path, so this must stay
  // above 20 or the deep-nesting scenario silently drops out of the comparison.
  treeDepth: 25,

  // Structure is exact: a missing or extra item is a defect, never absorbed by a tolerance.
  countDelta: 0,
};
