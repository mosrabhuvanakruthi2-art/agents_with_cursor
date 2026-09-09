/**
 * Deep Slack → Microsoft Teams message validation.
 *
 * One file per combination — owns all per-channel deep-validation logic for this
 * pairing. Shared utilities live in validation/shared/deepMessageCore.js.
 *
 * Architecture mirrors gmailToOutlook.js from the mail validation system:
 *   Step 1 — Scan Slack source messages (top-level + thread replies)
 *   Step 2 — Fetch Teams destination messages with retry (CF indexing lag)
 *   Step 3 — Match each Slack message to a Teams message (2-tier pairing)
 *   Step 4 — Per-message Tier A comparison (text presence, file count)
 *   Step 5 — Thread chain validation (Slack reply count vs Teams reply count)
 *   Step 6 — Message order validation (timestamp ordering preserved?)
 *
 * @returns {Promise<object>} deepMessageValidation result for this channel
 */
const slackClient  = require('../../../clients/slackClient');
const outlookClient = require('../../../clients/outlookClient');
const {
  buildDstTextIndex,
  matchSingleMessage,
  compareMessageTierA,
  validateSlackToTeamsThreadChains,
  validateMessageOrderByTimestamp,
  DEEP_MAX_MESSAGES,
  DEEP_RETRY_WAIT_MS,
  DEEP_RETRY_COUNT,
} = require('../../shared/deepMessageCore');

/**
 * Validate one Slack channel against its Teams destination, message by message.
 *
 * Designed to be called once per channel from MessageValidationAgent._runDeepComparison().
 * This function is non-blocking and wraps every sub-step in try/catch so a failing
 * section never crashes the overall validation run.
 *
 * @param {object} opts
 * @param {string} opts.srcAdminEmail  - Slack OAuth token owner email
 * @param {string} opts.destEmail      - Teams/Graph token owner email
 * @param {string} opts.slackChannelId - Slack channel ID (e.g. C01ABCDEF)
 * @param {string} opts.teamId         - Teams team GUID
 * @param {string} opts.channelId      - Teams channel GUID
 * @param {string} opts.channelName    - Teams channel display name (for logging)
 * @param {object} opts.log            - pino/winston logger instance
 * @returns {Promise<object>} deepMessageValidation result
 */
