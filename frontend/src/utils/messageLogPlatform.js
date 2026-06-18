/**
 * Classify an execution for log filtering (Message Agent / message migrations).
 * @param {object|null|undefined} context — execution.context from API
 * @returns {'mail'|'slack'|'teams'|'googleChat'|'message'}
 */
export function inferMessageLogPlatform(context) {
  if (!context) return 'mail';
  if ((context.productType || 'Mail') !== 'Message') return 'mail';
  const combo = String(context.messageCombination || '').toLowerCase();
  const left = combo.split(/\u2192|->/)[0]?.trim() || '';
  if (left.includes('slack')) return 'slack';
  if (left.includes('teams')) return 'teams';
  if (left.includes('google chat') || /^\s*chat\s*$/i.test(left)) return 'googleChat';
  return 'message';
}

export const PLATFORM_FILTERS = [
  { id: 'all', label: 'All', description: 'Every run' },
  { id: 'mail', label: 'Mail', description: 'Gmail / Outlook agent runs' },
  { id: 'slack', label: 'Slack', description: 'Slack as source' },
  { id: 'teams', label: 'Microsoft Teams', description: 'Teams as source' },
  { id: 'googleChat', label: 'Google Chat', description: 'Chat as source' },
];
