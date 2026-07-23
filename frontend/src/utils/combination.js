// Combination label helpers — shared by the results view and the Reports & Logs header
// so the "Gmail → Outlook" style label stays consistent (and matches the PDF report).

/** Provider id → display name. Covers mail, content, and message providers. */
const PROVIDER_LABELS = {
  google: 'Gmail', gmail: 'Gmail',
  microsoft: 'Outlook', outlook: 'Outlook',
  slack: 'Slack', teams: 'Teams', googlechat: 'Google Chat',
  box: 'Box', sharepoint: 'SharePoint', onedrive: 'OneDrive',
  googledrive: 'Google Drive', dropbox: 'Dropbox',
};

export function providerLabel(p) {
  return PROVIDER_LABELS[String(p || '').toLowerCase()] || (p ? String(p) : '—');
}

/**
 * "Gmail → Outlook" style combination label from a run context, or null when unknown.
 * Works across all products: mail (google/microsoft), content (box/sharepoint/…), and message
 * (slack/teams/…). Message runs that only carry a pre-formatted messageCombination fall back to it.
 */
export function combinationLabel(ctx) {
  if (!ctx) return null;
  if (ctx.sourceProvider || ctx.destinationProvider) {
    return `${providerLabel(ctx.sourceProvider)} → ${providerLabel(ctx.destinationProvider)}`;
  }
  return ctx.messageCombination || null;
}

/**
 * Filename-safe combination slug derived from combinationLabel, e.g. "outlook-to-gmail",
 * "box-to-sharepoint". Returns null when the combination is unknown.
 */
export function combinationSlug(ctx) {
  const label = combinationLabel(ctx);
  if (!label) return null;
  const slug = label
    .toLowerCase()
    .replace(/→/g, 'to')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || null;
}
