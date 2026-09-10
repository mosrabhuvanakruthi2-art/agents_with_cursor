// Tolerance bands for Dropbox → SharePoint Online. Edit only this file to tune
// dropbox_to_sharepoint tolerances.
//
// Bands are destination/source ratios read as: inside info = normal, inside warn = flag it,
// outside = fail. Feature reference: backend/data/feature-scope/dropbox-to-sharepoint-*.md
//
// ⚠️ These are NOT the Dropbox → Google bands. Same source cloud, different destination, and three
// values invert. Copying dropboxToGoogledrive.js here would silence the two features this
// combination most needs to assert:
//
//   pathLengthLimit      Infinity there (Google has no limit) → 400 here. Left at Infinity, feature
//                        8.1's placeholder-link expectation can never trigger and every over-limit
//                        item is reported missing instead.
//   segmentLengthLimit   32767 there → 255 here.
//   convertedFileSize    0.0–25.0 there, because a Google native doc reports almost no size.
//                        SharePoint stores a real .docx and reports a real size, so that band would
//                        accept essentially anything.
module.exports = {
  combination: 'dropbox_to_sharepoint',

  // Formats migrated byte-for-byte (.pdf, .png, .zip, .txt, .csv …). A correctly migrated file is
  // the same size; the band absorbs storage-reporting rounding, nothing more.
  fileSize: {
    infoMin: 0.99, infoMax: 1.01,
    warnMin: 0.95, warnMax: 1.05,
    note: 'Pass-through formats migrate byte-for-byte — sizes should be identical.',
  },

  // Converted files. On this pair that means Dropbox Paper → Microsoft Word (.docx), per scope
  // §11.1 — the ONLY conversion this combination performs. Unlike the Google destination, the
  // destination file is a real .docx with a real reported size, so the band is the SharePoint-shaped
  // one rather than the near-zero-tolerant Google one.
  //
  // Still wide: a Paper document is markdown-ish source converted into an Office package with its
  // own zip overhead, styles and embedded media, so a faithful conversion legitimately differs from
  // the source by a large factor in either direction. Size is a sanity check here, never a content
  // check — §11.x fidelity is judged by structure, not bytes.
  convertedFileSize: {
    infoMin: 0.25, infoMax: 4.0,
    warnMin: 0.05, warnMax: 20.0,
    note: 'Dropbox Paper converted to Word (.docx). Package overhead and embedded media mean size '
      + 'cannot indicate correctness — the structure comparison is what does.',
  },

  // Created/modified drift still counted as preserved (scope §6.1).
  //
  // Only the MODIFIED half is comparable, for two independent reasons: Dropbox exposes no creation
  // time on file metadata, AND scope §6.1 states the Microsoft Graph API supports only ModifiedTime,
  // so CreatedBy / ModifiedBy / CreatedTime are not preserved by default. Comparing them and failing
  // reports a defect against documented behaviour.
  timestampDriftMs: 5 * 60 * 1000,

  // Scope §8.1: "Microsoft enforces a 400-character maximum file path length." Measured on the
  // URL-ENCODED path — a space costs 3 characters, not 1 — with each segment capped at 255. Over the
  // limit CloudFuze creates a placeholder link instead of the item, which is the DOCUMENTED expected
  // outcome, so an over-limit item must never be reported missing.
  pathLengthLimit: 400,
  segmentLengthLimit: 255,

  // Recursion cap when walking either tree. DropboxTestDataAgent seeds a 20-level chain for the
  // long-path scenario, so this must stay above 20 or that scenario silently drops out.
  treeDepth: 25,

  // Structure is exact: a missing or extra item is a defect, never absorbed by a tolerance.
  countDelta: 0,

  // ── Version rules, both stated verbatim by scope §3.1 ────────────────────────────────────────
  //
  // "In SharePoint Online, an extra version may appear with the migration date/time — this is a
  // system-generated entry, not a duplicate." So one MORE version at the destination than the source
  // is a pass, not an extra. Exactly one: two extra versions is not explained by this rule.
  versionExtraAllowed: 1,

  // "CloudFuze migrates Dropbox file versions from the last 180 days along with the latest version;
  // older versions are not migrated." A source revision older than this is expected ABSENT at the
  // destination — counting it missing fails a correct migration. The latest version always migrates
  // regardless of its age.
  versionWindowDays: 180,
};
