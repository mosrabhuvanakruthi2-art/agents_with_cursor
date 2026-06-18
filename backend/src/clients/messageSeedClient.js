/**
 * Post seed messages to Slack, Google Chat, or Microsoft Teams for Message migration QA.
 * Tokens and target IDs come from env (and optional per–test-case overrides in custom-test-cases.json).
 */
const axios = require('axios');
const { google } = require('googleapis');
const env = require('../config/env');
const { getAppAccessToken } = require('./outlookClient');

const GRAPH = 'https://graph.microsoft.com/v1.0';

/**
 * Derive source platform from migration combination (text before "→").
 * @returns {'slack'|'gchat'|'teams'}
 */
function parseMessageSourcePlatform(combination) {
  const left = String(combination || '')
    .split(/\u2192|->/)[0]
    ?.trim()
    .toLowerCase() || '';
  if (left.includes('slack')) return 'slack';
  if (left.includes('teams')) return 'teams';
  if (left.includes('google chat') || /^\s*chat\s*$/i.test(left.trim())) return 'gchat';
  return 'slack';
}

function cleanEnv(v) {
  return String(v ?? '')
    .trim()
    .replace(/^["']|["']$/g, '');
}

/**
 * @param {string} token — xoxb- or xoxp-
 * @param {string} channel — channel ID (C…) or name
 * @param {string} text
 * @param {{ threadTs?: string }} [opts]
 */
async function postSlackMessage(token, channel, text, opts = {}) {
  const body = {
    channel,
    text,
    ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}),
  };
  const res = await axios.post('https://slack.com/api/chat.postMessage', body, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    timeout: 30000,
    validateStatus: () => true,
  });
  const data = res.data;
  if (!data.ok) {
    throw new Error(`Slack API error: ${data.error || res.status}`);
  }
  return data;
}

/**
 * Post as the Google user identified by sourceEmail (GOOGLE_ACCOUNTS refresh token).
 * Requires Chat API enabled and OAuth scopes including chat.messages or chat.messages.create.
 */
async function postGoogleChatMessage(sourceEmail, spaceName, text) {
  const token = env.googleAccounts.get(String(sourceEmail).toLowerCase());
  if (!token) {
    throw new Error(
      `No GOOGLE_ACCOUNTS refresh token for ${sourceEmail}. Add chat scopes and reconnect OAuth.`
    );
  }
  const oauth2Client = new google.auth.OAuth2(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET);
  oauth2Client.setCredentials({ refresh_token: token });
  const chat = google.chat({ version: 'v1', auth: oauth2Client });
  const parent = spaceName.startsWith('spaces/') ? spaceName : `spaces/${spaceName}`;
  const res = await chat.spaces.messages.create({
    parent,
    requestBody: { text },
  });
  return res.data;
}

/**
 * App-only Graph: post to a standard channel. Needs ChannelMessage.Send (application) on the app.
 */
async function postTeamsChannelMessage(teamId, channelId, text, tenantKey = '1') {
  const accessToken = await getAppAccessToken(tenantKey);
  const url = `${GRAPH}/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages`;
  const res = await axios.post(
    url,
    {
      body: {
        contentType: 'text',
        content: text,
      },
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
      validateStatus: () => true,
    }
  );
  if (res.status >= 400) {
    throw new Error(`Teams Graph ${res.status}: ${JSON.stringify(res.data)}`);
  }
  return res.data;
}

function slackToken() {
  return cleanEnv(process.env.SLACK_USER_TOKEN || process.env.SLACK_BOT_TOKEN || '');
}

function slackDefaultChannel() {
  return cleanEnv(process.env.SLACK_CHANNEL_ID || '');
}

function googleChatSpace() {
  return cleanEnv(process.env.GOOGLE_CHAT_SPACE || '');
}

function teamsIds() {
  return {
    teamId: cleanEnv(process.env.TEAMS_TEAM_ID || ''),
    channelId: cleanEnv(process.env.TEAMS_CHANNEL_ID || ''),
  };
}

module.exports = {
  parseMessageSourcePlatform,
  postSlackMessage,
  postGoogleChatMessage,
  postTeamsChannelMessage,
  slackToken,
  slackDefaultChannel,
  googleChatSpace,
  teamsIds,
};
