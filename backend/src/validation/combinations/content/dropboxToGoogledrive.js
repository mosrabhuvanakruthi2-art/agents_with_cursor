'use strict';

/**
 * Deep validation for content: Dropbox → Google My Drive.
 *
 * Edit ONLY this file to change Dropbox → My Drive behaviour. Provider-agnostic comparison logic
 * lives in validation/shared/deepContentCore.js; the numbers live in utils/contentTolerance/; the
 * Google destination's name/path rules live in validation/destinations/googledrive.js; the
 * Dropbox→Google role and link tables live in validation/roleMaps/dropbox_to_google.js.
 *
 * Feature coverage — backend/data/feature-scope/dropbox-to-google-inscope.md (36 in-scope features):
 *   Tier A — 1.1 structure, 5.1 special characters, 7.1 long paths
 *   Tier B — file content hashes for pass-through formats
 *   Tier C — 2.1–2.5 permissions, 3.1–3.2 shared links, 4.1 metadata (created AND modified dates,
 *            each judged against the job flag that asked for it), 9.1–9.2 versions
 *   Reports — 3.1/3.2 CSVs written into the destination; 8.1's CSV is supporting evidence only
 *   In-doc  — 8.1 the hyperlink targets inside the migrated embedded_link_doc.docx (the .html
 *             beside it is a contrast case, reported and never judged: see EMBEDDED_DOC_PATH)
 *   §10     — Dropbox Paper (19 features): reported, not judged. See PAPER_DISPUTED below.
 *
 * THE DESTINATION IS GOOGLE, NOT SHAREPOINT. That single fact changes three rules, and getting any
 * of them wrong produces confident false failures rather than quiet gaps:
 *
 *   - Google rejects almost no characters, so feature 5.1's expected outcome is NO replacement.
 *     Applying SharePoint's character set here predicts a renamed folder that never occurs, then
 *     reports it missing, reports its real name extra, and reports every child misplaced.
 *   - Google imposes no total-path limit, so no placeholder link is ever the expected outcome for
 *     feature 7.1. Expecting one reports intact deep data as wrongly handled.
 *   - A shared LINK in Drive is a permission entry (type 'anyone' / 'domain'), not a separate
 *     object. Left in the user list it makes every link look like a grant to an unknown principal.
 *
 * All three are handled by passing the Google destination rules into the shared comparison rather
 * than by branching here, so there is one place that says what Google does.
 */

const GoogleDriveValidationAgent = require('../../../agents/googledrive/GoogleDriveValidationAgent');
const dropboxClient = require('../../../clients/dropboxClient');
const driveClient = require('../../../clients/driveClient');
const core = require('../../shared/deepContentCore');
const { extractDocxLinks } = require('../../../utils/docxLinks');
const destinations = require('../../destinations');
const roleMaps = require('../../roleMaps');
const tolerance = require('../../../utils/contentTolerance');
const env = require('../../../config/env');
const logger = require('../../../utils/logger');

/**
 * Structural element counts from a Dropbox Paper markdown export.
 *
 * Scope §10 asks whether each Paper construct survived the conversion to a Google Doc. Comparing
 * the documents word-for-word is meaningless — the conversion rewrites the markup entirely — but the
 * COUNT of each construct is a fair question: three tables in, three tables out.
 *
 * Only constructs with an unambiguous marker on BOTH sides are counted. Anything the two exports
 * cannot distinguish is deliberately left out rather than guessed at, because a wrong Paper verdict
 * is exactly what the scope document warns about: on the sibling combination one guessed rule
 * failed 92 ordinary notification emails.
 */
function paperMarkdownStructure(md) {
  const text = String(md || '');
  const lines = text.split('\n');
  const count = (re) => (text.match(re) || []).length;

  return {
    // A markdown table is identified by its header SEPARATOR row (|---|---|), one per table —
    // counting `|` rows would count every row of every table instead.
    // A markdown table is identified by its header SEPARATOR row, one per table — counting `|`
    // rows would count every row of every table instead.
    //
    // `-+`, not `-{3,}`: Paper's own markdown export writes the separator as `| - | - | - |` with a
    // SINGLE dash, while hand-written markdown uses `|---|---|`. Requiring three dashes counted 0
    // tables in a Paper document that demonstrably had one — verified by exporting a seeded doc
    // and reading the raw bytes. The old test fixture used the hand-written form, so it agreed
    // with the bug instead of catching it.
    // A markdown table is identified by its header SEPARATOR row, one per table — counting `|`
    // rows would count every row of every table instead.
    //
    // `-+` rather than `-{3,}`: Paper's own markdown export writes the separator with a SINGLE
    // dash, `| - | - | - |`, while hand-written markdown uses `|---|---|`. Requiring three
    // dashes counted ZERO tables in a Paper document that demonstrably had one — confirmed by
    // seeding a doc and reading the raw export bytes. The test fixture used the hand-written
    // form, so it agreed with the bug rather than catching it.
    tables: lines.filter((l) => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(l)).length,
    // Bulleted and numbered are counted as ITEMS, not blocks.
    //
    // This was block-counting, on the stated premise that "Google's HTML export emits one
    // <ul>/<ol> per block however many items it holds". That premise is false. Read off the real
    // export of /11-Paper/qa-paper-full.html, Google emits one list element per ITEM:
    //
    //   <ul> 1 item: ["alpha"]     <ol> 1 item: ["first"]
    //   <ul> 1 item: ["beta"]      <ol> 1 item: ["second"]
    //   <ul> 1 item: ["gamma"]     <ol> 1 item: ["third"]
    //
    // all six at nesting depth 0 — siblings, not nested. So block-counting compared 1 source
    // block against 3 destination lists and run e6bdd529 warned "3 in the source but 9 at the
    // destination" on three perfectly migrated lists. Counting items compares 3 against 3.
    //
    // Item counting also survives either exporter behaviour: if Google ever does emit one list
    // per block, the <li> count is unchanged, whereas block counting breaks on both shapes.
    //
    // Checklist lines are counted here too, not excluded, so a checklist rendered as an ordinary
    // list at the destination does not read as excess. `todo` below counts its items separately
    // for feature 10.11.
    bulleted: lines.filter((l) => /^\s*[-*+]\s+/.test(l)).length,
    numbered: lines.filter((l) => /^\s*\d+[.)]\s+/.test(l)).length,
    todo: lines.filter((l) => /^\s*[-*+]\s+\[[ xX]\]/.test(l)).length,
    // Images first: an image is a link with a leading !, so links must exclude them.
    images: count(/!\[[^\]]*\]\([^)]*\)/g),
    links: count(/(^|[^!])\[[^\]]*\]\([^)]*\)/g),
    emojis: countEmoji(text),
  };
}

/**
 * <li> items inside the given list type, across every such list in the document.
 *
 * Google emits one <ul>/<ol> per item rather than one per list, so the element count is not a
 * block count and must not be compared against one. Items are the stable unit.
 *
 * Nested lists are counted by whichever type directly encloses each item, which is what a reader
 * comparing against the source markdown expects.
 */
const listBlock = (tag) => new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, 'gi');

function listItems(html, tag) {
  const blocks = String(html || '').match(listBlock(tag)) || [];
  let n = 0;
  for (const b of blocks) {
    // Strip any nested list of the OTHER type first, so its items are not attributed here.
    const own = b.replace(listBlock(tag === 'ul' ? 'ol' : 'ul'), '');
    n += (own.match(/<li\b/gi) || []).length;
  }
  return n;
}

/** The same counts from Google's HTML export of the converted Doc. */
function googleDocStructure(html) {
  const text = String(html || '');
  const count = (re) => (text.match(re) || []).length;
  const split = splitImages(text);

  return {
    tables: count(/<table[\s>]/gi),
    // <ul>/<ol> blocks, not <li> items: Paper's markdown export emits one line per item while
    // Google nests them, so item counts do not correspond. Block counts do.
    // <li> items, attributed to the list type that encloses them — see the note on the source
    // side: Google emits one <ul>/<ol> per item, so counting list ELEMENTS counts items in
    // disguise and only agrees with a source block count by accident.
    bulleted: listItems(text, 'ul'),
    numbered: listItems(text, 'ol'),
    // Google's HTML export renders a checklist as an ordinary list, so a checkbox cannot be
    // recognised here. Reported as null — NOT zero, which would read as "none arrived".
    todo: null,
    // Rasterised emoji are excluded here and added to the emoji count instead,
    // because Google exports every emoji as an <img>. See isEmojiImage.
    images: split.images,
    links: count(/<a\s[^>]*href=/gi),
    emojis: countEmoji(stripTags(text)) + split.emojiImages,
  };
}

/** Drop tags and decode the few entities Google's exporter emits, so text-level counts are fair. */
function stripTags(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * Emoji count, treating a ZWJ sequence as ONE emoji.
 *
 * Two decisions here, both learned the hard way:
 *
 * Matching the pictographic ranges rather than \p{Emoji}, because that property also matches
 * ordinary digits, '#' and '*' — a document with page numbers would report dozens of emojis and
 * feature 10.16 would fail on every run.
 *
 * And consuming a whole ZWJ sequence as one match rather than stripping the joiners. Stripping
 * them does not merge anything: it leaves the parts behind, so a family emoji counted as three.
 * Sequence-aware counting is also strictly more useful — if the conversion SPLITS a family emoji
 * into its members, the source reads 1 against the destination 3 and the difference is caught,
 * where part-counting would read 3 against 3 and miss it.
 */
const EMOJI_CORE = '[\\u{1F300}-\\u{1FAFF}\\u{1F000}-\\u{1F2FF}\\u{2600}-\\u{27BF}]'
  + '(?:[\\u{1F3FB}-\\u{1F3FF}])?(?:\\u{FE0F})?';
const EMOJI_SEQUENCE = new RegExp(`${EMOJI_CORE}(?:\\u{200D}${EMOJI_CORE})*`, 'gu');

function countEmoji(s) {
  return (String(s || '').match(EMOJI_SEQUENCE) || []).length;
}

/**
 * Emoji that Google's exporter turned into images.
 *
 * Google Docs does not export an emoji as a text character. It rasterises each one to a 64x64 PNG
 * and emits an <img> whose alt is the emoji's CLDR NAME IN WORDS. Measured on the real export of
 * /11-Paper/qa-paper-full.html from run e6bdd529:
 *
 *   <img alt="party popper" src="data:image/png;base64,…">   64x64 png
 *   <img alt="rocket"       src="data:image/png;base64,…">   64x64 png
 *   <img alt="thumbs up"    src="data:image/png;base64,…">   64x64 png
 *   <img alt=""             src="data:image/jpeg;base64,…">  the one genuinely inserted image
 *
 * That is why counting emoji from stripTags() at the destination returns 0 however well the
 * migration ran: the characters are not in the text any more. Run e6bdd529 reported "8 in the
 * source but only 0 at the destination — 8 lost in the conversion" and FAILED feature 10.16, while
 * the same eight emoji simultaneously inflated the image count from 2 to 10 and pushed 10.3/10.4/
 * 10.5 into WARN. One exporter behaviour, two wrong verdicts.
 *
 * Three signals identify these images. All three held on every emoji and none held on the real
 * image, so all three are REQUIRED rather than any one of them:
 *   - the src is a base64 data URI of a PNG,
 *   - the PNG's IHDR declares a small square (Google uses exactly 64x64; the cap leaves room for a
 *     future glyph size without matching a photograph),
 *   - the alt is non-empty, because a rasterised emoji always carries its name.
 *
 * An <img> failing any one of them is counted as an ordinary image.
 */
const EMOJI_IMG_MAX_EDGE = 128;
const IMG_TAG = new RegExp('<img[^>]*>', 'gi');
const ALT_ATTR = new RegExp('alt="([^"]*)"', 'i');
const PNG_DATA_URI = new RegExp('src="data:image/png;base64,([^"]+)"', 'i');

function isEmojiImage(tag) {
  const alt = (tag.match(ALT_ATTR) || [, ''])[1];
  if (!alt.trim()) return false;
  const src = tag.match(PNG_DATA_URI);
  if (!src) return false;
  // The IHDR sits in the first 24 bytes, so a short prefix is enough to read the dimensions.
  let head;
  try {
    head = Buffer.from(src[1].slice(0, 120), 'base64');
  } catch {
    return false;
  }
  if (head.length < 24 || head.slice(1, 4).toString('latin1') !== 'PNG') return false;
  const w = head.readUInt32BE(16);
  const h = head.readUInt32BE(20);
  return w === h && w > 0 && w <= EMOJI_IMG_MAX_EDGE;
}

/** The <img> tags of a Google HTML export, split into rasterised emoji and real images. */
function splitImages(html) {
  const tags = String(html || '').match(IMG_TAG) || [];
  let emojiImages = 0;
  for (const t of tags) if (isEmojiImage(t)) emojiImages += 1;
  return { emojiImages, images: tags.length - emojiImages };
}

const DEFAULT_COMBINATION = 'dropbox_to_googledrive';

/**
 * The tolerance/role-map lookup key for this run — NOT a constant.
 *
 * orchestrator/combinations/content/dropboxToGoogleshareddrive.js reuses this whole file verbatim
 * (same client, same tree-reading code; only GoogleDriveValidationAgent's destination read branches
 * on destinationProvider). A hardcoded 'dropbox_to_googledrive' here meant every Shared Drive run
 * silently read My Drive's tolerance bands and reported the My Drive combination label, and left
 * utils/contentTolerance/dropboxToGoogleshareddrive.js unreachable — registered but never looked up.
 * roleMaps/dropbox_to_google.js already lists both combinations, so only this lookup needed to
 * become dynamic.
 */
function combinationFor(context) {
  const provider = String(context?.destinationProvider || 'googledrive').toLowerCase();
  return provider === 'googleshareddrive' ? 'dropbox_to_googleshareddrive' : DEFAULT_COMBINATION;
}

/**
 * How long to wait for CloudFuze's permission phase before calling a grant missing.
 *
 * Only used when the source has grants and the destination reports none — see the note in
 * _validateItem. Two attempts at 8s keeps the worst case bounded (16s per affected item) while
 * covering the delay actually observed.
 */
// Tunable per run — see CONTENT_PERMISSION_SETTLE_* in config/env.js for why the old hardcoded
// 2 x 8s was two orders of magnitude short of the delay measured on a real run.
const PERMISSION_SETTLE_ATTEMPTS = env.CONTENT_PERMISSION_SETTLE_ATTEMPTS;
const PERMISSION_SETTLE_MS = env.CONTENT_PERMISSION_SETTLE_MS;

/** Terminal CloudFuze statuses that mean the migration itself finished. */
const CF_OK = ['PROCESSED', 'PROCESS', 'VERSION_PROCESSED'];
const CF_CONFLICTS = ['PROCESSED_WITH_CONFLICTS', 'PROCESS_WITH_CONFLICTS'];

/**
 * The 36 in-scope features, in the scope document's own numbering.
 *
 * A combination-local list rather than validation/shared/contentFunctionalityChecklist.js: that
 * module hardcodes the Google→SharePoint feature set, including Commenter / Contributor / Content
 * Manager roles that do not exist in Dropbox and a "Sync Orbit" wording taken from one tenant. Using
 * it here would produce a report whose feature ids do not match the document a reviewer is holding.
 * Editing it would change both live SharePoint combinations, which CONTRIBUTING forbids.
 */
const DROPBOX_FEATURES = [
  { id: '1.1', category: 'Migration', feature: 'Data Migration (Files & Folders with structure)' },
  { id: '1.2', category: 'Migration', feature: 'One Time Migration' },
  { id: '1.3', category: 'Migration', feature: 'Delta Migration' },

  { id: '2.1', category: 'Permissions', feature: 'Root Folder Permissions' },
  { id: '2.2', category: 'Permissions', feature: 'Root File Permissions' },
  { id: '2.3', category: 'Permissions', feature: 'Sub-folder permissions' },
  { id: '2.4', category: 'Permissions', feature: 'Inner file permissions' },
  { id: '2.5', category: 'Permissions', feature: 'External Shares' },

  { id: '3.1', category: 'Shared Links', feature: 'Shared Links (Anyone with the Link)' },
  { id: '3.2', category: 'Shared Links', feature: 'Shared Links (Team Members)' },

  { id: '4.1', category: 'Metadata', feature: 'Metadata (timestamps)' },
  { id: '5.1', category: 'Special Characters Replacement', feature: 'Special Characters Replacement' },
  { id: '6.1', category: 'Suppressing email notifications', feature: 'Suppressing email notifications' },
  { id: '7.1', category: 'Long-File/folder path', feature: 'Long-File/folder path' },
  { id: '8.1', category: 'Embedded Links', feature: 'Embedded Links' },

  { id: '9.1', category: 'Versions', feature: 'Version History' },
  { id: '9.2', category: 'Versions', feature: 'Selective Versions' },

  { id: '10.1', category: 'Dropbox Papers', feature: 'Dropbox Papers Migration' },
  { id: '10.2', category: 'Dropbox Papers', feature: 'Text Formatting' },
  { id: '10.3', category: 'Dropbox Papers', feature: 'Inserted Images' },
  { id: '10.4', category: 'Dropbox Papers', feature: 'Inserted Media' },
  { id: '10.5', category: 'Dropbox Papers', feature: 'Clipboard Images' },
  { id: '10.6', category: 'Dropbox Papers', feature: 'GIFs' },
  { id: '10.7', category: 'Dropbox Papers', feature: 'Links' },
  { id: '10.8', category: 'Dropbox Papers', feature: 'Insert Dropbox Files' },
  { id: '10.9', category: 'Dropbox Papers', feature: 'Tables' },
  { id: '10.10', category: 'Dropbox Papers', feature: 'Inserted Timeline' },
  { id: '10.11', category: 'Dropbox Papers', feature: 'TO-DO list' },
  { id: '10.12', category: 'Dropbox Papers', feature: 'Bulleted List' },
  { id: '10.13', category: 'Dropbox Papers', feature: 'Numbered List' },
  { id: '10.14', category: 'Dropbox Papers', feature: 'Section Break' },
  { id: '10.15', category: 'Dropbox Papers', feature: 'Code Block' },
  { id: '10.16', category: 'Dropbox Papers', feature: 'Emojis' },
  { id: '10.17', category: 'Dropbox Papers', feature: 'Mentions' },
  { id: '10.18', category: 'Dropbox Papers', feature: 'Comments' },
  { id: '10.19', category: 'Dropbox Papers', feature: 'Versions of Dropbox Papers' },
];

/**
 * The six Paper features the scope document records as NOT migrating, with its own wording.
 *
 * These are the open question the scope and out-of-scope documents both flag: they appear in the
 * IN-scope document, yet the out-of-scope document lists only the in-line comment CSV. Until the
 * combination owner rules, each is reported at INFO carrying the document's wording — neither hiding
 * a defect nor inventing one.
 *
 * Do NOT convert these to failures or to passes without that ruling. The scope document records what
 * guessing cost on the sibling combination: one guessed rule failed 92 ordinary notification emails,
 * another printed "handled as documented" directly above a FAIL for the same thing.
 */
const PAPER_DISPUTED = {
  '10.2': 'Minor differences, such as highlight colours, are not migrated.',
  '10.6': 'GIFs are not properly migrated and appear as unsupported elements in the destination document.',
  '10.14': 'Section breaks are not migrated — no corresponding formatting or separators are present at the destination.',
  '10.15': 'The code block formatting (background, borders, structured layout) is not fully preserved, resulting in plain text representation.',
  '10.17': 'User mentions are not migrated as expected. They appear as plain, editable text at the destination, and the link appears as an invalid link.',
  '10.18': 'Comments are not migrated. The destination item does not contain any of the original comments from the source.',
};

/**
 * The HTML document 8.1 used to be judged on, and now is NOT — the deliberate contrast case.
 *
 * Judging 8.1 on this file produced an INVALID FAIL, and that FAIL was being reported as a
 * CloudFuze defect. Scope 8.1 promises link rewriting for "supported file types where link
 * rewriting is technically feasible", and a plain <a href> in an .html file is not one of them.
 * DriveTestDataAgent._createEmbeddedLinks states the rule for the Drive pair in as many words:
 * "A real .docx with a real hyperlink is used, not a .txt with a URL in it ... failing on it would
 * report a defect against behaviour that was never promised."
 *
 * The live destination corroborates it independently. `Erik E-EmbeddedLinks.csv` on the migrated
 * Shared Drive carried 12 rows, every one of them a Paper document, and NOT ONE for this .html —
 * so CloudFuze never processed the document whose unrewritten href we were failing on.
 *
 * The file is still seeded and still read, because "HTML was not rewritten" is worth stating. It is
 * reported at INFO under EMBEDDED_CONTRAST, a name the feature checklist deliberately does not key
 * on, so it cannot reach a verdict again. Do not wire it back into one.
 */
const EMBEDDED_DOC_PATH = /(^|\/)09-embedded-links\/document-with-embedded-links\.html$/i;

/**
 * The one destination document feature 8.1 IS judged on: a real .docx with real hyperlinks.
 *
 * DropboxTestDataAgent._seedEmbeddedLinks builds it with `docx`, so each link is a
 * TargetMode="External" relationship in word/_rels/document.xml.rels — the thing a migration
 * actually rewrites, and a supported file type under scope 8.1. One link points at an IN-SCOPE
 * target inside the migrated tree, one at an OUT-OF-SCOPE target in a sibling QA-Out-Of-Scope
 * folder that is deliberately never migrated. Matched on the relativized source path, so it works
 * for both the My Drive and the Shared Drive pair.
 *
 * The seeder SKIPS this document when the in-scope shared link could not be created, rather than
 * embedding a placeholder URL: a fabricated target can never be rewritten, so 8.1 would fail on
 * every run regardless of what CloudFuze did. A skipped document reports as "not exercised" here,
 * which is the honest answer.
 */
const EMBEDDED_DOCX_PATH = /(^|\/)09-embedded-links\/embedded_link_doc\.docx$/i;

/** The check name the .html contrast observation carries. Never a verdict — see EMBEDDED_DOC_PATH. */
const EMBEDDED_CONTRAST = '8.1 Embedded Links — HTML contrast document (not judged)';

/** The check name every 8.1 VERDICT carries. The feature checklist keys on it, so it lives here. */
const EMBEDDED_VERDICT = '8.1 Embedded Links (in-document URLs)';

/** The check name the 8.1 SUPPORTING observations carry — never the verdict. */
const EMBEDDED_SUPPORTING = '8.1 Embedded Links — supporting observation';

/**
 * HTML entities that occur in a real href.
 *
 * `&amp;` is not cosmetic here: a Dropbox shared link carries `?rlkey=…&dl=0`, and an HTML document
 * stores that ampersand escaped. An un-decoded href prints into the report as `&amp;dl=0`, which
 * reads like a corrupted URL, and compares unequal against the URL the seeder recorded.
 */
const HTML_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', '#39': '\'', '#38': '&',
};

