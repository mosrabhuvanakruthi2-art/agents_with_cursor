const path = require('path');
const fs   = require('fs');
const { BaseAgent }       = require('../core/BaseAgent');
const slackClient         = require('../../clients/slackClient');
const outlookClient       = require('../../clients/outlookClient');
const googleChatClient    = require('../../clients/googleChatClient');
const logger              = require('../../utils/logger');

const CUSTOM_CASES_FILE = path.resolve(__dirname, '../../../data/custom-test-cases.json');
const SEED_LOG_FILE     = path.resolve(__dirname, '../../../data/seeding-log.json');

// ── Seeding deduplication log ─────────────────────────────────────────────────

function readSeedLog() {
  try {
    if (!fs.existsSync(SEED_LOG_FILE)) return {};
    return JSON.parse(fs.readFileSync(SEED_LOG_FILE, 'utf8'));
  } catch { return {}; }
}

function writeSeedLog(log) {
  try {
    fs.mkdirSync(path.dirname(SEED_LOG_FILE), { recursive: true });
    fs.writeFileSync(SEED_LOG_FILE, JSON.stringify(log, null, 2), 'utf8');
  } catch { /* non-fatal */ }
}

/** Returns true if testCaseId was already successfully seeded into channelId. */
function alreadySeeded(log, channelId, testCaseId) {
  return !!(log[channelId] && log[channelId][testCaseId]);
}

function markSeeded(log, channelId, testCaseId, ts) {
  if (!log[channelId]) log[channelId] = {};
  log[channelId][testCaseId] = { ts, seededAt: new Date().toISOString() };
}

// ── Test case loader ──────────────────────────────────────────────────────────

function loadMatchingCases({ messageCombination, selectedTestCaseIds }, log) {
  let data;
  try {
    if (!fs.existsSync(CUSTOM_CASES_FILE)) {
      log.warn(`custom-test-cases.json not found at ${CUSTOM_CASES_FILE}`);
      return [];
    }
    data = JSON.parse(fs.readFileSync(CUSTOM_CASES_FILE, 'utf8'));
  } catch (e) {
    log.error(`Failed to read custom-test-cases.json: ${e.message}`);
    return [];
  }

  // Support both old { smoke, sanity } format and new flat { scenarios } format
  let all;
  if (Array.isArray(data.scenarios)) {
    all = data.scenarios;
  } else {
    all = [...(Array.isArray(data.smoke) ? data.smoke : []), ...(Array.isArray(data.sanity) ? data.sanity : [])];
  }

  const selectedIds = Array.isArray(selectedTestCaseIds) && selectedTestCaseIds.length > 0
    ? new Set(selectedTestCaseIds.map(String))
    : null;

  const normSelected = messageCombination ? normCombo(messageCombination) : null;

  const filtered = all.filter((tc) => {
    if ((tc.productType || '').toLowerCase() !== 'message') return false;
    if (normSelected && normCombo(tc.combination) !== normSelected) return false;
    if (selectedIds) {
      const id = String(tc.testCaseId || tc.id || '');
      if (!selectedIds.has(id)) return false;
    }
    return true;
  });

  if (filtered.length === 0 && messageCombination) {
    log.warn(`No test cases for combination "${messageCombination}". Falling back to all Message cases.`);
    const fallback = all.filter((tc) => {
      if ((tc.productType || '').toLowerCase() !== 'message') return false;
      if (selectedIds) {
        const id = String(tc.testCaseId || tc.id || '');
        if (!selectedIds.has(id)) return false;
      }
      return true;
    });
    log.info(`Fallback lookup → ${fallback.length} case(s)`);
    return fallback;
  }

  log.info(`Scenario lookup — combination=${messageCombination || 'any'} → ${filtered.length} case(s)`);
  return filtered;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Extracts the leading count from testData, e.g. "100 bold text messages…" → 100.
 * Returns 0 if no number is found (caller should fall back to messageCount field).
 */
function extractCountFromTestData(testData) {
  const m = String(testData || '').match(/^\s*(\d[\d,]*)\s+/);
  if (!m) return 0;
  const n = parseInt(m[1].replace(/,/g, ''), 10);
  return n > 0 ? n : 0;
}

/**
 * Normalize combination strings for loose matching.
 * "Microsoft Teams → Microsoft Teams" and "Teams → Teams" both → "teams → teams"
 */
function normCombo(combo) {
  return (combo || '')
    .replace(/microsoft\s+teams/gi, 'teams')
    .replace(/google\s+chat/gi, 'chat')
    .trim()
    .toLowerCase();
}

function detectMessageType(tc) {
  const folder   = (tc.folder   || '').toLowerCase();
  const subject  = (tc.subject  || tc.summary || '').toLowerCase();
  const testData = (tc.testData || '').toLowerCase();
  const all = `${subject} ${testData} ${folder}`;

  if (all.includes('bold'))                                               return 'bold';
  if (all.includes('italic'))                                             return 'italic';
  if (all.includes('strikethrough'))                                      return 'strikethrough';
  if (all.includes('code block') || all.includes('code snippet'))         return 'code';
  if (all.includes('mixed format'))                                       return 'mixed';
  if (all.includes('hyperlink') || all.includes(' link') || subject.includes('link') || all.includes(' url')) return 'link';
  if (all.includes('emoji') || all.includes('emojis'))                    return 'emoji';
  if (folder.includes('thread')  || all.includes('thread') || subject.includes('repl')) return 'thread';
  if (folder.includes('attachment') || all.includes('attachment') || tc.hasAttachment === true) return 'attachment';
  if (folder.includes('pinned')  || all.includes('pinned'))               return 'pinned';
  if (folder.includes('reaction') || all.includes('reaction'))            return 'reaction';
  if (all.includes('@mention') || all.includes('mention'))                return 'mention';
  if (folder.includes('direct message') || folder.includes('direct messages')) return 'dm';
  if (folder.includes('group message')  || folder.includes('group messages'))  return 'group';
  return 'text';
}

/**
 * Extract raw mention text from testData (e.g. "'@Sophia'" → "@Sophia").
 * Also handles bare @mention or #channel patterns without quotes.
 */
function extractMentionText(testData) {
  // Quoted: '@Sophia' or '#channel-name'
  const quoted = (testData || '').match(/'([@#][^']+)'/);
  if (quoted) return quoted[1];
  // Bare @mention anywhere in testData
  const bare = (testData || '').match(/(?:^|\s)([@#][\w][\w.-]*)/);
  if (bare) return bare[1].trim();
  return null;
}

function extractThreadReply(tc) {
  const m = (tc.testData || '').match(/reply[:\s]*'([^']+)'/i);
  return m ? m[1] : null;
}

function extractAttachmentNames(testData) {
  const matches = [];
  const re = /'([^']+\.\w{2,5})'/g;
  let m;
  while ((m = re.exec(testData)) !== null) matches.push(m[1]);
  return matches;
}

