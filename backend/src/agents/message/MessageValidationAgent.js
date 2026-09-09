const { BaseAgent } = require('../core/BaseAgent');
const logger = require('../../utils/logger');
const chatMigrationClient = require('../../clients/chatMigrationClient');
const slackClient = require('../../clients/slackClient');
const outlookClient = require('../../clients/outlookClient');
const tokenStore = require('../../clients/oauthTokenStore');
const executionService = require('../../services/executionService');

const POLL_INTERVAL_MS = 20_000;
const MAX_WAIT_MS = 10 * 60 * 1000;

// CF writes channel-record (counter N) then Teams-job record (counter N+1).
function teamsJobIdFromChannelId(hexId) {
  if (!hexId || hexId.length !== 24 || !/^[0-9a-f]+$/i.test(hexId)) return null;
  const counter = parseInt(hexId.slice(18), 16);
  return hexId.slice(0, 18) + ((counter + 1) & 0xFFFFFF).toString(16).padStart(6, '0');
}

const CF_PLATFORM = {
  slack: 'SLACK', teams: 'MICROSOFT_TEAMS', microsoft: 'MICROSOFT_TEAMS',
  microsoft_teams: 'MICROSOFT_TEAMS', google: 'GOOGLE_CHAT', googlechat: 'GOOGLE_CHAT',
  google_chat: 'GOOGLE_CHAT',
};
const COMBINATION_CODE = {
  SLACK_MICROSOFT_TEAMS: 'S2T', SLACK_GOOGLE_CHAT: 'S2C', SLACK_SLACK: 'S2S',
  MICROSOFT_TEAMS_MICROSOFT_TEAMS: 'T2T', MICROSOFT_TEAMS_GOOGLE_CHAT: 'T2C',
  MICROSOFT_TEAMS_SLACK: 'T2S', GOOGLE_CHAT_MICROSOFT_TEAMS: 'C2T',
  GOOGLE_CHAT_GOOGLE_CHAT: 'C2C', GOOGLE_CHAT_SLACK: 'C2S',
};

function combinationCode(context) {
  const src = CF_PLATFORM[(context.sourcePlatform || '').toLowerCase()] || 'SLACK';
  const dst = CF_PLATFORM[(context.destinationPlatform || '').toLowerCase()] || 'MICROSOFT_TEAMS';
  return COMBINATION_CODE[`${src}_${dst}`] || `${src[0]}2${dst[0]}`;
}

