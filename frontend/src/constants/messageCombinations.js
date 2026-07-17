/** Same catalogue as Test Case Generator → Product Type: Message */
export const MESSAGE_MIGRATION_COMBINATIONS = [
  'Slack → Microsoft Teams',
  'Slack → Google Chat',
  'Slack → Slack',
  'Microsoft Teams → Slack',
  'Microsoft Teams → Google Chat',
  'Microsoft Teams → Microsoft Teams',
  'Google Chat → Microsoft Teams',
  'Google Chat → Google Chat',
  'Google Chat → Slack',
  'Slack → Existing Teams',
  'Slack → Teams (Direct Messages to Channels)',
];

/** Split pasted IDs by comma, semicolon, or newline */
export function parseIdList(raw) {
  if (!raw || typeof raw !== 'string') return [];
  return raw
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
