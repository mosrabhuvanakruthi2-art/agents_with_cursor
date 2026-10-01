// Tolerance bands for Google Shared Drive → OneDrive for Business. Edit only this file to tune
// googleshareddrive_to_onedrive tolerances.
//
// Bands are destination/source ratios read as: inside info = normal, inside warn = flag it,
// outside = fail. Feature reference:
// backend/data/feature-scope/google-shared-drive-to-onedrive-*.md
//
// This combination is narrow — eight features, four migration and four permissions. Versions,
// shared links, timestamps and external shares are all OUT of scope for it, so several bands that
// matter elsewhere are deliberately absent here rather than copied across. A band that exists
// invites a check, and a check the scope document does not ask for is how this project has most
// often produced a wrong verdict.
module.exports = {
  combination: 'googleshareddrive_to_onedrive',

  // Formats that migrate byte-for-byte (.pdf, .png, .zip, …). A correctly migrated file is the
  // same size; the small band absorbs storage-reporting rounding, nothing more.
  fileSize: {
    infoMin: 0.99, infoMax: 1.01,
    warnMin: 0.95, warnMax: 1.05,
    note: 'Pass-through formats migrate byte-for-byte — sizes should be identical.',
  },

  // Converted formats: Google native exports (Doc→.docx, Sheet→.xlsx, Slides→.pptx). A converter
  // legitimately produces a very different size for the same document, so this band is wide on
  // purpose — size is a sanity check here, not a content check.
  //
  // The lower bound matters more than it looks: a 1 KB Google Doc becomes a ~14 KB .docx because a
  // .docx carries fixed zip overhead, so a NARROW band reports correct conversions as defects.
  convertedFileSize: {
    infoMin: 0.25, infoMax: 4.0,
    warnMin: 0.05, warnMax: 20.0,
    note: 'Converted file (Google native export) — the destination is produced by a converter, so its size legitimately differs from the source.',
  },

  // OneDrive for Business runs on SharePoint Online, so SharePoint's limits apply unchanged —
  // measured on the URL-encoded path, exactly as for a SharePoint destination. In-scope feature 1.4
  // names this explicitly ("subject to SharePoint Online path length and naming limitations"), so
  // an item renamed or relocated for these reasons is correct behaviour, not a structure defect.
  pathLengthLimit: 400,
  segmentLengthLimit: 255,

  // Recursion cap when walking either tree. DriveTestDataAgent seeds a 20-level path, so this must
  // stay above 20 or the deep-nesting scenario silently drops out of the comparison — and 1.4 would
  // then pass without ever having looked at the deepest structure it exists to check.
  treeDepth: 25,

  // Structure is exact: a missing or extra item is a defect, never absorbed by a tolerance.
  //
  // One caveat the validator handles rather than this band: the destination is a PERSONAL OneDrive
  // that already held 281 root items before this combination ever ran. Content belonging to
  // anything other than this run's migrated tree is foreign and must not be counted here — see the
  // foreign-subtree note in the validator.
  countDelta: 0,

  // NOT PRESENT, and deliberately so — all four are out of scope for this combination:
  //   timestampDriftMs   (out-of-scope 2.1 Timestamps)
  //   versionCountDelta  (out-of-scope 4.1 Versions)
  //   linkScopeMap       (out-of-scope 3.1 SharedLinks)
  //   externalGrant*     (out-of-scope 1.1 External shares)
  // Adding any of them without first changing the in-scope document would make the validator judge
  // a promise the document does not make.
};