/** Decode the handful of entities that occur in hrefs. An unknown entity is left untouched. */
function decodeHtmlEntities(value) {
  return String(value == null ? '' : value).replace(/&(#?\w+);/g, (full, name) => {
    const hit = HTML_ENTITIES[String(name).toLowerCase()];
    return hit === undefined ? full : hit;
  });
}

/**
 * Anchors in an HTML document, as { href, text } pairs.
 *
 * Feature 8.1 is about the URLs INSIDE a migrated document, so the document has to be opened. This
 * is the HTML reader, and it now serves TWO callers: the .html contrast document (measured on the
 * live Shared Drive QA-Automation-Dropbox-Dest: `09-Embedded-Links/document-with-embedded-links
 * .html`, `text/html`, 520 bytes), and the judged `embedded_link_doc.docx` WHEN Google converted it
 * to a native Doc on import, in which case the caller exports it as text/html and the anchors come
 * out here. A .docx that arrived untouched is read by `readDocxAnchors` instead, which returns the
 * same shape from utils/docxLinks — so the verdict code below never has to know which happened.
 *
 * Returns a discriminated result rather than a bare array, because "could not be read" and "holds
 * no links" are DIFFERENT findings. Collapsing them is how 8.1 came to pass on a document nobody
 * had opened: the old check asserted only that CloudFuze's CSV existed beside it.
 *
 * @param {string|Buffer} html Raw document bytes or text.
 * @returns {{ok: boolean, anchors: Array<{href: string, text: string}>, stage: string|null,
 *   reason: string|null}}
 */
