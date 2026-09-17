// Tolerance bands for Box → Google My Drive. Edit only this file to tune box_to_googledrive
// tolerances.
//
// Bands are destination/source ratios read as: inside info = normal, inside warn = flag it,
// outside = fail. Feature reference: backend/data/feature-scope/box-to-google-*.md
//
// Modelled directly on utils/contentTolerance/dropboxToGoogledrive.js — same destination, same three
// numbers that differ from every SharePoint-bound combination in this repo, for the same reasons.
module.exports = {
  combination: 'box_to_googledrive',

  // Formats migrated byte-for-byte (.pdf, .png, .zip, .txt, .csv …). A correctly migrated file is the
  // same size; the band absorbs storage-reporting rounding, nothing more.
  fileSize: {
    infoMin: 0.99, infoMax: 1.01,
    warnMin: 0.95, warnMax: 1.05,
    note: 'Pass-through formats migrate byte-for-byte — sizes should be identical.',
  },

  // Converted formats: legacy Office upgrades (.doc/.xls/.ppt → .docx/.xlsx/.pptx), Office files
  // imported as Google native docs, and Box Notes converted to a Google Doc. A native Google
  // destination file reports little or no size relative to its source, same as the Dropbox → Google
  // pair, so size is a sanity check only here, never a content check.
  convertedFileSize: {
    infoMin: 0.0, infoMax: 6.0,
    warnMin: 0.0, warnMax: 25.0,
    note: 'Converted file (imported as a Google native doc, a legacy Office upgrade, or a Box Note '
      + 'converted to a Google Doc). Drive reports little or no size for native docs, so size cannot '
      + 'indicate correctness — the destination opening cleanly is what does, and Tier B cannot '
      + 'assert it.',
  },

  // Feature 4.1: BOTH created and modified are comparable for this pair. Box exposes
  // content_created_at AND content_modified_at on every file (unlike Dropbox, which has no creation
  // time at all) — see boxClient.buildFolderTree, which already reads both.
  timestampDriftMs: 5 * 60 * 1000,

  // Google imposes NO total-path limit and no 255-char segment limit (a name may be 32,767 chars).
  // Infinity rather than a large number so a comparison can never accidentally trip it. Same value as
  // dropboxToGoogledrive.js and validation/destinations/googledrive.js, for the same destination.
  pathLengthLimit: Infinity,
  segmentLengthLimit: 32767,

  // Recursion cap when walking either tree. BoxToGoogledriveTestDataAgent follows the existing
  // BoxTestDataAgent convention of a 30-level long-path chain, so this must stay comfortably above 30
  // or that scenario silently drops out of the comparison.
  treeDepth: 35,

  // Structure is exact: a missing or extra item is a defect, never absorbed by a tolerance.
  countDelta: 0,
};
