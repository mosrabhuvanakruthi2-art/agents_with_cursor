// Tolerance bands for Google My Drive → Google My Drive. Edit only this file to tune
// googledrive_to_googledrive tolerances.
//
// Bands are destination/source ratios read as: inside info = normal, inside warn = flag it,
// outside = fail. Feature reference: backend/data/feature-scope/my-drive-to-my-drive-*.md
//
// Source and destination are the SAME platform, which makes almost every band tighter than on any
// cross-platform pair — there is no converter in the path to justify drift. Each number is stated
// rather than inherited, because a band copied from a cross-platform combination would quietly
// excuse a real difference here.
module.exports = {
  combination: 'googledrive_to_googledrive',

  // Pass-through formats (.pdf, .png, .zip, .txt, .csv, .docx …). Google → Google copies the bytes;
  // there is no conversion step at all, so a correctly migrated file is the SAME SIZE.
  //
  // Tighter than the Dropbox → Google band (0.95–1.05) on purpose: that one absorbs two clouds'
  // different storage accounting. Here both numbers come from the same Drive API, so a difference
  // beyond rounding is a real difference in the file.
  fileSize: {
    infoMin: 0.999, infoMax: 1.001,
    warnMin: 0.99, warnMax: 1.01,
    note: 'Same platform on both sides — a pass-through file migrates byte-for-byte and its Drive '
      + 'reported size should be identical, not merely close.',
  },

  // "Converted" files, which on this pair means Google NATIVE docs (Doc / Sheet / Slides).
  //
  // Nothing is actually converted — a Doc arrives as a Doc — but Drive reports little or no size for
  // a native file, and the number it does report is not stable between two accounts. A native doc
  // can read 0 bytes on one side and a few hundred on the other for identical content.
  //
  // So the band is wide and the low end is 0, exactly as on the Dropbox → Google pair, and for the
  // same reason: size cannot indicate correctness for a native doc. It is a sanity check that the
  // item exists, never a content check.
  convertedFileSize: {
    infoMin: 0.0, infoMax: 6.0,
    warnMin: 0.0, warnMax: 25.0,
    note: 'Google native doc (Doc/Sheet/Slides). Drive reports little or no size for native files '
      + 'and the value is not comparable between accounts, so size proves nothing about content. '
      + 'Tier B cannot hash these either — see notHashableReason.',
  },

  // Created/modified drift still counted as preserved (feature 4.1).
  //
  // Figure 4.1.1 of the scope document shows source and destination `Date modified` matching to the
  // MINUTE, including a same-day `2:43 PM` entry — so the document's own evidence is minute-level,
  // not day-level. 5 minutes is kept (matching the other content combinations) because CloudFuze
  // writes the timestamp after the upload and the gap is real, but anything beyond it is a finding.
  timestampDriftMs: 5 * 60 * 1000,

  // Google imposes NO total-path limit and no 255-char segment limit (a name may be 32,767 chars).
  //
  // Unlike every other combination, this value is UNFALSIFIABLE here rather than merely unconfirmed:
  // the source is Google too, so no path that exists in the source can exceed a Google limit. The
  // open "breaking point" question in dropbox-to-google-testdata.md cannot be answered from this
  // pair, and a long-path failure on this combination means something other than a limit.
  pathLengthLimit: Infinity,
  segmentLengthLimit: 32767,

  // Recursion cap when walking either tree. The scope document's own long-path figure (7.1.1) shows
  // a TEST01…TEST09 chain, so 9 levels is the documented depth; 25 leaves headroom for seeded data
  // deeper than the document's example without an unbounded walk.
  treeDepth: 25,

  // Structure is exact: a missing or extra item is a defect, never absorbed by a tolerance.
  //
  // With one large caveat that belongs to the validator, not to a number here — the out-of-scope
  // document's five conflict types (Vids, Forms, My Maps, Apps Script, Sites) are EXPECTED to be
  // absent, and its figures show 13 source items against 7 at the destination. That six-item gap is
  // documented behaviour. It is excluded by classifying those items before the comparison, not by
  // loosening this to 6 — a count tolerance would equally excuse six genuinely lost files.
  countDelta: 0,
};
