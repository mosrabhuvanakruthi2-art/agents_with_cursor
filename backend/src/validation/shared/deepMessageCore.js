/**
 * Deep source↔destination message validation — shared utilities.
 *
 * Architecture mirrors deepMailCore.js from the mail validation system:
 *   - normalizeMessageText()               → CF transformation normaliser
 *   - buildDstTextIndex()                  → lookup index from Teams messages
 *   - matchSingleMessage()                 → primary + fallback pairing strategy
 *   - compareMessageTierA()                → always-on metadata fields
 *   - validateSlackToTeamsThreadChains()   → thread reply-count integrity
 *   - validateMessageOrderByTimestamp()    → timestamp ordering check
 *
 * All combination handlers (slackToTeams, etc.) import from here.
 * Shared constants are also exported so callers can override via env vars.
 */

// ── Environment-tunable constants ─────────────────────────────────────────────
const DEEP_MAX_MESSAGES  = parseInt(process.env.MSG_VAL_MAX_MESSAGES   || '500',   10);
const DEEP_RETRY_WAIT_MS = parseInt(process.env.MSG_VAL_RETRY_WAIT_MS  || '30000', 10);
const DEEP_RETRY_COUNT   = parseInt(process.env.MSG_VAL_RETRY_COUNT    || '6',     10);
const PARTIAL_MATCH_LEN  = parseInt(process.env.MSG_VAL_PARTIAL_LEN    || '50',    10);
const PARTIAL_MATCH_MIN  = parseInt(process.env.MSG_VAL_PARTIAL_MIN    || '8',     10);
const ORDER_WINDOW_MS    = parseInt(process.env.MSG_VAL_ORDER_WINDOW_MS || '120000', 10);

// ── Text normalisation ─────────────────────────────────────────────────────────

/**
 * Normalise Slack/Teams message text for comparison.
 *
 * CF transforms Slack-specific markup during migration (mentions, emoji codes,
 * markdown bold/italic, URLs, block-quote prefixes, "Posted by:" headers injected
 * at destination, HTML from Teams). These are KNOWN transformations — normalise
 * both source and destination to the same plain form so expected differences
 * don't surface as false mismatches.
 *
 * Used by buildDstTextIndex() and matchSingleMessage().
 */
