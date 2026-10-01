/**
 * Destination rules for OneDrive for Business AS CLOUDFUZE WRITES IT.
 *
 * `destinations/sharepoint.js` describes what SharePoint Online itself rejects. That is the right
 * model for a destination someone writes to directly, and the wrong one for a destination CloudFuze
 * writes to — because CloudFuze sanitises a WIDER set of characters than SharePoint requires, and
 * picks its own replacement.
 *
 * Measured on run 7fadbadc, reading the destination byte by byte:
 *
 *   source  "Special !@#$%^&*()-_+=[] Folder"
 *   dest    "Special !@#--^--()-_+=[] Folder"
 *           char codes: [-=45][-=45] ^ [-=45][-=45]
 *
 * So `$ % & *` all became `-`. SharePoint only rejects `*` of those four, so sharepoint.js predicted
 * the name unchanged, the folder failed to pair, and feature 1.4 reported it as one missing folder
 * plus one extra folder plus one misplaced child — three defects for one documented rename.
 *
 * TWO THINGS WORTH RAISING WITH CLOUDFUZE rather than absorbing silently:
 *
 *   1. The job requested `specialCharacter=_` and the destination received `-`. The requested
 *      replacement character was not honoured, so both are accepted here — pairing must not depend
 *      on a setting the product ignores.
 *   2. `$ % &` are legal in SharePoint Online names. Replacing them is CloudFuze's choice, not a
 *      platform limit, and it means a migrated name differs from the source for no reason the
 *      destination imposes.
 *
 * Neither is failed by this combination: in-scope feature 1.4 allows the destination's naming
 * limitations, and a rename the product performs consistently is not data loss. They are recorded
 * here so the next reader knows the widening is evidence-based rather than a guess.
 */
const sharepoint = require('./sharepoint');

/**
 * Characters CloudFuze replaces when writing to OneDrive.
 *
 * SharePoint's own set (`" * : < > ? / \ |`) plus `$ % &`, which CloudFuze sanitises even though
 * the platform accepts them. A fresh regex per call because /g regexes carry lastIndex.
 */
function invalidChars() {
  return /["*:<>?/\\|$%&]/g;
}

/** True when a name would be rewritten on the way in. */
function needsSanitizing(name) {
  return invalidChars().test(String(name || '')) || sharepoint.isReservedName(name);
}

/** The name this source name is expected to arrive under. */
function sanitizeName(name, replacement = '_') {
  return String(name || '').replace(invalidChars(), replacement).trim();
}

module.exports = {
  ...sharepoint,
  destination: 'onedrive',
  label: 'OneDrive for Business (via CloudFuze)',
  invalidChars,
  needsSanitizing,
  sanitizeName,
};