/** Generate dummy file content for a given filename extension */
function generateFileContent(filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  const base = filename.replace(/\.[^.]+$/, '');
  switch (ext) {
    case 'pdf':
      // Minimal valid PDF
      return Buffer.from(
        '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
        '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
        '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n' +
        'xref\n0 4\n0000000000 65535 f\n0000000009 00000 n\n0000000058 00000 n\n0000000115 00000 n\n' +
        'trailer<</Size 4/Root 1 0 R>>\nstartxref\n190\n%%EOF'
      );
    case 'png':
    case 'jpg':
    case 'jpeg':
      // 1×1 transparent PNG
      return Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64'
      );
    case 'csv':
      return Buffer.from(`id,name,value\n1,${base},test-data\n2,migration,validation\n`);
    case 'txt':
      return Buffer.from(`Test file: ${filename}\nGenerated for migration test case seeding.\nContent validates file attachment migration.`);
    default:
      // Generic text content for docx, xlsx, zip, etc.
      return Buffer.from(`Test file: ${filename}\nFile type: ${ext}\nGenerated for CloudFuze migration validation.`);
  }
}

function getMimeType(filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  const map = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', csv: 'text/csv', txt: 'text/plain',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    zip: 'application/zip', mp4: 'video/mp4' };
  return map[ext] || 'application/octet-stream';
}

// ── Slack Block Kit message builder ──────────────────────────────────────────
/**
 * Builds a Slack message that accurately demonstrates the test case type.
 * repeatIdx: 0-based index of the current repeat — used to number each message.
 */
