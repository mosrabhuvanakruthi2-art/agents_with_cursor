const path = require('path');
const fs = require('fs');
const { BaseAgent } = require('../core/BaseAgent');
const logger = require('../../utils/logger');
const {
  parseMessageSourcePlatform,
  postSlackMessage,
  postGoogleChatMessage,
  postTeamsChannelMessage,
  slackToken,
  slackDefaultChannel,
  googleChatSpace,
  teamsIds,
} = require('../../clients/messageSeedClient');
const env = require('../../config/env');

const CUSTOM_CASES_FILE = path.resolve(__dirname, '../../../data/custom-test-cases.json');

function readCustomCases() {
  try {
    if (!fs.existsSync(CUSTOM_CASES_FILE)) return { smoke: [], sanity: [] };
    return JSON.parse(fs.readFileSync(CUSTOM_CASES_FILE, 'utf8'));
  } catch {
    return { smoke: [], sanity: [] };
  }
}

/**
 * Custom test cases saved with productType "Message" (Test Case Generator).
 */
function loadMessageCustomTestCases(testType, log) {
  try {
    const data = readCustomCases();
    const bucket = testType === 'SMOKE' ? 'smoke' : 'sanity';
    const cases = (data[bucket] || []).filter((tc) => (tc.productType || 'Mail') === 'Message');
    if (cases.length > 0) log.info(`Loading ${cases.length} Message custom test case(s) for ${testType}`);
    return cases;
  } catch (e) {
    log.warn(`Failed to load Message custom cases: ${e.message}`);
    return [];
  }
}

function defaultSmokeTexts(combination) {
  return [
    `QA Smoke — Message connectivity check [${combination}]\nPlain text seed for migration QA.`,
  ];
}

function defaultSanityTexts(combination) {
  return [
    `QA Sanity — Channel/DM text [${combination}]\nVerify plain text migrates with timestamps.`,
    `QA Sanity — Unicode & emoji [${combination}]\nTest: ❤️ ✅ Thread markers 👍`,
    `QA Sanity — Attachment note [${combination}]\n(Attach files manually if API upload not configured.)`,
  ];
}

class MessageTestDataAgent extends BaseAgent {
  constructor() {
    super('MessageTestDataAgent');
  }

  async execute(context) {
    const log = logger.child({ agent: this.name, executionId: context.executionId });
    const testType = context.testType || 'E2E';
    const combination =
      context.messageCombination || 'Slack → Google Chat';
    const platform = parseMessageSourcePlatform(combination);
    const sourceEmail = context.sourceEmail;

    const summary = {
      testType,
      combination,
      platform,
      messagesPosted: 0,
      errors: [],
    };

    if (context.messageAdmins && Object.keys(context.messageAdmins).length > 0) {
      log.info(`Message admins on file: ${JSON.stringify(context.messageAdmins)}`);
    }
    log.info(`Seeding ${platform} messages for ${sourceEmail} [${testType}] (${combination})`);

    if (testType === 'E2E') {
      log.warn('E2E for Message: use SANITY or SMOKE; E2E uses SANITY-level seeds.');
    }

    const effectiveType = testType === 'SMOKE' ? 'SMOKE' : 'SANITY';
    let texts = [];

    const custom = loadMessageCustomTestCases(effectiveType, log);
    for (const tc of custom) {
      const line = [tc.subject, tc.textBody].filter(Boolean).join('\n\n');
      if (line.trim()) texts.push(line.trim());
    }

    if (texts.length === 0) {
      texts =
        effectiveType === 'SMOKE'
          ? defaultSmokeTexts(combination)
          : defaultSanityTexts(combination);
    }

    for (let i = 0; i < texts.length; i++) {
      const text = texts[i];
      const customCase = custom[i];
      try {
        await this._postForPlatform(platform, sourceEmail, text, customCase, log);
        summary.messagesPosted++;
      } catch (err) {
        const msg = err.message || String(err);
        summary.errors.push(msg);
        log.error(`Post failed (${platform}): ${msg}`);
      }
    }

    if (summary.messagesPosted === 0 && summary.errors.length > 0) {
      throw new Error(
        `MessageTestDataAgent: no messages posted. ${summary.errors[0]}. Configure env vars for ${platform}.`
      );
    }

    log.info(`Message seeding complete: ${JSON.stringify(summary)}`);
    return summary;
  }

  async _postForPlatform(platform, sourceEmail, text, customCase, log) {
    const ch = (customCase && customCase.messageChannelId) || slackDefaultChannel();
    const space =
      (customCase && customCase.messageSpaceId) || googleChatSpace();
    const { teamId, channelId } = teamsIds();
    const overrideTeam = customCase && customCase.messageTeamId;
    const overrideChan = customCase && customCase.messageChannelId;

    switch (platform) {
      case 'slack': {
        const tok = slackToken();
        if (!tok) {
          throw new Error('Set SLACK_USER_TOKEN or SLACK_BOT_TOKEN and SLACK_CHANNEL_ID (or messageChannelId on the test case).');
        }
        const channel = ch;
        if (!channel) {
          throw new Error('Set SLACK_CHANNEL_ID or save messageChannelId on the custom test case.');
        }
        log.info('Posting to Slack…');
        return postSlackMessage(tok, channel, text);
      }
      case 'gchat': {
        if (!space) {
          throw new Error('Set GOOGLE_CHAT_SPACE (e.g. spaces/AAAA…) or messageSpaceId on the test case.');
        }
        log.info('Posting to Google Chat…');
        return postGoogleChatMessage(sourceEmail, space, text);
      }
      case 'teams': {
        const tid = overrideTeam || teamId;
        const cid = overrideChan || channelId;
        if (!tid || !cid) {
          throw new Error('Set TEAMS_TEAM_ID and TEAMS_CHANNEL_ID (or messageTeamId / messageChannelId on test cases).');
        }
        log.info('Posting to Microsoft Teams channel…');
        const tenantKey = env.GRAPH_TENANT_2_DOMAINS?.some((d) =>
          String(sourceEmail).toLowerCase().endsWith('@' + d)
        )
          ? '2'
          : '1';
        return postTeamsChannelMessage(tid, cid, text, tenantKey);
      }
      default:
        throw new Error(`Unknown platform: ${platform}`);
    }
  }
}

module.exports = MessageTestDataAgent;