function extractHtmlAnchors(html) {
  const text = html == null ? '' : String(html);
  if (text.trim() === '') {
    return {
      ok: false,
      anchors: [],
      stage: 'parse',
      reason: 'the document downloaded as 0 bytes of text',
    };
  }
  if (!/<\s*(html|body|a|p|div)\b/i.test(text)) {
    return {
      ok: false,
      anchors: [],
      stage: 'parse',
      reason: `the ${text.length} downloaded byte(s) contain no HTML markup at all, so this is not `
        + 'the HTML document that was migrated',
    };
  }

  const anchors = [];
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  let match = anchorRe.exec(text);
  while (match !== null) {
    const hrefMatch = /\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s">]+))/i.exec(match[1]);
    const raw = hrefMatch ? [hrefMatch[2], hrefMatch[3], hrefMatch[4]].find((v) => v != null) : '';
    anchors.push({
      href: decodeHtmlEntities(String(raw || '').trim()),
      // Inner markup is stripped, not kept: Google's HTML export wraps anchor text in <span>, and
      // the label is what identifies WHICH seeded anchor this is.
      text: decodeHtmlEntities(String(match[2]).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim(),
    });
    match = anchorRe.exec(text);
  }
  return { ok: true, anchors, stage: null, reason: null };
}

/** A URL still pointing at the SOURCE system. */
const EMBEDDED_SOURCE_HOST = /(^|\/\/|\.)(dropbox\.com|dropboxusercontent\.com)/i;

/** A URL pointing at the Google DESTINATION. */
const EMBEDDED_DEST_HOST =
  /(^|\/\/|\.)((drive|docs|sheets|slides)\.google\.com|googleusercontent\.com|googleapis\.com)/i;

/**
 * Which seeded anchor each <a> is, and where it now points.
 *
 * Classified on the anchor's visible LABEL first and its href filename second; JUDGED only on the
 * href. The label has to be the classifier because it is the only clue that survives a successful
 * rewrite — a rewritten link becomes a Drive URL carrying a file id and no filename, so filename
 * matching alone could recognise a stale link and never a fixed one, and would read every correct
 * migration as unclassified.
 *
 * The VERDICT never reads the label. That is the mistake the Google→SharePoint document is seeded
 * to catch: it prints its original URL as body text, so matching on the body reports a failure on
 * every correct migration. Here the label is a plain word ("in-scope target"), never a URL.
 *
 * @param {Array<{href: string, text: string}>} anchors
 * @returns {{inScope: Array, outOfScope: Array, unclassified: Array}}
 */
function classifyEmbeddedAnchors(anchors) {
  const groups = { inScope: [], outOfScope: [], unclassified: [] };
  for (const anchor of anchors || []) {
    const href = String((anchor && anchor.href) || '').trim();
    if (href === '') continue;
    const label = String((anchor && anchor.text) || '');
    const haystack = `${label} ${href}`;
    const row = {
      href,
      label,
      state: EMBEDDED_SOURCE_HOST.test(href) ? 'source'
        : EMBEDDED_DEST_HOST.test(href) ? 'destination'
          : 'unrecognised',
    };
    // Out-of-scope FIRST: "out-of-scope" must never be read as an in-scope match.
    if (/out[-_ ]?of[-_ ]?scope/i.test(haystack)) groups.outOfScope.push(row);
    else if (/in[-_ ]?scope/i.test(haystack)) groups.inScope.push(row);
    else groups.unclassified.push(row);
  }
  return groups;
}

/**
 * The seeded .docx, read into the SAME { href, text } anchors the HTML path produces.
 *
 * `utils/docxLinks.extractDocxLinks` returns the hyperlink TARGETS out of
 * word/_rels/document.xml.rels, and nothing pairs each target with the visible label that sits in
 * word/document.xml — the relationship id is the only join, and the public helper does not expose
 * it. So the label is RECONSTRUCTED from the URL, and where that is not possible it is INFERRED,
 * with the inference reported rather than hidden:
 *
 *   - a Dropbox shared link spells its filename in the path, so a link still pointing at
 *     `link-target-out-of-scope.txt` or `link-target-in-scope.txt` names itself. Out-of-scope is
 *     tested FIRST: "out-of-scope" contains "scope", and reading it as the in-scope link would
 *     fail a link that scope 10.8 says is correct where it is.
 *   - a link that was REWRITTEN carries a Google file id and no filename, so nothing in it says
 *     which target it was. It is taken to be the in-scope one, and that is sound rather than
 *     convenient: the out-of-scope target sits in the sibling QA-Out-Of-Scope folder that is never
 *     migrated, so it has no destination copy for a rewrite to point at. Every link classified
 *     this way is returned in `inferred` so the report can say so out loud.
 *   - anything else is left unclassified, and `judgeEmbeddedLinksByHost` claims no verdict on it.
 *
 * Entities are decoded here because the rels part stores them escaped: a Dropbox shared link ends
 * `?rlkey=...&dl=0` and the XML holds `&amp;dl=0`. Measured, not assumed — an undecoded target
 * prints into a report looking like a corrupted URL and compares unequal against the CSV.
 *
 * @param {string[]} targets the `targets` array from `extractDocxLinks`
 * @returns {{anchors: Array<{href: string, text: string}>, inferred: string[]}}
 */
function docxAnchorsFromTargets(targets) {
  const anchors = [];
  const inferred = [];
  for (const raw of targets || []) {
    const href = decodeHtmlEntities(String(raw == null ? '' : raw)).trim();
    if (href === '') continue;
    if (/link-target-out-of-scope/i.test(href)) {
      anchors.push({ href, text: 'out-of-scope target' });
    } else if (/link-target-in-scope/i.test(href)) {
      anchors.push({ href, text: 'in-scope target' });
    } else if (EMBEDDED_DEST_HOST.test(href)) {
      anchors.push({ href, text: 'in-scope target' });
      inferred.push(href);
    } else {
      anchors.push({ href, text: '' });
    }
  }
  return { anchors, inferred };
}

/**
 * Hyperlinks inside a .docx buffer, in the shape `judgeEmbeddedLinks` consumes.
 *
 * Mirrors `extractHtmlAnchors`'s contract exactly, including the part that matters most: a
 * discriminated result, so "the archive could not be read" never reaches a report as "the document
 * holds no links". `extractDocxLinks` already refuses to collapse those two, and that distinction
 * is carried through here rather than flattened into an empty array.
 *
 * @param {Buffer} buf the downloaded destination bytes
 * @returns {{ok: boolean, anchors: Array, stage: string|null, reason: string|null,
 *   inferred: string[]}}
 */
function readDocxAnchors(buf) {
  const read = extractDocxLinks(buf);
  if (!read.ok) {
    return {
      ok: false,
      anchors: [],
      stage: 'parse',
      reason: `the downloaded bytes could not be read as a Word document (${read.reason
        || 'no reason was recorded'}), so the hyperlink relationships inside it were never seen`,
      inferred: [],
    };
  }
  const { anchors, inferred } = docxAnchorsFromTargets(read.targets);
  return { ok: true, anchors, stage: null, reason: null, inferred };
}

// ── 8.1: CloudFuze's own embedded-links CSV, read as an EXPECTED VALUE ────────────────
//
// The report is `<user>-EmbeddedLinks.csv` and the reference export the team works to carries
// nine columns:
//
//   Sl.No | Original File Name | Original File Path | Link File Name | Link Text Name
//         | Linked File Path | Source url | Destination url | Destination Path
//
// `Source url` AND `Destination url` sit on the same row. That makes the report an AUTHORITATIVE
// EXPECTED VALUE rather than a row count: for every embedded link CloudFuze records what the URL
// was and what it should have become. Comparing the migrated document against it turns
// "the href points at dropbox.com" into "CloudFuze recorded the destination URL in its own report
// and did not apply it to the document" — the same defect, stated as something a developer cannot
// argue with.
//
// The CSV makes the check STRONGER WHEN AVAILABLE. It is never allowed to become a dependency:
// when it is absent, unparseable, or holds no row for our document, the hostname judgement below
// still produces the verdict exactly as it did before. Two independent paths, and every report
// says which one decided.

/** The check name the CSV cross-check's NON-decisive observations carry. */
const EMBEDDED_CSV_CHECK = '8.1 Embedded Links CSV cross-check';

/**
 * Columns the embedded-links report must carry, from the reference export.
 *
 * Written in NORMALISED form (lower case, punctuation as spaces) because that is what a header is
 * compared in. `sl no` covers the index column, which is written variously as "No", "S.No" and
 * "Sl.No" across exports.
 */
const EMBEDDED_CSV_COLUMNS = [
  'sl no', 'original file name', 'original file path', 'link file name', 'link text name',
  'linked file path', 'source url', 'destination url', 'destination path',
];

/** The two columns without which no cross-check is possible at all. */
const EMBEDDED_CSV_URL_COLUMNS = ['source url', 'destination url'];

/**
 * A header cell, normalised.
 *
 * Deliberately the same rule as googledriveToSharepoint's `missingCsvColumns` — lower case,
 * anything not alphanumeric (or `/`) collapsed to a space — so the two combinations cannot end up
 * disagreeing about what a valid CloudFuze report looks like. Matching on the normalised name
 * rather than the exact string is what lets "Sl.No", "S.No" and "No" all be the index column.
 */
function normalizeCsvHeader(value) {
  return String(value == null ? '' : value).toLowerCase().replace(/[^a-z0-9/]+/g, ' ').trim();
}

/**
 * One CSV line, split into fields.
 *
 * A state machine rather than `line.split(',')`, because the columns that matter here are exactly
 * the ones that contain commas: `Linked File Path` carries folder names and a URL carries commas
 * in its query string. Splitting naively shifts every later column left by one, which would read a
 * path as a URL and compare it against an href — a guaranteed false FAIL.
 *
 * `""` inside a quoted field is an escaped quote, per RFC 4180.
 *
 * @param {string} line
 * @returns {string[]} the fields, each trimmed of surrounding whitespace
 */
function parseCsvRow(line) {
  const text = String(line == null ? '' : line);
  const fields = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (text[i + 1] === '"') { field += '"'; i += 1; }
      else quoted = false;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      fields.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  fields.push(field);
  return fields.map((f) => f.trim());
}

/**
 * Which required columns a parsed header is missing.
 *
 * Both-ways substring matching, again mirroring googledriveToSharepoint: "Sl.No" normalises to
 * `sl no`, and an export writing plain "No" must still count as the index column rather than
 * being reported as a missing one on a report that is perfectly correct.
 *
 * @param {string[]} header column names, normalised or not
 * @returns {string[]} empty when every required column is present
 */
function missingEmbeddedCsvColumns(header) {
  const present = (header || []).map(normalizeCsvHeader).filter(Boolean);
  return EMBEDDED_CSV_COLUMNS.filter((want) => !present.some(
    (got) => got === want || got.includes(want) || want.includes(got)
  ));
}

/**
 * The embedded-links CSV, as a header plus keyed rows.
 *
 * Rows are keyed by NORMALISED column name, so a caller asks for `source url` and never for a
 * column index. A row with fewer fields than the header is kept but marked `_truncated` rather
 * than dropped: `readTextLines` splits the file on newlines before this sees it, so a quoted field
 * containing a newline arrives cut in half, and reading its remaining columns as if they lined up
 * would compare a path against a URL. Better to say the row is malformed and claim nothing.
 *
 * @param {string[]|string|null} lines non-empty lines of the CSV, header first
 * @returns {{ok: boolean, reason: string|null, present: boolean, header: string[],
 *   rows: Array<object>, malformed: number, missingColumns: string[]}}
 */
function parseEmbeddedLinksCsv(lines) {
  const empty = {
    ok: false,
    reason: null,
    present: false,
    header: [],
    rows: [],
    malformed: 0,
    missingColumns: EMBEDDED_CSV_COLUMNS.slice(),
  };
  if (lines == null) {
    return { ...empty, reason: 'no embedded-links CSV was found at the destination' };
  }
  const clean = (Array.isArray(lines) ? lines : String(lines).split(/\r?\n/))
    .map((l) => String(l == null ? '' : l))
    .filter((l) => l.trim() !== '');
  if (clean.length === 0) {
    return {
      ...empty,
      present: true,
      reason: 'the embedded-links CSV is empty — it carries not even a header row',
    };
  }

  const header = parseCsvRow(clean[0]).map(normalizeCsvHeader);
  const named = header.filter(Boolean);
  if (named.length === 0) {
    return { ...empty, present: true, reason: 'the CSV first line holds no column names at all' };
  }

  let malformed = 0;
  const rows = [];
  for (const line of clean.slice(1)) {
    const fields = parseCsvRow(line);
    const truncated = fields.length < named.length;
    if (truncated) malformed += 1;
    const row = { _fieldCount: fields.length, _truncated: truncated };
    header.forEach((name, i) => {
      if (name) row[name] = fields[i] === undefined ? '' : fields[i];
    });
    rows.push(row);
  }

  return {
    ok: true,
    reason: null,
    present: true,
    header,
    rows,
    malformed,
    missingColumns: missingEmbeddedCsvColumns(header),
  };
}

/**
 * A URL reduced to the parts that decide whether two addresses are the SAME address.
 *
 * Scheme and host are lower-cased; the path is not, because a Drive URL carries a case-sensitive
 * file id and lower-casing it could only ever make two different addresses compare EQUAL — a false
 * PASS. `dl=0` / `dl=1` is dropped: it is Dropbox's download toggle, and a report recording `dl=0`
 * against an href carrying `dl=1` is not evidence of a missing rewrite. Everything else, `rlkey`
 * included, is compared as written — that token identifies the shared link.
 */
function normalizeEmbeddedUrl(url) {
  const raw = decodeHtmlEntities(String(url == null ? '' : url))
    .trim()
    .replace(/^["']+|["']+$/g, '');
  if (raw === '') return '';
  const cut = raw.indexOf('?');
  const query = cut === -1 ? '' : raw.slice(cut + 1);
  const base = (cut === -1 ? raw : raw.slice(0, cut))
    .replace(/\/+$/, '')
    .replace(/^(https?:\/\/)([^/]+)/i, (m, scheme, host) => scheme.toLowerCase() + host.toLowerCase());
  const params = query.split('&').filter((p) => p !== '' && !/^dl=[01]$/i.test(p));
  return params.length > 0 ? `${base}?${params.join('&')}` : base;
}

/**
 * Is this CSV row about the one document feature 8.1 is judged on?
 *
 * `Original File Path` first, matched with the same `EMBEDDED_DOCX_PATH` regex the source tree is
 * searched with, after folding Windows separators — CloudFuze's own path formatting is not
 * something this validator gets to assume. `Original File Name` is the fallback, and a safe one:
 * `embedded_link_doc.docx` is unique in the seeded tree.
 *
 * It looks for the .docx and not the .html on purpose. The .html is no longer judged, and the live
 * report is the reason the two had to be told apart: `Erik E-EmbeddedLinks.csv` held 12 rows and
 * not one named the .html, so a row-matcher looking for the .html could only ever conclude
 * "CloudFuze said nothing" — about a file type scope 8.1 never promised to rewrite.
 */
function csvRowNamesEmbeddedDoc(row) {
  const path = String((row && row['original file path']) || '').replace(/\\/g, '/');
  if (path !== '' && EMBEDDED_DOCX_PATH.test(path)) return true;
  const name = String((row && row['original file name']) || '').trim().toLowerCase();
  return name === 'embedded_link_doc.docx';
}

/**
 * The migrated document, cross-checked against what CloudFuze's own report says should be in it.
 *
 * PURE — every finding comes from the CSV rows plus the hrefs, so the whole judgement is assertable
 * from fixtures taken off the live destination.
 *
 * A row is DECISIVE only when it names two DIFFERENT URLs, because only then did CloudFuze intend a
 * rewrite:
 *
 *   - the href equals `Destination url` → the rewrite CloudFuze recorded was applied → PASS.
 *   - the href is still `Source url` while the row names a different `Destination url` → FAIL, and
 *     the wording is the entire reason for reading this CSV: CloudFuze recorded the destination URL
 *     in its own report and did not apply it to the document.
 *   - `Source url` equals `Destination url` → CloudFuze did not intend a rewrite, so there is
 *     nothing here to have failed → INFO. This is the OUT-OF-SCOPE case: that target sits in the
 *     sibling QA-Out-Of-Scope folder and was never migrated, so no destination URL exists to
 *     rewrite to and scope 10.8 does not ask for one. Failing it would be a false positive.
 *   - a row whose neither URL appears in the document → WARN: the link may have been dropped.
 *   - an href on no row at all → WARN naming it: CloudFuze's report did not cover it, so the CSV
 *     cannot speak for it either way.
 *
 * Missing columns are a WARN, never a FAIL. The format is CloudFuze's own, so a changed header is a
 * REPORTING problem rather than a migration defect, and reporting it as a defect would put a false
 * entry in a ticket.
 *
 * @param {object|null} csv the result of `parseEmbeddedLinksCsv`
 * @param {Array<{href: string, text: string}>} anchors the document's anchors
 * @param {{destPath?: string, csvName?: string}} [opts]
 * @returns {{decided: boolean, verdicts: Array, observations: Array, docRows: number}}
 */
function crossCheckEmbeddedLinksCsv(csv, anchors, opts = {}) {
  const destPath = opts.destPath || 'the destination document';
  const csvName = opts.csvName || 'the embedded-links CSV';
  const verdicts = [];
  const observations = [];
  const verdict = (status, suffix, detail) => verdicts.push({
    status,
    name: suffix ? `${EMBEDDED_VERDICT} — ${suffix}` : EMBEDDED_VERDICT,
    detail,
  });
  const note = (status, detail) => observations.push({ status, name: EMBEDDED_CSV_CHECK, detail });
  const done = (docRows) => ({ decided: verdicts.length > 0, verdicts, observations, docRows });

  if (!csv || !csv.ok) {
    const reason = (csv && csv.reason) || 'no embedded-links CSV was available';
    note('INFO',
      `8.1 was judged from the destination document's own hostnames: ${reason}. CloudFuze's report `
      + 'carries a Destination url per link and would have made the verdict stronger, but its '
      + 'absence cannot weaken one — the document itself was read either way.');
    return done(0);
  }

  if (csv.missingColumns.length > 0) {
    const blocking = csv.missingColumns.filter((c) => EMBEDDED_CSV_URL_COLUMNS.includes(c));
    const tail = blocking.length > 0
      ? ` Without ${blocking.join(' and ')} the report states no expected value for any link, so `
        + 'no row-by-row cross-check was possible and the verdict comes from the document\'s '
        + 'hostnames instead.'
      : ' The URL columns are present, so the row-by-row cross-check still ran.';
    note('WARN',
      `${csvName} is missing ${csv.missingColumns.length} of the ${EMBEDDED_CSV_COLUMNS.length} `
      + `columns the reference export carries: ${csv.missingColumns.join(', ')}. Reported as a WARN `
      + 'and not a FAIL because the format is CloudFuze\'s own — a changed header is a REPORTING '
      + 'problem, not a migration defect, and the migration itself is judged from the document.'
      + tail);
    if (blocking.length > 0) return done(0);
  }
  if (csv.malformed > 0) {
    note('WARN',
      `${csv.malformed} of ${csv.rows.length} row(s) in ${csvName} carry fewer fields than the `
      + 'header, so their columns cannot be lined up with confidence and nothing is claimed from '
      + 'them. A truncated row read as though it were complete would compare a path against a URL.');
  }

  const hrefs = (anchors || [])
    .map((a) => ({ href: String((a && a.href) || '').trim(), label: String((a && a.text) || '') }))
    .filter((a) => a.href !== '')
    .map((a) => ({ ...a, key: normalizeEmbeddedUrl(a.href) }));
  const quoteHrefs = (list, limit) => list.slice(0, limit).map((h) => h.href).join(' | ');
  const docRows = (csv.rows || []).filter((r) => csvRowNamesEmbeddedDoc(r) && !r._truncated);

  if (docRows.length === 0) {
    // A row that names the document but whose Destination url was not applied is a DIFFERENT
    // finding from no row at all, and the two must not read alike: the first says CloudFuze
    // processed the document and lost the rewrite, the second says CloudFuze never processed it.
    const tail = hrefs.length > 0
      ? `The document itself carries ${hrefs.length} link(s) — ${quoteHrefs(hrefs, 3)} — so `
        + 'CloudFuze did not process the one document that was seeded with embedded links, which '
        + 'is NOT the same as a row whose Destination url was recorded and then not applied. '
        + 'The verdict therefore comes from the document\'s hostnames and not from this report.'
      : 'The document carries no link either, so the two agree there was nothing to map.';
    note(hrefs.length > 0 ? 'WARN' : 'INFO',
      `${csvName} holds ${(csv.rows || []).length} row(s), none of which names the seeded document `
      + `09-Embedded-Links/embedded_link_doc.docx. ${tail}`);
    return done(0);
  }

  const seen = new Set();
  for (const row of docRows) {
    const sourceUrl = normalizeEmbeddedUrl(row['source url']);
    const destUrl = normalizeEmbeddedUrl(row['destination url']);
    const linkName = String(
      row['link file name'] || row['link text name'] || '(unnamed link)'
    ).trim() || '(unnamed link)';
    const atSource = hrefs.find((h) => h.key !== '' && h.key === sourceUrl);
    const atDest = hrefs.find((h) => h.key !== '' && h.key === destUrl);

    if (sourceUrl === '' && destUrl === '') {
      note('WARN',
        `${csvName} has a row for ${linkName} carrying neither a Source url nor a Destination url, `
        + 'so it states no expected value for that link and nothing is claimed from it.');
      continue;
    }
    if (sourceUrl === destUrl) {
      // The out-of-scope anchor lands here, and it must not fail: no rewrite was ever intended.
      if (atSource) seen.add(atSource.key);
      const held = atSource
        ? 'The document still carries exactly that address, which is what the report asks for.'
        : 'The document does not carry that address.';
      note('INFO',
        `8.1 / 10.8: ${csvName} records the SAME address as both Source url and Destination url `
        + `for ${linkName} (${row['source url']}), so CloudFuze did not intend a rewrite for it `
        + `and there is nothing here to have failed. ${held} Scope 10.8 limits the transformation `
        + 'to files "included in the migration scope", and a target that was deliberately never '
        + 'migrated has no destination URL to be rewritten to.');
      continue;
    }
    if (atDest) {
      seen.add(atDest.key);
      verdict('PASS', null,
        `${destPath} carries the very address CloudFuze recorded as the Destination url for `
        + `${linkName}: ${atDest.href}. Its own report named an expected value and the document `
        + `matches it, so the rewrite scope 8.1 promises was applied (Source url was `
        + `${row['source url']}). Verdict produced by the CSV cross-check, not by hostnames.`);
      continue;
    }
    if (atSource) {
      seen.add(atSource.key);
      verdict('FAIL', `${linkName} still carries the Source url`,
        'CloudFuze recorded the destination URL in its own report and did not apply it to the '
        + `document. ${csvName} maps ${linkName} from Source url ${row['source url']} to `
        + `Destination url ${row['destination url']}, and ${destPath} still links to `
        + `${atSource.href}. The expected value here is CloudFuze's own, taken from the report the `
        + 'migration wrote itself, so this is not a question of which hostname is acceptable: the '
        + 'rewrite the job recorded was never written into the document. Verdict produced by the '
        + 'CSV cross-check, not by hostnames.');
      continue;
    }
    note('WARN',
      `${csvName} maps ${linkName} from ${row['source url']} to ${row['destination url']}, but `
      + `${destPath} carries NEITHER address (it holds ${hrefs.length} link(s): `
      + `${quoteHrefs(hrefs, 3) || 'none'}). The link may have been dropped from the document `
      + 'entirely, or rewritten to a third address. Reported rather than scored — which of the two '
      + 'it is cannot be told from here.');
  }

  const unlisted = hrefs.filter((h) => !seen.has(h.key));
  if (unlisted.length > 0) {
    const quoted = unlisted.slice(0, 4)
      .map((h) => `${h.label || '(no label)'} → ${h.href}`)
      .join(' | ');
    note('WARN',
      `${unlisted.length} link(s) inside ${destPath} appear on no row of ${csvName}: ${quoted}. `
      + 'CloudFuze\'s report says nothing about them, so this cross-check claims nothing about them '
      + 'either — they are judged by the hostname path alone.');
  }

  return done(docRows.length);
}

/**
 * Feature 8.1 verdicts from the destination document's own HOSTNAMES — path 2 of 2.
 *
 * This is the ORIGINAL judgement and it is deliberately untouched. It needs nothing but the
 * document, so it always produces a verdict, which is what makes it the fallback when
 * CloudFuze's embedded-links CSV is absent, unparseable, or silent about this document.
 * `judgeEmbeddedLinks` below combines the two paths; call THAT, not this.
 *
 * The two seeded anchors mean different things and are judged differently:
 *
 *   - an IN-SCOPE link still pointing at dropbox.com is a FAIL. Its target migrated into the same
 *     destination folder and the job ran with embeddedLinks=true, so scope 8.1 requires the URL to
 *     have been transformed. Measured live on run fe2581f8's destination: it was not.
 *   - an OUT-OF-SCOPE link still pointing at dropbox.com is CORRECT and not a finding. Scope 10.8
 *     limits the transformation to files "included in the migration scope", and the out-of-scope
 *     document adds nothing that changes that. Failing it would be a false positive, so it is
 *     reported at INFO under a name the feature checklist deliberately does not key on.
 *   - a document that is missing, undownloadable or unreadable is a WARN naming WHICH, never a
 *     pass. "Could not be read" and "no links found" must not reach the report as the same thing.
 *
 * @param {{ok: boolean, anchors?: Array, stage?: string, reason?: string}} parsed
 * @param {{destPath?: string}} [opts]
 * @returns {Array<{status: string, name: string, detail: string}>}
 */
function judgeEmbeddedLinksByHost(parsed, opts = {}) {
  const destPath = opts.destPath || 'the destination document';
  const rows = [];
  const add = (status, suffix, detail) => rows.push({
    status,
    name: suffix ? `${EMBEDDED_VERDICT} — ${suffix}` : EMBEDDED_VERDICT,
    detail,
  });
  const support = (detail) => rows.push({ status: 'INFO', name: EMBEDDED_SUPPORTING, detail });

  if (!parsed || !parsed.ok) {
    const stage = (parsed && parsed.stage) || 'parse';
    const reason = (parsed && parsed.reason) || 'no reason was recorded';
    const suffix = stage === 'missing'
      ? 'document not found at the destination'
      : stage === 'download'
        ? 'document could not be downloaded'
        : 'document could not be read';
    add('WARN', suffix,
      `${reason}. Whether the URLs inside it were rewritten is therefore UNVERIFIED. This is not a `
      + 'pass — nothing about its links was observed — and it is not "the document holds no links" '
      + 'either, which would be a finding about a document that WAS read.');
    return rows;
  }

  const linked = (parsed.anchors || []).filter((a) => String((a && a.href) || '').trim() !== '');
  if (linked.length === 0) {
    add('FAIL', 'the links are gone',
      `${destPath} was read successfully and holds no hyperlink at all. The source document carries `
      + 'two anchors — one to an in-scope target, one to an out-of-scope target — so both were '
      + 'dropped in migration.');
    return rows;
  }

  const groups = classifyEmbeddedAnchors(linked);
  const quote = (list, limit = 3) => list.slice(0, limit).map((r) => r.href).join(' | ');
  const stale = groups.inScope.filter((r) => r.state === 'source');
  const rewritten = groups.inScope.filter((r) => r.state === 'destination');
  const unknown = groups.inScope.filter((r) => r.state === 'unrecognised');

  if (groups.inScope.length === 0) {
    add('WARN', 'the in-scope anchor was not found',
      `${destPath} holds ${linked.length} link(s), none of which is the in-scope anchor this `
      + `feature is about: ${quote(linked, 4)}. Reported rather than passed — the anchor whose `
      + 'target migrated is the only one 8.1 can be judged on.');
  } else if (stale.length > 0) {
    add('FAIL', `${stale.length} in-scope link(s) still point at Dropbox`,
      `${destPath} still links to ${quote(stale)}. Its target (link-target-in-scope.txt) DID `
      + 'migrate, into the same destination folder, and the job ran with embeddedLinks=true — so '
      + 'scope 8.1 requires the address to have been transformed into the destination format and '
      + '10.8\'s in-scope condition is met. It was not transformed: a reader at the destination is '
      + 'sent back to the source system.');
  } else if (rewritten.length > 0) {
    add('PASS', null,
      `${rewritten.length} in-scope link(s) inside ${destPath} were rewritten to the destination: `
      + `${quote(rewritten, 2)}`);
  } else {
    add('WARN', 'in-scope target unrecognised',
      `${destPath} holds ${unknown.length} in-scope link(s) pointing at neither Dropbox nor `
      + `Google: ${quote(unknown)}. Reported for a human to judge rather than scored either way.`);
  }

  const outStale = groups.outOfScope.filter((r) => r.state === 'source');
  const outMoved = groups.outOfScope.filter((r) => r.state !== 'source');
  if (outStale.length > 0) {
    support(
      `8.1 / 10.8: ${outStale.length} out-of-scope link(s) still point at Dropbox, and that is `
      + 'CORRECT, not a finding: the target sits in the sibling QA-Out-Of-Scope folder and was '
      + 'deliberately never migrated, so there is no destination URL to rewrite to. Scope 10.8 '
      + 'states the transformation applies "only if the referenced files are included in the '
      + 'migration scope", and the out-of-scope document records nothing that changes it. '
      + `Observed: ${quote(outStale, 2)}`);
  }
  if (outMoved.length > 0) {
    support(
      `8.1 / 10.8: ${outMoved.length} out-of-scope link(s) do NOT point at Dropbox: `
      + `${quote(outMoved, 2)}. Their target was never migrated, so no rewrite was expected and `
      + 'none is required — recorded for a human and deliberately not failed.');
  }
  if (groups.unclassified.length > 0) {
    support(
      `8.1: ${groups.unclassified.length} anchor(s) carry neither seeded label, so it cannot be `
      + `said whether their target was in scope: ${quote(groups.unclassified, 3)}. No verdict is `
      + 'claimed on them.');
  }
  return rows;
}

/**
 * Feature 8.1's verdict, from TWO independent paths — CloudFuze's report and the hostnames.
 *
 * `judgeEmbeddedLinksByHost` above is the original path and is unchanged: it needs nothing but the
 * document, so it always produces a verdict. The CSV path is stronger where it applies, because
 * `<user>-EmbeddedLinks.csv` carries a `Destination url` per link — CloudFuze's OWN expected value
 * — but it applies only when the report exists, parses, carries both URL columns, and holds a row
 * for this document.
 *
 * The rule for combining them is written to protect the failing case, since that is the one a
 * dependency would quietly destroy:
 *
 *   - the CSV path decides when it can, and its rows say so in their own text.
 *   - the hostname path then becomes corroboration, re-badged under a name the feature checklist
 *     does not key on, so one defect is not counted twice.
 *   - EXCEPT when the hostname path is MORE severe than the CSV verdict. Then it keeps the verdict
 *     name and the disagreement is stated. Otherwise a CSV recording `Destination url` as a
 *     dropbox.com address would produce a PASS that silently outranked a real FAIL.
 *   - when the CSV path cannot decide, the hostname rows pass through untouched — byte-for-byte
 *     the verdict this function produced before the CSV was read at all.
 *
 * `opts.csv` absent entirely means "no CSV context", which is exactly the old behaviour and no
 * extra rows. A run always passes one (`parseEmbeddedLinksCsv` handles the missing-file case), so
 * a real report always says which path decided.
 *
 * @param {{ok: boolean, anchors?: Array, stage?: string, reason?: string}} parsed
 * @param {{destPath?: string, csv?: object, csvName?: string}} [opts]
 * @returns {Array<{status: string, name: string, detail: string}>}
 */
function judgeEmbeddedLinks(parsed, opts = {}) {
  const hostRows = judgeEmbeddedLinksByHost(parsed, opts);
  if (opts.csv === undefined) return hostRows;

  // An unread document cannot be cross-checked against anything: there are no hrefs. The WARN the
  // hostname path already produced is the honest answer, and a CSV must not turn it into a pass.
  if (!parsed || !parsed.ok) {
    return [
      ...hostRows,
      {
        status: 'INFO',
        name: EMBEDDED_CSV_CHECK,
        detail: 'No cross-check against CloudFuze\'s embedded-links report was attempted: the '
          + 'destination document could not be read, so there are no hrefs to compare its '
          + 'Destination url column against. A report cannot stand in for the document.',
      },
    ];
  }

  const cross = crossCheckEmbeddedLinksCsv(opts.csv, parsed.anchors || [], opts);
  if (!cross.decided) return [...hostRows, ...cross.observations];

  const rank = (status) => (status === 'FAIL' ? 2 : status === 'WARN' ? 1 : 0);
  const csvWorst = cross.verdicts.reduce((acc, r) => Math.max(acc, rank(r.status)), 0);
  const corroboration = hostRows.map((row) => {
    if (!row.name.startsWith(EMBEDDED_VERDICT)) return row;
    if (rank(row.status) > csvWorst) {
      return {
        ...row,
        detail: `${row.detail} NOTE: the two independent 8.1 paths DISAGREE — CloudFuze's `
          + 'embedded-links report was cross-checked as well and did not reach this severity. The '
          + 'harsher reading is kept, because a report that records an acceptable destination URL '
          + 'cannot excuse what the document actually contains.',
      };
    }
    return {
      status: row.status === 'FAIL' ? 'INFO' : row.status,
      name: EMBEDDED_CSV_CHECK,
      detail: 'Corroboration only — the verdict above came from CloudFuze\'s embedded-links CSV, '
        + `which is the stronger evidence. Judged by hostname alone the same document reads `
        + `${row.status}: ${row.detail}`,
    };
  });
  return [...cross.verdicts, ...cross.observations, ...corroboration];
}

/**
 * Did the job ask for ALL versions?
 *
 * Mirrors migrationClient's own `opt()` exactly, including its default of TRUE: the job sends
 * `versioning=${opt('versionHistory')}`, so a run that names no option HAS requested all versions.
 * Defaulting to false here would silence the count comparison on every ordinary run.
 */
function allVersionsRequested(context) {
  const options = (context && context.contentOptions) || {};
  return options.versionHistory === undefined ? true : Boolean(options.versionHistory);
}

// ── 4.1 metadata: the CREATED half (scope §4) ─────────────────────────────────
//
// Feature 4.1 is "maintaining the original timestamps, including creation AND modification dates".
// Only the modified half was ever compared, on the stated grounds that "Dropbox exposes no creation
// time". That is true of files/get_metadata and false of Dropbox: files/list_revisions returns the
// full retained history newest-first, and its OLDEST entry's server_modified is the first upload
// recorded for the file — see dropboxClient.createdTimeFromRevisions, which also says when that
// value is only a lower bound.
//
// The verdict is judged against WHAT THE JOB REQUESTED, the same way 9.1/9.2 are: CloudFuze has a
// createdTimeForFiles flag, it defaults to false, and a created date that differs on a job which
// never asked for preservation is the expected outcome, not a defect. Failing it would invent one;
// passing it would claim a preservation that was never attempted. So that case is INFO.

/**
 * Did the job ask CloudFuze to preserve CREATED times?
 *
 * Mirrors migrationClient's own `opt('preserveCreatedTime', false)` — including the default of
 * FALSE, which is deliberate: the flag was hardcoded false for every content combination, so
 * defaulting to true here would fail runs for not doing something they never requested.
 */
function createdTimeRequested(context) {
  const options = (context && context.contentOptions) || {};
  return options.preserveCreatedTime === undefined ? false : Boolean(options.preserveCreatedTime);
}

/**
 * Did the job ask CloudFuze to preserve MODIFIED times?
 *
 * Mirrors `opt('preserveTimestamp')`, default TRUE, so ordinary runs are judged exactly as before.
 * Read only to avoid the mirror-image mistake on the modified half: a run that switched preservation
 * off must not be failed for the drift it asked for.
 */
function modifiedTimeRequested(context) {
  const options = (context && context.contentOptions) || {};
  return options.preserveTimestamp === undefined ? true : Boolean(options.preserveTimestamp);
}

/**
 * One file's created-date comparison. PURE — the revisions are already in hand.
 *
 * @param {object} srcItem   the Dropbox item (its `path` is only used for reporting)
 * @param {object} destItem  the paired Drive item, whose `createdAt` is Drive's createdTime
 * @param {Array}  srcRevs   the revision list already fetched for the 9.1 version count
 * @param {{driftMs?: number, revisionLimit?: number}} [opts]
 * @returns {{path, source, dest, comparable, drifted, truncated, revisionCount, reason}}
 */
function createdTimeRow(srcItem, destItem, srcRevs, opts = {}) {
  const driftMs = Number(opts.driftMs) > 0 ? Number(opts.driftMs) : 0;
  const derived = dropboxClient.createdTimeFromRevisions(srcRevs, { limit: opts.revisionLimit });
  const dest = (destItem && destItem.createdAt) || null;
  const base = {
    path: srcItem.path,
    source: derived.createdAt,
    dest,
    truncated: Boolean(derived.truncated),
    revisionCount: derived.revisionCount,
  };

  // `exact` false covers both "no revision came back" and "the list was truncated, so this is a
  // lower bound". Neither can support an equality verdict, and a lower bound quietly compared as
  // if it were the creation time is precisely how "could not determine" turns into "matches".
  if (!derived.exact || !derived.createdAt) {
    return { ...base, comparable: false, drifted: null, reason: derived.reason };
  }
  const s = Date.parse(derived.createdAt);
  const d = Date.parse(dest);
  if (!Number.isFinite(d)) {
    return {
      ...base,
      comparable: false,
      drifted: null,
      reason: 'the destination Drive item carried no createdTime, so there was nothing to compare '
        + 'the source creation time against',
    };
  }

  const offBy = Math.abs(s - d);
  return { ...base, comparable: true, drifted: offBy > driftMs, offByMs: offBy, reason: null };
}

/**
 * Feature 4.1, created half — the verdict from the measured rows.
 *
 * Four outcomes, and they are four because collapsing any two of them is what makes a report lie:
 *   PASS  preservation requested, every comparable created date inside the band
 *   FAIL  preservation requested and dates differ — names the files and BOTH timestamps
 *   INFO  preservation NOT requested (today's default): a difference is the expected outcome
 *   WARN  the source creation time could not be established, or only as a lower bound
 *
 * @param {Array} createdInfo  rows from createdTimeRow()
 * @param {{createdTimeRequested?: boolean, driftMs?: number}} [opts]
 * @returns {{status: string, detail: string}}
 */
function judgeCreatedTimestamps(createdInfo, opts = {}) {
  const rows = Array.isArray(createdInfo) ? createdInfo : [];
  const requested = opts.createdTimeRequested === true;
  const band = Number(opts.driftMs) > 0 ? `${Math.round(Number(opts.driftMs) / 1000)}s` : 'exact';
  const comparable = rows.filter((r) => r.comparable);
  const unknown = rows.filter((r) => !r.comparable);
  const truncated = unknown.filter((r) => r.truncated);
  const drifted = comparable.filter((r) => r.drifted);
  const matched = comparable.filter((r) => !r.drifted);
  const OPTION = 'contentOptions.preserveCreatedTime (job option createdTimeForFiles)';

  const show = (list, limit = 8) => list.slice(0, limit)
    .map((r) => `${core.lastSegment(r.path)} source ${r.source || '(unknown)'} → destination `
      + `${r.dest || '(none)'}`)
    .join(' | ');
  const unknownNote = () => {
    if (unknown.length === 0) return '';
    const why = truncated.length > 0
      ? ` ${truncated.length} of them hit the ${dropboxClient.REVISION_LIST_LIMIT}-revision listing `
        + 'maximum, so their oldest revision is only a LOWER BOUND on the creation time and cannot '
        + 'support an equality verdict.'
      : '';
    return ` ${unknown.length} further file(s) had no establishable source creation time and are `
      + `NOT counted either way (e.g. ${core.lastSegment((unknown[0] || {}).path)}: `
      + `${(unknown[0] || {}).reason}).${why}`;
  };

  if (rows.length === 0) {
    return {
      status: 'WARN',
      detail: 'No file produced revision data, so no Dropbox creation time could be derived for any '
        + 'of them and the created half of feature 4.1 was not assessed. Dropbox exposes creation '
        + 'time only through files/list_revisions; check the listRevisions warnings in the log.',
    };
  }

  if (!requested) {
    const differing = comparable.filter((r) => r.drifted).length;
    return {
      status: 'INFO',
      detail: 'Created-date preservation was NOT requested for this job, so a difference between '
        + 'the source and destination creation dates IS the expected outcome and nothing is judged '
        + `here — this is neither a pass nor a failure. Set ${OPTION} to true to exercise it. `
        + `Observed anyway on ${comparable.length} comparable file(s): ${differing} differ beyond `
        + `${band}, ${comparable.length - differing} happen to agree.${unknownNote()}`,
    };
  }

  if (comparable.length === 0) {
    return {
      status: 'WARN',
      detail: `Created-date preservation WAS requested (${OPTION} is true), but no source creation `
        + `time could be established on any of the ${rows.length} file(s) checked, so the comparison `
        + 'could not be made — this is "could not determine", NOT "matches".'
        + (truncated.length > 0
          ? ` ${truncated.length} file(s) hit the ${dropboxClient.REVISION_LIST_LIMIT}-revision `
            + 'listing maximum, which makes their oldest revision a lower bound rather than the '
            + 'creation time.'
          : '')
        + ` First reason: ${(rows[0] || {}).reason}`,
    };
  }

  if (drifted.length > 0) {
    return {
      status: 'FAIL',
      detail: `Created-date preservation was requested (${OPTION} is true), but ${drifted.length} `
        + `of ${comparable.length} comparable file(s) arrived with a different creation date `
        + `(tolerance ${band}): ${show(drifted)}.${unknownNote()}`,
    };
  }

  if (unknown.length > 0) {
    return {
      status: 'WARN',
      detail: `Created dates were preserved on all ${matched.length} file(s) whose source creation `
        + `time could be established (within ${band}), but ${unknown.length} of ${rows.length} `
        + 'could NOT be established, so this is a partial result rather than a clean pass.'
        + unknownNote(),
    };
  }

  return {
    status: 'PASS',
    detail: `Created dates preserved on all ${matched.length} file(s) (within ${band}). The job `
      + `requested it (${OPTION} is true) and every source creation time was derived from a `
      + 'COMPLETE Dropbox revision list, so the comparison is an equality claim: '
      + `${show(matched, 4)}`,
  };
}

/**
 * Feature 9.1 — the verdict from the measured revision counts.
 *
 * Scope 9.1 is "migration of all file versions from source to destination", and the document adds
 * that the expected count "is a job setting, not a constant". So when the job requested ALL
 * versions the counts ARE comparable, and equality is a strictly stronger statement than presence.
 *
 * Ordering matters: no history at all stays a FAIL even though it is also a shortfall, because
 * losing history entirely is a different defect from delivering fewer revisions.
 *
 * @param {Array<{path: string, sourceVersions: number, destVersions: number}>} versionInfo
 * @param {{allVersionsRequested?: boolean}} [opts]
 * @returns {{status: string, detail: string}}
 */
function judgeVersionHistory(versionInfo, opts = {}) {
  const rows = Array.isArray(versionInfo) ? versionInfo : [];
  const wantsAll = opts.allVersionsRequested !== false;
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const versioned = rows.filter((v) => num(v.sourceVersions) > 1);
  const list = (items, limit = 5) => items.slice(0, limit)
    .map((v) => `${core.lastSegment(v.path)} ${num(v.sourceVersions)}→${num(v.destVersions)}`)
    .join(', ');

  if (versioned.length === 0) {
    // "None had more than one source revision" is only true if the SOURCE read worked. A file with
    // history at the destination and one revision at the source is a failed Dropbox listRevisions
    // call, not a single-version file, and saying otherwise sends the reader to fix seeding.
    const destOnly = rows.filter((v) => num(v.destVersions) > 1);
    return {
      status: 'WARN',
      detail: `${rows.length} file(s) reported version data but none had more than one source `
        + 'revision, so there was no history to preserve. Seed multiple uploads of the same file to '
        + 'exercise this.'
        + (destOnly.length > 0
          ? ` NOTE: ${destOnly.length} of them DO have history at the destination `
            + `(${list(destOnly)}), which normally means the Dropbox revision read failed rather `
            + 'than that the source held one version — check the listRevisions warnings in the log.'
          : ''),
    };
  }

  const lostHistory = versioned.filter((v) => num(v.destVersions) <= 1);
  if (lostHistory.length > 0) {
    return {
      status: 'FAIL',
      detail: `${lostHistory.length} of ${versioned.length} versioned file(s) arrived with no `
        + `history at all: ${lostHistory.slice(0, 5)
          .map((v) => `${v.path} (${num(v.sourceVersions)}→${num(v.destVersions)})`).join(' | ')}`,
    };
  }

  if (!wantsAll) {
    return {
      status: 'PASS',
      detail: `${versioned.length} file(s) had multiple Dropbox revisions and all of them arrived `
        + 'with version history at the destination. Counts are NOT compared for this run: the job '
        + 'did not request all versions (contentOptions.versionHistory is false), so scope 9.2 '
        + 'makes the expected number a job setting and no N was recorded here. Observed: '
        + `${list(versioned, 4)}`,
    };
  }

  const fewer = versioned.filter((v) => num(v.destVersions) < num(v.sourceVersions));
  const more = versioned.filter((v) => num(v.destVersions) > num(v.sourceVersions));
  if (fewer.length === 0 && more.length === 0) {
    return {
      status: 'PASS',
      detail: `${versioned.length} file(s) had multiple Dropbox revisions, and every destination `
        + `count matched the source EXACTLY (${list(versioned, 4)}). The job requested ALL versions `
        + '(versioning=true), which is the case scope 9.1 describes — "migration of all file '
        + 'versions from source to destination" — so the counts are comparable, and they agree.',
    };
  }

  const parts = [];
  if (fewer.length > 0) {
    parts.push(`${fewer.length} arrived with FEWER versions than the source (${list(fewer, 10)})`);
  }
  if (more.length > 0) {
    parts.push(`${more.length} arrived with MORE versions than the source (${list(more, 10)})`);
  }
  return {
    status: 'WARN',
    detail: `History arrived on all ${versioned.length} versioned file(s), but the counts do not `
      + `match: ${parts.join('; ')}. The job requested ALL versions, and scope 9.1 asks for every `
      + 'source version, so this is a real observation — but it is surfaced for a human rather '
      + 'than failed, because revision merging has never been demonstrated on this pair and no '
      + 'version limitation is recorded in dropbox-to-google-outscope.md. If merging IS confirmed '
      + 'it belongs in that out-of-scope document; if it is not, this shortfall is a defect.',
  };
}

/** Filenames CloudFuze uses for the CSV reports it writes into the destination. */
const CSV_REPORT_PATTERNS = {
  '3.1': /shared[-_ ]?link/i,
  '8.1': /embedded[-_ ]?link/i,
  comments: /comment/i,
};

class DropboxToGoogledriveValidationAgent extends GoogleDriveValidationAgent {
  static supportsDeepValidation = true;

  constructor() {
    super('DropboxToGoogledriveValidationAgent');
  }

  async execute(context) {
    const COMBINATION = combinationFor(context);
    const bands = tolerance.forCombination(COMBINATION) || {};
    const rules = destinations.forDestination('googledrive');
    const roleMap = roleMaps.forCombination(COMBINATION);
    const globalChecks = [];
    const gPush = (status, name, detail) => globalChecks.push({ name, status, detail });

    if (!rules) {
      throw new Error(
        'validation/destinations/googledrive.js is not registered — the Google destination rules are '
        + 'required. Without them this validator would silently fall back to SharePoint\'s rules and '
        + 'report false renames and false path-limit relocations.'
      );
    }
    if (!roleMap) {
      throw new Error(
        `validation/roleMaps has no map covering "${COMBINATION}". Refusing to fall back to the `
        + 'SharePoint role table, which has no Dropbox roles in it and would mistranslate every grant.'
      );
    }

    if (!env.ENABLE_DEEP_CONTENT_VALIDATION) {
      gPush('WARN', 'Deep content validation',
        'Disabled by ENABLE_DEEP_CONTENT_VALIDATION=false — nothing was compared');
      return this._buildResult(globalChecks, [], { enabled: false }, context);
    }
    if (!dropboxClient.isConfigured()) {
      gPush('FAIL', 'Source items scanned',
        'Dropbox is not configured (DROPBOX_APP_KEY / DROPBOX_APP_SECRET / DROPBOX_REFRESH_TOKEN) — '
        + 'the source could not be read, so nothing was validated.');
      return this._buildResult(globalChecks, [], { enabled: true, scannedSourceItems: 0 }, context);
    }

    // ── CloudFuze's own report. Recorded, never trusted as the verdict.
    this._recordCloudFuzeStatus(context, gPush);

    const emailMap = core.buildEmailMap(context);
    const mapEmail = (e, opts) => {
      const key = String(e || '').toLowerCase();
      const hit = emailMap[key];
      if (opts && opts.detail) return { email: hit || key, mapped: Boolean(hit) };
      return hit || key;
    };
    const units = core.resolveUnits(context);
    logger.info(`[${COMBINATION} validation] validating ${units.length} user unit(s)`);

    // ── Destination root (the destination-side agent owns how Google is read).
    let destRoot;
    try {
      destRoot = await this.resolveDestinationRoot(context);
      gPush('PASS', 'Destination location', `${destRoot.label} resolved for ${context.destinationEmail}`);
    } catch (err) {
      gPush('FAIL', 'Destination location', err.message);
      return this._buildResult(globalChecks, [], { enabled: true, scannedSourceItems: 0 }, context);
    }

    const totals = this._emptyTotals(context);
    const perUser = [];

    for (const unit of units) {
      perUser.push(
        await this._validateUnit({ unit, context, destRoot, rules, roleMap, bands, mapEmail, totals })
      );
    }

    return this._buildResult(globalChecks, perUser, totals, context);
  }

  /** CloudFuze status, recorded as a check. A terminal status with no counts is not evidence. */
  _recordCloudFuzeStatus(context, gPush) {
    const report = context.contentMigrationReport || context.migrationJobDetails;
    const cfStatus = String(report?.status || report?.cfStatus || '').toUpperCase();
    const processed = Number(report?.processedCount) || 0;
    const total = Number(report?.totalCount) || 0;
    const hasCounts = report?.totalCount != null || report?.processedCount != null;

    if (CF_OK.includes(cfStatus) && !hasCounts) {
      gPush('WARN', 'CloudFuze migration status',
        `${cfStatus}, but CloudFuze reported no item counts — the destination comparison is the only evidence`);
    } else if (CF_OK.includes(cfStatus)) {
      gPush('PASS', 'CloudFuze migration status', `${cfStatus} — ${processed}/${total} items`);
    } else if (CF_CONFLICTS.includes(cfStatus)) {
      gPush('WARN', 'CloudFuze migration status', `${cfStatus} — ${processed}/${total} (conflicts present)`);
    } else if (!cfStatus) {
      gPush('WARN', 'CloudFuze migration status', 'Status unknown — proceeding with item-level checks');
    } else {
      gPush('FAIL', 'CloudFuze migration status', `${cfStatus} — expected PROCESSED`);
    }
  }

  /** The accumulator matching ValidationResult.deepContentValidation. */
  _emptyTotals(context) {
    return {
      enabled: true,
      combination: combinationFor(context),
      migrationType: context.migrationType || 'FULL',
      // Scope 9.2 makes the expected destination version count a JOB SETTING, so 9.1 can only
      // compare counts when the job asked for ALL versions. Captured once, here, so the
      // roll-up never has to guess.
      allVersionsRequested: allVersionsRequested(context),
      // Scope 4.1 covers creation AND modification dates, and CloudFuze has a separate flag for
      // each. Both are captured once, here, so the roll-up judges each half against what the job
      // actually asked for instead of against a constant.
      createdTimeRequested: createdTimeRequested(context),
      modifiedTimeRequested: modifiedTimeRequested(context),
      // The band both timestamp comparisons are judged against, recorded so the roll-up can print
      // the tolerance it actually used instead of a number the reader has to go and look up.
      timestampDriftMs:
        (tolerance.forCombination(combinationFor(context)) || {}).timestampDriftMs || 0,
      scannedSourceItems: 0,
      pairedCount: 0,
      skippedCount: 0,
      missing: [],
      extra: [],
      misplaced: [],
      placeholderLinks: [],
      notMigratable: [],
      notComparable: [],
      hashedCount: 0,
      notHashedCount: 0,
      hashMismatches: [],
      permissionMismatches: [],
      permissionObservations: [],
      // Items whose grants CloudFuze had not applied yet when validation ran. Initialised here so
      // the roll-up can compare it against permissionMismatches without an undefined check.
      // The PATHS of the items whose grants CloudFuze had not applied yet when validation ran —
      // not just how many. The per-feature roll-up has to know WHICH feature a pending item
      // belongs to, and a bare count could only ever be applied to all of them at once. Use
      // .length where a count is wanted; a separate counter alongside this went write-only the
      // moment the roll-up stopped reading it.
      permissionsPendingPaths: [],
      sharedLinkMismatches: [],
      linkObservations: [],
      conversionMismatches: [],
      timestampDrift: [],
      // One row per file for the CREATED half of 4.1, derived from the revision list that 9.1
      // already fetches. Rows where the source creation time could not be established are kept
      // with `comparable: false` rather than dropped — an unknown must reach the report as an
      // unknown, not vanish and leave the pass count looking complete.
      createdInfo: [],
      versionInfo: [],
      notificationLeaks: [],
      csvReports: [],
      // What the migrated embedded-link document actually contained — the evidence behind the
      // 8.1 verdict, kept so the report can show the hrefs rather than only the verdict.
      embeddedLinkDoc: null,
      paperItems: [],
      specialChars: { total: 0, arrived: 0 },
      longPathEvidence: [],
      featureChecklist: [],
      featureSummary: null,
      itemResults: [],
      summary: '',
    };
  }

  /** Validate one source→destination unit. */
  async _validateUnit({ unit, context, destRoot, rules, roleMap, bands, mapEmail, totals }) {
    const combination = combinationFor(context);
    const checks = [];
    const push = (status, name, detail) => checks.push({ name, status, detail });
    const sourceEmail = unit.sourceEmail || context.sourceEmail;
    const destEmail = unit.destinationEmail || context.destinationEmail;
    const sourcePath = dropboxClient.dbxPath(unit.sourcePath || context.sourcePath || env.DROPBOX_TEST_ROOT);

    // ── Source: the Dropbox tree.
    const asMemberId = await dropboxClient.resolveTeamMemberId(sourceEmail).catch(() => null);
    if (!asMemberId) {
      push('WARN', 'Source account context',
        `${sourceEmail} did not resolve to a Dropbox team member — reading the token's own Dropbox. `
        + 'On a Business team that is probably the admin account, not the intended source.');
    }
    const dbxOpts = { asMemberId };

    let sourceTree = [];
    try {
      sourceTree = await dropboxClient.buildFolderTree(sourcePath, {
        ...dbxOpts,
        maxDepth: bands.treeDepth || 25,
      });
      // Relativize against the root's DISPLAY path, not the path we asked for.
      //
      // Dropbox is case-insensitive on lookup but returns `path_display` in the tree, so asking for
      // "/qa-automation" (which is what the seeding agent reports, deliberately lower-cased) yields
      // items at "/QA-Automation/…". core.relativize strips a case-SENSITIVE prefix, so it stripped
      // nothing: every source path kept its "/QA-Automation" prefix while the destination tree was
      // relative to the migrated root, and the comparison read
      //   source 67, dest 68, matched 0, missing 0, extra 1, misplaced 67
      // on a migration where all 67 items had in fact arrived. Everything keyed on item paths went
      // with it — permissions reported "no comparable source permissions" against grants that were
      // demonstrably present, and the long-path check reported "0 encoded chars".
      //
      // Fixed here rather than in core.relativize: that helper is shared by every content
      // combination, and a case-insensitive strip there would change Box→SharePoint and
      // Drive→SharePoint behaviour too. Dropbox is the only source whose reported path case can
      // differ from its tree.
      const rootMeta = await dropboxClient.getMetadata(sourcePath, dbxOpts).catch(() => null);
      const rootPath = (rootMeta && rootMeta.path) || sourcePath;
      if (rootPath !== sourcePath) {
        logger.info(`[${combination} validation] source root "${sourcePath}" has display `
          + `path "${rootPath}" — relativizing against the display form`);
      }
      // Keep each item's ABSOLUTE Dropbox path before relativizing.
      //
      // Relativizing rewrites `path` to "/01-Root-Folder-Permissions", which is what the tree
      // comparison needs — but the per-item source lookups (listItemMembers, listSharedLinks) hand
      // that same string back to Dropbox, where it does not exist. Both calls end `.catch(() => [])`,
      // so the failure surfaced as "No comparable source permissions were found" and "No source
      // shared links were found" against a source that demonstrably had 9 grants and 2 links.
      //
      // relativize spreads the item (`{ ...i, path }`), so this field survives it.
      for (const item of sourceTree) item.dbxPath = item.path;
      sourceTree = core.relativize(sourceTree, rootPath);
    } catch (err) {
      push('FAIL', 'Source items scanned', `Could not read Dropbox ${sourcePath}: ${err.message}`);
      return { sourceEmail, destinationPath: unit.destinationPath, checks, itemDetails: [] };
    }

    if (sourceTree.length === 0) {
      push('FAIL', 'Source items scanned',
        `No source items were read from Dropbox ${sourcePath}. Check the path and the app's scopes.`);
      return { sourceEmail, destinationPath: unit.destinationPath, checks, itemDetails: [] };
    }
    totals.scannedSourceItems += sourceTree.length;
    push('PASS', 'Source items scanned', `${sourceTree.length} item(s) read from Dropbox ${sourcePath}`);

    // ── Destination: where it landed, and its tree.
    const sourceFolderName = core.lastSegment(sourcePath);
    const migrated = await this.findMigratedRoot(
      destRoot.rootId, destRoot.driveId, unit.destinationPath, sourceFolderName, destEmail
    );
    if (!migrated) {
      push('FAIL', 'Destination location',
        `Nothing named "${sourceFolderName}" (or a dedup variant) exists under ${destRoot.label} — `
        + 'the migration appears to have created nothing.');
      return { sourceEmail, destinationPath: unit.destinationPath, checks, itemDetails: [] };
    }
    push('PASS', 'Destination location', `Migrated content found at ${migrated.path} in ${destRoot.label}`);

    const destTree = await this.readTree(migrated.id, destEmail, {
      driveId: destRoot.driveId,
      maxDepth: bands.treeDepth || 25,
    });

    // ── Feature 1.1 + 7.1: structure, with GOOGLE's rules.
    const cmp = core.compareTrees(sourceTree, destTree, {
      rules,
      pathLimit: bands.pathLengthLimit ?? rules.pathLengthLimit,
      segmentLimit: bands.segmentLengthLimit ?? rules.segmentLengthLimit,
    });

    totals.pairedCount += cmp.matchedCount;
    totals.missing.push(...cmp.missing.map((i) => ({ path: i.path, type: i.type, name: i.name })));
    // CloudFuze's own CSV reports are filtered out below before the 1.1 verdict; keep them out of
    // the run totals too, or the failure index and the check detail disagree about the same run.
    totals.extra.push(...cmp.extra
      .filter((i) => !(/\.csv$/i.test(String(i.name || i.path || ''))
        && Object.values(CSV_REPORT_PATTERNS).some((re) => re.test(String(i.name || i.path || '')))))
      .map((i) => ({ path: i.path, type: i.type, name: i.name })));
    totals.misplaced.push(...(cmp.misplaced || []));
    totals.placeholderLinks.push(...(cmp.placeholderLinks || []));
    totals.notMigratable.push(...(cmp.notMigratable || []));

    // CloudFuze's own CSV reports are not "extra" content.
    //
    // The migration writes its Shared Links and Embedded Links CSVs into the destination root.
    // Features 3.1 and 8.1 read those files as PROOF the feature worked — 8.1 passes on
    // "Erik E-EmbeddedLinks.csv present" — while the structure comparison counted the very same
    // files as unexpected items and failed 1.1 on them. A run where all 67 items arrived
    // correctly read "extra 2 … FAIL", and 1.2 inherited it. One report cannot call the same file
    // evidence of success and evidence of failure.
    //
    // Matched by the same patterns the CSV check uses, so the two can never disagree about what
    // counts as a CloudFuze report. Anything else extra at the destination is still a finding.
    const isCloudFuzeReport = (name) => {
      const n = String(name || '');
      if (!/\.csv$/i.test(n)) return false;
      return Object.values(CSV_REPORT_PATTERNS).some((re) => re.test(n));
    };
    const unexpectedExtra = (cmp.extra || []).filter((i) => !isCloudFuzeReport(i.name || i.path));
    const reportExtras = (cmp.extra || []).length - unexpectedExtra.length;

    const structureDetail =
      `source ${cmp.totalSource}, dest ${cmp.totalDest}, matched ${cmp.matchedCount}, `
      + `missing ${cmp.missing.length}, extra ${unexpectedExtra.length}, `
      + `misplaced ${(cmp.misplaced || []).length}`
      + (reportExtras > 0 ? ` (+${reportExtras} CloudFuze CSV report(s), not counted)` : '');

    // Re-derive the verdict from what is actually wrong, rather than reusing cmp.status, which
    // was computed before the reports were excluded.
    const structureOk = cmp.missing.length === 0
      && unexpectedExtra.length === 0
      && (cmp.misplaced || []).length === 0;
    push(structureOk ? 'PASS' : 'FAIL', '1.1 Data Migration (structure)', structureDetail);

    // ── Per-item Tier C: permissions, links, timestamps, versions; Tier B hashes.
    const itemDetails = [];
    const paired = [...cmp.matched.entries()];

    // `cmp.matched` maps source path → { source, dest }, NOT → the destination item.
    //
    // This loop read the value as the destination item itself, so `destItem.id` and `destItem.name`
    // were undefined for every pair. Once the relativize fix made items actually pair, that turned
    // into "67 of 67 paired item(s) carried no destination id" and every per-item check — Tier B
    // hashes, permissions, versions, timestamps — was skipped on content that had migrated fine.
    // Before the relativize fix nothing paired, so the mistake was unreachable and invisible.
    //
    // deepContentCore.js:452 sets the shape, and the sibling combination reads it correctly as
    // `for (const { source, dest } of cmp.matched.values())` — matched here rather than changing the
    // shared helper.
    for (const [srcPath, pair] of paired) {
      const destItem = pair && pair.dest;
      const srcItem = (pair && pair.source) || sourceTree.find((s) => s.path === srcPath);
      if (!srcItem || !destItem) continue;
      const row = await this._validateItem({
        srcItem, destItem, destEmail, dbxOpts, roleMap, bands, mapEmail, totals, combination,
      });
      itemDetails.push(row);
    }

    // Items that could not be inspected are reported, not dropped. Without this the run would show
    // a clean per-item table whose rows were never actually examined — the same vacuous pass the
    // "Match" cards used to give on zero comparisons.
    if (totals.uninspectable) {
      push('WARN', 'Items inspected',
        `${totals.uninspectable} of ${paired.length} paired item(s) carried no destination id, so `
        + 'their permissions, versions and content hashes were NOT checked. They are present at the '
        + 'destination but unverified — do not read them as passing.');
    }

    this._rollUpItemChecks(push, totals, itemDetails);
    this._checkSpecialCharacters(push, sourceTree, cmp, rules, totals);
    this._checkLongPaths(push, sourceTree, cmp, rules, totals);
    // The 8.1 CSV is read once, here, and handed to the document check below: CloudFuze's
    // embedded-links report carries a Destination url per link, which is an expected value the
    // migrated document can be compared against. Passed explicitly rather than stashed on `this`,
    // because a validator instance is reused across units and a leftover CSV would be cross-checked
    // against the wrong user's document.
    const csvReports = await this._checkCsvReports(push, migrated, destEmail, destRoot, totals);
    await this._checkEmbeddedLinks(push, sourceTree, cmp, destEmail, totals,
      (csvReports || {})['8.1']);
    this._checkPaper(push, sourceTree, cmp, totals);
    this._checkNotificationSuppression(push, totals);

    // The per-user shape the report renderers actually read.
    //
    // pdfGenerator draws "Per-item validation" from `u.items` and "Folder structure validation"
    // from `u.folderStructure`, and ResultsView.jsx reads those same two fields for its Source
    // Items / Found / Folders Compared cards. This unit returned `itemDetails` and no
    // folderStructure, so BOTH report surfaces silently dropped everything: the PDF had no
    // per-item section and no tree diagram, and the UI showed 0 / 0 / 0 / 0 beside a run that had
    // verified 67 items. The sibling combination supplies all of these (see its finishUnit), which
    // is the whole reason its report reads end-to-end and this one looked empty.
    //
    // `mapping` and `status` are the same story in miniature: without them the PDF header printed
    // "User 1 undefined ·" with "—" for both locations.
    const folderStructure = core.compareFolders(sourceTree, destTree, {
      rules,
      pathLimit: bands.pathLengthLimit ?? rules.pathLengthLimit,
      segmentLimit: bands.segmentLengthLimit ?? rules.segmentLengthLimit,
      sourceRootName: core.lastSegment(sourcePath) || '(root)',
      destRootName: migrated.name || '(root)',
      sourceLabel: 'Dropbox',
      destLabel: destRoot.driveId ? 'Google Shared Drive' : 'Google My Drive',
    });

    const passed = checks.filter((c) => c.status === 'PASS').length;
    const failed = checks.filter((c) => c.status === 'FAIL').length;

    return {
      sourceEmail,
      destinationEmail: destEmail,
      sourcePath,
      destinationPath: unit.destinationPath,
      sourceDriveName: null,
      mapping: {
        sourceEmail,
        sourceLocation: sourcePath,
        destEmail,
        destLocation: `${unit.destinationPath || '/'}`
          + (migrated.path && migrated.path !== '/' ? ` → ${migrated.path}` : ''),
      },
      status: failed > 0 ? 'FAIL' : 'PASS',
      summary: `${passed}/${checks.length} checks passed`,
      checks,
      folderStructure,
      // Both names: `items` is what the PDF and the UI read, `itemDetails` is what this file's own
      // roll-up helpers already consume. Keeping one and renaming the other would break whichever
      // reader was not updated.
      items: itemDetails,
      itemDetails,
    };
  }

  /** Tier C + Tier B for one paired item. */
  async _validateItem({ srcItem, destItem, destEmail, dbxOpts, roleMap, bands, mapEmail, totals, combination }) {
    const row = {
      path: srcItem.path,
      name: srcItem.name,
      type: srcItem.type,
      found: true,
      destName: destItem.name,
      isPaper: Boolean(srcItem.isPaper),
    };

    // A paired destination item with no id cannot be inspected, and asking anyway is expensive and
    // silent-by-default: every Drive call rejects with "Missing required parameters: fileId", which
    // retry.js treats as retryable and re-attempts four times with 1+2+4+8s backoff. Two such calls
    // per item is ~30s of guaranteed-doomed waiting each, on an error that can never succeed on a
    // retry. This only became reachable once the relativize fix made items pair at all, so it was
    // latent rather than new.
    //
    // Counted and surfaced, never swallowed: an item we could not inspect is not an item that
    // passed, and this validator's whole purpose is refusing to report unexamined data as good.
    if (!destItem.id) {
      row.inspectionSkipped = 'destination item carries no id, so it could not be inspected';
      totals.uninspectable = (totals.uninspectable || 0) + 1;
      logger.warn(`[${combination} validation] "${srcItem.path}" paired with a destination `
        + 'item that has no id — skipping its permission, version and hash checks rather than '
        + 'issuing calls that cannot succeed');
      return row;
    }

    // Paper is converted to a Google Doc: its bytes, size, timestamps and version history are all
    // products of the conversion, so none of them can be compared. Recorded and skipped.
    if (srcItem.isPaper) {
      // Compare the CONTENT, which nothing did before this.
      //
      // The report used to say all 18 of features 10.2-10.19 "require the document to be opened"
      // and must be checked by hand. That was never true of the structure: dropboxClient.exportPaper
      // and driveClient.exportNativeFile both already existed — exportPaper's own comment says it is
      // "needed for any content comparison of scope §10" — and neither was ever called. So every
      // Paper feature sat at N/A on every run while the means to answer several of them went unused.
      const content = await this._comparePaperContent(srcItem, destItem, destEmail, dbxOpts);
      totals.paperItems.push({
        path: srcItem.path, destPath: destItem.path, destName: destItem.name, content,
      });
      row.note = 'Dropbox Paper — converted to a Google Doc; bytes, size, timestamps and version '
        + 'history are conversion products and are not comparable (scope 10.1, 10.19)';
      return row;
    }

    // ── 2.x permissions and 3.x links.
    //
    // `dbxPath` is the item's absolute Dropbox path, stamped before the tree was relativized.
    // Passing the relativized `path` here looked up a path that does not exist, and the swallowing
    // catch turned that into "no source permissions" rather than an error.
    const srcRef = { ...srcItem, path: srcItem.dbxPath || srcItem.path };
    let destPerms;
    let srcMembers;
    [srcMembers, destPerms] = await Promise.all([
      dropboxClient.listItemMembers(srcRef, dbxOpts).catch((err) => {
        // Logged, not silent: an unreadable source is not the same as an unshared one, and
        // treating it as "none" is how a permission gap becomes an invisible pass.
        logger.warn(`[${combination} validation] could not read source members for `
          + `"${srcRef.path}": ${err.message}`);
        return [];
      }),
      this.readPermissions(destItem.id, destEmail),
    ]);

    // Wait for CloudFuze to finish applying permissions before calling a grant missing.
    //
    // CloudFuze copies the items first and applies sharing AFTER, so a validator that starts the
    // moment the job reports PROCESSED races that phase. Measured on run dbx-gsd-1788417784387:
    // 01-Root-Folder-Permissions and its four descendants all reported destRoles=[] and "5 of 6
    // grant(s) differ", while a direct read ~25 minutes later showed every grant present and
    // correct (ben:fileorganizer, qa_automation:reader, plus the inherited copies on the
    // children). The item at the root, 02-root-file-viewer.txt, matched in the same run because
    // its grant had already landed — which is why this failure came and went between runs and
    // looked like a real defect twice.
    //
    // Retry only in the one situation that is suspicious: the SOURCE has comparable grants and
    // the destination reports none at all. A destination with some grants, or a source with none,
    // is answered immediately, so the happy path is not slowed.
    // NOTE ON ORDER: the settle-retry sits AFTER sourcePerms is built, because it needs to know
    // whether the source had any comparable grants at all. Placing it above the declaration threw
    // a temporal-dead-zone ReferenceError at run time that `node --check` cannot see.
    const sourcePerms = srcMembers
      .filter((m) => roleMap.isComparableDriveRole(m.role))
      .map((m) => ({
        email: m.email,
        role: m.role,
        type: m.type,
        displayName: m.displayName,
      }));

    // Has CloudFuze applied the item-level grants yet?
    //
    // The first version of this asked "does the destination have ZERO grants" — and never fired,
    // because a Shared Drive item ALWAYS carries the drive's own grant by inheritance
    // (erik:organizer, inherited: true). So the list was never empty even when none of the expected
    // grants had arrived.
    //
    // The right question is whether any DIRECT (non-inherited) grant exists. CloudFuze re-grants
    // per item, so a migrated item that has been processed carries at least one direct grant; one
    // that has not carries only inherited ones.
    const directGrants = (perms) => (perms.permissions || []).filter((x) => !x.inherited);

    if (sourcePerms.length > 0 && directGrants(destPerms).length === 0) {
      for (let attempt = 1; attempt <= PERMISSION_SETTLE_ATTEMPTS; attempt += 1) {
        await new Promise((r) => setTimeout(r, PERMISSION_SETTLE_MS));
        const retry = await this.readPermissions(destItem.id, destEmail);
        if (directGrants(retry).length > 0) {
          logger.info(`[${combination} validation] "${srcItem.path}" had no direct `
            + `destination grants on the first read; ${directGrants(retry).length} appeared after `
            + `${attempt * (PERMISSION_SETTLE_MS / 1000)}s — CloudFuze was still applying sharing`);
          destPerms = retry;
          break;
        }
      }
    }

    // Still nothing item-specific: the sharing phase has not run for this item YET.
    //
    // Measured across three runs: the grants appear tens of MINUTES after the job reports
    // PROCESSED, not seconds. Run dbx-gsd-1788417784387 reported "5 of 6 grant(s) differ" and a
    // direct read ~25 minutes later showed every grant present and correct; run
    // dbx-gsd-1788421910278 failed the same way and a read 5 minutes later still showed only the
    // inherited drive grant. No inline wait can cover that.
    //
    // So this is marked NOT YET JUDGEABLE rather than failed. A validator that reports a defect
    // because it measured too early is worse than one that says "I could not tell yet": it filed
    // four Neutara tickets (QT-63, QT-67, CF-30684, CF-30695) against permissions that were
    // correct. The roll-up turns this into a WARN naming the re-validation step.
    if (sourcePerms.length > 0 && directGrants(destPerms).length === 0) {
      row.permissionsNotYetApplied = true;
      totals.permissionsPendingPaths.push(srcItem.path);
      logger.warn(`[${combination} validation] "${srcItem.path}" still carries only `
        + `inherited drive grants after ${PERMISSION_SETTLE_ATTEMPTS * (PERMISSION_SETTLE_MS / 1000)}s `
        + '— CloudFuze has not applied item sharing yet. Reported as pending, NOT as a difference.');
    }

    for (const m of srcMembers.filter((x) => !roleMap.isComparableDriveRole(x.role))) {
      totals.notComparable.push({
        path: srcItem.path,
        principal: m.email || m.displayName,
        role: m.role,
        reason: roleMap.nonComparableReason(m.role),
      });
    }

    if (sourcePerms.length > 0) {
      // Pass the DROPBOX role map. deepContentCore otherwise falls back to the Box/Drive to
      // SharePoint tables, which classify Dropbox's 'editor' and 'viewer' as not-comparable and
      // skip every grant — which is exactly what produced "No comparable source permissions were
      // found" on a tree with 9 of them.
      const permCmp = core.comparePermissions(sourcePerms, destPerms.permissions, mapEmail,
        { roleMap });

      // `row.permissions` must be the per-grant ARRAY the report renders, not the comparison
      // object.
      //
      // pdfGenerator does `for (const p of (it.permissions || []))`, so handing it the
      // comparePermissions result — { checked, matches, mismatches, … } — threw
      //   "object is not iterable (cannot read property Symbol(Symbol.iterator))"
      // and the whole PDF endpoint answered HTTP 500 ("Failed to download PDF"). It only
      // surfaced once `items` started being rendered at all; before that this section was
      // skipped and the bad shape sat there unnoticed.
      //
      // Field names match what the renderer reads: user, mappedTo, principalType, sourceRole,
      // destRoles, viaGroup, match. The comparison object is kept under its own key for the
      // roll-up helpers.
      row.permissionComparison = permCmp;
      row.permissions = [
        ...(permCmp.matches || []).map((m) => ({ ...m, match: true })),
        ...(permCmp.mismatches || []).map((m) => ({ ...m, match: false })),
        ...(permCmp.escalations || []).map((m) => ({ ...m, match: false })),
        ...(permCmp.viaGroup || []).map((m) => ({ ...m, match: true, viaGroup: true })),
      ];
      row.sourceLabel = 'Dropbox';
      // Feature 2.5 asks about a grant to someone OUTSIDE the team, which is a question about the
      // PRINCIPAL rather than the item's position — so it is counted here, where the per-grant rows
      // are still in scope, instead of being re-derived from the roll-up.
      const extAddr = String(env.DROPBOX_TEST_EXTERNAL_USER || '').trim().toLowerCase();
      const isExtRow = (r) => Boolean(extAddr) && String(r.user || '').toLowerCase() === extAddr;

      totals.permissionObservations.push({
        path: srcItem.path,
        type: srcItem.type,
        checked: permCmp.checked,
        externalChecked: (permCmp.matches || []).filter(isExtRow).length
          + (permCmp.mismatches || []).filter(isExtRow).length,
        externalFailed: (permCmp.mismatches || []).filter(isExtRow).length,
        matches: permCmp.matches.length,
        mismatches: permCmp.mismatches.length,
        escalations: permCmp.escalations.length,
        viaGroup: permCmp.viaGroup.length,
      });
      for (const m of permCmp.mismatches) {
        totals.permissionMismatches.push({ path: srcItem.path, ...m });
      }
      // A privilege escalation is a finding in its own right, never a pass.
      for (const e of permCmp.escalations) {
        totals.permissionMismatches.push({
          path: srcItem.path, ...e, escalation: true,
        });
      }
    }

    // ── 3.1 / 3.2 shared links.
    const srcLinks = await dropboxClient.listSharedLinks(srcRef.path, dbxOpts).catch((err) => {
      logger.warn(`[${combination} validation] could not read source links for `
        + `"${srcRef.path}": ${err.message}`);
      return [];
    });
    if (srcLinks.length > 0) {
      for (const link of srcLinks) {
        const linkCmp = roleMap.compareSharedLink(link, destPerms.links);
        totals.linkObservations.push({
          path: srcItem.path,
          type: srcItem.type,
          sourceAudience: link.type,
          sourceRole: link.role,
          expectedScope: linkCmp.expectedScope,
          expectedType: linkCmp.expectedType,
          match: linkCmp.match,
          actual: linkCmp.actual,
        });
        if (!linkCmp.match) {
          totals.sharedLinkMismatches.push({
            path: srcItem.path,
            expected: `${linkCmp.expectedScope}/${linkCmp.expectedType}`,
            actual: linkCmp.actual.join(', ') || '(no link permission at the destination)',
          });
        }
      }
      // Per-link ARRAY, not a counts object.
      //
      // pdfGenerator does `for (const l of (it.sharedLinks || []))` and reads sourceType /
      // sourceRole / actual / match off each entry. A { source, dest } summary is not iterable, so
      // it threw the same "object is not iterable" that the permissions field did and took the
      // whole PDF down with a 500. Counts kept alongside for the roll-up.
      row.sharedLinkCounts = { source: srcLinks.length, dest: destPerms.links.length };
      row.sharedLinks = srcLinks.map((link) => {
        const cmp = roleMap.compareSharedLink(link, destPerms.links);
        return {
          sourceType: link.type,
          sourceRole: link.role,
          actual: (cmp.actual || []).join(", ") || "(none)",
          match: cmp.match,
        };
      });
    }

    if (srcItem.type === 'folder') return row;

    // ── 4.1 metadata, the MODIFIED half.
    //
    // Created is deliberately passed as null on BOTH sides here, and judged separately below. Two
    // reasons: the source creation time comes from the revision list, which is not fetched until the
    // 9.1 block a few lines down, and `compareTimestamps` folds created drift into its single
    // `match` flag — which pdfGenerator prints as "modified preserved ✓ / changed ✗". Feeding a
    // created value in would make that line report the wrong field.
    const tsCmp = core.compareTimestamps(
      { createdAt: null, modifiedAt: srcItem.modifiedAt },
      { createdAt: null, modifiedAt: destItem.modifiedAt },
      bands.timestampDriftMs
    );
    row.timestamps = { ...tsCmp, createdComparable: false };
    // `modifiedOff`, not `drifted`. compareTimestamps has never returned a `drifted` field — it
    // returns `comparable / match / modifiedOff / createdOff` — so this condition was `undefined`
    // on every file, timestampDrift could never be populated, and the FAIL branch of the 4.1
    // roll-up was unreachable: 4.1 reported "Modified timestamps preserved" whatever the data said.
    // Kept tolerant of a future `drifted` field rather than swapping one hardcoded name for another.
    if (tsCmp && tsCmp.comparable && (tsCmp.modifiedOff || tsCmp.drifted)) {
      totals.timestampDrift.push({
        path: srcItem.path,
        source: srcItem.modifiedAt,
        dest: destItem.modifiedAt,
        field: 'modifiedAt',
      });
    }

    // ── 9.1 / 9.2 versions. Informational: the expected destination count is a JOB SETTING
    // (scope 9.2), so a count alone cannot be judged without knowing what the job requested.
    const [srcRevs, destVersions] = await Promise.all([
      // Absolute path, like the permission and link reads above. Using the relativized
      // srcItem.path meant Dropbox never found the file, srcRevs was always empty, versionInfo
      // stayed empty and features 9.1/9.2 fell to "Not exercised by this run" on a source that
      // had 6 version uploads seeded.
      dropboxClient.listRevisions(srcRef.path, dbxOpts).catch((err) => {
        logger.warn(`[${combination} validation] could not read revisions for `
          + `"${srcRef.path}": ${err.message}`);
        return [];
      }),
      this.readVersionCount(destItem.id, destEmail),
    ]);
    if (srcRevs.length > 1 || destVersions > 1) {
      totals.versionInfo.push({
        path: srcItem.path,
        sourceVersions: srcRevs.length,
        destVersions,
        note: totals.allVersionsRequested !== false
          ? 'Counts ARE compared: the job requested all versions (versioning=true), which is '
            + 'the case scope 9.1 describes. See the 9.1 Version History check for the verdict.'
          : 'Counts are NOT compared: the job did not request all versions, so scope 9.2 makes '
            + 'the expected number a job setting and no N was recorded for this run.',
      });
      row.versions = { source: srcRevs.length, dest: destVersions };
    }

    // ── 4.1 metadata, the CREATED half — NO EXTRA API CALL.
    //
    // `srcRevs` above is the whole revision list, already paid for by the 9.1 version count, and
    // its oldest entry is the file's creation time. Calling dropboxClient.getCreatedTime() here
    // would issue a second files/list_revisions per file — ~38 extra calls on the current seeded
    // tree — for data this function is already holding.
    const created = createdTimeRow(srcItem, destItem, srcRevs, {
      driftMs: bands.timestampDriftMs,
      revisionLimit: dropboxClient.REVISION_LIST_LIMIT,
    });
    totals.createdInfo.push(created);
    row.timestamps.created = created;
    row.timestamps.createdComparable = created.comparable;
    if (!created.comparable) {
      logger.warn(`[${combination} validation] no source creation time for "${srcItem.path}": `
        + `${created.reason}`);
    }

    // ── Size, banded by whether the destination was converted.
    const converted = core.isConverted(destItem) || core.isGoogleNative(destItem.mimeType);
    const sizeBands = converted ? bands.convertedFileSize : bands.fileSize;
    if (srcItem.size != null && destItem.size != null && sizeBands) {
      const sizeCmp = core.compareSize(srcItem, destItem, sizeBands);
      row.size = sizeCmp;
      if (sizeCmp && sizeCmp.severity === 'error') {
        totals.conversionMismatches.push({
          path: srcItem.path, source: srcItem.size, dest: destItem.size, converted,
        });
      }
    }

    return row;
  }

  /** Turn per-item observations into the unit's feature checks. */
  _rollUpItemChecks(push, totals, itemDetails) {
    // ── Permissions: 2.1-2.4 by POSITION in the tree, 2.5 by PRINCIPAL ──────────────────
    //
    // One lumped '2.x Permissions' check used to answer all five features — _buildChecklist mapped
    // 2.1 through 2.5 to the same regex. So a difference on an inner file also marked Root Folder
    // Permissions as failed, and a clean root marked Inner file permissions as passed. Both
    // directions are wrong, and the run already holds the evidence to separate them: every
    // observation carries the item's path and type.
    const permAt = (atRoot, type) => totals.permissionObservations.filter((o) =>
      (core.segmentsOf(o.path).length <= 1) === atRoot && o.type === type);

    /** One permission feature's verdict, over only the items that feature covers. */
    const permFeature = (id, label, obs, notExercised) => {
      const checked = obs.reduce((n, o) => n + o.checked, 0);
      if (checked === 0) {
        push('WARN', `${id} ${label}`, notExercised);
        return;
      }
      const paths = new Set(obs.map((o) => o.path));
      const bad = totals.permissionMismatches.filter((m) => paths.has(m.path));
      const pending = (totals.permissionsPendingPaths || []).filter((x) => paths.has(x)).length;

      if (bad.length === 0) {
        push('PASS', `${id} ${label}`,
          `${checked} grant(s) compared across ${paths.size} item(s), all matched`);
      } else if (pending > 0 && pending >= bad.length) {
        // The same "not yet judgeable" rule as before, now applied per feature: a difference
        // sitting entirely on items CloudFuze had not finished sharing is NOT a defect. Reporting
        // it as FAIL is what filed four Neutara tickets (QT-63, QT-67, CF-30684, CF-30695)
        // against permissions that a later read showed were correct.
        push('WARN', `${id} ${label}`,
          `Not judgeable yet: ${pending} item(s) still carried only inherited drive grants when `
          + 'validation ran. CloudFuze applies item sharing AFTER the copy completes, tens of '
          + 'minutes behind the PROCESSED status — re-validate this execution once it has settled.');
      } else {
        const esc = bad.filter((m) => m.escalation).length;
        push('FAIL', `${id} ${label}`,
          `${bad.length} of ${checked} grant(s) differ`
          + (esc > 0 ? ` (${esc} privilege escalation(s))` : '')
          + (pending > 0
            ? ` (${pending} more item(s) not yet shared by CloudFuze — not counted)` : ''));
      }
    };

    const seed = 'Seed grants with DROPBOX_TEST_INTERNAL_USER / DROPBOX_TEST_GROUP.';
    permFeature('2.1', 'Root Folder Permissions', permAt(true, 'folder'),
      `No folder at the source root carried a comparable grant, so this was not exercised. ${seed}`);
    permFeature('2.2', 'Root File Permissions', permAt(true, 'file'),
      `No file at the source root carried a comparable grant, so this was not exercised. ${seed}`);
    permFeature('2.3', 'Sub-folder permissions', permAt(false, 'folder'),
      `No sub-folder carried a comparable grant, so this was not exercised. ${seed}`);
    permFeature('2.4', 'Inner file permissions', permAt(false, 'file'),
      `No file below the root carried a comparable grant, so this was not exercised. ${seed}`);

    // 2.5 is not positional — it asks whether a grant to someone OUTSIDE the team survived.
    const extAddr = String(env.DROPBOX_TEST_EXTERNAL_USER || '').trim();
    const extChecked = totals.permissionObservations
      .reduce((n, o) => n + (o.externalChecked || 0), 0);
    const extFailed = totals.permissionObservations
      .reduce((n, o) => n + (o.externalFailed || 0), 0);
    if (!extAddr) {
      push('WARN', '2.5 External Shares',
        'DROPBOX_TEST_EXTERNAL_USER is not set, so no external grant was seeded and the feature was '
        + 'not exercised. It must be an address OUTSIDE this Dropbox team — an invitee who belongs '
        + 'to another managed Dropbox team cannot receive the grant on this plan, which is a '
        + 'platform limit rather than a migration defect.');
    } else if (extChecked === 0) {
      push('WARN', '2.5 External Shares',
        `No grant to ${extAddr} was found on any source item, so external sharing was not `
        + 'exercised. Seeding named the address but no item carries the grant.');
    } else if (extFailed === 0) {
      push('PASS', '2.5 External Shares',
        `${extChecked} external grant(s) to ${extAddr} compared, all matched`);
    } else {
      push('FAIL', '2.5 External Shares',
        `${extFailed} of ${extChecked} external grant(s) to ${extAddr} differ`);
    }

    // ── Shared links: 3.1 anyone-with-the-link, 3.2 team members ────────────────────────
    //
    // Split for the same reason. Dropbox reports the audience on every link ('public' vs
    // 'team_only'), so these two documented features are separately answerable and were sharing
    // one verdict.
    const linkFeature = (id, label, obs, notExercised) => {
      if (obs.length === 0) {
        push('WARN', `${id} ${label}`, notExercised);
        return;
      }
      const bad = obs.filter((o) => !o.match);
      if (bad.length === 0) {
        push('PASS', `${id} ${label}`, `${obs.length} link(s) compared, all matched`);
      } else {
        push('FAIL', `${id} ${label}`, `${bad.length} of ${obs.length} link(s) differ`);
      }
    };
    // Each feature claims only the audience it is ABOUT. 3.2 used to take "everything that is not
    // public", which quietly swept up audiences that are neither: Dropbox also reports 'no_one'
    // (invite-only) and password-protected links. Copying a link in the Dropbox UI creates one with
    // audience 'no_one', so an invite-only link appears on the source without being seeded — and it
    // was then judged as a team link, expected to arrive as an organization link, and failed. A
    // FAIL attributed to the wrong feature is worse than no verdict, so those are reported apart.
    const audienceOf = (o) => String(o.sourceAudience || '').toLowerCase();
    const anyoneLinks = totals.linkObservations.filter((o) => audienceOf(o) === 'public');
    const teamLinks = totals.linkObservations.filter((o) => audienceOf(o) === 'team_only');
    const otherLinks = totals.linkObservations
      .filter((o) => !['public', 'team_only'].includes(audienceOf(o)));

    linkFeature('3.1', 'Shared Links (Anyone with the Link)', anyoneLinks,
      'No source link had an "anyone with the link" audience, so this was not exercised');
    linkFeature('3.2', 'Shared Links (Team Members)', teamLinks,
      'No source link had a team-only audience, so this was not exercised');

    if (otherLinks.length > 0) {
      const seen = [...new Set(otherLinks.map(audienceOf))].join(', ');
      push('INFO', '3.x Shared Links (other audiences)',
        `${otherLinks.length} source link(s) carry an audience that is neither "anyone with the `
        + `link" nor team-only (${seen}), so neither 3.1 nor 3.2 covers them and no verdict is `
        + 'claimed. An invite-only link is what the Dropbox UI creates when someone copies a link, '
        + `so this usually means a link was added by hand: ${
          otherLinks.slice(0, 3).map((o) => o.path).join(', ')}`);
    }

    // ── 4.1 Metadata. Two halves, two checks, because the scope feature names two dates:
    // "maintaining the original timestamps, including creation and modification dates and times".
    // The modified half is unchanged; the created half is new and is judged against the job's own
    // createdTimeForFiles flag, the same way 9.1/9.2 are judged against versioning.
    const tsCompared = itemDetails.filter((r) => r.timestamps).length;
    if (tsCompared === 0) {
      push('WARN', '4.1 Metadata', 'No files were available to compare timestamps on');
    } else if (totals.timestampDrift.length === 0) {
      push('PASS', '4.1 Metadata',
        `Modified timestamps preserved on ${tsCompared} file(s). Created dates are judged `
        + 'separately below.');
    } else if (totals.modifiedTimeRequested === false) {
      // The mirror image of the created-half rule: this run switched modified-time preservation
      // off, so drift is what it asked for and failing it would invent a defect.
      push('INFO', '4.1 Metadata',
        `${totals.timestampDrift.length} of ${tsCompared} file(s) have a different modified date, `
        + 'but this job did not request modified-time preservation '
        + '(contentOptions.preserveTimestamp is false), so that is the expected outcome and no '
        + 'verdict is claimed. Created dates are judged separately below.');
    } else {
      // WARN, not FAIL — deliberately aligned with googledriveToSharepoint.js, which reports the
      // identical situation (modified-time drift beyond the band, on a run that DID request
      // timestamp preservation) as a WARN. The same observation cannot be a defect in one content
      // validator and worth-a-look in another: whichever reading is right, disagreeing is not, and
      // a FAIL here was reaching the report as a CloudFuze defect on the strength of one file.
      //
      // The measured case, from run 54f9bfc2:
      //
      //   /13-Permission-Matrix/file_viewer.txt
      //     source 2026-09-10T04:49:06Z -> dest 2026-09-10T05:05:12Z   (modifiedAt, 16 min late)
      //
      // 1 file of 37. The correlation is the useful part: it is a file carrying a DIRECT permission
      // grant, and the other 36 kept their timestamps. A plausible mechanism is that CloudFuze
      // applies item sharing AFTER the copy and that write updates modifiedAt. That is a
      // HYPOTHESIS — one file is not a pattern — and it needs a second run to confirm, so it is
      // reported as something to check rather than as a cause.
      push('WARN', '4.1 Metadata',
        `${totals.timestampDrift.length} of ${tsCompared} file(s) have a modified date outside the `
        + 'tolerance band. Reported as a WARN and not a FAIL so this combination agrees with '
        + 'googledriveToSharepoint.js, which reports the same drift on the same field as a WARN — '
        + 'one content validator calling this a defect while another calls it an observation is a '
        + 'reporting defect in itself. Measured on run 54f9bfc2: '
        + '/13-Permission-Matrix/file_viewer.txt, source 2026-09-10T04:49:06Z -> dest '
        + '2026-09-10T05:05:12Z (modifiedAt, 16 minutes late), 1 file of 37 — and it is a file '
        + 'carrying a DIRECT permission grant while the other 36 kept their timestamps. HYPOTHESIS '
        + 'needing a second run, not a conclusion: CloudFuze may apply item sharing after the copy, '
        + 'and that write would update modifiedAt. One file is not a pattern. Created dates are '
        + 'judged separately below.');
    }

    if (tsCompared > 0) {
      const createdVerdict = judgeCreatedTimestamps(totals.createdInfo, {
        createdTimeRequested: totals.createdTimeRequested === true,
        driftMs: totals.timestampDriftMs,
      });
      push(createdVerdict.status, '4.1 Metadata (created dates)', createdVerdict.detail);
    }

    // 9.1 Version History — counts COMPARED when the job asked for all versions.
    //
    // 9.1 asks whether history arrived AND, when the job requested every version, whether every
    // version arrived. The in-scope document is explicit: 9.1 is "migration of all file versions
    // from source to destination", and §9 adds that the expected count "is a job setting, not a
    // constant". So on a versioning=true run the count IS comparable — that is exactly the case
    // the document describes.
    //
    // This used to refuse the comparison outright, on the grounds that "Google merges revisions,
    // so a lower number is expected behaviour". That justification does not hold on this pair:
    //
    //   - It is not in dropbox-to-google-outscope.md. Grepping that file for "version" returns
    //     nothing, and a limitation that lives only in a code comment is not an accepted one.
    //     Where the claim IS documented is google-shared-drive-to-sharepoint-outscope.md, about
    //     Google as the SOURCE: the Drive API merges small revisions when LISTING a file's
    //     history. Here Google is the DESTINATION and Dropbox is the source, so a documented
    //     limitation about the other direction had been carried onto a pair it was never
    //     written for.
    //   - The measured data contradicts it. Every sampled file matched exactly — file_editor.txt
    //     9→9, file_viewer.txt 9→9, document.txt 40→40, data.csv 40→40 — so the lower count the
    //     old text called "expected behaviour" never actually happened.
    //
    // A shortfall is therefore a WARN, not a FAIL: the document asks for all versions, so it is
    // a real observation, but revision merging has never been demonstrated on this pair and is
    // undocumented, so it goes to a human rather than failing on an unproven expectation. If
    // merging is confirmed it belongs in the out-of-scope document; if it is not, the shortfall
    // is a defect. A count HIGHER than the source warns too — a migration inventing revisions is
    // worth seeing. No history at all is still a FAIL.
    if (totals.versionInfo.length > 0) {
      const versioned = totals.versionInfo.filter((v) => v.sourceVersions > 1);
      const verdict = judgeVersionHistory(totals.versionInfo, {
        allVersionsRequested: totals.allVersionsRequested !== false,
      });
      push(verdict.status, '9.1 Version History', verdict.detail);

      // 9.2 Selective Versions — judged against what the job actually requested.
      //
      // The job options send versioning=true, i.e. ALL versions. So the expectation is history
      // present on every versioned file, which is what 9.1 measured. A selective-count run (last
      // N) would need the job to request it; until a run does, say so rather than scoring it.
      //
      // The opening clause is read off the job rather than asserted, because 9.1 now depends on
      // the same fact: stating "this run requested ALL versions" on a run that did not would put
      // a false premise next to the verdict it justifies.
      push('INFO', '9.2 Selective Versions',
        (totals.allVersionsRequested !== false
          ? 'This run requested ALL versions (job option versioning=true), not a selective count, '
            + 'so there is no N to verify. '
          : 'This run did not request all versions, but the job carries no selective COUNT either '
            + '(CloudFuze takes versioning as a boolean), so there is still no N to verify. ')
        + `${versioned.length} versioned file(s) were checked for `
        + 'history presence under 9.1. To exercise 9.2, run with a selective version count set on '
        + 'the job and re-check.');
    }
  }

  /**
   * Feature 5.1 — special characters, as a NEGATIVE test.
   *
   * On a Google destination the expected outcome is no replacement at all. So this asserts the names
   * arrived UNCHANGED; a sanitized name here is the defect, which is the reverse of the SharePoint
   * combinations.
   */
  _checkSpecialCharacters(push, sourceTree, cmp, rules, totals) {
    // The interesting population is names carrying SPECIAL CHARACTERS — not specifically the ones
    // SharePoint rejects.
    //
    // This filtered on SharePoint's needsSanitizing(), which accepts ~ ! @ # $ % ^ & ( ) + [ ] { } ;
    // — every character in the seeded name "Special ~!@#$%^&()_+[]{};,.= chars". So `risky` was
    // always empty, the check reported "no source names … would rewrite", and feature 5.1 sat at
    // N/A on every run while a purpose-built special-character folder existed in the source.
    //
    // The scope document names the population directly: its own figure shows `!@#$%^&*()_+[]{};:,.<>?`
    // arriving UNCHANGED at Google, and states the expected outcome for this combination is no
    // replacement at all. So the test is: names with special characters must survive intact.
    // Ordinary . _ - and spaces are excluded — every filename has a dot, and matching on that
    // would make the whole tree "risky" and the check meaningless.
    const SPECIAL_CHARS = /[!@#$%^&*()+[\]{};:<>?~"|=]/;
    const risky = sourceTree.filter((i) => SPECIAL_CHARS.test(String(i.name || '')));
    totals.specialChars.total += risky.length;

    if (risky.length === 0) {
      push('WARN', '5.1 Special Characters Replacement',
        'No source name carried a special character, so the feature was not exercised. Seed a name '
        + 'containing characters such as ! @ # $ % ^ & ( ) [ ] { } ; = to cover it.');
      return;
    }

    const renamed = [];
    let arrived = 0;
    for (const item of risky) {
      // cmp.matched holds { source, dest } pairs, not destination items. Reading .name straight off
      // the pair gave undefined, so every special-character name looked "altered at the
      // destination" and 5.1 failed with: "Special ~!@#$%^&()_+[]{};,.= chars" → "undefined".
      const dest = (cmp.matched.get(item.path) || {}).dest;
      if (!dest) continue;
      arrived += 1;
      // Compare against the name this item is SUPPOSED to carry, not its source name.
      // A converted file changes extension by design, and 5.1 is about character REPLACEMENT,
      // not about conversion. Run e6bdd529 failed it on
      //   "qa-paper-full (1).paper" -> "qa-paper-full (1).html"
      // which is the documented .paper -> .html conversion: not one character was replaced. The
      // parentheses are what made the name "risky" enough to be examined, so only converted
      // files whose names also carry a special character were ever affected — which is why this
      // survived until Paper was first seeded.
      const expected = core.convertName(item.name, item.mimeType);
      if (core.normKey(dest.name) !== core.normKey(expected)) {
        renamed.push({ source: item.name, dest: dest.name, expected, path: item.path });
      }
    }
    totals.specialChars.arrived += arrived;

    if (renamed.length === 0) {
      push('PASS', '5.1 Special Characters Replacement',
        `${arrived} name(s) with special characters arrived UNCHANGED, which is the documented `
        + 'outcome for a Google destination — Google accepts characters SharePoint rejects.');
    } else {
      push('FAIL', '5.1 Special Characters Replacement',
        `${renamed.length} name(s) were altered at the destination, but Google accepts these `
        + `characters and no replacement was expected: `
        + renamed.slice(0, 5).map((r) => `"${r.source}" → "${r.dest}"`
          + (r.expected !== r.source ? ` (expected "${r.expected}")` : '')).join(', '));
    }
  }

  /**
   * Feature 7.1 — long paths.
   *
   * The condition ("if the destination cloud has a long folder path limitation") is not met on
   * Google, so intact deep data is the expected outcome and no placeholder link should exist.
   *
   * This deliberately reports EVIDENCE rather than asserting a limit, because the test-data document
   * records an unresolved contradiction: 144 QA cases exercise a "breaking point" while
   * destinations/googledrive.js declares no limit. The longest path that arrived, and the longest
   * that did not, are exactly the two numbers needed to settle it.
   */
  _checkLongPaths(push, sourceTree, cmp, rules, totals) {
    const byLength = [...sourceTree].sort((a, b) => b.path.length - a.path.length);
    const longest = byLength[0];
    if (!longest) return;

    // Nothing arrived at all: this feature cannot be judged, and guessing is worse than saying so.
    //
    // The inference below compares the longest path that ARRIVED against the shortest that did
    // NOT, which is only meaningful when the migration actually delivered something. Run
    // ade2a3d0 moved 0 items (CloudFuze returned CONFLICT / "Migration not Allowed for wrong CSV
    // paths"), so every source item was "missing" — and the check concluded
    //   "Items up to 0 encoded chars arrived, and the shortest MISSING item is 12 chars. That
    //    pattern suggests a real path limit"
    // i.e. it read a 12-character path as evidence of a length limit, and contradicted
    // destinations/googledrive.js on the strength of a migration that never ran. A failed
    // migration must not be able to manufacture a platform finding.
    if (cmp.matchedCount === 0) {
      push('WARN', '7.1 Long-File/folder path',
        `Not judgeable: the migration delivered no items (${(cmp.missing || []).length} of `
        + `${cmp.totalSource} source items missing), so there is no arrived-vs-missing length `
        + 'comparison to make. Re-run once the migration completes — the open question in '
        + 'dropbox-to-google-testdata.md needs a run that actually moved data.');
      return;
    }

    const arrivedLengths = sourceTree
      .filter((i) => cmp.matched.has(i.path))
      .map((i) => core.encodedPathLength(i.path));
    const missingLengths = (cmp.missing || []).map((i) => core.encodedPathLength(i.path));

    const maxArrived = arrivedLengths.length ? Math.max(...arrivedLengths) : 0;
    const minMissing = missingLengths.length ? Math.min(...missingLengths) : null;

    totals.longPathEvidence.push({
      longestSourcePath: longest.path,
      longestSourcePathEncodedLength: core.encodedPathLength(longest.path),
      longestArrivedEncodedLength: maxArrived,
      shortestMissingEncodedLength: minMissing,
      declaredLimit: rules.pathLengthLimit === Infinity ? 'none (Infinity)' : rules.pathLengthLimit,
    });

    if (minMissing == null) {
      push('PASS', '7.1 Long-File/folder path',
        `Every item arrived, including the longest source path (${maxArrived} encoded chars). Google `
        + 'declares no path limit, so intact deep data is the documented outcome and no placeholder '
        + 'link was expected.');
    } else if (minMissing > maxArrived) {
      // Everything short arrived and everything long did not — that is the signature of a real limit.
      push('FAIL', '7.1 Long-File/folder path',
        `Items up to ${maxArrived} encoded chars arrived, and the shortest MISSING item is `
        + `${minMissing} chars. That pattern suggests a real path limit between the two, which `
        + 'contradicts the declared "no limit" in validation/destinations/googledrive.js — the open '
        + 'question in dropbox-to-google-testdata.md. Confirm before treating either as settled.');
    } else {
      // NOT ASSESSED, not failed.
      //
      // This feature asks one question: did a path get too long to migrate? The lengths here say
      // no — items longer than the missing one arrived intact — so 7.1 has found no path-length
      // defect and must not report one. The absence is real, but it belongs to whatever check owns
      // it: on run 85a41244 a single unpaired Paper document produced a 1.1 failure, a 10.1 failure
      // AND a 7.1 failure, so one cause was counted three times and the report read worse than the
      // migration was. Same double-counting the 2.x permission lump used to cause, in reverse.
      push('WARN', '7.1 Long-File/folder path',
        `Not assessed: ${missingLengths.length} item(s) are missing, but items LONGER than the `
        + `shortest missing one arrived intact (longest arrived ${maxArrived} encoded chars, `
        + `shortest missing ${minMissing}), so path length does not explain the absence and this `
        + 'feature has found no defect. The missing item is reported by the structure check (1.1), '
        + 'which owns it — see there for the cause.');
    }
  }

  /**
   * Features 3.1 / 3.2 / 8.1 — the CSV reports CloudFuze writes into the destination.
   *
   * These are ordinary files. There is no special API for them, which is worth restating: two
   * features on the sibling combination were marked "not automated — no API for the CSV" for months
   * while the files sat in the destination the whole time.
   */
  async _checkCsvReports(push, migrated, destEmail, destRoot, totals) {
    const children = await this.listChildren(migrated.id, destEmail, destRoot.driveId);

    // Match only CSV FILES, never folders.
    //
    // The patterns are substring matches, and the seeded tree contains folders named
    // "04-Shared-Links" and "09-Embedded-Links" that match them exactly as well as the real reports
    // do. `.find()` returned whichever came first in the listing — the folder — so both features
    // reported PASS on a directory, "present with 0 row(s)", while "Erik E shared links.csv" sat
    // beside it unread. Two documented features passing on the wrong evidence is worse than either
    // failing honestly.
    const csvFiles = (children || []).filter((c) => {
      // FOLDER_MIME comes off the parent agent's exports — it is not a local binding here, and
      // referencing it bare passed `node --check` while being a ReferenceError at run time.
      const isFolder = String(c.mimeType || '') === GoogleDriveValidationAgent.FOLDER_MIME
        || c.type === 'folder';
      return !isFolder && /\.csv$/i.test(String(c.name || ''));
    });

    const found = {};
    for (const [feature, pattern] of Object.entries(CSV_REPORT_PATTERNS)) {
      const hit = csvFiles.find((c) => pattern.test(String(c.name || '')));
      if (hit) {
        const lines = await this.readTextLines({ id: hit.id, mimeType: hit.mimeType }, destEmail);
        // The LINES are kept, not just their count. 8.1's cross-check reads this same file's
        // Source url / Destination url columns, and reading it twice would download it twice.
        found[feature] = { name: hit.name, rows: Math.max(0, lines.length - 1), lines };
        totals.csvReports.push({ feature, name: hit.name, rows: Math.max(0, lines.length - 1) });
      }
    }

    if (found['3.1']) {
      push('PASS', '3.x Shared Link CSV', `"${found['3.1'].name}" present with ${found['3.1'].rows} row(s)`);
    } else {
      push('WARN', '3.x Shared Link CSV',
        'No shared-link CSV found in the destination root. Scope 3.1/3.2 say CloudFuze writes one, '
        + 'so either none was produced or it landed elsewhere.');
    }
    // 8.1's CSV is SUPPORTING evidence, not the verdict.
    //
    // Scope 8.1 says the CSV "maps the source URLs to their corresponding destination URLs" —
    // a claim ABOUT the transformation, not the transformation itself. Passing the feature on
    // the filename alone is how run fe2581f8 reported "8.1 PASS" while the in-scope anchor in
    // the migrated document still pointed at dropbox.com. _checkEmbeddedLinks now owns the
    // verdict, and the checklist keys on its name rather than on this one.
    if (found['8.1']) {
      push('INFO', '8.1 Embedded Links CSV (supporting evidence)',
        `"${found['8.1'].name}" present with ${found['8.1'].rows} row(s). Supporting evidence `
        + 'only: a written report proves a report was written, not that any URL inside a '
        + 'migrated document was transformed. The verdict comes from reading the document — see '
        + '"8.1 Embedded Links (in-document URLs)".');
    } else {
      push('WARN', '8.1 Embedded Links CSV (supporting evidence)',
        'No embedded-links CSV found in the destination root, though scope 8.1 says one is '
        + 'generated. Reported on its own: the feature verdict now comes from the migrated '
        + 'document, so a missing CSV no longer decides 8.1 in either direction.');
    }
    if (found.comments) {
      push('PASS', 'In-line comments CSV (out of scope)',
        `"${found.comments.name}" present with ${found.comments.rows} row(s) — the documented outcome: `
        + 'comments arrive as a CSV, not as comments on the item.');
    }
    return found;
  }

  /**
   * The .html document 8.1 used to be judged on — REPORTED, never judged.
   *
   * Reported because "the HTML kept its Dropbox hrefs" is a true and useful observation about a
   * migration. Never judged because scope 8.1 promises rewriting only for "supported file types
   * where link rewriting is technically feasible", and a plain <a href> in an .html file is not
   * one — see EMBEDDED_DOC_PATH for the Drive rationale this follows and for the live CSV that
   * shows CloudFuze never processed this file at all. Failing it reported a defect against
   * behaviour that was never promised, which is worse than reporting nothing.
   *
   * Emitted under EMBEDDED_CONTRAST, which the feature checklist's 8.1 pattern does not match, so
   * no path from this observation to a verdict exists. Do not create one.
   */
  _reportEmbeddedHtmlContrast(push, sourceTree, cmp, totals) {
    const srcHtml = sourceTree.find((i) => EMBEDDED_DOC_PATH.test(String(i.path || '')));
    if (!srcHtml) return;
    const destHtml = (cmp.matched.get(srcHtml.path) || {}).dest;
    const state = destHtml && destHtml.id
      ? `It paired with ${destHtml.path || destHtml.name} at the destination`
      : 'It did not pair with any destination item (the structure check 1.1 owns that absence)';
    totals.embeddedLinkContrastDoc = {
      sourcePath: srcHtml.path,
      destPath: destHtml ? (destHtml.path || destHtml.name || null) : null,
      judged: false,
    };
    push('INFO', EMBEDDED_CONTRAST,
      `${srcHtml.path} carries the same two links as plain HTML anchors, and it is NOT judged. `
      + 'Plain HTML is not a supported link-rewrite target under scope 8.1, which limits rewriting '
      + 'to "supported file types where link rewriting is technically feasible" — the same rule '
      + 'DriveTestDataAgent._createEmbeddedLinks records for the Drive pair: "A real .docx with a '
      + 'real hyperlink is used, not a .txt with a URL in it ... failing on it would report a '
      + 'defect against behaviour that was never promised." CloudFuze\'s own embedded-links CSV on '
      + 'the live destination held 12 rows, every one a Paper document and none for this .html, so '
      + `it was never processed. ${state}. Feature 8.1 is decided by embedded_link_doc.docx alone.`);
  }

  /**
   * Feature 8.1 — the URLs INSIDE the migrated document, which is where the feature actually lives.
   *
   * This check used to assert only that CloudFuze's own report CSV existed at the destination. That
   * is a false pass: run fe2581f8 reported "8.1 PASS" on the strength of a CSV filename while the
   * migrated document's in-scope anchor still pointed at dropbox.com. Reading the CSV proves a
   * report was written, not that a URL was transformed, so the CSV is now supporting evidence and
   * the verdict comes from here.
   *
   * THE JUDGED DOCUMENT IS THE .docx, NOT THE .html. Judging the .html produced an invalid FAIL
   * that was being filed as a CloudFuze defect; the reasoning and the live evidence are recorded on
   * EMBEDDED_DOC_PATH above. The .html is still read and reported, at INFO, by
   * `_reportEmbeddedHtmlContrast`.
   *
   * BOTH destination shapes are handled, and the report says which one was seen, because Google may
   * or may not convert a .docx on import:
   *
   *   - still a .docx → the bytes are DOWNLOADED and the hyperlink relationships read out of
   *     word/_rels/document.xml.rels with utils/docxLinks, the same helper googledriveToSharepoint
   *     uses for the mirror-image feature.
   *   - converted to a Google Doc → EXPORTED as text/html and the anchors read, exactly as the
   *     .html path did.
   *
   * Which one occurs is NOT assumed either way: it is decided at runtime from the destination mime
   * type and stated in the report, so nobody has to trust a comment about it.
   *
   * The CSV is read for its CONTENT as well. `<user>-EmbeddedLinks.csv` carries a Source url and a
   * Destination url on every row, so for each embedded link CloudFuze records both what the URL was
   * and what it should have become — an authoritative expected value that was being thrown away in
   * favour of a row count. Cross-checking the document against it upgrades the evidence from "the
   * href points at dropbox.com" to "CloudFuze recorded the destination URL in its own report and
   * did not apply it to the document". The hostname judgement still runs, and still decides on its
   * own whenever the CSV cannot: see `judgeEmbeddedLinks`.
   *
   * @param {object} [csvReport] the `found['8.1']` entry from `_checkCsvReports` — `{name, lines}`
   *   — or undefined when no embedded-links CSV is present at the destination.
   */
  async _checkEmbeddedLinks(push, sourceTree, cmp, destEmail, totals, csvReport) {
    const emit = (rows) => { for (const r of rows) push(r.status, r.name, r.detail); };
    const csv = parseEmbeddedLinksCsv(csvReport ? csvReport.lines : null);
    const csvName = csvReport && csvReport.name ? `"${csvReport.name}"` : 'the embedded-links CSV';

    this._reportEmbeddedHtmlContrast(push, sourceTree, cmp, totals);

    const srcDoc = sourceTree.find((i) => EMBEDDED_DOCX_PATH.test(String(i.path || '')));
    if (!srcDoc) {
      push('WARN', `${EMBEDDED_VERDICT} — not exercised`,
        'No embedded-link .docx exists in the source, so nothing 8.1 can be judged on was read. '
        + 'DropboxTestDataAgent._seedEmbeddedLinks writes 09-Embedded-Links/embedded_link_doc.docx '
        + 'with one in-scope and one out-of-scope hyperlink, so an empty source here means seeding '
        + 'did not run, was cleared, or SKIPPED the document because the in-scope shared link '
        + 'could not be created (it skips rather than embed a placeholder URL, which could never '
        + 'be rewritten and would fail 8.1 forever). The .html beside it is reported separately '
        + 'and is deliberately not a substitute — plain HTML is not a supported rewrite target.');
      return;
    }

    const destItem = (cmp.matched.get(srcDoc.path) || {}).dest;
    if (!destItem || !destItem.id) {
      // 1.1 owns the missing-item finding. Naming it here as well would count one cause twice, the
      // way a single unpaired Paper document once produced a 1.1, a 10.1 AND a 7.1 failure.
      emit(judgeEmbeddedLinks({
        ok: false,
        stage: 'missing',
        reason: `${srcDoc.path} did not pair with any destination item, so the migrated copy could `
          + 'not be opened (the structure check 1.1 owns the absence itself)',
      }, { destPath: srcDoc.path, csv, csvName }));
      return;
    }

    const destPath = destItem.path || destItem.name || srcDoc.path;
    const native = core.isGoogleNative(destItem.mimeType);
    let buf = null;
    let failure = null;
    try {
      buf = native
        ? await driveClient.exportNativeFile(destItem.id, 'text/html', destEmail)
        : await driveClient.downloadFile(destItem.id, destEmail);
    } catch (err) {
      failure = {
        ok: false,
        stage: 'download',
        reason: `${native ? 'exporting' : 'downloading'} ${destPath} `
          + `(${destItem.mimeType || 'unknown mime type'}) failed: ${err.message}`,
      };
    }

    // One shape, one reader. `readDocxAnchors` and `extractHtmlAnchors` return the same
    // discriminated result, so the verdict below is produced by identical code either way.
    const parsed = failure || (native ? extractHtmlAnchors(buf) : readDocxAnchors(buf));
    const inferred = (parsed && parsed.inferred) || [];
    totals.embeddedLinkDoc = {
      sourcePath: srcDoc.path,
      destPath,
      destMimeType: destItem.mimeType || null,
      // How the destination copy arrived, and therefore how it was read. Recorded rather than
      // assumed: no run has yet been observed to establish whether Google converts this .docx on
      // import to a Shared Drive, so the report states what happened on THIS run.
      destShape: native ? 'google-doc' : 'docx',
      readVia: native ? 'exportNativeFile(text/html)' : 'downloadFile + utils/docxLinks',
      converted: native,
      readable: Boolean(parsed.ok),
      reason: parsed.reason || null,
      hrefs: (parsed.anchors || []).map((a) => a.href).filter((h) => h !== ''),
      inferredInScopeLinks: inferred,
      // What CloudFuze's own report said should be in it, so the report surfaces both sides of the
      // comparison rather than only the verdict sentence.
      csvReport: csvReport && csvReport.name ? csvReport.name : null,
      csvRows: csv.ok ? csv.rows.length : 0,
      csvMissingColumns: csv.ok ? csv.missingColumns : null,
      csvUnparseableReason: csv.ok ? null : csv.reason,
    };

    // Which shape arrived is stated on every run, in both directions. Google converting an imported
    // .docx into a Google Doc is normal and is NOT a finding; so is it arriving untouched. What
    // would be a defect is a report that quietly assumed one of them.
    push('INFO', EMBEDDED_SUPPORTING,
      native
        ? `8.1: ${destPath} arrived as a native Google document (${destItem.mimeType}), so the `
          + '.docx was CONVERTED on import and its links were read from an HTML export rather '
          + 'than from word/_rels/document.xml.rels. Conversion is not a finding — a Google '
          + 'destination is entitled to convert an imported Word file — and the links are judged '
          + 'the same either way.'
        : `8.1: ${destPath} arrived still as a Word document (${destItem.mimeType
          || 'unknown mime type'}), so its links were read straight out of `
          + 'word/_rels/document.xml.rels with utils/docxLinks. No conversion happened, and no '
          + 'HTML export was involved.');

    if (inferred.length > 0) {
      push('INFO', EMBEDDED_SUPPORTING,
        `8.1: ${inferred.length} link(s) in ${destPath} were classified as the IN-SCOPE link by `
        + `inference rather than by name: ${inferred.slice(0, 3).join(' | ')}. A rewritten link `
        + 'carries a Google file id and no filename, so nothing in the URL says which target it '
        + 'was; the out-of-scope target sits in the never-migrated QA-Out-Of-Scope folder and has '
        + 'no destination copy for a rewrite to point at, so a destination address inside this '
        + 'document can only be the in-scope link. Stated out loud because the verdict rests on it.');
    }

    emit(judgeEmbeddedLinks(parsed, { destPath, csv, csvName }));
  }

  /**
   * Scope §10 — Dropbox Paper. Nineteen features, reported and not judged.
   *
   * What CAN be asserted automatically is narrow: that each source Paper produced a destination item,
   * and that it is a Google Doc. Everything inside the document — formatting, tables, mentions,
   * comments — needs the document opened, which no API comparison here does.
   *
   * The six features the scope document records as NOT migrating are surfaced at INFO with the
   * document's own wording, because whether each is an accepted limitation or an open defect is the
   * unresolved question both scope files flag. This is the honest position: it neither hides a defect
   * nor invents one.
   */
  /**
   * Export a Paper and its converted Google Doc, and count the structures in each.
   *
   * Word-for-word comparison would be meaningless — the conversion rewrites the markup — but "three
   * tables in, three tables out" is a fair question, and it is the question scope §10 asks.
   *
   * Never throws. A failed export is recorded as { compared: false, reason } and reported as NOT
   * ASSESSED, never as a content defect: an export that could not run is not evidence that the
   * migration lost anything.
   */
  async _comparePaperContent(srcItem, destItem, destEmail, dbxOpts) {
    // The absolute Dropbox path, stamped before the tree was relativized — the relative path would
    // not resolve against the team space.
    const srcRef = srcItem.dbxPath || srcItem.path;

    let md;
    try {
      md = (await dropboxClient.exportPaper(srcRef, 'markdown', dbxOpts)).toString('utf8');
    } catch (err) {
      return { compared: false, reason: `source Paper export failed: ${err.message}` };
    }

    let html;
    try {
      html = (await driveClient.exportNativeFile(destItem.id, 'text/html', destEmail)).toString('utf8');
    } catch (err) {
      return { compared: false, reason: `destination Google Doc export failed: ${err.message}` };
    }

    return {
      compared: true,
      source: paperMarkdownStructure(md),
      dest: googleDocStructure(html),
    };
  }

  /**
   * Feature 8.1 content check — the CSV report above only confirms CloudFuze WROTE a mapping file;
   * it never opens the migrated document to see whether the rewrite actually happened. This reads
   * the migrated HTML itself. DropboxTestDataAgent seeds exactly one such document
   * (09-Embedded-Links/document-with-embedded-links.html) with two links: one to a file inside the
   * migration scope (expected to be rewritten away from Dropbox, scope 8.1) and one to a file
   * deliberately seeded outside it (expected to still point at Dropbox — scope 10.8's stated limit
   * on 8.1: transformation happens only when the referenced file is itself in scope).
   */
  async _checkEmbeddedLinksContent(push, cmp, destEmail, totals) {
    const pair = [...cmp.matched.values()]
      .find((p) => /document-with-embedded-links\.html$/i.test(p.source.path));
    if (!pair) {
      push('WARN', '8.1 Embedded Links (content)',
        'The seeded embedded-links document did not reach the destination, so the actual link '
        + 'rewrite could not be checked — see the structure check.');
      return;
    }

    const text = (await this.readTextLines(pair.dest, destEmail)).join('\n');
    if (!text) {
      push('WARN', '8.1 Embedded Links (content)',
        `Could not read "${pair.dest.name}" at the destination to check its links.`);
      return;
    }

    // The seeded markup is `href="URL">label</a>` — the href attribute precedes its own link text.
    const hrefBefore = (label) => {
      const m = text.match(new RegExp(`href="([^"]+)">\\s*${label}`, 'i'));
      return m ? m[1] : null;
    };
    const inScopeHref = hrefBefore('in-scope target');
    const outOfScopeHref = hrefBefore('out-of-scope target');
    const isDropboxUrl = (u) => /dropbox\.com/i.test(String(u || ''));

    totals.embeddedLinks = { inScopeHref, outOfScopeHref };

    if (!inScopeHref && !outOfScopeHref) {
      push('WARN', '8.1 Embedded Links (content)',
        `Neither seeded link could be found in "${pair.dest.name}" at the destination — its markup `
        + 'may have changed on migration in a way this check does not anticipate.');
      return;
    }

    const problems = [];
    if (inScopeHref && isDropboxUrl(inScopeHref)) {
      problems.push('the in-scope link still points at Dropbox — it was not rewritten');
    }
    if (outOfScopeHref && !isDropboxUrl(outOfScopeHref)) {
      problems.push('the out-of-scope link was rewritten, but scope 10.8 says only in-scope targets should be');
    }

    if (problems.length === 0) {
      push('PASS', '8.1 Embedded Links (content)',
        'The in-scope link was rewritten away from Dropbox; the out-of-scope link correctly still '
        + 'points at Dropbox, matching the documented scope-10.8 limit.');
    } else {
      push('FAIL', '8.1 Embedded Links (content)', problems.join('; '));
    }
  }

  _checkPaper(push, sourceTree, cmp, totals) {
    const papers = sourceTree.filter((i) => i.isPaper);
    // The SOURCE count, kept apart from totals.paperItems (which holds only the docs that PAIRED
    // with a destination item). Conflating the two made the checklist state "No Dropbox Paper
    // documents in the source" on a run whose source demonstrably held one — it had failed to pair
    // because CloudFuze renames .paper to .html. A report that denies the existence of seeded data
    // sends the reader to look for a seeding problem that is not there.
    totals.paperSourceCount = papers.length;
    if (papers.length === 0) {
      push('WARN', '10.x Dropbox Papers',
        'No Dropbox Paper documents in the source, so 19 of the 36 in-scope features were not '
        + 'exercised. DropboxTestDataAgent seeds Paper via files/paper/create, so an empty source '
        + 'here means seeding did not run or was cleared.');
      return;
    }

    const arrived = papers.filter((p) => cmp.matched.has(p.path));
    const missing = papers.filter((p) => !cmp.matched.has(p.path));

    // A Paper doc can produce a destination item that holds NOTHING. Observed on run 93b0636a:
    //
    //   qa-paper-v2        source == dest on every counter
    //   qa-paper-full (1)  source == dest on every counter
    //   qa-paper-full      source 3 tables / 3 lists / 3 emojis / 1 image / 3 links -> dest all 0
    //
    // The destination export was 500 bytes and zero characters of text, while the other two were
    // 370 KB and 32 KB. The document did not convert.
    //
    // That is ONE failure — the document did not migrate — and it belongs to 10.1. Left in the
    // per-construct sums it instead subtracted from every counter at once and failed 10.7, 10.9,
    // 10.12, 10.13 and 10.16, so a reader saw five content-fidelity defects and no mention of the
    // empty document that caused all five. Same shape as the emoji-as-image and small-converted-
    // file cases: one cause wearing several verdicts, with the real finding nowhere in sight.
    //
    // So it fails 10.1 by name and is excluded below, letting the construct features report
    // truthfully on the documents that actually converted.
    const STRUCTURE_KEYS = ['tables', 'bulleted', 'numbered', 'images', 'links', 'emojis'];
    const emptyAtDest = (x) => Boolean(x.content) && x.content.compared === true
      && STRUCTURE_KEYS.some((k) => Number(x.content.source?.[k] || 0) > 0)
      && STRUCTURE_KEYS.every((k) => Number(x.content.dest?.[k] || 0) === 0);
    const emptied = (totals.paperItems || []).filter(emptyAtDest);

    if (missing.length === 0 && emptied.length === 0) {
      push('PASS', '10.1 Dropbox Papers Migration',
        `${arrived.length} Paper document(s) produced a destination item with content`);
    } else {
      const parts = [];
      if (missing.length) {
        parts.push(`${missing.length} with no destination item: `
          + missing.slice(0, 5).map((x) => x.path).join(', '));
      }
      if (emptied.length) {
        parts.push(`${emptied.length} produced an EMPTY destination document — the item exists but `
          + `carries none of the source content: `
          + emptied.slice(0, 5).map((x) => `"${x.path}" (source had `
            + STRUCTURE_KEYS.filter((k) => Number(x.content.source?.[k] || 0) > 0)
              .map((k) => `${x.content.source[k]} ${k}`).join(', ')
            + ', destination none)').join('; '));
      }
      push('FAIL', '10.1 Dropbox Papers Migration',
        `${papers.length} Paper document(s) at the source: ` + parts.join('. ') + '.');
    }

    // ── Paper CONTENT, feature by feature, from the two exports ─────────────────────────
    //
    // This replaced a single WARN covering 10.2-10.19 which said the content "was not compared" and
    // that all 18 features "must be confirmed manually". The structure never needed a human: it is
    // counted from the Paper markdown export and Google's HTML export of the converted Doc.
    //
    // Only constructs with an unambiguous marker on BOTH sides get a verdict. The rest are reported
    // NOT ASSESSED with the numbers actually measured and the reason they cannot be separated —
    // which is far more use to a reviewer than "open the document", and does not pretend to a
    // verdict the evidence cannot support.
    const withContent = totals.paperItems.filter((x) => x.content);
    // Empty-at-destination docs are judged by 10.1 above, not counted here — see the note there.
    const comparable = withContent.filter((x) => x.content.compared && !emptyAtDest(x));
    const failedExport = withContent.filter((x) => !x.content.compared);

    if (comparable.length === 0) {
      const why = failedExport.length > 0
        ? ` Exports failed: ${failedExport.slice(0, 3).map((x) => `"${x.path}" (${x.content.reason})`).join('; ')}`
        : '';
      push('WARN', '10.2-10.19 Paper content fidelity',
        `${arrived.length} Paper document(s) arrived but none could be exported, so no content `
        + `feature was assessed.${why}`);
    } else {
      const sum = (rows, side, key) => rows.reduce((n, x) => n + (x.content[side][key] || 0), 0);
      // Named in every construct verdict below: a count over 2 of 3 documents must never read as
      // though it covered all 3.
      const scope = `${comparable.length} document(s)`
        + (emptied.length
          ? ` (${emptied.length} excluded as empty at the destination — see 10.1)`
          : '');

      /**
       * One structural feature's verdict: the same construct counted on both sides.
       *
       * A destination count BELOW the source is a loss and fails. ABOVE is reported too, because
       * the conversion inventing structure is also a fidelity problem — a Paper table becoming two
       * Google tables is not a pass.
       */
      const structure = (id, label, key, absentDetail) => {
        const src = sum(comparable, 'source', key);
        const dst = sum(comparable, 'dest', key);
        if (src === 0 && dst === 0) {
          push('WARN', `${id} ${label}`, absentDetail);
          return;
        }
        if (src === dst) {
          push('PASS', `${id} ${label}`,
            `${src} in the source, ${dst} at the destination across ${scope}`);
        } else if (dst < src) {
          push('FAIL', `${id} ${label}`,
            `${src} in the source but only ${dst} at the destination across ${scope} `
            + `— ${src - dst} lost in the conversion`);
        } else {
          // More at the destination is NOT reported as a defect. Google's exporter adds anchors and
          // wrappers of its own, so an excess can be an artefact of how the document was read
          // rather than anything the migration did. Surfaced as a WARN so it is still visible.
          push('WARN', `${id} ${label}`,
            `${src} in the source but ${dst} at the destination across ${scope} `
            + `— ${dst - src} more than the source. Nothing was lost; the excess may be `
            + `an artefact of Google's exporter rather than the migration, so this is not called a `
            + 'defect without a human confirming it.');
        }
      };

      structure('10.7', 'Links', 'links',
        'No link appeared in any exported Paper, so this was not exercised');
      structure('10.9', 'Tables', 'tables',
        'No table appeared in any exported Paper, so this was not exercised');
      structure('10.12', 'Bulleted List', 'bulleted',
        'No bulleted list appeared in any exported Paper, so this was not exercised');
      structure('10.13', 'Numbered List', 'numbered',
        'No numbered list appeared in any exported Paper, so this was not exercised');
      structure('10.16', 'Emojis', 'emojis',
        'No emoji appeared in any exported Paper, so this was not exercised');

      // 10.3 / 10.4 / 10.5 — all three arrive as an <img> in Google's export, so the image COUNT is
      // measurable but its ORIGIN is not. Giving each of the three the same count would repeat the
      // mistake the 2.x split just corrected: one piece of evidence answering several features.
      const srcImg = sum(comparable, 'source', 'images');
      const dstImg = sum(comparable, 'dest', 'images');
      const imgDetail = `${srcImg} image(s) in the source, ${dstImg} at the destination. The exports `
        + 'cannot tell an inserted image from a clipboard image or from embedded media — all three '
        + 'become an <img> — so 10.3, 10.4 and 10.5 cannot be separated by API and need a human to '
        + `attribute them.${srcImg !== dstImg ? ' The counts DIFFER, which is worth investigating.' : ''}`;
      for (const [id, label] of [['10.3', 'Inserted Images'], ['10.4', 'Inserted Media'],
        ['10.5', 'Clipboard Images']]) {
        push('WARN', `${id} ${label}`, imgDetail);
      }

      // 10.11 — Google's HTML export renders a checklist as an ordinary list, so a checkbox cannot
      // be recognised at the destination. The SOURCE count is still worth reporting: it says
      // whether the feature was even exercised, which the old blanket WARN did not.
      const srcTodo = sum(comparable, 'source', 'todo');
      push('WARN', '10.11 TO-DO list',
        srcTodo === 0
          ? 'No TO-DO item appeared in any exported Paper, so this was not exercised'
          : `${srcTodo} TO-DO item(s) in the source. Google's HTML export renders a checklist as an `
            + 'ordinary list, so whether the checkboxes survived cannot be read from it — this needs '
            + 'the document opened.');

      if (failedExport.length > 0) {
        push('WARN', '10.x Paper exports that failed',
          `${failedExport.length} of ${withContent.length} Paper document(s) could not be exported, `
          + 'so they contributed nothing to the content features above: '
          + failedExport.slice(0, 3).map((x) => `"${x.path}" (${x.content.reason})`).join('; '));
      }
    }

    for (const [id, wording] of Object.entries(PAPER_DISPUTED)) {
      totals.paperDisputed = totals.paperDisputed || [];
      totals.paperDisputed.push({ id, wording });
    }
    push('WARN', '10.x documented non-migrations (6 features)',
      'The scope document records six Paper elements as not migrating — 10.2 highlight colours, '
      + '10.6 GIFs, 10.14 section breaks, 10.15 code block formatting, 10.17 mentions, 10.18 '
      + 'comments — yet the out-of-scope document lists only the in-line comment CSV. Reported at '
      + 'INFO with the document\'s wording; the combination owner must rule whether each is an '
      + 'accepted limitation or an open defect.');
  }

  /** Feature 6.1 — suppression, which cannot be verified from the Google side. */
  _checkNotificationSuppression(push, totals) {
    if (!env.CONTENT_MIGRATION_SUPPRESSES_NOTIFICATIONS) {
      push('WARN', '6.1 Suppressing email notifications',
        'Not judgeable: suppression was not requested for this run '
        + '(CONTENT_MIGRATION_SUPPRESSES_NOTIFICATIONS is false), so notification mail is the correct '
        + 'outcome and its presence is not a defect.');
      return;
    }
    // The destination-side agent explains why this is not automated for Google.
    push('WARN', '6.1 Suppressing email notifications',
      'Suppression was requested but NOT VERIFIED: confirming it on a Google destination needs Gmail '
      + 'read scope on the destination account, which the content flow does not request. Confirm '
      + 'manually — reported as not verified rather than as a pass.');
    totals.notificationLeaks.push({ verified: false, reason: 'no Gmail scope in the content flow' });
  }

  /**
   * The 36-feature rollup, in the scope document's numbering.
   *
   * A feature that was never exercised is `na` with its reason — never counted as passing. That rule
   * is the whole point of the checklist: the sibling combination once reported "handled as
   * documented" directly above a FAIL for the same thing.
   */
  _buildChecklist(totals, checks) {
    const byName = (pattern) => checks.filter((c) => pattern.test(c.name));
    const worst = (rows) => {
      if (rows.length === 0) return null;
      if (rows.some((r) => r.status === 'FAIL')) return 'fail';
      if (rows.some((r) => r.status === 'WARN')) return 'warn';
      return 'pass';
    };
    const scanned = totals.scannedSourceItems || 0;

    return DROPBOX_FEATURES.map((f) => {
      const na = (detail) => ({ ...f, status: 'na', detail });

      if (!totals.enabled) return na('Deep content validation was disabled for this run');
      if (scanned === 0) return na('No source items were read — nothing was validated');

      // Paper features: 10.1 is assertable, the rest are not.
      if (f.id === '10.1') {
        const rows = byName(/(^|\] )10\.1 Dropbox Papers Migration/);
        const v = worst(rows);
        return v
          ? { ...f, status: v === 'fail' ? 'fail' : 'pass', detail: rows[0].detail }
          : na((totals.paperSourceCount || 0) === 0
            ? 'No Dropbox Paper documents in the source'
            : `${totals.paperSourceCount} Paper document(s) in the source, but the migration check `
              + 'did not run — the roll-up produced no verdict for this feature');
      }
      // Paper features that now carry a real check of their own. Everything else under 10.x still
      // falls through to the blanket N/A below, which is correct: those either cannot be read from
      // an export or are the six the scope document disputes.
      const PAPER_CHECKED = {
        '10.3': /(^|\] )10\.3 /, '10.4': /(^|\] )10\.4 /, '10.5': /(^|\] )10\.5 /,
        '10.7': /(^|\] )10\.7 /, '10.9': /(^|\] )10\.9 /, '10.11': /(^|\] )10\.11 /,
        '10.12': /(^|\] )10\.12 /, '10.13': /(^|\] )10\.13 /, '10.16': /(^|\] )10\.16 /,
      };
      if (PAPER_CHECKED[f.id]) {
        const rows = byName(PAPER_CHECKED[f.id]);
        const v = worst(rows);
        if (v) {
          return {
            ...f,
            // A WARN here means "measured, but not assessable" — na, never a pass. Reporting an
            // unexercised feature as passing is the failure mode this checklist exists to avoid.
            status: v === 'fail' ? 'fail' : v === 'warn' ? 'na' : 'pass',
            detail: rows[0].detail,
          };
        }
      }
      if (f.id.startsWith('10.')) {
        const disputed = PAPER_DISPUTED[f.id];
        // Three distinct states, and they need different words. Saying "none in the source" when
        // the source HAS one but it did not pair is not a nuance — it points the reader at the
        // wrong half of the system.
        const srcCount = totals.paperSourceCount || 0;
        const pairedCount = totals.paperItems.length;
        const state = srcCount === 0
          ? 'No Dropbox Paper documents in the source — not exercised. '
          : pairedCount === 0
            ? `${srcCount} Paper document(s) exist in the source but did NOT pair with a `
              + 'destination item, so their content could not be compared — see 10.1 for why. This '
              + 'is not a seeding gap. '
            : 'Paper arrived, but document content is not compared by API — manual check required. ';
        return na(state + (disputed ? `Scope document records: "${disputed}" — owner ruling pending.` : ''));
      }

      const map = {
        '1.1': /1\.1 Data Migration/,
        // `(^|\] )` rather than `^`: a per-unit check is named
        // "[QA-Automation-Dropbox-Dest] 2.1 Root Folder Permissions", so the feature id is NOT at
        // the start of the string. Anchoring with ^ alone matched nothing, and every one of these
        // features reported "Not exercised by this run" while its own check said PASS — the report
        // contradicting itself in the most misleading direction possible.
        //
        // The alternation keeps the original intent: the id must start the name or follow the unit
        // prefix, so 2.1 still cannot match inside 2.10.
        // Each permission feature has its own check now, so each maps to its own pattern.
        // Sharing one regex made every feature inherit the same verdict: a difference on an
        // inner file marked Root Folder Permissions failed, and a clean root marked Inner file
        // permissions passed. Anchored at the start so 2.1 cannot also match 2.10 later.
        '2.1': /(^|\] )2\.1 Root Folder/, '2.2': /(^|\] )2\.2 Root File/,
        '2.3': /(^|\] )2\.3 Sub-folder/, '2.4': /(^|\] )2\.4 Inner file/, '2.5': /(^|\] )2\.5 External/,
        // Scope sections 3.1 and 3.2 require BOTH halves: the link permissions at the
        // destination AND the shared-links CSV report. So each feature takes the worst of its
        // own audience check and the CSV check — a written CSV cannot excuse missing link
        // permissions, which is exactly the live defect on this combination today.
        '3.1': /(^|\] )3\.1 Shared Links|(^|\] )3\.x Shared Link CSV/,
        '3.2': /(^|\] )3\.2 Shared Links|(^|\] )3\.x Shared Link CSV/,
        '4.1': /4\.1 Metadata/,
        '5.1': /5\.1 Special Characters/,
        '6.1': /6\.1 Suppressing/,
        '7.1': /7\.1 Long-File/,
        // Keyed on the DOCUMENT verdict, not on the CSV. The CSV check is named
        // "8.1 Embedded Links CSV (supporting evidence)" and deliberately does not match this
        // pattern: a CSV's existence must never decide the feature again.
        '8.1': /(^|\] )8\.1 Embedded Links \(in-document URLs\)/,
        // Separate patterns now that 9.1 and 9.2 are separate checks. Sharing one pattern meant
        // both features inherited whichever check matched first, so a real 9.1 verdict could not
        // reach the checklist independently of 9.2's informational note.
        '9.1': /9\.1 Version History/, '9.2': /9\.2 Selective Versions/,
      };

      // 1.2 and 1.3 are the SAME evidence — the structure comparison — read under the run's
      // migration type. Both therefore require that evidence to exist.
      //
      // `worst([])` is null, not 'fail', so an earlier version of this fell through to 'pass' and
      // reported One Time Migration as passing on a run where nothing had been compared. That is the
      // exact defect these documents were written around: a validator reporting SUCCESS having
      // validated nothing. Absence of evidence is `na`, never a pass.
      const isDelta = String(totals.migrationType).toUpperCase() === 'DELTA';
      if (f.id === '1.2' || f.id === '1.3') {
        if (f.id === '1.2' && isDelta) return na('This run was a delta migration');
        if (f.id === '1.3' && !isDelta) return na('This run was a one-time migration, not a delta');
        const structure = worst(byName(/1\.1 Data Migration/));
        if (!structure) return na('The structure comparison did not run — nothing to base this on');
        return {
          ...f,
          status: structure === 'fail' ? 'fail' : structure === 'warn' ? 'na' : 'pass',
          detail: isDelta
            ? 'Delta run compared against the destination'
            : 'One-time migration delivered the source tree',
        };
      }

      const pattern = map[f.id];
      if (!pattern) return na('Not assessed by this validator');
      const rows = byName(pattern);
      const v = worst(rows);
      if (!v) return na('Not exercised by this run');
      return {
        ...f,
        status: v === 'fail' ? 'fail' : v === 'warn' ? 'na' : 'pass',
        detail: rows.map((r) => r.detail).join(' | ').slice(0, 400),
      };
    });
  }

  /** Assemble the agent result, matching the shape the orchestrator, PDF and Neutara consume. */
  _buildResult(globalChecks, perUser, totals, context) {
    const flat = [...globalChecks];
    const destLeaf = (p) => String(p || '').split('/').filter(Boolean).pop() || '';
    for (const u of perUser) {
      const tag = u.sourceDriveName || destLeaf(u.destinationPath) || u.sourceEmail || 'unit';
      for (const c of u.checks) flat.push({ ...c, name: `[${tag}] ${c.name}` });
    }

    const hasFail = flat.some((c) => c.status === 'FAIL');
    const hasWarn = flat.some((c) => c.status === 'WARN');
    const overall = hasFail ? 'FAIL' : hasWarn ? 'WARN' : 'PASS';

    const featureChecklist = this._buildChecklist(totals, flat);
    const counts = featureChecklist.reduce(
      (acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; },
      {}
    );
    const featureSummary = {
      line: `Features: ${counts.pass || 0} pass, ${counts.fail || 0} fail, ${counts.na || 0} not assessed `
        + `(of ${featureChecklist.length})`,
      pass: counts.pass || 0,
      fail: counts.fail || 0,
      na: counts.na || 0,
      total: featureChecklist.length,
    };
    if (totals) {
      totals.featureChecklist = featureChecklist;
      totals.featureSummary = featureSummary;
    }

    const infraCheck = /Destination location|Source items scanned|Source account context|Deep content validation/i;
    const mismatches = flat
      .filter((c) => c.status === 'FAIL')
      .map((c) => {
        const infra = infraCheck.test(c.name);
        return {
          category: 'content',
          kind: infra ? 'infrastructure' : 'content',
          kindLabel: infra ? 'Validation could not run' : 'Content comparison',
          field: c.name,
          expected: 'source and destination identical',
          actual: c.detail || '(no detail)',
          summaryLine: `${c.name}: ${c.detail || '(no detail)'}`.slice(0, 300),
          severity: infra ? 'critical' : 'error',
        };
      });

    const scanned = totals?.scannedSourceItems || 0;
    const paired = totals?.pairedCount || 0;
    const passed = flat.filter((c) => c.status === 'PASS').length;

    const summary = (() => {
      const tail = `${perUser.length} unit(s); ${scanned} source item(s) scanned, ${paired} paired. `
        + featureSummary.line;
      if (scanned > 0 && paired === 0) {
        return `MIGRATION MOVED NOTHING — 0 of ${scanned} source item(s) reached the destination, so no `
          + `content was compared. ${passed}/${flat.length} reachability check(s) passed — these say `
          + `nothing about migrated data. ${tail}`;
      }
      return `${passed}/${flat.length} checks passed across ${tail}`;
    })();

    if (totals) totals.summary = summary;

    return {
      featureChecklist,
      featureSummary,
      mismatches,
      status: overall,
      overallStatus: overall,
      domain: 'content',
      sourceProvider: 'dropbox',
      destinationProvider: context?.destinationProvider || 'googledrive',
      combination: combinationFor(context),
      checks: flat,
      perUser,
      deepContentValidation: totals,
      summary,
    };
  }
}