function buildSlackBlocks(tc, idx, mentionCtx = {}, repeatIdx = 0) {
  const type        = detectMessageType(tc);
  const caseId      = tc.testCaseId || tc.id || `case-${idx + 1}`;
  const folder      = tc.folder || 'Uncategorized';
  const n           = repeatIdx + 1;  // 1-based message number
  const names       = extractAttachmentNames(tc.testData || '');
  const isThread    = type === 'thread';
  const isAttachment = type === 'attachment' || tc.hasAttachment === true || names.length > 0;
  const isReaction  = type === 'reaction';
  const isPinned    = type === 'pinned';

  const blocks = [];
  let fallbackText = '';
  let replyText = null;

  const EMOJIS = ['😀','🎉','✅','👍','🚀','💬','🔥','⭐','🎯','💡'];

  switch (type) {
    case 'bold':
      fallbackText = `Bold message #${n} — ${caseId}`;
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Bold message #${n} — ${caseId}*` } });
      break;

    case 'italic':
      fallbackText = `Italic message #${n} — ${caseId}`;
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `_Italic message #${n} — ${caseId}_` } });
      break;

    case 'strikethrough':
      fallbackText = `Strikethrough message #${n} — ${caseId}`;
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `~Strikethrough message #${n} — ${caseId}~` } });
      break;

    case 'code':
      fallbackText = `Code block message #${n}`;
      blocks.push({ type: 'section', text: { type: 'mrkdwn',
        text: `\`\`\`// Code block #${n} — ${caseId}\nconsole.log("Migration test message ${n}");\`\`\`` } });
      break;

    case 'mixed':
      fallbackText = `Mixed format message #${n} — ${caseId}`;
      blocks.push({ type: 'section', text: { type: 'mrkdwn',
        text: `*Bold #${n}* _Italic_ ~Strikethrough~ — ${caseId}` } });
      break;

    case 'link':
      fallbackText = `Link message #${n} — ${caseId}`;
      blocks.push({ type: 'section', text: { type: 'mrkdwn',
        text: `Link message #${n} — <https://cloudfuze.com|CloudFuze> migration test — ${caseId}` } });
      break;

    case 'emoji': {
      const e = EMOJIS[n % EMOJIS.length];
      fallbackText = `${e} Emoji message #${n} ${e} — ${caseId}`;
      blocks.push({ type: 'section', text: { type: 'mrkdwn',
        text: `${e} Emoji message #${n} ${e} 🎊 — ${caseId}` } });
      break;
    }

    case 'mention': {
      const { resolvedText, firstUserId, firstGroup } = mentionCtx;
      const leadMention = resolvedText || '<!channel>';
      const parts = [leadMention];
      if (!leadMention.includes('<!here>')) parts.push('<!here>');
      if (firstUserId) parts.push(`<@${firstUserId}>`);
      if (firstGroup)  parts.push(`<!subteam^${firstGroup.id}|${firstGroup.handle}>`);
      parts.push(`Mention test #${n} — ${caseId}`);
      fallbackText = parts.join(' ');
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: fallbackText } });
      break;
    }

    case 'reaction':
      fallbackText = `Reaction test message #${n} — ${caseId}`;
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: fallbackText } });
      break;

    case 'pinned':
      fallbackText = `📌 Pinned message #${n} — ${caseId}`;
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: fallbackText } });
      break;

    case 'thread':
      fallbackText = `Thread message #${n} — ${caseId}`;
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: fallbackText } });
      replyText = extractThreadReply(tc) || `↩️ Thread reply #${n} for: ${caseId}`;
      break;

    case 'attachment':
      fallbackText = `📎 Attachment test #${n} — ${caseId}`;
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: fallbackText } });
      if (names.length > 0) {
        blocks.push({ type: 'section', text: { type: 'mrkdwn',
          text: `Files: ${names.map(f => `\`${f}\``).join(', ')}` } });
      }
      break;

    default: // text / dm / group
      fallbackText = `Test message #${n} — ${caseId}`;
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: fallbackText } });
      break;
  }

  // Traceability footer
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `🧪 *${caseId}* · ${folder} · msg #${n}` }],
  });

  return {
    blocks, fallbackText, replyText, isThread, isAttachment, isReaction, isPinned,
    attachmentNames: names.length > 0 ? names : isAttachment ? [`${caseId}_attachment.txt`] : [],
  };
}

