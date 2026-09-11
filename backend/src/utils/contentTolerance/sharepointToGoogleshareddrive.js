// Tolerance bands for SharePoint Online → Google Shared Drive. Edit only this file to tune
// sharepoint_to_googleshareddrive tolerances.
//
// Bands are destination/source ratios read as: inside info = normal, inside warn = flag it,
// outside = fail. Feature reference:
// backend/data/feature-scope/sharepoint-to-google-shared-drive-{inscope,outscope}.md
module.exports = {
  combination: 'sharepoint_to_googleshareddrive',

  // A pass-through file is the same bytes wherever it lands, so sizes should be identical. The
  // small window absorbs nothing but rounding in the reported size.
  fileSize: {
    infoMin: 0.99, infoMax: 1.01,
    warnMin: 0.95, warnMax: 1.05,
    note: 'Pass-through formats migrate byte-for-byte — sizes should be identical.',
  },

  // Office → Google native conversion. Drive reports little or no size for a native Doc/Sheet/Slide,
  // so the low end must reach 0 or every converted file fails on size alone — the same reasoning as
  // the Dropbox→Google bands, and for the same destination.
  convertedFileSize: {
    infoMin: 0.0, infoMax: 6.0,
    warnMin: 0.0, warnMax: 25.0,
    note: 'Converted file (a .docx/.xlsx/.pptx imported as a Google native doc). Drive reports '
      + 'little or no size for native docs, so size cannot indicate correctness here.',
  },

  // Feature 9.1 asks for created/modified timestamps to be preserved. Five minutes is the same
  // band every other content combination uses; it absorbs clock skew between the two clouds
  // without absorbing a migration that stamped "now" on everything (which drifts by hours).
  timestampDriftMs: 5 * 60 * 1000,

  // Google imposes no total-path limit and no 255-character segment limit, so feature 12.1's
  // expected outcome is that a long path arrives INTACT — nothing truncated, nothing relocated.
  // These values state that rather than leaving it to the SharePoint default, which would make the
  // validator expect a relocation that Google never performs.
  //
  // NOT YET CONFIRMED AGAINST A RUN — taken from Google's documented behaviour, like the Dropbox
  // pair's identical values. Confirm against the first validated run of this combination.
  pathLengthLimit: Infinity,
  segmentLengthLimit: 32767,

  // Must stay above the 20-level chain SharePointTestDataAgent seeds for feature 12.1, plus the
  // few levels of wrapper folders around it.
  treeDepth: 25,

  // Structure is exact: a missing or extra item is a defect, never absorbed by a tolerance.
  countDelta: 0,
};