module.exports = DropboxToGoogledriveValidationAgent;
module.exports.DROPBOX_FEATURES = DROPBOX_FEATURES;
module.exports.PAPER_DISPUTED = PAPER_DISPUTED;
// Exported for the unit tests: the counting is where the subtle errors live (an emoji regex that
// also matches digits, a table matcher that counts rows instead of tables, links that swallow
// images), and those are worth asserting directly rather than only through a roll-up.
module.exports.paperMarkdownStructure = paperMarkdownStructure;
module.exports.googleDocStructure = googleDocStructure;
module.exports.COMBINATION = DEFAULT_COMBINATION;
module.exports.splitImages = splitImages;
// Feature 8.1 and 9.1 now carry real verdicts, and both are decided by pure functions so the
// verdict itself can be asserted from fixtures taken off the live destination.
module.exports.extractHtmlAnchors = extractHtmlAnchors;
module.exports.classifyEmbeddedAnchors = classifyEmbeddedAnchors;
module.exports.judgeEmbeddedLinks = judgeEmbeddedLinks;
// The 8.1 CSV cross-check. Exported piece by piece because each part is where a subtle error would
// hide: a naive comma split that shifts every column, a URL comparison that lower-cases a
// case-sensitive Drive file id into a false match, a required-column list that quietly tolerates a
// report with no Destination url in it.
module.exports.judgeEmbeddedLinksByHost = judgeEmbeddedLinksByHost;
module.exports.parseCsvRow = parseCsvRow;
module.exports.normalizeCsvHeader = normalizeCsvHeader;
module.exports.missingEmbeddedCsvColumns = missingEmbeddedCsvColumns;
module.exports.parseEmbeddedLinksCsv = parseEmbeddedLinksCsv;
module.exports.normalizeEmbeddedUrl = normalizeEmbeddedUrl;
module.exports.csvRowNamesEmbeddedDoc = csvRowNamesEmbeddedDoc;
module.exports.crossCheckEmbeddedLinksCsv = crossCheckEmbeddedLinksCsv;
module.exports.EMBEDDED_CSV_COLUMNS = EMBEDDED_CSV_COLUMNS;
module.exports.EMBEDDED_CSV_CHECK = EMBEDDED_CSV_CHECK;
module.exports.judgeVersionHistory = judgeVersionHistory;
module.exports.allVersionsRequested = allVersionsRequested;
// Feature 4.1 now compares CREATED dates as well as modified ones. Same reasoning as above: the
// verdict is a pure function of measured rows plus what the job requested, so it is asserted
// directly rather than only through a run.
module.exports.judgeCreatedTimestamps = judgeCreatedTimestamps;
module.exports.createdTimeRow = createdTimeRow;
module.exports.createdTimeRequested = createdTimeRequested;
module.exports.modifiedTimeRequested = modifiedTimeRequested;
module.exports.EMBEDDED_DOC_PATH = EMBEDDED_DOC_PATH;
// 8.1 is judged on the .docx now, and both destination shapes have to be readable, so the .docx
// reader and its label reconstruction are asserted directly against a buffer built by the same
// library the seeder uses.
module.exports.EMBEDDED_DOCX_PATH = EMBEDDED_DOCX_PATH;
module.exports.EMBEDDED_CONTRAST = EMBEDDED_CONTRAST;
module.exports.docxAnchorsFromTargets = docxAnchorsFromTargets;
module.exports.readDocxAnchors = readDocxAnchors;
module.exports.EMBEDDED_VERDICT = EMBEDDED_VERDICT;
module.exports.EMBEDDED_SUPPORTING = EMBEDDED_SUPPORTING;