// ── Teams HTML builder ────────────────────────────────────────────────────────
function buildTeamsContent(tc, idx, repeatIdx = 0) {
  const type   = detectMessageType(tc);
  const caseId = tc.testCaseId || tc.id || `case-${idx + 1}`;
  const folder = tc.folder || 'Uncategorized';
  const testData = tc.testData || '';
  const names    = extractAttachmentNames(testData);
  const isThread = type === 'thread';
  const n = repeatIdx + 1;

  const EMOJIS = ['😀','🎉','✅','👍','🚀','💬','🔥','⭐'];
  let typeHtml = '';
  switch (type) {
    case 'bold':          typeHtml = `<p><strong>Bold message #${n} — ${esc(caseId)}</strong></p>`; break;
    case 'italic':        typeHtml = `<p><em>Italic message #${n} — ${esc(caseId)}</em></p>`; break;
    case 'strikethrough': typeHtml = `<p><s>Strikethrough message #${n} — ${esc(caseId)}</s></p>`; break;
    case 'code':          typeHtml = `<pre>// Code block #${n} — ${esc(caseId)}\nconsole.log("Migration test ${n}");</pre>`; break;
    case 'mixed':         typeHtml = `<p><strong>Bold #${n}</strong>, <em>Italic</em>, <s>Strikethrough</s> — ${esc(caseId)}</p>`; break;
    case 'link':          typeHtml = `<p>Link message #${n} — <a href="https://cloudfuze.com">CloudFuze</a> — ${esc(caseId)}</p>`; break;
    case 'emoji': {
      const e = EMOJIS[n % EMOJIS.length];
      typeHtml = `<p>${e} Emoji message #${n} ${e} — ${esc(caseId)}</p>`; break;
    }
    case 'reaction':      typeHtml = `<p>Reaction test #${n} 👍 ❤️ 🎉 — ${esc(caseId)}</p>`; break;
    case 'pinned':        typeHtml = `<p>📌 Pinned message #${n} — ${esc(caseId)}</p>`; break;
    case 'mention': {
      const mention = extractMentionText(testData) || '@channel';
      typeHtml = `<p>${esc(mention)} Mention test #${n} — ${esc(caseId)}</p>`; break;
    }
    case 'thread':        typeHtml = `<p>Thread message #${n} — ${esc(caseId)}</p>`; break;
    case 'attachment': {
      const fileList = names.length > 0 ? names.map(f => `<em>${esc(f)}</em>`).join(', ') : '<em>attachment.txt</em>';
      typeHtml = `<p>📎 Attachment test #${n} — ${esc(caseId)}</p><p>Files: ${fileList}</p>`; break;
    }
    default: typeHtml = `<p>Test message #${n} — ${esc(caseId)}</p>`;
  }

  const mainHtml = typeHtml + `<p><em>🧪 ${esc(caseId)} · ${esc(folder)} · msg #${n}</em></p>`;

  let replyHtml = null;
  if (isThread) {
    replyHtml = `<p>${esc(extractThreadReply(tc) || `↩️ Thread reply #${n} for: ${caseId}`)}</p>`;
  }

  return {
    mainHtml, replyHtml, isThread,
    hasAttachment: tc.hasAttachment === true || names.length > 0,
    attachmentNames: names,
  };
}

// ── Google Chat builder ───────────────────────────────────────────────────────
function buildChatContent(tc, idx, repeatIdx = 0) {
  const type   = detectMessageType(tc);
  const caseId = tc.testCaseId || tc.id || `case-${idx + 1}`;
  const folder = tc.folder || 'Uncategorized';
  const testData = tc.testData || '';
  const names    = extractAttachmentNames(testData);
  const isThread = type === 'thread';
  const n = repeatIdx + 1;

  const EMOJIS = ['😀','🎉','✅','👍','🚀','💬','🔥','⭐'];
  let typeText = '';
  switch (type) {
    case 'bold':          typeText = `*Bold message #${n} — ${caseId}*`; break;
    case 'italic':        typeText = `_Italic message #${n} — ${caseId}_`; break;
    case 'strikethrough': typeText = `~Strikethrough message #${n} — ${caseId}~`; break;
    case 'code':          typeText = `\`Code block #${n} — ${caseId}\``; break;
    case 'mixed':         typeText = `*Bold #${n}* _Italic_ ~Strikethrough~ — ${caseId}`; break;
    case 'link':          typeText = `Link message #${n} — https://cloudfuze.com — ${caseId}`; break;
    case 'emoji': {
      const e = EMOJIS[n % EMOJIS.length];
      typeText = `${e} Emoji message #${n} ${e} — ${caseId}`; break;
    }
    case 'reaction':      typeText = `Reaction test #${n} 👍 ❤️ — ${caseId}`; break;
    case 'pinned':        typeText = `📌 Pinned message #${n} — ${caseId}`; break;
    case 'mention':       typeText = `${extractMentionText(testData) || '@all'} Mention test #${n} — ${caseId}`; break;
    case 'thread':        typeText = `Thread message #${n} — ${caseId}`; break;
    case 'attachment': {
      const fileList = names.length > 0 ? names.join(', ') : 'attachment.txt';
      typeText = `📎 Attachment test #${n} — ${caseId}\nFiles: ${fileList}`; break;
    }
    default: typeText = `Test message #${n} — ${caseId}`;
  }

  const mainText = `${typeText}\n🧪 _${caseId} · ${folder} · msg #${n}_`;

  let replyText = null;
  if (isThread) {
    replyText = extractThreadReply(tc) || `↩️ Thread reply #${n} for: ${caseId}`;
  }

  return {
    mainText, replyText, isThread,
    hasAttachment: tc.hasAttachment === true || names.length > 0,
    attachmentNames: names,
  };
}