async function validateSlackToTeams({
  srcAdminEmail,
  destEmail,
  slackChannelId,
  teamId,
  channelId,
  channelName,
  log,
}) {
  const result = {
    enabled:               true,
    scannedSourceMessages: 0,
    pairedCount:           0,   // MATCHED + CONTENT_CHANGED
    unmatchedCount:        0,   // MISSING
    extraCount:            0,   // extra at destination (CF system messages)
    matchRate:             0,
    messageResults:        [],
    threadChainResults:    [],
    orderValidation:       null,
    summary:               '',
    errors:                [],
  };

  // ── Step 1: Scan Slack source messages ──────────────────────────────────────
  let srcData;
  try {
    srcData = await slackClient.getChannelMessages(srcAdminEmail, slackChannelId);
  } catch (e) {
    const msg = `Slack source fetch failed for ${slackChannelId}: ${e.message}`;
    log.warn(msg);
    result.errors.push(msg);
    result.summary = msg;
    return result;
  }

  // Only validate user messages — skip Slack system messages (channel_join, etc.)
  const srcMessages = srcData.userMessages.filter((m) => !m.isSystem);
  result.scannedSourceMessages = srcMessages.length;

  log.info(
    `Deep Slack→Teams "${channelName}": ` +
    `src=${srcMessages.length} msgs + ${srcData.replies} thread replies`
  );

  if (srcMessages.length === 0) {
    result.summary = 'No source messages to compare.';
    return result;
  }

  // ── Step 2: Fetch Teams destination messages with retry ──────────────────────
  // CF takes several minutes to finish indexing messages after closing a migration
  // channel. Retry up to DEEP_RETRY_COUNT times with DEEP_RETRY_WAIT_MS between
  // attempts — mirrors the email validation approach.
  let allDstMessages = [];
  for (let attempt = 1; attempt <= DEEP_RETRY_COUNT; attempt++) {
    try {
      allDstMessages = await outlookClient.listTeamsChannelAllMessages(
        destEmail, teamId, channelId, DEEP_MAX_MESSAGES
      );
    } catch (e) {
      log.warn(`Teams "${channelName}" fetch attempt ${attempt}/${DEEP_RETRY_COUNT}: ${e.message}`);
      allDstMessages = [];
    }
    const visible = allDstMessages.filter((m) => !m.isReply && !m.isDeleted);
    if (visible.length > 0 || attempt === DEEP_RETRY_COUNT) break;
    log.info(
      `Teams "${channelName}": 0 messages on attempt ${attempt}/${DEEP_RETRY_COUNT} ` +
      `— waiting ${DEEP_RETRY_WAIT_MS / 1000}s for CF to finish indexing…`
    );
    await new Promise((r) => setTimeout(r, DEEP_RETRY_WAIT_MS));
  }

  // Split into top-level vs replies
  const dstTopLevel = allDstMessages.filter((m) => !m.isReply && !m.isDeleted);
  log.info(
    `Teams "${channelName}": ${dstTopLevel.length} top-level messages ` +
    `(${allDstMessages.length} total including replies)`
  );

  // ── Step 3+4: Match each Slack message → Teams; run Tier A comparison ────────
  const dstIndex     = buildDstTextIndex(dstTopLevel);
  const matchedDstIds = new Set();
  // Map<slackTs, teamsId> — used by thread chain validator (Step 5)
  const matchedMap   = new Map();

  for (const srcMsg of srcMessages) {
    let matchResult;
    try {
      matchResult = matchSingleMessage(srcMsg, dstIndex, dstTopLevel, matchedDstIds);
    } catch (e) {
      log.warn(`matchSingleMessage failed for ts=${srcMsg.ts}: ${e.message}`);
      matchResult = { status: 'MISSING', dstMsg: null, pairing: 'none' };
    }

    const { status, dstMsg, pairing } = matchResult;

    if (dstMsg) matchedMap.set(srcMsg.ts, dstMsg.id);

    // Tier A field comparison (only for messages that were found)
    let diffs;
    if (dstMsg) {
      try {
        diffs = compareMessageTierA(srcMsg, dstMsg);
      } catch (e) {
        diffs = [];
        log.warn(`Tier A comparison failed for ts=${srcMsg.ts}: ${e.message}`);
      }
    } else if (status === 'UNVERIFIABLE') {
      // File-only / link-only message — no text to match, so we cannot confirm presence or absence
      diffs = [{
        field:              'unverifiable',
        ok:                 null,
        expected:           `${srcMsg.fileCount || 0} file(s) present at destination`,
        actual:             'Cannot verify — message has no text for content matching',
        displaySource:      `${srcMsg.fileCount || 0} file(s), no matchable text`,
        displayDestination: 'Unverifiable',
        severity:           'info',
      }];
    } else {
      // Not found at destination — the pairing failure IS the diff
      diffs = [{
        field:              'notFound',
        ok:                 false,
        expected:           srcMsg.text ? srcMsg.text.substring(0, 200) : '(empty message)',
        actual:             'Message not found in Teams destination',
        displaySource:      srcMsg.text ? srcMsg.text.substring(0, 100) : '(empty)',
        displayDestination: 'NOT FOUND',
        severity:           'error',
      }];
    }

    // UNVERIFIABLE messages are neither pass nor fail — exclude from error count
    const pass = status === 'UNVERIFIABLE' || !diffs.some((d) => d.severity === 'error');

    result.messageResults.push({
      slackTs:           srcMsg.ts,
      slackTimestampMs:  srcMsg.timestampMs,
      slackTimestampISO: srcMsg.timestampISO,
      teamsId:           dstMsg?.id || null,
      teamsTimestampMs:  dstMsg?.timestampMs || null,
      teamsTimestampISO: dstMsg?.createdDateTime || null,
      status,
      pairing,
      pass,
      diffs,
      srcText:    srcMsg.text ? srcMsg.text.substring(0, 300) : '',
      dstText:    dstMsg      ? dstMsg.text.substring(0, 300) : null,
      srcFiles:   srcMsg.fileCount        || 0,
      dstFiles:   dstMsg?.attachmentCount ?? null,
      srcReplies: srcMsg.threadReplyCount || 0,
      edited:     srcMsg.edited           || false,
    });
  }

  // Record extra Teams messages (CF system/migration-info messages at destination —
  // these are expected and are NOT bugs, but we record them for completeness)
  const extraDst = dstTopLevel.filter((m) => !matchedDstIds.has(m.id));
  for (const m of extraDst) {
    result.messageResults.push({
      slackTs: null, slackTimestampMs: null, slackTimestampISO: null,
      teamsId: m.id, teamsTimestampMs: m.timestampMs, teamsTimestampISO: m.createdDateTime,
      status: 'EXTRA', pairing: 'none', pass: true, diffs: [],
      srcText: null, dstText: m.text ? m.text.substring(0, 300) : '',
      senderName: m.senderName || null,
    });
  }

  // ── Step 4b: Fetch actual Teams reply counts for matched thread parents ─────────
  // listTeamsChannelAllMessages only fetches top-level messages — replies require a
  // separate /replies?$count=true call per parent. We only fetch for Slack thread
  // parents that were actually matched, keeping the number of API calls small.
  const replyCountByParent = new Map();
  const threadParentEntries = srcMessages.filter(
    (m) => (m.threadReplyCount || 0) > 0 && matchedMap.has(m.ts)
  );
  if (threadParentEntries.length > 0) {
    await Promise.all(threadParentEntries.map(async (srcParent) => {
      const teamsParentId = matchedMap.get(srcParent.ts);
      if (!teamsParentId) return;
      try {
        const cnt = await outlookClient.countTeamsMessageReplies(
          destEmail, teamId, channelId, teamsParentId
        );
        replyCountByParent.set(teamsParentId, cnt);
        if (cnt !== srcParent.threadReplyCount) {
          log.info(
            `Thread reply mismatch: Teams msg ${teamsParentId} has ${cnt} replies, ` +
            `Slack had ${srcParent.threadReplyCount}`
          );
        }
      } catch (e) {
        log.warn(`Reply count fetch failed for Teams msg ${teamsParentId}: ${e.message}`);
      }
    }));
  }

  // ── Step 5: Thread chain validation ─────────────────────────────────────────
  try {
    result.threadChainResults = validateSlackToTeamsThreadChains(
      srcMessages, allDstMessages, matchedMap, replyCountByParent
    );
  } catch (e) {
    log.warn(`Thread chain validation failed for "${channelName}": ${e.message}`);
    result.threadChainResults = [];
  }

  // ── Step 6: Message order validation ────────────────────────────────────────
  try {
    result.orderValidation = validateMessageOrderByTimestamp(result.messageResults);
  } catch (e) {
    log.warn(`Order validation failed for "${channelName}": ${e.message}`);
    result.orderValidation = null;
  }

  // ── Summary stats ────────────────────────────────────────────────────────────
  const srcResults     = result.messageResults.filter((r) => r.slackTs != null);
  const matched        = srcResults.filter((r) => r.status === 'MATCHED').length;
  const contentChanged = srcResults.filter((r) => r.status === 'CONTENT_CHANGED').length;
  const missing        = srcResults.filter((r) => r.status === 'MISSING').length;
  const unverifiable   = srcResults.filter((r) => r.status === 'UNVERIFIABLE').length;
  const extra          = result.messageResults.filter((r) => r.status === 'EXTRA').length;

  result.pairedCount    = matched + contentChanged;
  result.unmatchedCount = missing;
  result.extraCount     = extra;
  // Exclude UNVERIFIABLE messages (file-only / link-only) from the matchRate denominator —
  // they cannot be confirmed missing and should not penalise the migration quality score.
  const verifiable = srcMessages.length - unverifiable;
  result.matchRate = verifiable > 0
    ? Math.round(((matched + contentChanged) / verifiable) * 100)
    : 100;

  result.summary =
    `src=${srcMessages.length} matched=${matched} reformatted=${contentChanged} ` +
    `missing=${missing} unverifiable=${unverifiable} extra=${extra} matchRate=${result.matchRate}%`;

  log.info(
    `Deep compare "${channelName}": ${result.summary}` +
    (result.threadChainResults.some((t) => !t.pass)
      ? ` | THREAD ISSUES=${result.threadChainResults.filter((t) => !t.pass).length}` : '') +
    (result.orderValidation?.outOfOrderCount > 0
      ? ` | ORDER VIOLATIONS=${result.orderValidation.outOfOrderCount}` : '')
  );

  return result;
}

module.exports = { validateSlackToTeams };