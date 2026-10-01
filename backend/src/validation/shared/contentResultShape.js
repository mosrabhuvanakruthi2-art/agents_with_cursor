/**
 * The shape the Results screen reads from a content validation result.
 *
 * WHY THIS FILE EXISTS.
 *
 * A validator can return a perfectly correct verdict and still render an EMPTY Results tab. It
 * happened on the first googleshareddrive → onedrive run: the migration moved 99/99 items, the
 * feature checklist was populated, and the screen showed
 *
 *     SOURCE ITEMS 0 · FOUND AT DESTINATION 0 · MISSING 0 · FOLDERS COMPARED 0
 *     ALL ITEMS REACHED DESTINATION — Not compared
 *
 * because `ResultsView.jsx` does not read the checklist for that panel. It reads two fields off each
 * entry in `perUser`, and a new combination that does not know to emit them shows nothing:
 *
 *   u.items           [{ path, name, type, found, destName, placeholder }]
 *   u.folderStructure { missing: [], extra: [], misplaced: [] }
 *
 * Both are built here from the tree comparison every content validator already has, so a new
 * combination gets the panel right by calling one function instead of rediscovering the contract.
 *
 * Deliberately a NEW file rather than an addition to deepContentCore: that module is imported by
 * every live content combination, and this is additive convenience, not shared comparison logic.
 */

/**
 * Build the per-unit payload the Results screen needs.
 *
 * @param {Array}  sourceTree  the source items, each { path, name, type }
 * @param {object} cmp         the result of core.compareTrees — { matched: Map, missing, extra, misplaced }
 * @param {object} opts        { placeholderPaths?: Set<string> } paths the destination legitimately
 *                             replaced with a link rather than the item (SharePoint path limits).
 * @returns {{ items: Array, folderStructure: object }}
 */
function buildUnitResult(sourceTree, cmp, opts = {}) {
  const matched = (cmp && cmp.matched) || new Map();
  const placeholders = opts.placeholderPaths instanceof Set ? opts.placeholderPaths : new Set();

  const items = (sourceTree || []).map((s) => {
    const pair = matched.get(s.path);
    const dest = pair && pair.dest;
    return {
      path: s.path,
      name: s.name,
      type: s.type,
      // `found` drives both the "All items reached destination" card and the per-folder counts, so
      // it must mean "this source item has a destination counterpart" and nothing looser.
      found: Boolean(dest),
      // Shown as proof the destination's rename rules worked, rather than hidden — a converted or
      // sanitised name is expected behaviour, not a discrepancy.
      destName: (dest && dest.name) || null,
      // A placeholder is documented behaviour, not an absence: over SharePoint's path limit the
      // destination writes a link instead of the item. Counting it as missing made a deliberately
      // over-length test path read as three lost items.
      placeholder: placeholders.has(s.path),
    };
  });

  // THE FOLDER-STRUCTURE PANEL AND THE PDF READ DIFFERENT FIELD NAMES, and emitting only the ones
  // the screen needed printed a broken report. Measured on run e8fc456e:
  //
  //   "Folder structure validation — undefined"
  //   98 Source Folders | undefined Dest Folders | undefined Matched
  //   Structure: undefined
  //   Box (Source) / SharePoint (Destination)        <- neither is this combination
  //   Differences (full paths):  MISSING [object Object]
  //
  // `drawFolderStructureSection` wants `totalDest`, `matched`, `status`, `sourceLabel`/`destLabel`
  // and PATH STRINGS in `missing`/`extra`; it falls back to the literals "Box" and "SharePoint"
  // when the labels are absent, which is how a Shared Drive → OneDrive report came to name two
  // clouds that were not involved. The screen reads `missing.length` and renders `extra` through
  // String(), so objects there produced the same `[object Object]` in the UI.
  //
  // One shape satisfying both, with `matchedCount`/`totalSource` kept for anything already reading
  // them.
  const pathsOf = (list) => (list || []).map((x) => String((x && x.path) || x));
  const missing = pathsOf(cmp && cmp.missing);
  const extra = pathsOf(cmp && cmp.extra);
  const misplaced = (cmp && cmp.misplaced) || [];
  const clean = missing.length === 0 && extra.length === 0 && misplaced.length === 0;

  return {
    items,
    folderStructure: {
      missing,
      extra,
      misplaced,
      status: clean ? 'PASS' : 'FAIL',
      totalSource: (sourceTree || []).length,
      totalDest: Number.isFinite(opts.destCount) ? opts.destCount : items.filter((i) => i.found).length,
      matched: (cmp && cmp.matchedCount) || 0,
      matchedCount: (cmp && cmp.matchedCount) || 0,
      sourceLabel: opts.sourceLabel || null,
      destLabel: opts.destLabel || null,
      sourceRootName: opts.sourceRootName || null,
      destRootName: opts.destRootName || null,
      sourceFolderPaths: (sourceTree || []).filter((s) => s.type === 'folder').map((s) => s.path).sort(),
      destFolderPaths: (opts.destTree || []).filter((d) => d.type === 'folder').map((d) => d.path).sort(),
    },
  };
}

module.exports = { buildUnitResult };
