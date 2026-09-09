// Tolerance bands for Dropbox → Google Shared Drive. Edit only this file to tune
// dropbox_to_googleshareddrive tolerances.
//
// Bands are destination/source ratios read as: inside info = normal, inside warn = flag it,
// outside = fail. Feature reference: backend/data/feature-scope/dropbox-to-google-*.md
//
// Its own file rather than an alias of dropboxToGoogledrive.js, even though most numbers are the
// same. A Shared Drive is the same STORAGE with a different OWNERSHIP model, and ownership is
// exactly what the permission half of this scope document is about — so the two need to be tunable
// apart. Sharing one file would mean a Shared Drive finding could only be addressed by changing My
// Drive's bands too.
module.exports = {
  combination: 'dropbox_to_googleshareddrive',

  // Identical to My Drive: a pass-through file is the same bytes wherever it lands.
  fileSize: {
    infoMin: 0.99, infoMax: 1.01,
    warnMin: 0.95, warnMax: 1.05,
    note: 'Pass-through formats migrate byte-for-byte — sizes should be identical.',
  },

  // Same reasoning as My Drive: Drive reports little or no size for a native Google doc, so the low
  // end must reach 0 or every converted file fails on size alone.
  convertedFileSize: {
    infoMin: 0.0, infoMax: 6.0,
    warnMin: 0.0, warnMax: 25.0,
    note: 'Converted file (imported as a Google native doc, or a legacy Office upgrade). Drive '
      + 'reports little or no size for native docs, so size cannot indicate correctness.',
  },

  timestampDriftMs: 5 * 60 * 1000,

  // Google imposes no total-path limit and no 255-char segment limit, on either destination.
  //
  // NOT YET CONFIRMED AGAINST A RUN — the same open question as My Drive: 144 QA cases exercise a
  // long-path "breaking point" for this pair, which contradicts these values. See
  // dropbox-to-google-testdata.md.
  pathLengthLimit: Infinity,
  segmentLengthLimit: 32767,

  // Must stay above the 20-level chain DropboxTestDataAgent seeds for the long-path scenario.
  treeDepth: 25,

  // Structure is exact: a missing or extra item is a defect, never absorbed by a tolerance.
  countDelta: 0,
};
