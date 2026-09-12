// Tolerance bands for Google Shared Drive → Google Shared Drive. Edit only this file to tune
// googleshareddrive_to_googleshareddrive tolerances.
//
// Bands are destination/source ratios read as: inside info = normal, inside warn = flag it,
// outside = fail. Feature reference:
// backend/data/feature-scope/google-shared-drive-to-shared-drive-{inscope,outscope}.md
module.exports = {
  combination: 'googleshareddrive_to_googleshareddrive',

  // Google → Google is a COPY, not a conversion: a binary file arrives byte-identical. This is the
  // tightest band in the directory, and deliberately so — a difference here is a real difference,
  // not a format change to be absorbed.
  fileSize: {
    infoMin: 0.99, infoMax: 1.01,
    warnMin: 0.97, warnMax: 1.03,
    note: 'Google → Google copies the bytes — sizes should be identical.',
  },

  // Native Docs/Sheets/Slides stay NATIVE; nothing is converted.
  //
  // The band still has to be wide, for a different reason than every Google→Microsoft combination:
  // not because the file changed, but because Drive reports little or no size for a native doc on
  // EITHER side, and the two reported numbers need not agree even when the content is identical.
  // Size therefore cannot indicate correctness for natives, and the band must not pretend otherwise.
  convertedFileSize: {
    infoMin: 0.0, infoMax: 6.0,
    warnMin: 0.0, warnMax: 25.0,
    note: 'Native Google doc on both sides — Drive reports little or no size for these, so size '
      + 'says nothing about correctness here.',
  },

  // Feature 4.1 asks for created and modified timestamps to be preserved. Five minutes is the band
  // every other content combination uses: it absorbs clock skew between the two accounts without
  // absorbing a migration that stamped "now" on everything, which drifts by hours.
  timestampDriftMs: 5 * 60 * 1000,

  // Google imposes no total-path limit and no 255-character segment limit, so feature 7.1's expected
  // outcome is that a long path arrives INTACT — nothing truncated, nothing relocated, and no
  // placeholder link. Stated here rather than inherited from the SharePoint default, which would
  // make the validator expect a relocation Google never performs.
  pathLengthLimit: Infinity,
  segmentLengthLimit: 32767,

  // Must stay above the deep chain DriveTestDataAgent seeds (20 levels) plus its wrapper folders.
  treeDepth: 25,

  // Structure is exact: a missing or extra item is a defect, never absorbed by a tolerance. The
  // non-migratable Google types (Forms, Sites, Vids, My Maps, Apps Script) are excluded from
  // "missing" by deepContentCore, not by a count tolerance — see the out-of-scope document.
  countDelta: 0,
};