function normalizeMessageText(t) {
  return (t || '')
    // Slack mention tokens
    .replace(/<@[A-Z0-9]+\|([^>]*)>/gi,  '@$1')   // <@USERID|display> → @display
    .replace(/<@[A-Z0-9]+>/gi,           '@user')  // bare <@USERID>    → @user
    .replace(/<#[A-Z0-9]+\|([^>]*)>/gi, '#$1')    // <#CHANID|name>    → #name
    .replace(/<#[A-Z0-9]+>/gi,          '#channel') // bare <#CHANID>  → #channel
    // Slack link tokens
    .replace(/<https?:\/\/[^|>]*\|([^>]*)>/gi, '$1') // link with display text
    .replace(/<https?:\/\/[^>]*>/gi,           '')    // bare link → drop
    // Slack special mentions
    .replace(/<!here>/gi,     '@here')
    .replace(/<!channel>/gi,  '@channel')
    .replace(/<!everyone>/gi, '@everyone')
    // Emoji shortcodes  :thumbsup:  :wave:  etc.
    .replace(/:[a-z0-9_+'.-]+:/gi, '')
    // Slack markdown (CF converts these to Teams HTML)
    .replace(/\*([^*]+)\*/g,  '$1')   // *bold*
    .replace(/_([^_]+)_/g,    '$1')   // _italic_
    .replace(/~([^~]+)~/g,    '$1')   // ~strikethrough~
    .replace(/```[\s\S]*?```/g, '')   // code blocks → drop (not migrated as-is)
    .replace(/`([^`]+)`/g,    '$1')   // `inline code`
    .replace(/^>\s?/gm,       '')     // block-quote prefix lines
    // CF-injected "Posted by: Name · timestamp" headers at destination.
    // The header occupies its own line (preserved by the updated HTML→text conversion
    // in listTeamsChannelAllMessages). Strip the entire header line.
    // Pattern: start of line, optional spaces, "posted by", anything up to · or :, rest of line.
    .replace(/^\s*posted by[^\n·]*[·:][^\n]*/gim,            '')
    .replace(/^\s*originally posted by[^\n·]*[·:][^\n]*/gim, '')
    // Teams HTML entities and tags
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/<[^>]+>/g, ' ')   // strip remaining HTML tags
    // Normalise whitespace
    .toLowerCase()
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Destination index ──────────────────────────────────────────────────────────

/**
 * Build a normalised-text → Teams message lookup for efficient O(1) exact matching.
 * Only indexes top-level (non-reply, non-deleted) messages.
 *
 * @param {object[]} dstTopLevel  - filtered Teams messages
 * @returns {Map<string, object>}
 */
function buildDstTextIndex(dstTopLevel) {
  const map = new Map();
  for (const m of dstTopLevel) {
    const norm = normalizeMessageText(m.text);
    if (norm && !map.has(norm)) map.set(norm, m);
  }
  return map;
}

// ── Message pairing ────────────────────────────────────────────────────────────

/**
 * Match one Slack source message against the Teams destination index.
 *
 * Pairing strategy — two tiers (mirrors mail pairing in deepMailCore):
 *   Tier 1 (primary)  — exact normalised-text match
 *   Tier 2 (fallback) — partial match on first PARTIAL_MATCH_LEN chars
 *                        (CF may prepend "Posted by:" or wrap text)
 *   No match          → MISSING
 *
 * @param {object}   srcMsg        - Slack source message
 * @param {Map}      dstIndex      - from buildDstTextIndex()
 * @param {object[]} allDstTopLevel - all top-level Teams messages (for partial scan)
 * @param {Set}      matchedDstIds  - accumulator of already-paired Teams IDs
 * @returns {{ status: 'MATCHED'|'CONTENT_CHANGED'|'MISSING', dstMsg: object|null, pairing: string }}
 */
function matchSingleMessage(srcMsg, dstIndex, allDstTopLevel, matchedDstIds) {
  const srcNorm = normalizeMessageText(srcMsg.text);

  // File-only / link-only messages have no matchable text after normalisation
  // (bare URLs, emoji-only, or messages with only file attachments).
  // Returning MISSING would be a false positive — mark UNVERIFIABLE instead
  // so the report omits these from the "messages not migrated" bug count.
  if (!srcNorm) {
    return { status: 'UNVERIFIABLE', dstMsg: null, pairing: 'no-text' };
  }

  // Tier 1: exact normalised match
  const exact = dstIndex.get(srcNorm);
  if (exact && !matchedDstIds.has(exact.id)) {
    matchedDstIds.add(exact.id);
    return { status: 'MATCHED', dstMsg: exact, pairing: 'exact-text' };
  }

  // Tier 2: partial match — first PARTIAL_MATCH_LEN normalised chars
  const partial = srcNorm.substring(0, PARTIAL_MATCH_LEN);
  if (partial.length >= PARTIAL_MATCH_MIN) {
    const partialMatch = allDstTopLevel.find(
      (m) => !matchedDstIds.has(m.id) && normalizeMessageText(m.text).includes(partial)
    );
    if (partialMatch) {
      matchedDstIds.add(partialMatch.id);
      return { status: 'CONTENT_CHANGED', dstMsg: partialMatch, pairing: 'partial-text' };
    }
  }

  // No match
  return { status: 'MISSING', dstMsg: null, pairing: 'none' };
}

// ── Tier A comparison ──────────────────────────────────────────────────────────

/**
 * Tier A — always-on, cheap metadata comparison.
 * Checks: file count, thread-reply presence.
 *
 * Text match itself is already confirmed by the pairing strategy above;
 * we do not re-compare text here (avoids double-reporting known formatting diffs).
 *
 * @returns {object[]} diffs — same shape as mail comparator diffs
 */
function compareMessageTierA(srcMsg, dstMsg) {
  const diffs = [];

  // File count
  const srcFiles = srcMsg.fileCount || 0;
  const dstFiles = dstMsg.attachmentCount || 0;
  if (srcFiles !== dstFiles) {
    diffs.push({
      field: 'fileCount',
      ok: false,
      expected: srcFiles,
      actual: dstFiles,
      displaySource: `${srcFiles} file(s) in Slack`,
      displayDestination: `${dstFiles} attachment(s) in Teams`,
      severity: srcFiles > 0 && dstFiles === 0 ? 'error' : 'warning',
    });
  }

  // Thread reply presence (coarse check — validateSlackToTeamsThreadChains does the
  // exact per-thread count check; this is a first-pass flag so reports surface early)
  const srcReplies = srcMsg.threadReplyCount || 0;
  if (srcReplies > 0 && !(dstMsg.hasReplies)) {
    diffs.push({
      field: 'threadReplies',
      ok: false,
      expected: `${srcReplies} thread repl${srcReplies === 1 ? 'y' : 'ies'}`,
      actual: 'Thread replies not confirmed at destination (thread chain validation will check exact count)',
      displaySource: `${srcReplies} Slack replies`,
      displayDestination: 'Unverified — see Thread Chain Validation',
      severity: 'info',
    });
  }

  return diffs;
}

// ── Thread chain validation ────────────────────────────────────────────────────

/**
 * Validate thread chain integrity for all Slack threads that were migrated.
 *
 * For each Slack thread parent (reply_count > 0), checks that the paired
 * Teams message has the same number of replies.
 *
 * Teams replies are identified by `isReply === true` + `replyToId` in the
 * full message list from listTeamsChannelAllMessages().
 *
 * @param {object[]} srcMessages    - Slack top-level user messages (incl. thread parents)
 * @param {object[]} allDstMessages - ALL Teams messages (top-level + replies)
 * @param {Map}      matchedMap     - Map<slackTs, teamsId> for paired top-level messages
 * @returns {object[]} threadChainResults
 */
function validateSlackToTeamsThreadChains(srcMessages, allDstMessages, matchedMap, replyCountMap) {
  // Count Teams replies per parent message ID.
  // Prefer the caller-supplied replyCountMap (built from targeted /replies?$count=true API calls)
  // because listTeamsChannelAllMessages only fetches top-level messages — replies are not
  // included in allDstMessages and the fallback loop below would always yield 0.
  const replyCountByParent = replyCountMap || new Map();
  if (!replyCountMap) {
    for (const m of allDstMessages) {
      if (!m.isReply || !m.replyToId) continue;
      replyCountByParent.set(m.replyToId, (replyCountByParent.get(m.replyToId) || 0) + 1);
    }
  }

  const results = [];
  const threadParents = srcMessages.filter((m) => (m.threadReplyCount || 0) > 0);

  for (const parent of threadParents) {
    const pairedDstId   = matchedMap.get(parent.ts) || null;
    const dstReplyCount = pairedDstId != null ? (replyCountByParent.get(pairedDstId) ?? 0) : null;
    const srcReplyCount = parent.threadReplyCount;

    const mismatches = [];

    if (!pairedDstId) {
      mismatches.push({
        field:    'threadParent',
        severity: 'error',
        expected: `Teams message paired to Slack ts=${parent.ts}`,
        actual:   'Parent message not found in Teams — cannot validate thread',
        displaySource:      `Slack ts=${parent.ts} (${srcReplyCount} replies)`,
        displayDestination: 'Unmatched parent',
      });
    } else if (dstReplyCount !== srcReplyCount) {
      mismatches.push({
        field:    'threadCount',
        severity: dstReplyCount < srcReplyCount ? 'error' : 'warning',
        expected: srcReplyCount,
        actual:   dstReplyCount,
        displaySource:      `${srcReplyCount} Slack thread replies`,
        displayDestination: `${dstReplyCount} Teams thread replies`,
      });
    }

    const pass = pairedDstId != null && dstReplyCount === srcReplyCount;
    results.push({
      slackTs:        parent.ts,
      srcText:        (parent.text || '').substring(0, 200),
      srcReplyCount,
      dstMsgId:       pairedDstId,
      dstReplyCount:  dstReplyCount ?? null,
      pass,
      bugStatus:      pass ? 'pass' : 'bug',
      mismatches,
    });
  }

  return results;
}

// ── Order validation ───────────────────────────────────────────────────────────

/**
 * Validate that message ordering is preserved after migration.
 *
 * Mirrors validateMailOrderByTimestamp() from the mail validation system.
 *
 * Tier 1: rank comparison for messages with unique timestamps.
 *   Sort paired messages by Slack ts → assign source rank.
 *   Sort by Teams createdDateTime → assign destination rank.
 *   Flag any message whose rank differs.
 *
 * Tier 2: messages within ORDER_WINDOW_MS of a neighbour are "simultaneous" —
 *   their ordering is ambiguous. Skip them in Tier 1 and track how many were skipped.
 *
 * @param {object[]} messageResults - from validateSlackToTeams(), each entry has
 *                                   { slackTs, slackTimestampMs, teamsTimestampMs, status, srcText }
 * @returns {object} orderValidation
 */
function validateMessageOrderByTimestamp(messageResults) {
  const paired = messageResults.filter(
    (r) => r.slackTs != null && (r.status === 'MATCHED' || r.status === 'CONTENT_CHANGED')
      && r.slackTimestampMs != null && r.teamsTimestampMs != null
  );

  if (paired.length < 2) {
    return {
      totalChecked: paired.length, simultaneousSkipped: 0,
      sequenceChecked: paired.length, outOfOrderCount: 0,
      pass: true, outOfOrder: [],
    };
  }

  // Source rank
  const bySrcTs = [...paired].sort((a, b) => a.slackTimestampMs - b.slackTimestampMs);
  const srcRankOf = new Map(bySrcTs.map((r, i) => [r, i]));

  // Destination rank
  const byDstTs = [...paired].sort((a, b) => a.teamsTimestampMs - b.teamsTimestampMs);
  const dstRankOf = new Map(byDstTs.map((r, i) => [r, i]));

  const outOfOrder = [];
  let simultaneousSkipped = 0;

  for (const r of paired) {
    const srcPos = srcRankOf.get(r);
    const prevTs = srcPos > 0 ? bySrcTs[srcPos - 1].slackTimestampMs : null;
    const nextTs = srcPos < bySrcTs.length - 1 ? bySrcTs[srcPos + 1].slackTimestampMs : null;

    // Skip messages whose timestamps are too close to a neighbour (ambiguous order)
    const tooClose = (prevTs != null && Math.abs(r.slackTimestampMs - prevTs) < ORDER_WINDOW_MS)
                  || (nextTs != null && Math.abs(r.slackTimestampMs - nextTs) < ORDER_WINDOW_MS);
    if (tooClose) { simultaneousSkipped++; continue; }

    const dstPos = dstRankOf.get(r);
    if (srcPos !== dstPos) {
      outOfOrder.push({
        slackTs:         r.slackTs,
        slackTimestampMs: r.slackTimestampMs,
        teamsTimestampMs: r.teamsTimestampMs,
        srcPosition:     srcPos,
        dstPosition:     dstPos,
        srcText:         r.srcText ? r.srcText.substring(0, 100) : null,
        validatedBy:     'timestamp-rank',
      });
    }
  }

  return {
    totalChecked:      paired.length,
    simultaneousSkipped,
    sequenceChecked:   paired.length - simultaneousSkipped,
    outOfOrderCount:   outOfOrder.length,
    pass:              outOfOrder.length === 0,
    outOfOrder,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  normalizeMessageText,
  buildDstTextIndex,
  matchSingleMessage,
  compareMessageTierA,
  validateSlackToTeamsThreadChains,
  validateMessageOrderByTimestamp,
  DEEP_MAX_MESSAGES,
  DEEP_RETRY_WAIT_MS,
  DEEP_RETRY_COUNT,
  PARTIAL_MATCH_LEN,
  PARTIAL_MATCH_MIN,
  ORDER_WINDOW_MS,
};