// ── Agent ─────────────────────────────────────────────────────────────────────

class MessageTestDataAgent extends BaseAgent {
  constructor() { super('MessageTestDataAgent'); }

  async execute(context) {
    const log = logger.child({ agent: this.name, executionId: context.executionId });
    const {
      sourceEmail,
      sourceAdminEmail,
      sourcePlatform,
      destinationPlatform,
      messageCombination,
      channelIds = [],
      dmIds = [],
      selectedTestCaseIds = [],
      repeatCount = 1,
    } = context;

    function resolvePostingEmail(email) {
      const userHasToken =
        (sourcePlatform === 'teams'      && outlookClient.hasTeamsToken(email)) ||
        (sourcePlatform === 'slack'      && slackClient.hasSlackToken(email)) ||
        (sourcePlatform === 'googlechat' && googleChatClient.hasGoogleChatToken(email));
      if (userHasToken) return { email, usingAdmin: false };
      if (sourceAdminEmail && sourceAdminEmail !== email) {
        const adminHasToken =
          (sourcePlatform === 'teams'      && outlookClient.hasTeamsToken(sourceAdminEmail)) ||
          (sourcePlatform === 'slack'      && slackClient.hasSlackToken(sourceAdminEmail)) ||
          (sourcePlatform === 'googlechat' && googleChatClient.hasGoogleChatToken(sourceAdminEmail));
        if (adminHasToken) return { email: sourceAdminEmail, usingAdmin: true };
      }
      return { email, usingAdmin: false };
    }

    const { email: effectiveSourceEmail, usingAdmin } = resolvePostingEmail(sourceEmail);

    log.info(
      `Seeding — combination="${messageCombination}" src=${sourcePlatform} dst=${destinationPlatform} ` +
      `effectiveEmail=${effectiveSourceEmail}${usingAdmin ? ' (admin fallback)' : ''} ` +
      `channels=${channelIds.length} dms=${dmIds.length}`
    );

    const cases = loadMatchingCases({ messageCombination, selectedTestCaseIds }, log);

    const rc = Math.max(1, parseInt(repeatCount, 10) || 1);
    const summary = {
      combination: messageCombination, sourcePlatform, destinationPlatform,
      sourceEmail, effectiveSourceEmail, usingAdminFallback: usingAdmin,
      totalTargets: channelIds.length + dmIds.length, totalCases: cases.length,
      repeatCount: rc,
      plannedPosts: 0, postsAttempted: 0, postsSucceeded: 0, postsFailed: 0,
      skipped: [], errors: [], livePosting: false, liveSlackPosting: false,
    };

    if (cases.length === 0) {
      log.warn('No matching test cases. Add cases from Test Case Generator → Agent Repo.');
    }

    const targets = [
      ...channelIds.map((id) => ({ kind: 'channel', id })),
      ...dmIds.map((id) => ({ kind: 'dm', id })),
    ];
    // plannedPosts updated dynamically per case (tcCount varies per test case)

    const slackIsSource = sourcePlatform === 'slack';
    const teamsIsSource = sourcePlatform === 'teams';
    const chatIsSource  = sourcePlatform === 'googlechat';

    const slackConnected = slackIsSource && slackClient.hasSlackToken(effectiveSourceEmail);
    const teamsConnected = teamsIsSource && outlookClient.hasTeamsToken(effectiveSourceEmail);
    const chatConnected  = chatIsSource  && googleChatClient.hasGoogleChatToken(effectiveSourceEmail);
    const isLive = slackConnected || teamsConnected || chatConnected;

    summary.livePosting = isLive;
    summary.liveSlackPosting = isLive;

    if (!isLive) {
      log.warn(`DRY-RUN on ${sourcePlatform}: no live token for "${effectiveSourceEmail}".`);
    } else {
      log.info(`LIVE posting as "${effectiveSourceEmail}" on ${sourcePlatform}.`);
    }

    if (targets.length === 0) {
      log.warn('No channels/DMs selected — nothing to post to.');
    }

    // Load seeding log for deduplication
    const seedLog = readSeedLog();

    // Pre-resolve workspace-level mention data once (not per-case) for Slack
    let _slackFirstUserId = null;
    let _slackFirstGroup  = null;
    if (slackConnected) {
      try {
        _slackFirstUserId = await slackClient.getFirstUserId(effectiveSourceEmail);
        _slackFirstGroup  = await slackClient.getFirstUserGroup(effectiveSourceEmail);
      } catch { /* non-fatal */ }
    }

    for (let c = 0; c < cases.length; c++) {
      const tc = cases[c];
      const baseCaseId = tc.testCaseId || tc.id || `case-${c + 1}`;

      // Resolve Slack mentions for this specific test case (async, once per case)
      let slackMentionCtx = { resolvedText: null, firstUserId: _slackFirstUserId, firstGroup: _slackFirstGroup };
      if (slackConnected && detectMessageType(tc) === 'mention') {
        const rawMention = extractMentionText(tc.testData) || '@channel';
        try {
          slackMentionCtx.resolvedText = await slackClient.resolveSlackMentions(effectiveSourceEmail, rawMention);
        } catch { /* fallback to <!channel> in block builder */ }
      }

      // Per-test-case count: use dedicated messageCount field first,
      // then fall back to parsing testData ("100 bold text messages" → 100),
      // then fall back to UI repeatCount (rc), minimum 1.
      const tcCount = (parseInt(tc.messageCount, 10) > 0 ? parseInt(tc.messageCount, 10) : null)
        || (extractCountFromTestData(tc.testData) > 0 ? extractCountFromTestData(tc.testData) : null)
        || rc;
      const totalRepeat = tcCount;
      summary.plannedPosts += targets.length * totalRepeat;

      log.info(`Case ${baseCaseId} (${tc.folder || 'uncategorized'}) type=${detectMessageType(tc)} count=${tcCount}×${rc}=${totalRepeat}`);

    for (let r = 0; r < totalRepeat; r++) {
      // Rebuild content per repeat so the message number (#n) is correct
      const teamsContent = teamsIsSource ? buildTeamsContent(tc, c, r) : null;
      const slackContent = slackIsSource ? buildSlackBlocks(tc, c, slackMentionCtx, r) : null;
      const chatContent  = chatIsSource  ? buildChatContent(tc, c, r)  : null;

      // Suffix caseId with repeat index when posting multiple times
      const caseId = totalRepeat > 1 ? `${baseCaseId}-r${r + 1}` : baseCaseId;

      for (const t of targets) {
        summary.postsAttempted++;

        // ── DRY RUN ─────────────────────────────────────────────────────────
        if (!isLive) {
          summary.skipped.push({ case: caseId, target: t.id, reason: `dry-run — no live ${sourcePlatform} token` });
          log.info(`Dry-run: would post ${caseId} → ${t.kind} ${t.id}`);
          continue;
        }

        // ── Deduplication check (only when posting a single message per case) ─
        if (totalRepeat === 1 && alreadySeeded(seedLog, t.id, caseId)) {
          log.info(`Skip duplicate: ${caseId} already seeded into ${t.id}`);
          summary.skipped.push({ case: caseId, target: t.id, reason: 'already seeded' });
          summary.postsAttempted--;
          continue;
        }

        // ── LIVE POST ────────────────────────────────────────────────────────
        try {
          if (slackConnected) {
            // ── Slack ─────────────────────────────────────────────────────────
            const { blocks, fallbackText, replyText, isThread, isAttachment, isReaction, isPinned, attachmentNames } = slackContent;

            const res = await slackClient.postMessage(effectiveSourceEmail, t.id, fallbackText, blocks);
            log.info(`Slack: posted ${caseId} → ${t.kind} ${t.id} (ts=${res.ts})`);

            // Thread reply
            if (isThread && res.ts) {
              try {
                await slackClient.postThreadReply(effectiveSourceEmail, t.id, res.ts, replyText);
                log.info(`Slack: thread reply for ${caseId} → ${t.id}`);
              } catch (err) {
                log.warn(`Slack: thread reply failed for ${caseId}: ${err.message}`);
              }
            }

            // File uploads — actually upload each attachment file
            if (isAttachment && attachmentNames.length > 0) {
              for (const filename of attachmentNames) {
                try {
                  const fileBuffer = generateFileContent(filename);
                  const mimeType   = getMimeType(filename);
                  await slackClient.uploadFile(effectiveSourceEmail, t.id, filename, {
                    fileBuffer,
                    mimeType,
                    initialComment: `📎 Attachment for test case ${caseId}: \`${filename}\``,
                  });
                  log.info(`Slack: uploaded file "${filename}" for ${caseId} → ${t.id}`);
                } catch (fileErr) {
                  log.warn(`Slack: file upload failed "${filename}" for ${caseId}: ${fileErr.message}`);
                }
              }
            }

            // Reactions — add emoji reactions to the posted message
            if (isReaction && res.ts) {
              for (const emoji of ['thumbsup', 'heart', 'tada']) {
                try {
                  await slackClient.addReaction(effectiveSourceEmail, t.id, res.ts, emoji);
                  log.info(`Slack: reaction :${emoji}: added for ${caseId}`);
                } catch (err) {
                  log.warn(`Slack: reaction :${emoji}: failed for ${caseId}: ${err.message}`);
                }
              }
            }

            // Pin the message
            if (isPinned && res.ts) {
              try {
                await slackClient.pinMessage(effectiveSourceEmail, t.id, res.ts);
                log.info(`Slack: pinned message for ${caseId} → ${t.id}`);
              } catch (err) {
                log.warn(`Slack: pin failed for ${caseId}: ${err.message}`);
              }
            }

            markSeeded(seedLog, t.id, caseId, res.ts);
            summary.postsSucceeded++;

          } else if (teamsConnected) {
            // ── Teams ─────────────────────────────────────────────────────────
            const { mainHtml, replyHtml, isThread } = teamsContent;
            const res = await outlookClient.postTeamsMessage(effectiveSourceEmail, t.id, mainHtml, 'html');
            log.info(`Teams: posted ${caseId} → ${t.kind} ${t.id} (id=${res.id})`);

            if (isThread && replyHtml && res.isChannel && res.id) {
              try {
                await outlookClient.postTeamsReply(effectiveSourceEmail, t.id, res.id, replyHtml, 'html');
                log.info(`Teams: thread reply for ${caseId} → ${t.id}`);
              } catch (err) {
                log.warn(`Teams: thread reply failed for ${caseId}: ${err.message}`);
              }
            }

            markSeeded(seedLog, t.id, caseId, res.id);
            summary.postsSucceeded++;

          } else if (chatConnected) {
            // ── Google Chat ───────────────────────────────────────────────────
            const { mainText, replyText, isThread } = chatContent;
            const res = await googleChatClient.postChatMessage(effectiveSourceEmail, t.id, mainText);
            log.info(`Google Chat: posted ${caseId} → ${t.kind} ${t.id} (name=${res.name})`);

            if (isThread && replyText && res.name) {
              try {
                await googleChatClient.postChatThreadReply(effectiveSourceEmail, t.id, res.name, replyText);
                log.info(`Google Chat: thread reply for ${caseId} → ${t.id}`);
              } catch (err) {
                log.warn(`Google Chat: thread reply failed for ${caseId}: ${err.message}`);
              }
            }

            markSeeded(seedLog, t.id, caseId, res.name);
            summary.postsSucceeded++;
          }
        } catch (err) {
          summary.postsFailed++;
          summary.errors.push({ case: caseId, target: t.id, error: err.message });
          log.error(`Post failed: ${caseId} → ${t.kind} ${t.id}: ${err.message}`);
        }
      }
    } // end repeat loop
    } // end cases loop

    // Persist deduplication log
    writeSeedLog(seedLog);

    log.info(
      `MessageTestDataAgent done — cases=${summary.totalCases} targets=${summary.totalTargets} ` +
      `attempted=${summary.postsAttempted} succeeded=${summary.postsSucceeded} ` +
      `failed=${summary.postsFailed} skipped=${summary.skipped.length}`
    );

    return summary;
  }
}

module.exports = MessageTestDataAgent;
