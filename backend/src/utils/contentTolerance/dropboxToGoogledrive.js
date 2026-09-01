// Tolerance bands for Dropbox → Google My Drive. Edit only this file to tune
// dropbox_to_googledrive tolerances.
//
// Bands are destination/source ratios read as: inside info = normal, inside warn = flag it,
// outside = fail. Feature reference: backend/data/feature-scope/dropbox-to-google-*.md
//
// The destination is GOOGLE, not SharePoint, and three numbers differ from every other content
// combination in this repo because of it. Each is stated rather than inherited, since a silently
// inherited SharePoint value is what produced the four-way false failure recorded in the scope doc.
module.exports = {
  combination: 'dropbox_to_googledrive',

  // Formats migrated byte-for-byte (.pdf, .png, .zip, .txt, .csv …). A correctly migrated file is
  // the same size; the band absorbs storage-reporting rounding, nothing more.
  fileSize: {
    infoMin: 0.99, infoMax: 1.01,
    warnMin: 0.95, warnMax: 1.05,
    note: 'Pass-through formats migrate byte-for-byte — sizes should be identical.',
  },

  // Converted formats. On a Google destination the conversion runs the OPPOSITE way to the
  // SharePoint combinations: Office and legacy Office files may be imported as Google native docs
  // (Doc/Sheet/Slides), and a Google native doc reports a size that has almost no relationship to
  // the source bytes — Drive reports 0 or a small metadata size for native files.
  //
  // Hence a much wider band than googledriveToSharepoint's, and the low end goes to ~0: a Google
  // native destination file legitimately reports a near-zero size for a multi-megabyte source.
  // Size is a sanity check here, never a content check.
  convertedFileSize: {
    infoMin: 0.0, infoMax: 6.0,
    warnMin: 0.0, warnMax: 25.0,
    note: 'Converted file (imported as a Google native doc, or a legacy Office upgrade). Drive '
      + 'reports little or no size for native docs, so size cannot indicate correctness — the '
      + 'destination opening cleanly is what does, and Tier B cannot assert it.',
  },

  // Created/modified drift still counted as preserved (feature 4.1).
  //
  // Only the MODIFIED half is comparable: Dropbox exposes no creation time on file metadata, so
  // there is no source created-date to compare and the validator must report that as not comparable
  // rather than as a mismatch.
  timestampDriftMs: 5 * 60 * 1000,

  // Google imposes NO total-path limit and no 255-char segment limit (a name may be 32,767 chars).
  // Infinity rather than a large number so a comparison can never accidentally trip it, and so the
  // intent reads as "there is no limit" rather than "the limit is big".
  //
  // NOT YET CONFIRMED AGAINST A RUN. 144 QA cases exercise a long-path "breaking point" for this
  // pair, which contradicts this value — see the open question in dropbox-to-google-testdata.md.
  // If a real limit exists it belongs here and in validation/destinations/googledrive.js.
  pathLengthLimit: Infinity,
  segmentLengthLimit: 32767,

  // Recursion cap when walking either tree. DropboxTestDataAgent seeds a 20-level chain for the
  // long-path scenario, so this must stay above 20 or that scenario silently drops out.
  treeDepth: 25,

  // Structure is exact: a missing or extra item is a defect, never absorbed by a tolerance.
  countDelta: 0,
};
