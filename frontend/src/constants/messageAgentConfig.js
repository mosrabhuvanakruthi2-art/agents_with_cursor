/** Migration routes for message QA — source before → determines seed API. */
export const MESSAGE_COMBINATIONS = [
  'Slack → Google Chat',
  'Slack → Microsoft Teams',
  'Teams → Google Chat',
  'Teams → Teams',
  'Teams → Slack',
  'Chat → Teams',
  'Chat → Chat',
  'Chat → Slack',
];

/**
 * Shown in Message Agent UI — backend .env keys and admin responsibilities.
 */
export const PLATFORM_CARDS = [
  {
    id: 'slack',
    name: 'Slack',
    color: '#4A154B',
    adminLabel: 'Slack workspace primary owner / admin',
    adminPlaceholder: 'owner@company.com',
    requirements: [
      'Slack app with chat:write (bot) or user token if posting as a user',
      'Backend: SLACK_BOT_TOKEN or SLACK_USER_TOKEN, SLACK_CHANNEL_ID',
      'User token (xoxp-) for messages that appear from a person',
    ],
  },
  {
    id: 'googleChat',
    name: 'Google Chat',
    color: '#00832D',
    adminLabel: 'Google Workspace super admin (Chat API)',
    adminPlaceholder: 'workspace-admin@company.com',
    requirements: [
      'Google Cloud: enable Google Chat API; OAuth client for your app',
      'Backend: GOOGLE_CHAT_SPACE (e.g. spaces/xxx), GOOGLE_ACCOUNTS for source user',
      'OAuth scopes: chat.messages or chat.messages.create',
    ],
  },
  {
    id: 'teams',
    name: 'Microsoft Teams',
    color: '#6264A7',
    adminLabel: 'Microsoft 365 / Entra Global or Teams admin',
    adminPlaceholder: 'teams-admin@company.com',
    requirements: [
      'Azure app registration with Microsoft Graph',
      'Backend: TEAMS_TEAM_ID, TEAMS_CHANNEL_ID; GRAPH_* app credentials',
      'Permissions: ChannelMessage.Send, Group.Read.All (as required by tenant)',
    ],
  },
];
