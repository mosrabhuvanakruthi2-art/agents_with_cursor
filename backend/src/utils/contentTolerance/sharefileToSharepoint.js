// Tolerance bands for ShareFile → SharePoint. Edit only this file to tune
// sharefile_to_sharepoint tolerances.
//
// Bands are destination/source ratios read as: inside info = normal, inside warn = flag it,
// outside = fail. Feature reference: backend/data/feature-scope/sharefile-to-sharepoint-*.md
//
// The destination is SharePoint Online, so the destination-side numbers (path limit, segment limit,
// timestamp drift) are the same physics as googledriveToSharepoint and are deliberately restated
// here rather than imported — a silently inherited band is what produced the four-way false failure
// recorded in the Dropbox scope doc. The SOURCE-side numbers differ, and each is justified below.
module.exports = {
  combination: 'sharefile_to_sharepoint',

  // Formats migrated byte-for-byte. ShareFile stores ordinary binaries with no native document
  // format of its own — there is no ShareFile equivalent of a Google Doc or a Box Note — so almost
  // everything on this combination is a pass-through and should land byte-identical. The narrow band
  // absorbs storage-reporting rounding, nothing more.
  fileSize: {
    infoMin: 0.99, infoMax: 1.01,
    warnMin: 0.95, warnMax: 1.05,
    note: 'ShareFile stores plain binaries with no native document format — files migrate byte-for-byte, so sizes should be identical.',
  },

  // Converted formats.
  //
  // File Conversion is NOT an in-scope feature for this combination — the ShareFile → SharePoint
  // document lists no conversion section, unlike Shared Drive → SharePoint (feature 12.1). So in
  // principle nothing should be converted at all.
  //
  // The band is kept, wide, rather than omitted: if CloudFuze does upgrade a legacy Office file
  // (.doc → .docx) the run should REPORT that as an unexpected conversion, not fail on a size ratio
  // and not crash on a missing band. `convertedSizeFloor.test.js` covers the shape.
  convertedFileSize: {
    infoMin: 0.25, infoMax: 4.0,
    warnMin: 0.05, warnMax: 20.0,
    note: 'File Conversion is not an in-scope feature for ShareFile → SharePoint. A converted destination file is unexpected and is reported for review; the band exists so the size check degrades to a report rather than a false failure.',
  },

  // Created/modified drift still counted as preserved (feature 3.1 Metadata).
  timestampDriftMs: 5 * 60 * 1000,

  // SharePoint path limits (feature 6.1), measured on the URL-encoded path. Items over the limit are
  // expected at an adjusted path.
  //
  // Note for whoever validates 6.1: on the Shared Drive combination, content relocated for exceeding
  // this limit was confirmed to LOSE ITS SHARING (defects 11.1 / 11b in docs/session-handoff.md).
  // Check permissions on relocated items specifically — relocation alone is not success.
  pathLengthLimit: 400,
  segmentLengthLimit: 255,

  // Recursion cap when walking either tree.
  //
  // Must exceed the DEEPEST PATH THE SEEDER PLANTS, and it did not. ShareFileTestDataAgent builds
  // 30 nested segments under /05-Long-Paths/deep-by-count, which sits 3 levels below the seeding
  // root — 33 levels of folder plus the file. At 25 the walk stopped inside that chain and reported
  // 139 of the 156 seeded items: SEVENTEEN items dropped out of the comparison silently, and the
  // long-path feature they exist to test could not be judged. Measured on the 2026-09-10 dry run.
  //
  // 40 leaves headroom for a deeper case without another silent truncation. The walk warns when it
  // hits the cap, so the symptom is visible — but a warning is not a substitute for a cap that fits
  // the data, because the items simply vanish from the counts.
  treeDepth: 40,

  // Structure is exact (feature 1.1): a missing or extra item is a defect, never absorbed by a
  // tolerance.
  countDelta: 0,

  // Version History (feature 4.1).
  //
  // This was `versionCountDelta: 0` — an exact match — reasoned from the document text, which says
  // ALL versions migrate and records no consolidation caveat like Google's. That reasoning was
  // wrong, and it would have failed every correct run.
  //
  // Figure 4.1.1 of Content_ShareFiletoSharePoint_(02-09-2026).docx shows the actual behaviour:
  // `version.docx` with 5 source versions arrives with TEN at the destination. The rows alternate —
  // versions 2.0/4.0/6.0/8.0/10.0 carry the real author ("Erik e") and the original source
  // timestamps, while 1.0/3.0/5.0/7.0/9.0 are authored by "SharePoint App" and dated at migration
  // time. CloudFuze writes a placeholder version alongside each real one, so the destination count
  // is roughly DOUBLE the source.
  //
  // The defensible invariant is therefore not equality but LOSS: a destination with fewer versions
  // than the source has lost history, which is a defect. Extra versions are an artifact of how
  // CloudFuze writes them and are reported, never failed — the same "loss fails, excess warns" rule
  // deepContentCore.compareVersions already applies, which anticipates exactly this
  // ("SharePoint may add a version reflecting the migration timestamp").
  //
  // Null rather than a number: there is no symmetric tolerance to express. The rule is directional.
  versionCountDelta: null,
  /** Destination versions per source version, observed in figure 4.1.1. Reported, never enforced. */
  versionCountExpectedRatio: 2,
};
