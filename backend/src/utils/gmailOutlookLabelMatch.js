/**
 * Gmail uses slash-separated nested label names (e.g. QA-TestLabel/Nested-Child).
 * Outlook/Graph often returns the leaf folder as displayName "Nested-Child" under parent "QA-TestLabel"
 * but custom folder entries may be stored as flat names without the path.
 */

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .trim();
}

/**
 * Find destination custom folder row for a Gmail label name.
 * Tries full path match first, then parent/leaf match when label contains "/".
 */
function findDestCustomFolder(customFolders, gmailLabelName) {
  if (!customFolders?.length) return null;
  const target = norm(gmailLabelName);
  const direct = customFolders.find((f) => norm(f.name) === target);
  if (direct) return direct;

  const parts = String(gmailLabelName)
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;

  const leaf = norm(parts[parts.length - 1]);
  const parent = norm(parts[parts.length - 2]);
  const parentExists = customFolders.some((f) => norm(f.name) === parent);
  const leafMatches = customFolders.filter((f) => norm(f.name) === leaf);
  if (leafMatches.length === 0) return null;
  if (parentExists || leafMatches.length === 1) return leafMatches[0];
  return leafMatches[0];
}

/**
 * Re-evaluate custom-label comparison for PDF output so flat Outlook folder names
 * (e.g. Nested-Child next to QA-TestLabel) match Gmail nested labels without re-running the agent.
 */
function buildPdfValidationView(validation) {
  if (!validation?.sourceData || !validation?.destinationData) return validation;
  const view = JSON.parse(JSON.stringify(validation));
  const cf = view.destinationData.customFolders || [];

  const filteredIssues = (view.comparison?.issues || []).filter((issue) => {
    if (issue.type !== 'custom') return true;
    const found = findDestCustomFolder(cf, issue.label);
    const src = view.sourceData.customLabels.find((l) => l.name === issue.label);
    if (!found || !src) return true;
    return (Number(src.messageCount) || 0) !== (Number(found.messageCount) || 0);
  });

  if (!view.comparison) view.comparison = {};
  view.comparison.issues = filteredIssues;
  view.comparison.customLabelsMatch = !filteredIssues.some((i) => i.type === 'custom');

  const nonComp = (validation.mismatches || []).filter((m) => m.category !== 'comparison');
  const compMis = filteredIssues.map((i) => ({
    category: 'comparison',
    field: i.label,
    expected: `${i.sourceCount} (source)`,
    actual: `${i.destCount} (destination)`,
  }));
  view.mismatches = [...nonComp, ...compMis];
  view.overallStatus = view.mismatches.length === 0 ? 'PASS' : 'FAIL';
  return view;
}

module.exports = { findDestCustomFolder, norm, buildPdfValidationView };