function normalizeChannelName(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// ─── Feature definitions ─────────────────────────────────────────────────────
// Each entry describes one Slack→Teams feature to validate.
// tolerance: fraction of source value allowed as delta before flagging
// knownLimitation: CF is known NOT to migrate this — flag as KNOWN_LIMITATION not BUG
const FEATURES = [
  {
    key: 'messages',
    label: 'Messages',
    srcField: 'messageCount',
    dstField: 'messageCount',
    cfField: 'processedMessages',
    severity: 'CRITICAL',
    // 5% tolerance: accounts for bot messages that Slack counts but CF may not migrate,
    // and minor discrepancies from system subtypes that differ between platforms.
    tolerance: 0.05,
    knownLimitation: false,
    description: 'Total user messages migrated from Slack to Teams',
    impact: 'Users will find fewer messages in Teams than in the original Slack channel.',
  },
  {
    key: 'files',
    label: 'File attachments',
    srcField: 'fileCount',
    dstField: 'fileCount',
    cfField: null,
    severity: 'HIGH',
    // 20% tolerance: Slack fileCount includes ALL file types (inline images, snippets,
    // audio, video), but Teams fileCount only counts contentType='reference' attachments.
    // Inline images are stored in Teams message HTML, not as reference attachments.
    // This structural difference is NOT a migration bug — use a wider tolerance to avoid
    // false positives when the content is fully present.
    tolerance: 0.20,
    knownLimitation: false,
    description: 'Files attached to messages (Slack files → Teams file references)',
    impact: 'Users will be missing attachments/documents that were shared in Slack.',
  },
  {
    key: 'threadReplies',
    label: 'Thread replies',
    srcField: 'totalReplyCount',
    dstField: 'threadReplyCount',
    cfField: null,
    severity: 'HIGH',
    // 10% tolerance: Slack reply_count field on thread parents can be stale (includes
    // deleted replies that no longer exist). Teams counts only live replies. A small
    // count gap is expected and is not a migration defect.
    tolerance: 0.10,
    knownLimitation: false,
    description: 'Thread reply messages (Slack threads → Teams reply threads)',
    impact: 'Conversations and discussion threads will be incomplete in Teams.',
  },
  {
    key: 'reactions',
    label: 'Emoji reactions',
    srcField: 'totalReactionCount',
    dstField: null,            // handled by explicit REACTIONS_NOT_MIGRATED block below (avoids double-report)
    cfField: null,
    severity: 'LOW',
    tolerance: 0,
    knownLimitation: true,
    description: 'Emoji reactions on messages (CloudFuze does not migrate reactions)',
    impact: 'Emoji reactions will not appear in Teams — this is an expected CloudFuze limitation.',
  },
  {
    key: 'mentions',
    label: '@User mentions',
    srcField: 'mentionMsgCount',
    dstField: 'mentionMsgCount',
    cfField: null,
    severity: 'MEDIUM',
    tolerance: 0.10,
    knownLimitation: false,
    description: '@User mentions remapped from Slack user IDs to Teams user identities',
    impact: 'Some @mentions may not notify the correct user in Teams.',
  },
  {
    key: 'pinnedMessages',
    label: 'Pinned messages',
    srcField: 'pinnedCount',
    dstField: null,          // Teams pins not counted (no easy API)
    cfField: null,
    severity: 'LOW',
    tolerance: 0,
    knownLimitation: true,
    description: 'Pinned messages (CloudFuze does not migrate Slack pins to Teams)',
    impact: 'Pinned messages will not be pinned in the destination Teams channel.',
  },
  {
    key: 'formattedMessages',
    label: 'Formatted messages',
    srcField: 'formattedMsgCount',
    dstField: null,          // Teams HTML body — not easily comparable
    cfField: null,
    severity: 'LOW',
    tolerance: 0,
    knownLimitation: true,
    description: 'Messages with Slack markdown (bold/italic/code/quotes) converted to Teams HTML',
    impact: 'Formatting may differ visually; content is preserved but presentation may change.',
  },
];

// ─── Agent ───────────────────────────────────────────────────────────────────

class MessageValidationAgent extends BaseAgent {
  constructor() {
    super('MessageValidationAgent');
  }

  async execute(context) {
    const log = logger.child({ agent: this.name, executionId: context.executionId });

    const migrationResult = context.sharedResults?.migrationResult;
    const chatResults = migrationResult?.chatMigrationResults || [];
    const initiated = chatResults.filter((r) => r.status === 'INITIATED');

    if (initiated.length === 0) {
      log.info('No initiated migration jobs — skipping validation');
      return {
        overallStatus: 'SKIPPED',
        bugs: [],
        mismatches: [],
        summary: null,
        channels: [],
        note: 'No channels/DMs were successfully initiated for migration.',
        productType: context.productType || 'Message',
        messageCombination: context.messageCombination || '',
      };
    }

    log.info(`MessageValidationAgent: validating ${initiated.length} initiated job(s)…`);

    // Build CF job-ID lookup maps
    const channelRecordIds = new Set();
    const teamsJobIds = new Set();
    const recordToTeamsJob = new Map();

    // Build bidirectional ID maps — CF may report a job by either the channel record ID
    // (r.jobId) or the derived Teams job ID (incrementing the MongoDB ObjectID counter).
    // Both directions are needed so _waitForCompletion can clear both entries when done.
    const channelToTeamsId = new Map(); // channel record ID → derived teams job ID
    const teamsToChannelId = new Map(); // derived teams job ID → channel record ID
    for (const r of initiated) {
      channelRecordIds.add(r.jobId);
      const teamsId = teamsJobIdFromChannelId(r.jobId);
      if (teamsId) {
        teamsJobIds.add(teamsId);
        channelToTeamsId.set(r.jobId, teamsId);
        teamsToChannelId.set(teamsId, r.jobId);
      }
      recordToTeamsJob.set(r.jobId, teamsId || r.jobId);
    }

    const combination = combinationCode(context);

    // Step 1 — wait for CF jobs to finish
    log.info('Step 1: Polling CF for job completion…');
    this._progress(context, 'Waiting for CF migration jobs to complete…');
    // Include BOTH channel record IDs and derived teams job IDs in the initial pending
    // set so CF can match by either ID format — and both entries are cleared on completion.
    const allPendingIds = new Set([...channelRecordIds, ...teamsJobIds]);
    const jobReports = await this._waitForCompletion(
      context, combination, allPendingIds, channelRecordIds, channelToTeamsId, teamsToChannelId, log
    );

    // Step 1b — read Slack source data NOW (before any Teams read) — captures the original state
    log.info('Step 1b: Reading Slack source messages for baseline comparison…');
    this._progress(context, 'Reading Slack source messages…');
    const sourceStatsMap = await this._fetchAllSourceStats(context, initiated, log);

    // Step 1c — confirm Teams channels are closed, then wait for messages to become visible
    const isDstTeams = (context.destinationPlatform || '').toLowerCase().includes('teams') ||
                       (context.destinationPlatform || '').toLowerCase().includes('microsoft');
    if (isDstTeams) {
      const channelIdsToWait = initiated.filter(r => r.kind !== 'dm').map(r => r.target);
      log.info(`Step 1c: Confirming Teams channels are closed (${channelIdsToWait.length} channel(s))…`);
      this._progress(context, 'Confirming Teams channels are closed…');
      await chatMigrationClient.waitForChannelsClosed(channelIdsToWait, 90_000);
      log.info('Step 1c: Teams channels confirmed closed — proceeding to count-based validation');
      this._progress(context, 'Teams channels closed — reading destination channel stats…');
    }

    // Steps 2+3 — read destination Teams stats (channel discovery + message count)
    // Same methodology as email validation: count-based comparison, no deep content read.
    // If Teams Graph API returns 403 (missing ChannelMessage.Read.All), fall back to CF report counts.
    log.info('Steps 2+3: Querying Teams destination (channel discovery and message counts)…');
    this._progress(context, 'Querying Teams destination…');
    const destStatsMap = await this._fetchAllDestStats(context, initiated, log, jobReports, recordToTeamsJob);

    // Step 4 — deep per-message comparison (combination-specific handler).
    // Dispatches to validation/combinations/message/<combo>.js, mirroring how the
    // mail system dispatches to gmailToOutlook.js / outlookToOutlook.js etc.
    // Only runs when Teams Graph API is accessible (403 → skip, use CF counts instead).
    log.info('Step 4: Deep per-message comparison (source ↔ destination)…');
    this._progress(context, 'Reading and comparing individual messages source ↔ destination…');
    const deepCompareMap = await this._runDeepComparison(context, combination, initiated, destStatsMap, log);

    // Step 5 — build report (count-based summary + per-message bugs from deep compare)
    return this._buildReport(
      context, initiated, recordToTeamsJob, jobReports, sourceStatsMap, destStatsMap, deepCompareMap, log
    );
  }

  _progress(context, msg) {
    if (context.executionId) {
      executionService.update(context.executionId, { progress: msg });
    }
  }

  // ─── Step 4: Deep per-message comparison ─────────────────────────────────────
  // Dispatches to the appropriate combination handler file, mirroring the mail
  // validation system's dispatch to gmailToOutlook.js / outlookToOutlook.js etc.
  // Returns Map<channelId, deepResult> — null entries mean deep compare was skipped.

  async _runDeepComparison(context, combination, initiated, destStatsMap, log) {
    const map = new Map();

    // Only Slack→Teams has a combination handler at this time.
    // Other combinations (S2C, T2T, …) fall through and return an empty map.
    if (combination !== 'S2T') {
      log.info(`Deep comparison not implemented for combination ${combination} — skipping`);
      return map;
    }

    let validateSlackToTeams;
    try {
      ({ validateSlackToTeams } = require('../../validation/combinations/message/slackToTeams'));
    } catch (e) {
      log.warn(`Could not load slackToTeams combination handler: ${e.message}`);
      return map;
    }

    const srcAdminEmail = context.sourceAdminEmail || context.sourceEmail;
    const destEmail     = context.destinationEmail;

    for (const r of initiated) {
      if (r.kind === 'dm') {
        // Slack DM → Teams chat ID is not resolvable via Graph API
        log.info(`Deep compare skipped for DM ${r.target} (not resolvable via Graph API)`);
        continue;
      }

      const dst = destStatsMap.get(r.target);

      if (!dst?.found) {
        log.info(`Deep compare skipped for ${r.target}: channel not found at destination`);
        continue;
      }

      if (dst.graphAccessible === false) {
        log.info(`Deep compare skipped for "${dst.channelName}": Teams Graph API returned 403 — ChannelMessage.Read.All not granted`);
        continue;
      }

      this._progress(context, `Deep comparing "${dst.channelName}" (source ↔ destination)…`);

      try {
        const deepResult = await validateSlackToTeams({
          srcAdminEmail,
          destEmail,
          slackChannelId: r.target,
          teamId:         dst.teamId,
          channelId:      dst.channelId,
          channelName:    dst.channelName,
          log,
        });
        map.set(r.target, deepResult);
      } catch (e) {
        log.warn(`Deep comparison failed for ${r.target} ("${dst.channelName}"): ${e.message}`);
        // Non-blocking — a failed deep compare does not abort the overall run
      }
    }

    return map;
  }

  // ─── Step 1: Poll CF until terminal ────────────────────────────────────────

  async _waitForCompletion(context, combination, pendingSet, channelRecordIds, channelToTeamsId, teamsToChannelId, log) {
    const jobReports = new Map();
    const deadline = Date.now() + MAX_WAIT_MS;
    let firstPoll = true;

    while (pendingSet.size > 0 && Date.now() < deadline) {
      try {
        const reports = await chatMigrationClient.getMigrationReports({
          combination, migrationStatus: 'All', context,
        });

        if (firstPoll && reports.length > 0) {
          log.info(`CF poll: ${reports.length} report(s) — sample keys: ${JSON.stringify(reports[0]).slice(0, 300)}`);
        }

        for (const job of reports) {
          const reportId = String(job.id || job._id || '');
          if (!reportId) continue;

          let matched = pendingSet.has(reportId);
          if (!matched && Array.isArray(job.listOfMessageWorkspaceId)) {
            matched = job.listOfMessageWorkspaceId.some((w) => channelRecordIds.has(String(w)));
          }
          if (!matched) continue;

          const rawStatus = job.jobStatus || job.migrationStatus || job.status || '';
          const st = rawStatus.toLowerCase().replace(/\s+/g, '');
          const isDone =
            st.includes('processed') || st.includes('completed') ||
            st.includes('partial') || st.includes('failed');

          if (!isDone) {
            if (firstPoll) {
              log.info(`CF job ${reportId}: "${rawStatus}" totalMessages=${job.totalMessages} — waiting`);
            }
            continue;
          }

          pendingSet.delete(reportId);
          // Clear paired ID (channel record ↔ derived teams job) from pendingSet so one
          // report settling both doesn't leave a ghost entry and block the polling loop.
          const pairedToReport = channelToTeamsId?.get(reportId) || teamsToChannelId?.get(reportId);
          if (pairedToReport) pendingSet.delete(pairedToReport);
          if (Array.isArray(job.listOfMessageWorkspaceId)) {
            for (const w of job.listOfMessageWorkspaceId) {
              const wStr = String(w);
              pendingSet.delete(wStr);
              const wPaired = channelToTeamsId?.get(wStr) || teamsToChannelId?.get(wStr);
              if (wPaired) pendingSet.delete(wPaired);
              // Index by channel record ID so _buildReport can look up by r.jobId
              if (channelRecordIds.has(wStr)) jobReports.set(wStr, job);
            }
          }
          jobReports.set(reportId, job);
          // Also index by paired ID so lookups from either direction work
          if (pairedToReport) jobReports.set(pairedToReport, job);
          log.info(
            `CF job ${reportId}: "${rawStatus}" | ` +
            `picked=${job.totalMessages} processed=${job.processedMessages} notDone=${job.notProcessedMessage}`
          );
        }
        firstPoll = false;
      } catch (err) {
        log.warn(`CF poll error: ${err.message}`);
      }

      if (pendingSet.size === 0) break;
      const channelsPending = [...pendingSet].filter((id) => channelRecordIds.has(id)).length;
      this._progress(context, `Waiting for ${channelsPending} channel(s) migration to complete…`);
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    // On timeout capture last-known state of any still-pending jobs
    if (pendingSet.size > 0) {
      log.warn(`${pendingSet.size} job(s) still running after ${MAX_WAIT_MS / 1000}s — capturing last snapshot`);
      try {
        const snapshots = await chatMigrationClient.getMigrationReports({
          combination, migrationStatus: 'All', context,
        });
        for (const job of snapshots) {
          const id = String(job.id || job._id || '');
          if (!id || jobReports.has(id)) continue;
          let matched = pendingSet.has(id);
          if (!matched && Array.isArray(job.listOfMessageWorkspaceId)) {
            matched = job.listOfMessageWorkspaceId.some((w) => channelRecordIds.has(String(w)));
          }
          if (matched) {
            jobReports.set(id, job);
            log.info(`CF job ${id}: captured as IN_PROGRESS snapshot`);
          }
        }
      } catch { /* best effort */ }
    }

    return jobReports;
  }

  // ─── Step 2: Slack source stats ─────────────────────────────────────────────

  async _fetchAllSourceStats(context, initiated, log) {
    const map = new Map();
    if (!(context.sourcePlatform || '').toLowerCase().includes('slack')) {
      log.info('Source is not Slack — skipping source stats');
      return map;
    }
    const adminEmail = context.sourceAdminEmail || context.sourceEmail;
    if (!slackClient.hasSlackToken(adminEmail)) {
      log.warn(`No Slack token for ${adminEmail} — source stats unavailable`);
      return map;
    }
    for (const r of initiated) {
      log.info(`Querying Slack ${r.kind} ${r.target}…`);
      try {
        const stats = await slackClient.getChannelStats(adminEmail, r.target);
        map.set(r.target, stats);
        if (stats.error) {
          log.warn(`Slack ${r.target}: ${stats.error}`);
        } else {
          log.info(
            `Slack ${r.target}: msgs=${stats.messageCount} files=${stats.fileCount} ` +
            `threadParents=${stats.threadParentCount} replies=${stats.totalReplyCount} ` +
            `reactionMsgs=${stats.reactionMsgCount} totalReactions=${stats.totalReactionCount} ` +
            `mentionMsgs=${stats.mentionMsgCount} pinned=${stats.pinnedCount} formatted=${stats.formattedMsgCount}`
          );
        }
      } catch (err) {
        log.warn(`Slack stats for ${r.target} failed — skipping: ${err.message}`);
      }
    }
    return map;
  }

  // ─── Step 3: Teams destination stats ────────────────────────────────────────

  async _fetchAllDestStats(context, initiated, log, jobReports, recordToTeamsJob) {
    const map = new Map();
    const dstPlatform = (context.destinationPlatform || '').toLowerCase();
    if (!dstPlatform.includes('teams') && !dstPlatform.includes('microsoft')) {
      log.info('Destination is not Teams — skipping dest stats');
      return map;
    }
    const destEmail = context.destinationEmail;
    if (!destEmail) { log.warn('No destination email — Teams stats unavailable'); return map; }

    let hasToken = false;
    try { hasToken = outlookClient.hasTeamsToken(destEmail); } catch { /* no token */ }
    if (!hasToken) { log.warn(`No Teams token for ${destEmail}`); return map; }

    // Build channel-name map: context objects first (destChannelName preferred),
    // then override/enrich with CF job report's jobName (actual Teams channel name)
    const nameMap = new Map();
    for (const obj of (context.channelObjects || [])) {
      nameMap.set(obj.id, obj.destChannelName || obj.name || obj.channelName || obj.id);
    }
    for (const obj of (context.dmObjects || [])) {
      nameMap.set(obj.id, obj.name || obj.id);
    }
    // Enrich with CF report data — only use CF name when context has no meaningful channel name.
    // CF jobName is often the batch migration job name (e.g. "10-channels"), NOT the individual
    // Teams channel name. The Slack channel name from context is more accurate for the lookup.
    // CF destChannelName/channelName (when present) is more reliable than jobName.
    if (jobReports && recordToTeamsJob) {
      for (const r of initiated) {
        const teamsId = recordToTeamsJob.get(r.jobId) || r.jobId;
        const cfReport = jobReports.get(teamsId);
        if (!cfReport) continue;
        const existingName = nameMap.get(r.target);
        const contextHasChannelName = existingName && existingName !== r.target;
        // Prefer CF-provided per-channel name fields over the batch jobName
        const cfSpecificName = cfReport.destChannelName || cfReport.channelName || null;
        if (cfSpecificName && cfSpecificName !== cfReport.jobName) {
          // CF gave us a specific channel name — always use it (it's more authoritative)
          nameMap.set(r.target, cfSpecificName);
          log.info(`Channel ${r.target}: using CF destChannelName="${cfSpecificName}" for Teams lookup`);
        } else if (!contextHasChannelName && cfReport.jobName) {
          // Context had no meaningful name (only the raw channel ID) — fall back to CF jobName
          nameMap.set(r.target, cfReport.jobName);
          log.info(`Channel ${r.target}: no context name — using CF jobName="${cfReport.jobName}" for Teams lookup`);
        } else if (contextHasChannelName) {
          log.info(`Channel ${r.target}: using context name="${existingName}" for Teams lookup (CF jobName="${cfReport.jobName || 'none'}")`);
        }
      }
    }

    // Collect all expected destination team names from context AND from CF reports
    const expectedTeamNames = new Set();
    for (const obj of (context.channelObjects || [])) {
      if (obj.destTeamName) expectedTeamNames.add(obj.destTeamName.toLowerCase().replace(/[^a-z0-9]/g, ''));
    }
    if (jobReports) {
      for (const [, cfReport] of jobReports) {
        const dtn = cfReport?.destTeamName || cfReport?.workSpaceName;
        if (dtn) expectedTeamNames.add(dtn.toLowerCase().replace(/[^a-z0-9]/g, ''));
      }
    }

    // Get Slack workspace name to narrow the Teams team search
    const slackAcct = tokenStore.getSlackToken(context.sourceEmail || context.sourceAdminEmail);
    const workspaceName = slackAcct?.teamName || null;

    log.info(`Building Teams channel index for ${destEmail} (workspace: ${workspaceName || 'unknown'}, expected teams: ${expectedTeamNames.size})…`);
    const normWS = workspaceName ? workspaceName.toLowerCase().replace(/[^a-z0-9]/g, '') : '';

    function teamMatchesScope(t) {
      const normT = t.displayName.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (normWS && normT.includes(normWS)) return true;
      for (const dn of expectedTeamNames) {
        if (dn && normT.includes(dn)) return true;
      }
      return false;
    }

    // Step A: joined teams (delegated token — fast, returns only teams admin is a member of).
    // CF-created teams are owned by CF's service account, so the admin may NOT be a member.
    const joinedTeams = await outlookClient.listJoinedTeams(destEmail).catch(() => []);
    log.info(`${destEmail}: ${joinedTeams.length} joined team(s)`);
    const matchedJoined = joinedTeams.filter(teamMatchesScope);

    // Step B: app-only ALL-teams (run when joined teams have no name match, so CF-created teams
    // are always found regardless of admin membership). Called ONCE here so the per-channel
    // lookup tiers can use O(1) index lookups instead of re-fetching in every parallel branch.
    let appAllTeams = [];
    if (matchedJoined.length === 0) {
      log.warn(`No joined team matched workspace/destTeamName — fetching all Teams (app-only) to find CF-created teams…`);
      appAllTeams = await outlookClient.listAllTeams(destEmail).catch(() => []);
      log.info(`App-only: ${appAllTeams.length} total team(s) in tenant`);
    }

    // Combine: joined + app-only (deduplicated). Filter to name-matched candidates;
    // if still nothing matches, fall back to ALL app-only teams so we never miss a channel.
    const seenTeamIds = new Set(joinedTeams.map((t) => t.id));
    const combined = [...joinedTeams, ...appAllTeams.filter((t) => !seenTeamIds.has(t.id))];
    const matchedByName = combined.filter(teamMatchesScope);
    let candidateTeams = matchedByName.length > 0 ? matchedByName : combined;
    if (matchedByName.length === 0 && candidateTeams.length > 0) {
      log.warn(
        `No team matched workspace "${workspaceName}" or destTeamName in ${combined.length} team(s) — ` +
        `searching all ${candidateTeams.length} team(s) for channels. ` +
        `Set destTeamName in channelObjects to narrow the search.`
      );
    }
    log.info(`Candidate teams for channel index: ${candidateTeams.length} (${matchedByName.length} matched by name)`);

    // Build channel index: fetch channels for ALL candidate teams in parallel batches.
    // listTeamChannels now uses app-only fallback on 403, so CF-created teams are accessible
    // even when the admin user is not a member.
    const CHAN_BATCH = 20;
    const channelIndex = [];
    for (let i = 0; i < candidateTeams.length; i += CHAN_BATCH) {
      const batch = candidateTeams.slice(i, i + CHAN_BATCH);
      const batchResults = await Promise.all(
        batch.map((team) =>
          outlookClient.listTeamChannels(destEmail, team.id).catch(() => []).then((chs) =>
            chs.map((ch) => ({ teamId: team.id, teamName: team.displayName, channelId: ch.id, channelName: ch.displayName }))
          )
        )
      );
      batchResults.forEach((chs) => channelIndex.push(...chs));
    }
    log.info(`Teams channel index: ${channelIndex.length} channel(s) across ${candidateTeams.length} team(s)`);

    // Fetch message stats for all found channels in parallel
    // Build a local Teams destination map from CF job reports.
    // Used as a TIER-0 fallback when the in-memory _teamsDestinations map is empty
    // (e.g. server restarted between migration and validation, or CF completed so fast
    // that pollAndCloseTeams ran before MessageValidationAgent registered its listener).
    const jobReportTeamsIds = new Map();
    if (jobReports && recordToTeamsJob) {
      for (const r of initiated) {
        const teamsId = recordToTeamsJob.get(r.jobId) || r.jobId;
        const cfRpt   = jobReports.get(teamsId);
        if (!cfRpt) continue;
        const rawToRootId = String(cfRpt.toRootId || '').trim();
        const toRootIsGuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawToRootId);
        const teamId =
          cfRpt.teamId       || cfRpt.toTeamId    || cfRpt.msTeamId      ||
          cfRpt.teamsTeamId  || cfRpt.destTeamId  || cfRpt.targetTeamId  ||
          cfRpt.destinationTeamId || (toRootIsGuid ? rawToRootId : null) || null;
        const channelId =
          cfRpt.toChannelId       || cfRpt.msChannelId    || cfRpt.teamsChannelId ||
          cfRpt.destChannelId     || cfRpt.targetChannelId ||
          (!toRootIsGuid && rawToRootId && rawToRootId !== '/' ? rawToRootId : null) || null;
        const cfChannelName = cfRpt.destChannelName || cfRpt.toChannelName || null;
        const cfTeamName    = cfRpt.destTeamName    || cfRpt.toTeamName    || cfRpt.workSpaceName || null;
        if (teamId || channelId) {
          jobReportTeamsIds.set(r.target, { teamId, channelId, channelName: cfChannelName, teamName: cfTeamName });
          log.info(`CF jobReport: found Teams IDs for Slack ch ${r.target}: teamId=${teamId} channelId=${channelId}`);
        }
      }
    }

    const channelFetches = initiated.map(async (r) => {
      if (r.kind === 'dm') {
        return { target: r.target, result: { found: false, note: 'Slack DM → Teams chat ID not resolvable via API' } };
      }
      const targetName = nameMap.get(r.target) || r.target;
      const norm = normalizeChannelName(targetName);
      // Get the CF report for this channel so we can use jobName as a fallback
      const _teamsId = recordToTeamsJob ? (recordToTeamsJob.get(r.jobId) || r.jobId) : r.jobId;
      const _cfReport = jobReports ? jobReports.get(_teamsId) : null;

      let match = null;

      // ── TIER 0: CF-stored Teams IDs ─────────────────────────────────────────
      // Two sources:
      //   a) In-memory _teamsDestinations — populated by pollAndCloseTeams background poller
      //      reading CF's close response. Fast but lost on server restart.
      //   b) jobReportTeamsIds — parsed directly from the CF job reports that
      //      _waitForCompletion already fetched above. Survives server restarts.
      // Both are tried because CF may populate IDs in the report but not the close response
      // (or vice versa), and different CF versions use different field names.
      const cfDest = chatMigrationClient.getTeamsDestination(r.target) || jobReportTeamsIds.get(r.target) || null;
      if (cfDest?.teamId && cfDest?.channelId) {
        match = {
          teamId:      cfDest.teamId,
          teamName:    cfDest.teamName    || `CF-created (${r.target})`,
          channelId:   cfDest.channelId,
          channelName: cfDest.channelName || targetName,
        };
        log.info(
          `Teams: TIER-0 direct match for "${targetName}" via CF-stored IDs: ` +
          `team="${match.teamName}" (${match.teamId}) channel="${match.channelName}" (${match.channelId})`
        );
      } else if (cfDest?.teamId && !cfDest?.channelId) {
        // CF gave us the team ID (likely from toRootId GUID) but no channel ID.
        // Enumerate the team's channels and match by name, falling back to General or first channel.
        try {
          const chs = await outlookClient.listTeamChannels(destEmail, cfDest.teamId).catch(() => []);
          const found =
            chs.find((c) => normalizeChannelName(c.displayName) === norm) ||
            chs.find((c) => c.displayName.toLowerCase() === 'general') ||
            chs[0];
          if (found) {
            match = {
              teamId:      cfDest.teamId,
              teamName:    cfDest.teamName || `CF-created (${r.target})`,
              channelId:   found.id,
              channelName: found.displayName,
            };
            log.info(
              `Teams: TIER-0 partial match for "${targetName}" — teamId from CF, channelId from enumeration: ` +
              `team="${match.teamName}" (${match.teamId}) channel="${match.channelName}" (${match.channelId})`
            );
          }
        } catch (e) {
          log.warn(`Teams: TIER-0 channel enumeration failed for team ${cfDest.teamId}: ${e.message}`);
        }
      }

      // ── TIER 1: Name-based search in joined-teams channel index ─────────────────
      if (!match) {
        // 1a) Exact normalized match
        match = channelIndex.find((c) => normalizeChannelName(c.channelName) === norm);

        // 1b) Partial / contains match — handles CF adding prefixes/suffixes or minor transforms.
        if (!match && norm.length >= 5) {
          match = channelIndex.find((c) => {
            const cn = normalizeChannelName(c.channelName);
            if (cn.includes(norm)) return true;
            if (norm.includes(cn) && cn.length >= 4 && cn.length / norm.length >= 0.5) return true;
            return false;
          });
          if (match) log.info(`Teams: partial match "${targetName}" → "${match.channelName}" in team "${match.teamName}"`);
        }

        // 1c) Alt Slack channel name from channelObjects
        if (!match) {
          const altObj = (context.channelObjects || []).find((o) => o.id === r.target);
          if (altObj) {
            const altNorm = normalizeChannelName(altObj.channelName || altObj.name || '');
            if (altNorm && altNorm !== norm) {
              match = channelIndex.find((c) => normalizeChannelName(c.channelName) === altNorm);
              if (match) log.info(`Teams: alt-name match "${altObj.channelName || altObj.name}" → "${match.channelName}" in "${match.teamName}"`);
            }
          }
        }

        // 1d) CF jobName fallback
        if (!match && _cfReport?.jobName) {
          const cfJobNorm = normalizeChannelName(_cfReport.jobName);
          if (cfJobNorm.length >= 3 && cfJobNorm !== norm) {
            match = channelIndex.find((c) => normalizeChannelName(c.channelName) === cfJobNorm);
            if (match) {
              log.info(`Teams: CF-jobName exact match "${_cfReport.jobName}" → "${match.channelName}" in "${match.teamName}"`);
            } else if (cfJobNorm.length >= 5) {
              match = channelIndex.find((c) => {
                const cn = normalizeChannelName(c.channelName);
                if (cn.includes(cfJobNorm)) return true;
                if (cfJobNorm.includes(cn) && cn.length >= 4 && cn.length / cfJobNorm.length >= 0.5) return true;
                return false;
              });
              if (match) log.info(`Teams: CF-jobName partial match "${_cfReport.jobName}" → "${match.channelName}" in "${match.teamName}"`);
            }
          }
        }

        // 1e) CF creates a Teams TEAM per Slack channel — match by team displayName, pick General
        if (!match) {
          const teamByName = channelIndex.find((c) => {
            const tn = normalizeChannelName(c.teamName);
            if (tn === norm) return true;
            if (norm.length >= 5) {
              if (tn.includes(norm)) return true;
              if (norm.includes(tn) && tn.length >= 4 && tn.length / norm.length >= 0.5) return true;
            }
            return false;
          });
          if (teamByName) {
            const channelsInTeam = channelIndex.filter((c) => c.teamId === teamByName.teamId);
            const sameNameCh = channelsInTeam.find((c) => normalizeChannelName(c.channelName) === norm);
            match = sameNameCh ||
                    channelsInTeam.find((c) => c.channelName.toLowerCase() === 'general') ||
                    channelsInTeam[0];
            if (match) log.info(`Teams: team-name match "${targetName}" → team="${match.teamName}" channel="${match.channelName}"`);
          }
        }
      }

      // ── TIER 2: App-only ALL-teams search ──────────────────────────────────────
      // Fallback when the team isn't in listJoinedTeams (e.g. CF-created team with slow
      // Azure AD membership propagation, or the admin account isn't a team member yet).
      // Uses app-only client credentials — requires Team.ReadBasic.All or Group.Read.All.
      if (!match) {
        log.warn(
          `Teams: "${targetName}" not found in ${channelIndex.length} indexed channel(s) across ` +
          `${candidateTeams.length} candidate team(s) — trying TIER-2 app-only exhaustive search…`
        );
        try {
          // The upfront index already used listAllTeams when no joined team matched, so
          // TIER-2 only needs to cover teams NOT yet in the index (edge case: new teams
          // created after the index was built, or pagination gaps). No 30-team cap here.
          const tier2All = await outlookClient.listAllTeams(destEmail);
          const indexedTeamIds = new Set(channelIndex.map((c) => c.teamId));
          const tier2New = tier2All.filter((t) => !indexedTeamIds.has(t.id));
          log.info(`Teams: TIER-2 app-only: ${tier2All.length} total, ${tier2New.length} not yet in index`);

          for (const team of tier2New) {
            const chs = await outlookClient.listTeamChannels(destEmail, team.id).catch(() => []);
            const found = chs.find((c) => {
              const cn = normalizeChannelName(c.displayName);
              if (cn === norm) return true;
              if (norm.length >= 5) {
                if (cn.includes(norm)) return true;
                if (norm.includes(cn) && cn.length >= 4 && cn.length / norm.length >= 0.5) return true;
              }
              return false;
            }) || ((normalizeChannelName(team.displayName) === norm || (norm.length >= 5 && normalizeChannelName(team.displayName).includes(norm)))
              ? chs.find((c) => c.displayName.toLowerCase() === 'general') || chs[0]
              : null);

            if (found) {
              match = {
                teamId:      team.id,
                teamName:    team.displayName,
                channelId:   found.id,
                channelName: found.displayName,
              };
              log.info(
                `Teams: TIER-2 app-only match for "${targetName}" → ` +
                `team="${match.teamName}" channel="${match.channelName}" (${match.channelId})`
              );
              break;
            }
          }
        } catch (e) {
          log.warn(`Teams: app-only ALL-teams search failed: ${e.message}`);
        }
      }

      // ── TIER 3: OData displayName filter search ───────────────────────────────
      // Directly queries Groups API by team displayName — bypasses listJoinedTeams
      // membership requirement and the all-teams iteration cap of TIER-2.
      // CF names the Teams team after the Slack workspace (e.g. "pepperwood") or
      // after the channel (e.g. "cfqamsg-randommessage") depending on configuration.
      // Requires Group.Read.All (application) or at minimum Team.ReadBasic.All.
      if (!match) {
        const teamNameCandidates = [
          workspaceName,                                      // Slack workspace → Teams team
          targetName,                                         // Slack channel name → Teams team
          _cfReport?.destTeamName,                           // CF-reported dest team name
          _cfReport?.workSpaceName,                          // CF workspace name
          _cfReport?.jobName,                                // CF job name (may equal channel name)
          (context.channelObjects || []).find((o) => o.id === r.target)?.destTeamName,
        ].filter((n) => n && typeof n === 'string' && n.trim().length >= 3 && n !== r.target);

        const triedNames = new Set();
        const joinedTeamIdSet = new Set(channelIndex.map((c) => c.teamId));

        for (const candidate of [...new Set(teamNameCandidates)]) {
          const candidateTrim = candidate.trim();
          if (triedNames.has(candidateTrim.toLowerCase())) continue;
          triedNames.add(candidateTrim.toLowerCase());
          try {
            const teams = await outlookClient.searchTeamByDisplayName(destEmail, candidateTrim);
            for (const team of teams) {
              if (joinedTeamIdSet.has(team.id)) continue; // already searched in TIER-1
              const chs = await outlookClient.listTeamChannels(destEmail, team.id).catch(() => []);
              // Look for channel by name first; fall back to General or first channel
              const found =
                chs.find((c) => normalizeChannelName(c.displayName) === norm) ||
                chs.find((c) => c.displayName.toLowerCase() === 'general') ||
                chs[0];
              if (found) {
                match = {
                  teamId:      team.id,
                  teamName:    team.displayName,
                  channelId:   found.id,
                  channelName: found.displayName,
                };
                log.info(
                  `Teams: TIER-3 OData match for "${targetName}" via team name "${candidateTrim}" → ` +
                  `team="${match.teamName}" (${match.teamId}) channel="${match.channelName}" (${match.channelId})`
                );
                break;
              }
            }
            if (match) break;
          } catch (e) {
            log.warn(`Teams: TIER-3 OData search for team "${candidateTrim}" failed: ${e.message}`);
          }
        }
      }

      if (!match) {
        log.warn(
          `Teams: channel "${targetName}" not found after all 4 lookup tiers ` +
          `(CF IDs: ${cfDest ? 'attempted but incomplete' : 'none stored'}, ` +
          `joined-teams: ${channelIndex.length} channels, app-only: attempted, OData: attempted)`
        );
        return {
          target: r.target,
          result: {
            found: false,
            channelName: targetName,
            note: `"${targetName}" not found after 4-tier search (CF IDs: ${cfDest ? 'incomplete' : 'none'}, joined-teams: ${channelIndex.length} channels, app-only + OData fallbacks attempted)`,
          },
        };
      }

      log.info(`Teams: "${match.channelName}" in team "${match.teamName}" — opening destination channel…`);

      // Complete the Teams migration in the correct order:
      // 1) Team-level completeMigration (required first by the Teams migration API)
      // 2) Channel-level completeMigration (transitions channel to standard/readable mode)
      // Both calls require Teamwork.Migrate.All (application permission) — app-only token is tried
      // first. HTTP 400 means already in standard mode and is treated as success (idempotent).
      await outlookClient.completeMigrationForTeam(destEmail, match.teamId);
      await outlookClient.completeMigrationForChannel(destEmail, match.teamId, match.channelId);

      log.info(`Teams: "${match.channelName}" opened — fetching channel stats…`);

      // Try to get Teams message count. If the Graph API returns 403 (missing
      // ChannelMessage.Read.All permission), stats.error will be set and messageCount = 0.
      // In that case, we fall back to CF report counts for validation (same as email
      // methodology uses destination folder counts — here we use CF as the count source).
      const stats = await outlookClient.countTeamsChannelMessages(destEmail, match.teamId, match.channelId);
      const hasGraphPermission = !stats.error || !String(stats.error).includes('403');

      if (!hasGraphPermission) {
        log.warn(`Teams "${match.channelName}": Graph API returned 403 — ChannelMessage.Read.All not granted. Validation will use CF report counts as destination proxy.`);
      } else {
        log.info(
          `Teams ${r.target} ("${match.channelName}"): msgs=${stats.messageCount} files=${stats.fileCount} ` +
          `reactionMsgs=${stats.reactionMsgCount} totalReactions=${stats.totalReactionCount} ` +
          `mentionMsgs=${stats.mentionMsgCount} replies=${stats.threadReplyCount}`
        );
      }
      return {
        target: r.target,
        result: {
          found: true,
          teamId: match.teamId, channelId: match.channelId,
          teamName: match.teamName, channelName: match.channelName,
          graphAccessible: hasGraphPermission,
          ...stats,
        },
      };
    });

    const fetched = await Promise.all(channelFetches);
    for (const { target, result } of fetched) map.set(target, result);
    return map;
  }

  // ─── Step 5: Build report with feature-level bugs ────────────────────────────

  _buildReport(context, initiated, recordToTeamsJob, jobReports, sourceStatsMap, destStatsMap, deepCompareMap, log) {
    const allBugs = [];
    const channels = [];
    let channelsCompleted = 0, channelsFailed = 0, channelsPending = 0;

    // Running totals
    const totSrc = { messageCount: 0, fileCount: 0, totalReplyCount: 0, totalReactionCount: 0, mentionMsgCount: 0, pinnedCount: 0, formattedMsgCount: 0 };
    const totCf  = { picked: 0, processed: 0, notProcessed: 0 };
    const totDst = { messageCount: 0, fileCount: 0, totalReactionCount: 0, mentionMsgCount: 0, threadReplyCount: 0 };
    let destFound = 0, destNotFound = 0;

    for (const r of initiated) {
      const teamsId = recordToTeamsJob.get(r.jobId) || r.jobId;

      // Find CF report — try derived teams ID, then raw channel record ID, then scan
      let cfReport = jobReports.get(teamsId) || jobReports.get(r.jobId);
      if (!cfReport) {
        for (const [, v] of jobReports) {
          if (Array.isArray(v.listOfMessageWorkspaceId) &&
              v.listOfMessageWorkspaceId.map(String).includes(r.jobId)) {
            cfReport = v; break;
          }
        }
      }

      const src = sourceStatsMap.get(r.target) || {};
      const dst = destStatsMap.get(r.target) || { found: false };
      // deepCompareMap is null when deep content comparison is skipped (e.g. 403 Teams permission)
      const deep = deepCompareMap ? (deepCompareMap.get(r.target) || null) : null;

      // Accumulate totals (mentionMsgCount: Slack stores as userMentionMsgCount — use alias if set)
      for (const k of Object.keys(totSrc)) {
        const v = k === 'mentionMsgCount'
          ? (src.userMentionMsgCount ?? src.mentionMsgCount)
          : src[k];
        if (v != null) totSrc[k] += v;
      }
      if (dst.found) {
        destFound++;
        if (dst.messageCount != null) totDst.messageCount += dst.messageCount;
        if (dst.fileCount != null) totDst.fileCount += dst.fileCount;
        if (dst.totalReactionCount != null) totDst.totalReactionCount += dst.totalReactionCount;
        if (dst.mentionMsgCount != null) totDst.mentionMsgCount += dst.mentionMsgCount;
        if (dst.threadReplyCount != null) totDst.threadReplyCount += dst.threadReplyCount;
      } else {
        destNotFound++;
      }

      // ── No CF report ──
      if (!cfReport) {
        channelsPending++;
        const bug = {
          bugType: 'MIGRATION_INCOMPLETE',
          severity: 'CRITICAL',
          status: 'BUG',
          channel: r.target,
          channelName: dst.channelName || r.target,
          feature: 'Migration',
          expected: 'PROCESSED',
          actual: 'PENDING',
          delta: null,
          description: `CF migration job for ${r.kind} ${r.target} did not reach a terminal status within the validation window.`,
          impact: 'Migration may still be running or may have stalled. Check CloudFuze Reports for status.',
        };
        allBugs.push(bug);
        channels.push({
          channelId: r.target, kind: r.kind, jobId: teamsId,
          channelName: dst.channelName || null,
          jobStatus: 'PENDING', validationStatus: 'PENDING',
          source: src, cfReport: { jobStatus: 'PENDING', totalMessages: null, processedMessages: null, notProcessedMessages: null },
          destination: dst, features: {}, bugs: [bug],
        });
        continue;
      }

      const rawStatus = cfReport.jobStatus || cfReport.migrationStatus || cfReport.status || '';
      const st = rawStatus.toLowerCase().replace(/\s+/g, '');
      const cfPicked    = cfReport.totalMessages ?? 0;
      const cfProcessed = cfReport.processedMessages ?? 0;
      const cfNotDone   = cfReport.notProcessedMessage ?? Math.max(0, cfPicked - cfProcessed);

      totCf.picked    += cfPicked;
      totCf.processed += cfProcessed;
      totCf.notProcessed += cfNotDone;

      const channelBugs = [];
      let validationStatus = 'PASS';

      // ── CF job failed ──
      if (st.includes('failed')) {
        channelsFailed++;
        validationStatus = 'FAIL';
        channelBugs.push({
          bugType: 'MIGRATION_FAILED',
          severity: 'CRITICAL',
          status: 'BUG',
          channel: r.target,
          channelName: dst.channelName || r.target,
          feature: 'Migration',
          expected: 'PROCESSED', actual: rawStatus, delta: null,
          description: `CF migration job ${teamsId} reported FAILED status.`,
          impact: 'The channel was not migrated. No messages were moved to Teams.',
        });
      } else {
        channelsCompleted++;

        // ── CF not-processed messages ──
        if (cfNotDone > 0) {
          validationStatus = 'PARTIAL';
          channelBugs.push({
            bugType: 'CF_PARTIAL_PROCESSING',
            severity: 'HIGH',
            status: 'BUG',
            channel: r.target,
            channelName: dst.channelName || r.target,
            feature: 'Messages',
            expected: cfPicked, actual: cfProcessed, delta: -cfNotDone,
            description: `CF picked ${cfPicked} messages but only processed ${cfProcessed} (${cfNotDone} not processed).`,
            impact: 'Some messages were not delivered to the Teams channel.',
          });
        }

        // ── Per-feature comparison: Slack source vs Teams destination ──
        if (dst.found && dst.graphAccessible !== false) {
          // Normal path: Teams Graph API accessible — compare Slack ↔ Teams directly
          for (const feat of FEATURES) {
            const srcVal = feat.srcField ? (src[feat.srcField] ?? null) : null;
            const dstVal = feat.dstField ? (dst[feat.dstField] ?? null) : null;

            if (srcVal == null || dstVal == null) continue; // UNKNOWN — skip

            const delta = dstVal - srcVal;
            const tolerance = feat.tolerance > 0
              ? Math.max(1, Math.ceil(Math.abs(srcVal) * feat.tolerance))
              : 0;
            const mismatch = Math.abs(delta) > tolerance;

            if (!mismatch) continue;

            const bug = {
              bugType: feat.key.replace(/([A-Z])/g, '_$1').toUpperCase() + '_MISMATCH',
              severity: feat.severity,
              status: feat.knownLimitation ? 'KNOWN_LIMITATION' : (delta < 0 ? 'BUG' : 'BUG'),
              channel: r.target,
              channelName: dst.channelName || r.target,
              feature: feat.label,
              expected: srcVal,
              actual: dstVal,
              delta,
              description: this._bugDescription(feat, r, src, dst, delta),
              impact: feat.impact,
            };
            channelBugs.push(bug);
            if (!feat.knownLimitation && validationStatus === 'PASS') validationStatus = 'PARTIAL';
          }

          // ── Source vs CF picked (message count) ──
          if (src.messageCount != null) {
            // CF counts top-level messages + thread replies; include replies in source count
            const srcTotal = (src.messageCount ?? 0) + (src.totalReplyCount ?? 0);
            const tolerance = Math.max(1, Math.ceil(cfPicked * 0.05));
            if (Math.abs(srcTotal - cfPicked) > tolerance) {
              const delta = cfPicked - srcTotal;
              if (validationStatus === 'PASS') validationStatus = 'PARTIAL';
              channelBugs.push({
                bugType: 'CF_PICK_MISMATCH',
                severity: 'HIGH',
                status: 'BUG',
                channel: r.target,
                channelName: dst.channelName || r.target,
                feature: 'CF Message Pickup',
                expected: srcTotal,
                actual: cfPicked,
                delta,
                description:
                  `Slack has ${src.messageCount} messages + ${src.totalReplyCount ?? 0} thread replies = ` +
                  `${srcTotal} total, but CF picked ${cfPicked} ` +
                  `(${Math.abs(delta)} ${delta < 0 ? 'missed' : 'extra'}).`,
                impact: delta < 0
                  ? 'CF did not pick all source messages — some messages may have been skipped.'
                  : 'CF picked more messages than source — possible duplication or system messages included.',
              });
            }
          }

          // ── Known limitations — only when destination IS found (source ↔ dest comparison) ──

          // Pinned messages: CF does not migrate Slack pins to Teams
          if ((src.pinnedCount || 0) > 0) {
            channelBugs.push({
              bugType: 'PINNED_MESSAGES_NOT_MIGRATED',
              severity: 'LOW',
              status: 'KNOWN_LIMITATION',
              channel: r.target,
              channelName: dst.channelName || r.target,
              feature: 'Pinned messages',
              expected: src.pinnedCount,
              actual: 0,
              delta: -src.pinnedCount,
              description: `${src.pinnedCount} message(s) are pinned in Slack but CloudFuze does not migrate Slack pins to Teams.`,
              impact: 'Pinned messages must be manually pinned again in the Teams channel.',
              evidence: (src.pinnedMessages || []).slice(0, 5).map(p => ({
                type: 'pinned_slack', ts: p.timestamp, text: p.text,
                userId: p.userId, hasFiles: p.hasFiles,
              })),
            });
          }

          // Emoji reactions
          if ((src.totalReactionCount || 0) > 0 && (dst.totalReactionCount ?? 0) === 0) {
            channelBugs.push({
              bugType: 'REACTIONS_NOT_MIGRATED',
              severity: 'LOW',
              status: 'KNOWN_LIMITATION',
              channel: r.target,
              channelName: dst.channelName || r.target,
              feature: 'Emoji reactions',
              expected: src.totalReactionCount,
              actual: dst.totalReactionCount ?? 0,
              delta: -(src.totalReactionCount),
              description:
                `${src.totalReactionCount} reaction(s) on ${src.reactionMsgCount} message(s) in Slack ` +
                `were not migrated to Teams (CloudFuze does not migrate emoji reactions).`,
              impact: 'Emoji reactions will not appear in Teams — this is an expected limitation.',
            });
          }

          // Formatted messages: CF converts Slack markdown → Teams HTML
          if ((src.formattedMsgCount || 0) > 0) {
            channelBugs.push({
              bugType: 'FORMATTING_CONVERSION',
              severity: 'LOW',
              status: 'KNOWN_LIMITATION',
              channel: r.target,
              channelName: dst.channelName || r.target,
              feature: 'Message formatting',
              expected: src.formattedMsgCount,
              actual: null,
              delta: null,
              description:
                `${src.formattedMsgCount} message(s) use Slack markdown (bold/italic/code/quotes). ` +
                `CloudFuze converts these to Teams HTML — visual presentation may differ.`,
              impact: 'Formatting is converted automatically but may not be pixel-perfect.',
            });
          }

          // ── Deep comparison bugs (from combination handler validateSlackToTeams) ──
          if (deep && deep.enabled) {
            const contentChanged = (deep.messageResults || []).filter((m) => m.status === 'CONTENT_CHANGED').length;

            // Missing messages — BUG (not found at destination at all)
            if (deep.unmatchedCount > 0) {
              validationStatus = validationStatus === 'PASS' ? 'PARTIAL' : validationStatus;
              channelBugs.push({
                bugType: 'MESSAGES_NOT_MIGRATED',
                severity: deep.unmatchedCount > 1 ? 'HIGH' : 'MEDIUM',
                status: 'BUG',
                channel: r.target,
                channelName: dst.channelName || r.target,
                feature: 'Message Content',
                expected: deep.scannedSourceMessages,
                actual: deep.pairedCount,
                delta: -(deep.unmatchedCount),
                description:
                  `${deep.unmatchedCount} message(s) from Slack could not be found in Teams ` +
                  `(matched ${deep.pairedCount - contentChanged} exact, ${contentChanged} reformatted, ` +
                  `${deep.unmatchedCount} missing — overall match rate ${deep.matchRate}%).`,
                impact: 'These messages were either not migrated or their content changed beyond recognition.',
                evidence: (deep.messageResults || []).filter((m) => m.status === 'MISSING').slice(0, 5).map((m) => ({
                  slackTs:   m.slackTs,
                  srcText:   m.srcText ? m.srcText.substring(0, 200) : '(empty)',
                  srcFiles:  m.srcFiles,
                  srcReplies: m.srcReplies,
                })),
              });
            }

            // Reformatted messages — KNOWN LIMITATION (found but text normalised differently)
            if (contentChanged > 0) {
              channelBugs.push({
                bugType: 'MESSAGE_FORMATTING_CONVERTED',
                severity: 'LOW',
                status: 'KNOWN_LIMITATION',
                channel: r.target,
                channelName: dst.channelName || r.target,
                feature: 'Message Formatting',
                expected: `Exact text match for ${contentChanged} message(s)`,
                actual: 'Partial match — CF reformatted content (Slack markdown → Teams HTML)',
                delta: null,
                description:
                  `${contentChanged} message(s) were found in Teams but with reformatted content. ` +
                  `CF converts Slack markdown (*bold*, _italic_, \`code\`), @mentions (<@USER>), ` +
                  `emoji shortcodes (:wave:) and Slack URLs to Teams HTML format. ` +
                  `The message was migrated correctly — only the presentation changed.`,
                impact:
                  'Content reformatting during Slack→Teams migration is expected and unavoidable. ' +
                  'Message meaning and attachments are preserved.',
                evidence: (deep.messageResults || []).filter((m) => m.status === 'CONTENT_CHANGED').slice(0, 5).map((m) => ({
                  slackTs:  m.slackTs,
                  srcText:  m.srcText ? m.srcText.substring(0, 200) : '',
                  dstText:  m.dstText ? m.dstText.substring(0, 200) : '',
                  pairing:  m.pairing,
                })),
              });
            }

            // Thread chain failures — BUG (reply count mismatch per thread)
            const brokenThreads = (deep.threadChainResults || []).filter((t) => !t.pass);
            if (brokenThreads.length > 0) {
              const totalMissingReplies = brokenThreads.reduce((sum, t) => {
                const delta = (t.srcReplyCount || 0) - (t.dstReplyCount || 0);
                return sum + (delta > 0 ? delta : 0);
              }, 0);
              if (validationStatus === 'PASS') validationStatus = 'PARTIAL';
              channelBugs.push({
                bugType: 'THREAD_REPLY_COUNT_MISMATCH',
                severity: totalMissingReplies > 5 ? 'HIGH' : 'MEDIUM',
                status: 'BUG',
                channel: r.target,
                channelName: dst.channelName || r.target,
                feature: 'Thread Replies',
                expected: brokenThreads.reduce((s, t) => s + (t.srcReplyCount || 0), 0),
                actual:   brokenThreads.reduce((s, t) => s + (t.dstReplyCount || 0), 0),
                delta:    -totalMissingReplies,
                description:
                  `${brokenThreads.length} thread(s) have a reply count mismatch between Slack and Teams ` +
                  `(${totalMissingReplies} total missing replies across all affected threads).`,
                impact: 'Some thread replies were not migrated — conversations may appear incomplete in Teams.',
                evidence: brokenThreads.slice(0, 5).map((t) => ({
                  slackTs:      t.slackTs,
                  srcText:      t.srcText,
                  srcReplies:   t.srcReplyCount,
                  dstReplies:   t.dstReplyCount,
                })),
              });
            }

            // Order violations — BUG (message order not preserved)
            const orderVal = deep.orderValidation;
            if (orderVal && orderVal.outOfOrderCount > 0) {
              if (validationStatus === 'PASS') validationStatus = 'PARTIAL';
              channelBugs.push({
                bugType: 'MESSAGE_ORDER_VIOLATION',
                severity: 'MEDIUM',
                status: 'BUG',
                channel: r.target,
                channelName: dst.channelName || r.target,
                feature: 'Message Ordering',
                expected: 'Same chronological order as Slack source',
                actual: `${orderVal.outOfOrderCount} message(s) are out of order at destination`,
                delta: -orderVal.outOfOrderCount,
                description:
                  `${orderVal.outOfOrderCount} message(s) have a different chronological position in Teams ` +
                  `compared to Slack (checked ${orderVal.sequenceChecked} messages, ` +
                  `skipped ${orderVal.simultaneousSkipped} with ambiguous simultaneous timestamps).`,
                impact: 'Message timeline in Teams does not match Slack — users may see conversations in wrong order.',
                evidence: (orderVal.outOfOrder || []).slice(0, 5),
              });
            }

            // File count mismatches found during per-message Tier A comparison
            const fileMismatches = (deep.messageResults || []).filter(
              (m) => m.diffs && m.diffs.some((d) => d.field === 'fileCount' && d.severity === 'error')
            );
            if (fileMismatches.length > 0) {
              if (validationStatus === 'PASS') validationStatus = 'PARTIAL';
              channelBugs.push({
                bugType: 'FILE_ATTACHMENT_MISSING',
                severity: 'HIGH',
                status: 'BUG',
                channel: r.target,
                channelName: dst.channelName || r.target,
                feature: 'File Attachments',
                expected: fileMismatches.reduce((s, m) => s + (m.srcFiles || 0), 0),
                actual:   fileMismatches.reduce((s, m) => s + (m.dstFiles || 0), 0),
                delta:    null,
                description:
                  `${fileMismatches.length} message(s) have fewer file attachments in Teams than in Slack. ` +
                  `Source had files; destination has none or fewer.`,
                impact: 'Users may be missing file attachments that were shared in Slack.',
                evidence: fileMismatches.slice(0, 5).map((m) => ({
                  slackTs:  m.slackTs,
                  srcText:  m.srcText ? m.srcText.substring(0, 100) : '',
                  srcFiles: m.srcFiles,
                  dstFiles: m.dstFiles,
                })),
              });
            }
          }

        } else if (dst.found && dst.graphAccessible === false) {
          // Teams Graph API returned 403 (ChannelMessage.Read.All not granted).
          // Use CF report as the destination proxy — same methodology as email migration.
          // We can still compare source vs CF pick count (no Teams read permission needed).
          if (src.messageCount != null) {
            const srcTotal = (src.messageCount ?? 0) + (src.totalReplyCount ?? 0);
            const tolerance = Math.max(1, Math.ceil(cfPicked * 0.05));
            if (Math.abs(srcTotal - cfPicked) > tolerance) {
              const delta = cfPicked - srcTotal;
              if (validationStatus === 'PASS') validationStatus = 'PARTIAL';
              channelBugs.push({
                bugType: 'CF_PICK_MISMATCH',
                severity: 'HIGH',
                status: 'BUG',
                channel: r.target,
                channelName: dst.channelName || r.target,
                feature: 'CF Message Pickup',
                expected: srcTotal,
                actual: cfPicked,
                delta,
                description:
                  `Slack has ${src.messageCount} messages + ${src.totalReplyCount ?? 0} thread replies = ` +
                  `${srcTotal} total, but CF picked ${cfPicked} ` +
                  `(${Math.abs(delta)} ${delta < 0 ? 'missed' : 'extra'}).`,
                impact: delta < 0
                  ? 'CF did not pick all source messages — some messages may have been skipped.'
                  : 'CF picked more messages than source — possible duplication or system messages included.',
              });
            }
          }
          // Known limitations — report even when Teams Graph is blocked (source-only data)
          if ((src.pinnedCount || 0) > 0) {
            channelBugs.push({
              bugType: 'PINNED_MESSAGES_NOT_MIGRATED',
              severity: 'LOW',
              status: 'KNOWN_LIMITATION',
              channel: r.target,
              channelName: dst.channelName || r.target,
              feature: 'Pinned messages',
              expected: src.pinnedCount, actual: 0, delta: -src.pinnedCount,
              description: `${src.pinnedCount} message(s) are pinned in Slack but CloudFuze does not migrate Slack pins to Teams.`,
              impact: 'Pinned messages must be manually pinned again in the Teams channel.',
              evidence: (src.pinnedMessages || []).slice(0, 5).map(p => ({
                type: 'pinned_slack', ts: p.timestamp, text: p.text, userId: p.userId, hasFiles: p.hasFiles,
              })),
            });
          }
          if ((src.totalReactionCount || 0) > 0) {
            channelBugs.push({
              bugType: 'REACTIONS_NOT_MIGRATED',
              severity: 'LOW',
              status: 'KNOWN_LIMITATION',
              channel: r.target,
              channelName: dst.channelName || r.target,
              feature: 'Emoji reactions',
              expected: src.totalReactionCount, actual: null, delta: null,
              description: `${src.totalReactionCount} reaction(s) on ${src.reactionMsgCount} message(s) in Slack were not migrated to Teams (CloudFuze does not migrate emoji reactions).`,
              impact: 'Emoji reactions will not appear in Teams — this is an expected limitation.',
            });
          }
          if ((src.formattedMsgCount || 0) > 0) {
            channelBugs.push({
              bugType: 'FORMATTING_CONVERSION',
              severity: 'LOW',
              status: 'KNOWN_LIMITATION',
              channel: r.target,
              channelName: dst.channelName || r.target,
              feature: 'Message formatting',
              expected: src.formattedMsgCount, actual: null, delta: null,
              description: `${src.formattedMsgCount} message(s) use Slack markdown (bold/italic/code/quotes). CloudFuze converts these to Teams HTML — visual presentation may differ.`,
              impact: 'Formatting is converted automatically but may not be pixel-perfect.',
            });
          }

          // Record that Teams direct read is unavailable; CF report is the validation source
          channelBugs.push({
            bugType: 'TEAMS_GRAPH_NOT_ACCESSIBLE',
            severity: 'MEDIUM',
            status: 'WARNING',
            channel: r.target,
            channelName: dst.channelName || r.target,
            feature: 'Teams message read',
            expected: 'Teams API accessible (ChannelMessage.Read.All)',
            actual: 'HTTP 403 — permission not granted in Azure app registration',
            delta: null,
            description:
              `Teams Graph API returned 403 for channel "${dst.channelName}" — ChannelMessage.Read.All ` +
              `permission is not granted. Direct Slack ↔ Teams count comparison is not possible. ` +
              `Validation based on CF report: ${cfPicked} messages picked, ${cfProcessed} processed.`,
            impact:
              'CF report confirms migration completed. Grant ChannelMessage.Read.All in Azure to enable ' +
              'direct message count verification in future runs.',
            evidence: [{
              type:            'cf_as_proxy',
              cfPickedCount:   cfPicked,
              cfProcessedCount: cfProcessed,
              cfNotProcessed:  cfNotDone,
              teamId:          dst.teamId,
              channelId:       dst.channelId,
              teamName:        dst.teamName,
              channelName:     dst.channelName,
            }],
          });

        } else {
          // ── Destination channel not found in Teams ──
          // The Teams channel could not be located after all lookup tiers.
          // We cannot do a direct Slack ↔ Teams count comparison, but we CAN still
          // compare Slack source vs CF pick counts (CF report is always available here).
          validationStatus = 'INCOMPLETE';
          channelBugs.push({
            bugType: 'DESTINATION_NOT_ACCESSIBLE',
            severity: 'MEDIUM',
            status: 'WARNING',
            channel: r.target,
            channelName: dst.channelName || r.target,
            feature: 'Channel lookup',
            expected: `Teams channel "${dst.channelName || r.target}" accessible`,
            actual: 'Not found after 4-tier Teams lookup (joined teams, app-only, OData)',
            delta: null,
            description:
              `The destination Teams channel for Slack ${r.kind} "${dst.channelName || r.target}" could not be ` +
              `located in Microsoft Teams after all lookup tiers. CF reported ${cfPicked} messages picked ` +
              `and ${cfProcessed} processed — the channel may still be in Teams migration mode or may ` +
              `not yet be visible to the admin account. Check that completeMigration was called successfully.`,
            impact:
              'Direct Teams message count comparison skipped. Source vs CF comparison shown below. ' +
              'The channel exists in CF records — re-run validation once it is accessible in Teams.',
            evidence: [{
              type:             'channel_not_found',
              slackChannelId:   r.target,
              slackChannelName: dst.channelName || r.target,
              slackMsgCount:    src.messageCount ?? null,
              slackReplyCount:  src.totalReplyCount ?? null,
              cfPickedCount:    cfPicked,
              cfProcessedCount: cfProcessed,
              searchNote:       dst.note || null,
            }],
          });

          // Still compare Slack source vs CF pick count — we have both even without Teams access
          if (src.messageCount != null) {
            const srcTotal = (src.messageCount ?? 0) + (src.totalReplyCount ?? 0);
            const tolerance = Math.max(1, Math.ceil(cfPicked * 0.05));
            if (Math.abs(srcTotal - cfPicked) > tolerance) {
              const delta = cfPicked - srcTotal;
              channelBugs.push({
                bugType: 'CF_PICK_MISMATCH',
                severity: 'HIGH',
                status: 'BUG',
                channel: r.target,
                channelName: dst.channelName || r.target,
                feature: 'CF Message Pickup',
                expected: srcTotal, actual: cfPicked, delta,
                description:
                  `Slack has ${src.messageCount} messages + ${src.totalReplyCount ?? 0} thread replies = ` +
                  `${srcTotal} total, but CF picked ${cfPicked} ` +
                  `(${Math.abs(delta)} ${delta < 0 ? 'missed' : 'extra'}).`,
                impact: delta < 0
                  ? 'CF did not pick all source messages — some messages may have been skipped.'
                  : 'CF picked more messages than source — possible duplication or system messages included.',
              });
            }
          }
          // Known limitations — flag regardless (source-only data)
          if ((src.pinnedCount || 0) > 0) {
            channelBugs.push({
              bugType: 'PINNED_MESSAGES_NOT_MIGRATED',
              severity: 'LOW', status: 'KNOWN_LIMITATION',
              channel: r.target, channelName: dst.channelName || r.target,
              feature: 'Pinned messages',
              expected: src.pinnedCount, actual: 0, delta: -src.pinnedCount,
              description: `${src.pinnedCount} message(s) are pinned in Slack but CloudFuze does not migrate Slack pins to Teams.`,
              impact: 'Pinned messages must be manually pinned again in the Teams channel.',
              evidence: (src.pinnedMessages || []).slice(0, 5).map(p => ({
                type: 'pinned_slack', ts: p.timestamp, text: p.text, userId: p.userId, hasFiles: p.hasFiles,
              })),
            });
          }
          if ((src.totalReactionCount || 0) > 0) {
            channelBugs.push({
              bugType: 'REACTIONS_NOT_MIGRATED',
              severity: 'LOW', status: 'KNOWN_LIMITATION',
              channel: r.target, channelName: dst.channelName || r.target,
              feature: 'Emoji reactions',
              expected: src.totalReactionCount, actual: 0, delta: -(src.totalReactionCount),
              description: `${src.totalReactionCount} reaction(s) on ${src.reactionMsgCount} message(s) in Slack were not migrated to Teams (CloudFuze does not migrate emoji reactions).`,
              impact: 'Emoji reactions will not appear in Teams — this is an expected limitation.',
            });
          }
        }
      }

      // Build feature comparison table for this channel
      const features = this._buildFeatureTable(src, dst, cfPicked, cfProcessed);

      log.info(
        `${r.kind} ${r.target}: ${validationStatus} | ` +
        `src msgs=${src.messageCount ?? 'N/A'} files=${src.fileCount ?? 'N/A'} | ` +
        `CF picked=${cfPicked} processed=${cfProcessed} | ` +
        `dst msgs=${dst.found ? (dst.messageCount ?? 'N/A') : 'not found'} | ` +
        `bugs=${channelBugs.length}` +
        (deep?.enabled ? ` | deep: ${deep.summary}` : '')
      );

      // Build structured deep-comparison summary for this channel (mirrors deepMailValidation shape)
      const deepMessageValidation = deep?.enabled ? {
        enabled:               true,
        scannedSourceMessages: deep.scannedSourceMessages,
        pairedCount:           deep.pairedCount,
        unmatchedCount:        deep.unmatchedCount,
        extraCount:            deep.extraCount,
        matchRate:             deep.matchRate,
        // Per-message results — limit to first 200 to keep payload manageable.
        // UI renders these for the "Message Details" drill-down.
        messageResults:     (deep.messageResults || []).slice(0, 200),
        threadChainResults: (deep.threadChainResults || []),
        orderValidation:    deep.orderValidation || null,
        summary:            deep.summary || '',
        errors:             deep.errors || [],
      } : null;

      allBugs.push(...channelBugs);
      channels.push({
        channelId: r.target,
        kind: r.kind,
        jobId: teamsId,
        channelName: cfReport.jobName || dst.channelName || null,
        jobStatus: rawStatus,
        validationStatus,
        source: {
          messageCount: src.messageCount ?? null,
          fileCount: src.fileCount ?? null,
          threadParentCount: src.threadParentCount ?? null,
          totalReplyCount: src.totalReplyCount ?? null,
          reactionMsgCount: src.reactionMsgCount ?? null,
          totalReactionCount: src.totalReactionCount ?? null,
          mentionMsgCount: src.userMentionMsgCount ?? src.mentionMsgCount ?? null,
          pinnedCount: src.pinnedCount ?? null,
          pinnedMessages: src.pinnedMessages || [],
          formattedMsgCount: src.formattedMsgCount ?? null,
          error: src.error || null,
        },
        cfReport: {
          totalMessages: cfPicked,
          processedMessages: cfProcessed,
          notProcessedMessages: cfNotDone,
          jobStatus: rawStatus,
        },
        destination: dst.found
          ? {
              found: true,
              teamName: dst.teamName,
              channelName: dst.channelName,
              graphAccessible: dst.graphAccessible !== false,
              messageCount: dst.graphAccessible !== false ? (dst.messageCount ?? null) : null,
              fileCount: dst.graphAccessible !== false ? (dst.fileCount ?? null) : null,
              totalReactionCount: dst.graphAccessible !== false ? (dst.totalReactionCount ?? null) : null,
              mentionMsgCount: dst.graphAccessible !== false ? (dst.mentionMsgCount ?? null) : null,
              threadReplyCount: dst.graphAccessible !== false ? (dst.threadReplyCount ?? null) : null,
            }
          : { found: false, note: dst.note || 'Not found' },
        deepMessageValidation,
        features,
        bugs: channelBugs,
      });
    }

    // ── Summary ──
    const hasIncomplete = channels.some((c) => c.validationStatus === 'INCOMPLETE');
    const overallStatus =
      channelsFailed > 0 && channelsCompleted === 0 ? 'FAIL' :
      allBugs.some((b) => b.status === 'BUG') ? 'PARTIAL' :
      hasIncomplete ? 'INCOMPLETE' :
      channelsPending > 0 ? 'PARTIAL' :
      'PASS';

    const bugCounts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
    for (const b of allBugs) if (b.status === 'BUG') bugCounts[b.severity] = (bugCounts[b.severity] || 0) + 1;

    const summary = {
      channelsInitiated: initiated.length,
      channelsCompleted,
      channelsFailed,
      channelsPending,
      bugSummary: {
        total: allBugs.filter((b) => b.status === 'BUG').length,
        knownLimitations: allBugs.filter((b) => b.status === 'KNOWN_LIMITATION').length,
        byCritical: bugCounts.CRITICAL,
        byHigh: bugCounts.HIGH,
        byMedium: bugCounts.MEDIUM,
        byLow: bugCounts.LOW,
      },
      source: {
        totalMessages: totSrc.messageCount,
        totalMessagesWithReplies: totSrc.messageCount + (totSrc.totalReplyCount || 0),
        totalFiles: totSrc.fileCount,
        totalReplies: totSrc.totalReplyCount,
        totalReactions: totSrc.totalReactionCount,
        totalMentions: totSrc.mentionMsgCount,
        totalPinned: totSrc.pinnedCount,
        totalFormatted: totSrc.formattedMsgCount,
      },
      cfReport: {
        totalPicked: totCf.picked,
        totalProcessed: totCf.processed,
        totalNotProcessed: totCf.notProcessed,
        processingRate: totCf.picked > 0
          ? `${Math.round((totCf.processed / totCf.picked) * 100)}%` : 'N/A',
      },
      destination: {
        totalMessages: totDst.messageCount,
        totalReplies: totDst.threadReplyCount,
        totalFiles: totDst.fileCount,
        totalReactions: totDst.totalReactionCount,
        totalMentions: totDst.mentionMsgCount,
        channelsFound: destFound,
        channelsNotFound: destNotFound,
      },
    };

    log.info(
      `Result: ${overallStatus} | bugs=${bugCounts.CRITICAL}C/${bugCounts.HIGH}H/${bugCounts.MEDIUM}M/${bugCounts.LOW}L | ` +
      `src ${totSrc.messageCount} msgs / ${totSrc.fileCount} files | ` +
      `CF picked=${totCf.picked} processed=${totCf.processed} | ` +
      `dst ${totDst.messageCount} msgs / ${totDst.fileCount} files`
    );

    return {
      overallStatus,
      bugs: allBugs,
      mismatches: allBugs.filter((b) => b.status === 'BUG').map((b) => ({
        category: b.feature,
        field: b.bugType,
        expected: b.expected,
        actual: b.actual,
        summaryLine: b.description,
        bugStatus: 'bug',
      })),
      summary,
      channels,
      productType: context.productType || 'Message',
      messageCombination: context.messageCombination || '',
    };
  }

  // Build per-feature status rows for a channel
  _buildFeatureTable(src, dst, cfPicked, cfProcessed) {
    const rows = {};
    const graphBlocked = dst.found && dst.graphAccessible === false;
    for (const feat of FEATURES) {
      const srcVal = feat.srcField ? (src[feat.srcField] ?? null) : null;
      const dstVal = feat.dstField && dst.found && !graphBlocked ? (dst[feat.dstField] ?? null) : null;
      let status = 'UNKNOWN';
      let delta = null;
      if (graphBlocked && srcVal != null) {
        status = 'GRAPH_NOT_ACCESSIBLE';
      } else if (srcVal != null && dstVal != null) {
        delta = dstVal - srcVal;
        const tolerance = feat.tolerance > 0 ? Math.max(1, Math.ceil(Math.abs(srcVal) * feat.tolerance)) : 0;
        status = Math.abs(delta) <= tolerance ? 'MATCH' : (feat.knownLimitation ? 'KNOWN_LIMITATION' : 'MISMATCH');
      } else if (srcVal != null && !dst.found) {
        status = 'DEST_NOT_FOUND';
      } else if (srcVal != null && !feat.dstField && feat.knownLimitation) {
        // No dst field to compare (e.g. reactions, pinned, formatted) — CF known not to migrate
        status = 'KNOWN_LIMITATION';
      }
      rows[feat.key] = { label: feat.label, source: srcVal, destination: dstVal, delta, status, knownLimitation: feat.knownLimitation };
    }
    // Add CF-level row
    rows.cfPicked    = { label: 'CF picked',    source: src.messageCount ?? null, destination: cfPicked,    delta: cfPicked - (src.messageCount ?? cfPicked), status: 'INFO' };
    rows.cfProcessed = { label: 'CF processed', source: cfPicked,                 destination: cfProcessed, delta: cfProcessed - cfPicked,                    status: 'INFO' };
    return rows;
  }

  _bugDescription(feat, r, src, dst, delta) {
    const srcVal = src[feat.srcField];
    const dstVal = dst[feat.dstField];
    const dir = delta < 0 ? 'fewer' : 'more';
    const abs = Math.abs(delta);
    return (
      `${r.kind} "${dst.channelName || r.target}": Slack has ${srcVal} ${feat.label.toLowerCase()} ` +
      `but Teams has ${dstVal} (${abs} ${dir} than source). ${feat.description}.`
    );
  }
}

module.exports = MessageValidationAgent;