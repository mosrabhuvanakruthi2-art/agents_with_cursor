'use strict';

/**
 * Functionality Checklist
 * ------------------------
 * Rolls the per-message deep-mail validation results up into a per-FEATURE pass/fail
 * checklist. The feature SET is driven by migration type (one-time vs delta) — see
 * buildFeatureList — not the docs snapshot.
 *
 * Each feature gets one of three states:
 *   'pass' (green ✓)  — the feature was validated and no mismatches were found
 *   'fail' (red ✗)    — the feature was validated and at least one message mismatched
 *   'na'   (gray –)   — a mailbox-migration run cannot assess this feature
 *                       (Calendars, Contacts, …)
 *
 * The comparators emit a diff ONLY on mismatch (a match returns []), so "no diff for
 * this field across all paired messages" == the feature migrated correctly.
 */

const PROVIDER_TO_LABEL = {
  google: 'Gmail', gmail: 'Gmail',
  microsoft: 'Outlook', outlook: 'Outlook',
};

/** Resolve the docs-snapshot combination key, e.g. ('microsoft','google') → 'Outlook to Gmail'. */
function snapshotKey(sourceProvider, destinationProvider) {
  const s = PROVIDER_TO_LABEL[String(sourceProvider || '').toLowerCase()];
  const d = PROVIDER_TO_LABEL[String(destinationProvider || '').toLowerCase()];
  return s && d ? `${s} to ${d}` : null;
}

const norm = (s) => String(s || '').toLowerCase().trim();
/** Collapse to alphanumerics for fuzzy folder-name matching (SENT ≈ "Sent Items"). */
const squash = (s) => norm(s).replace(/[^a-z0-9]/g, '');

// Default-folder alias groups: a feature's folder name → the tokens that identify it
// across Gmail/Outlook naming differences.
const FOLDER_ALIASES = {
  inbox:   ['inbox'],
  sent:    ['sent', 'sentitems', 'sentmail'],
  drafts:  ['drafts', 'draft'],
  junk:    ['junk', 'spam', 'junkemail'],
  trash:   ['deleteditems', 'deleted', 'trash', 'bin'],
  starred: ['starred'],
  flagged: ['flagged', 'flag'],
  archive: ['archive'],
  important: ['important'],
  allmail: ['allmail'],
};

/**
 * Build the reusable evaluation context from a validation result.
 */
function buildEvalContext(validation) {
  const dmv = validation?.deepMailValidation || {};
  const messageResults = Array.isArray(dmv.messageResults) ? dmv.messageResults : [];
  const hasResults = messageResults.length > 0;
  const paired = messageResults.filter((m) => m.destMessageId);

  // Per paired message: the set of fields that mismatched (ok === false).
  const mismatchFieldsByMsg = paired.map((m) =>
    (m.diffs || []).filter((d) => d && d.ok === false).map((d) => d.field || '')
  );

  const threadChain = Array.isArray(dmv.threadChainResults) ? dmv.threadChainResults : [];
  const orderVal = dmv.orderValidation || null;
  const comparison = validation?.comparison || {};
  const issues = Array.isArray(comparison.issues) ? comparison.issues : [];

  const srcDefault =
    validation?.sourceData?.defaultFolders || validation?.sourceData?.defaultLabels || [];
  const srcCustom =
    validation?.sourceData?.customFolders || validation?.sourceData?.customLabels || [];
  const dstCustom =
    validation?.destinationData?.customFolders || validation?.destinationData?.customLabels || [];

  const settingsValidation = validation?.settingsValidation || null;

  const duplicateMessages = Array.isArray(dmv.duplicateMessages) ? dmv.duplicateMessages : [];

  const archiveAllMail = validation?.archiveAllMailValidation || null;

  return { all: messageResults, paired, hasResults, mismatchFieldsByMsg, threadChain, orderVal, comparison, issues, srcDefault, srcCustom, dstCustom, settingsValidation, duplicateMessages, archiveAllMail };
}

/** True if a diff field belongs to the target set (supports the attachment* prefix). */
function fieldInSet(field, targets) {
  if (targets.includes(field)) return true;
  if (targets.includes('attachment*') && String(field).startsWith('attachment')) return true;
  return false;
}

/** Count paired messages that mismatched on any of the given fields. */
function countFieldMismatches(ctx, targets) {
  let n = 0;
  for (const fields of ctx.mismatchFieldsByMsg) {
    if (fields.some((f) => fieldInSet(f, targets))) n++;
  }
  return n;
}

/** Generic per-field-attribute evaluator (read state, flag, importance, categories, …). */
function evalFields(ctx, targets, noun) {
  if (ctx.paired.length === 0) {
    return { status: 'na', evidence: 'No paired messages to validate' };
  }
  const fail = countFieldMismatches(ctx, targets);
  if (fail > 0) {
    // Name an example so the report points to the actual failing message and its values
    // (not just a bare count — which reads as if any flagged/important message failed).
    let example = '';
    for (const m of ctx.paired) {
      const d = (m.diffs || []).find((x) => x && x.ok === false && fieldInSet(x.field, targets));
      if (d) {
        const from = d.displaySource ?? d.expected ?? '?';
        const to = d.displayDestination ?? d.actual ?? '?';
        example = ` (e.g. "${m.subject || '(no subject)'}": ${d.field} ${from}→${to})`;
        break;
      }
    }
    return { status: 'fail', evidence: `${fail} of ${ctx.paired.length} message(s) — ${noun} mismatch${example}` };
  }
  return { status: 'pass', evidence: `${ctx.paired.length} message(s) — no ${noun} mismatch` };
}

/** Default-folder evaluator: uses source count for "exercised", comparison.issues for pass/fail. */
function evalDefaultFolder(ctx, group) {
  const aliases = FOLDER_ALIASES[group] || [group];
  const srcFolder = ctx.srcDefault.find((f) => aliases.some((a) => squash(f.name).includes(a)));
  const srcCount = srcFolder ? Number(srcFolder.messageCount || 0) : 0;

  if (!srcFolder || srcCount === 0) {
    return { status: 'na', evidence: 'No messages in this folder at source' };
  }
  const issue = ctx.issues.find((i) => aliases.some((a) => squash(i.label).includes(a)));
  if (issue) {
    return {
      status: 'fail',
      evidence: `source ${issue.sourceCount} vs destination ${issue.destCount}`,
    };
  }
  return { status: 'pass', evidence: `${srcCount} message(s) migrated` };
}

/**
 * Archive evaluator. For Gmail→Gmail the agent runs a dedicated "archived-in-All-Mail" count
 * (ctx.archiveAllMail) since Gmail has no distinct Archive folder — archived mail lives in All Mail.
 * For folder-based combinations (Outlook dest / O→O) fall back to the default-folder Archive check.
 */
function evalArchive(ctx) {
  const aa = ctx.archiveAllMail;
  if (aa && typeof aa.sourceArchivedCount === 'number') {
    if (aa.available === false) {
      return { status: 'na', evidence: aa.error ? `archive check unavailable: ${aa.error}` : 'archive check unavailable' };
    }
    if (aa.sourceArchivedCount === 0) {
      return { status: 'na', evidence: 'No archived (All Mail) messages at source' };
    }
    if (aa.destArchivedCount < aa.sourceArchivedCount) {
      return { status: 'fail', evidence: `source ${aa.sourceArchivedCount} archived (All Mail) vs destination ${aa.destArchivedCount}` };
    }
    return { status: 'pass', evidence: `${aa.sourceArchivedCount} archived (All Mail) message(s) migrated to destination All Mail` };
  }
  return evalDefaultFolder(ctx, 'archive');
}

/** Maps a diff field to a human reason label for the "why a thread broke" summary. */
function threadReasonLabel(field) {
  const k = String(field || '').split(':')[0];
  if (k === 'to' || k === 'cc') return 'recipients (To/Cc)';
  if (k === 'from') return 'sender (From)';
  if (k === 'subject') return 'subject';
  if (k === 'body') return 'body';
  if (k === 'folder') return 'folder placement';
  if (k === 'readState') return 'read/unread';
  if (k === 'flagState' || k === 'starred') return 'flag/starred';
  if (k === 'importance') return 'importance';
  if (k.startsWith('attachment')) return 'attachments';
  if (k === 'sentDateTime') return 'timestamp';
  return k || 'other';
}

/** Threads: fail if any thread chain broke or thread-level diffs exist. States WHY chains broke. */
function evalThreads(ctx) {
  if (ctx.paired.length === 0) return { status: 'na', evidence: 'No paired messages to validate' };
  const failedChains = ctx.threadChain.filter(
    (t) => t && t.pass === false && t.bugStatus !== 'known_limitation'
  );
  const chainFails = failedChains.length;
  const fieldFails = countFieldMismatches(ctx, ['threadCount', 'threadSplit', 'inReplyTo']);
  const total = chainFails + fieldFails;
  if (total > 0) {
    // Categorise WHY the chains broke (recipients, missing messages, order, split, …) so the report
    // states the cause — not just a count. A chain is counted once per distinct reason it exhibits.
    const reasonCounts = new Map();
    const bump = (r) => reasonCounts.set(r, (reasonCounts.get(r) || 0) + 1);
    for (const t of failedChains) {
      const reasons = new Set();
      if (t.threadSplit) reasons.add('split thread');
      if (t.countMatch === false) reasons.add('missing/extra messages');
      for (const mc of (t.messageComparisons || [])) {
        if (mc.pass) continue;
        for (const d of (mc.diffs || [])) {
          if (d && (d.ok === false || d.severity === 'error')) reasons.add(threadReasonLabel(d.field));
        }
      }
      for (const r of reasons) bump(r);
    }
    const reasonStr = [...reasonCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([r, n]) => `${r}: ${n}`)
      .join(', ');

    const parts = [];
    if (chainFails > 0) parts.push(`${chainFails} of ${ctx.threadChain.length} thread chain(s) broken`);
    if (fieldFails > 0) parts.push(`${fieldFails} message(s) mis-threaded`);
    return { status: 'fail', evidence: `${parts.join(', ')}${reasonStr ? ` — cause: ${reasonStr}` : ''}` };
  }
  const chainNote = ctx.threadChain.length > 0 ? `${ctx.threadChain.length} thread(s), ` : '';
  return { status: 'pass', evidence: `${chainNote}${ctx.paired.length} message(s) — order preserved` };
}

/** Timestamp: sentDateTime field diffs + chronological order validation. */
function evalTimestamp(ctx) {
  if (ctx.paired.length === 0) return { status: 'na', evidence: 'No paired messages to validate' };
  const tsFails = countFieldMismatches(ctx, ['sentDateTime']);
  const orderBad = ctx.orderVal && !ctx.orderVal.skipped && ctx.orderVal.pass === false;
  if (tsFails > 0 || orderBad) {
    const parts = [];
    if (tsFails > 0) parts.push(`${tsFails} message(s) — timestamp drift`);
    if (orderBad) parts.push(`${ctx.orderVal.outOfOrderCount} message(s) out of order`);
    return { status: 'fail', evidence: parts.join(', ') };
  }
  return { status: 'pass', evidence: `${ctx.paired.length} message(s) — timestamps & order preserved` };
}

/**
 * Custom folders / labels — COUNT / existence check (order-independent).
 * Every source custom folder (root, nested, or sub-folder) must exist at the destination.
 * Reports how many are MISSING at the destination. Folder sequence/order does not matter here
 * (nesting order is validated separately) and this is NOT about per-message placement.
 * Matches by leaf folder name so a folder that exists but was re-nested is NOT counted missing
 * (that's the nesting-order check's job).
 */
function evalCustomFolders(ctx) {
  const src = ctx.srcCustom || [];
  const dst = ctx.dstCustom || [];
  if (src.length === 0) {
    return { status: 'na', evidence: 'No custom folders/labels at source' };
  }

  const normPath = (p) => String(p || '').split('/').map((s) => s.trim().toLowerCase()).filter(Boolean).join('/');
  const leafOf = (p) => normPath(p).split('/').pop();
  const dstLeaves = new Set(dst.map((f) => leafOf(f.name)));

  const missing = src.map((f) => f.name).filter((n) => n && !dstLeaves.has(leafOf(n)));
  const found = src.length - missing.length;

  if (missing.length > 0) {
    const shown = missing.slice(0, 4).join(', ');
    const more = missing.length > 4 ? ` (+${missing.length - 4} more)` : '';
    return {
      status: 'fail',
      evidence: `${missing.length} of ${src.length} custom folder(s) missing at destination (${found} found): ${shown}${more}`,
    };
  }
  return {
    status: 'pass',
    evidence: `${src.length} custom folder(s) at source — all ${found} present at destination`,
  };
}

/**
 * Folder nesting order — every NESTED folder/sub-folder must keep its exact parent→child chain
 * at the destination (e.g. source "A/B/C" must exist as "A/B/C", not flattened to "C" or re-parented).
 * Root-level folders are intentionally NOT order-checked — their sequence may differ at destination.
 * Compares full "/"-separated paths segment-for-segment (order-sensitive).
 */
function evalFolderNesting(ctx) {
  const src = ctx.srcCustom || [];
  const dst = ctx.dstCustom || [];
  const normPath = (p) => String(p || '').split('/').map((s) => s.trim().toLowerCase()).filter(Boolean).join('/');

  // Only nested folders/sub-folders (path depth ≥ 2). Root folders (depth 1) are skipped by design.
  const nested = src.filter((f) => normPath(f.name).includes('/'));
  if (nested.length === 0) {
    return { status: 'na', evidence: 'No nested folders/sub-folders in this run' };
  }

  const dstPaths = new Set(dst.map((f) => normPath(f.name)));
  const dstLeaves = new Set([...dstPaths].map((p) => p.split('/').pop()));

  const broken = [];
  for (const f of nested) {
    const p = normPath(f.name);
    if (dstPaths.has(p)) continue; // exact chain preserved
    const leaf = p.split('/').pop();
    // Leaf exists but under a different chain → re-parented/flattened; else genuinely missing.
    broken.push(`${f.name}${dstLeaves.has(leaf) ? ' (re-nested/flattened)' : ' (missing)'}`);
  }

  if (broken.length > 0) {
    const shown = broken.slice(0, 3).join('; ');
    const more = broken.length > 3 ? ` (+${broken.length - 3} more)` : '';
    return { status: 'fail', evidence: `nesting order not preserved: ${shown}${more}` };
  }
  return { status: 'pass', evidence: `${nested.length} nested folder(s)/sub-folder(s) — parent→child chain preserved` };
}

/**
 * Distribution List / Group Mail.
 * Documented destination behavior: "Emails sent to Outlook distribution lists are migrated and
 * delivered to corresponding Gmail groups, but members are NOT migrated at destination."
 * So we validate the migrated EMAIL (present + To/CC recipients preserved), NOT group membership
 * — membership loss is an expected, documented limitation and is not penalized.
 */
function evalDistributionList(ctx) {
  const dl = ctx.all.find((m) => /distribution list/i.test(m.subject || ''));
  if (!dl) return { status: 'na', evidence: 'No distribution-list email seeded in this run' };
  if (!dl.destMessageId) {
    return { status: 'fail', evidence: 'DL email not migrated to destination' };
  }
  const recipFail = (dl.diffs || []).some(
    (d) => d && d.ok === false && ['to', 'cc', 'from'].includes(d.field)
  );
  if (recipFail) {
    return { status: 'fail', evidence: 'DL email migrated but To/CC recipients not preserved' };
  }
  return {
    status: 'pass',
    evidence: 'DL email migrated with recipients preserved (members not migrated — expected)',
  };
}

/**
 * Attachment integrity (synthetic — not a docs feature; added for every combination).
 * A compared attachment always leaves an attachment* diff trace: a fully-missing file shows as a
 * Tier A 'attachments' error, while a present file leaves an 'attachmentSize:<name>' entry (info when
 * fine) and, with Tier B, an 'attachmentHash:<name>'. So a message "has attachments" iff any of its
 * diffs use an attachment* field, and it "failed" iff any such diff is ok === false (missing / size
 * out of range / hash mismatch).
 */
function evalAttachments(ctx) {
  const isAtt = (f) => /^attachment/i.test(String(f || ''));
  let exercised = 0;
  let failed = 0;
  for (const m of ctx.paired) {
    const diffs = m.diffs || [];
    if (!diffs.some((d) => d && isAtt(d.field))) continue;
    exercised++;
    if (diffs.some((d) => d && d.ok === false && isAtt(d.field))) failed++;
  }
  if (exercised === 0) return { status: 'na', evidence: 'No attachments compared in this run' };
  if (failed > 0) {
    return { status: 'fail', evidence: `${failed} of ${exercised} message(s) with attachments — missing or altered` };
  }
  return { status: 'pass', evidence: `${exercised} message(s) with attachments — all intact` };
}

/**
 * Shared mailbox — validates the seeded shared-mailbox email migrated with From/content preserved.
 * (Shared calendars aren't assessable by a mailbox run and are noted, not penalized.)
 */
function evalSharedMailbox(ctx) {
  const sm = ctx.all.find((m) => /shared mailbox/i.test(m.subject || ''));
  if (!sm) return { status: 'na', evidence: 'No shared-mailbox email in this run' };
  if (!sm.destMessageId) return { status: 'fail', evidence: 'Shared-mailbox email not migrated to destination' };
  const bad = (sm.diffs || []).some((d) => d && d.ok === false && ['from', 'body', 'subject'].includes(d.field));
  if (bad) return { status: 'fail', evidence: 'Shared-mailbox email migrated but From/content not preserved' };
  return { status: 'pass', evidence: 'Shared-mailbox email migrated (From/content preserved; shared calendars not covered)' };
}

/**
 * Duplicate mails at destination — detected via per-folder count comparison.
 * If a folder/label holds MORE mails at the destination than at the source, extra copies
 * appeared there (potential duplication). Reports each such folder and how many extra mails.
 * A destination count that is not greater than the source is treated as no duplication.
 * (Pinpointing WHICH message duplicated — identical subject/timestamp/body/recipients — needs a
 * destination message enumeration pass; see notes. This count check is the folder-level trigger.)
 */
function evalDuplicateMails(ctx) {
  // Precise signal: deep-mail pairing found the SAME Message-ID copied 2+ times into the SAME
  // destination folder (e.g. a Gmail sent+labeled mail that reflects twice in one Outlook folder).
  const dups = Array.isArray(ctx.duplicateMessages) ? ctx.duplicateMessages : [];
  if (dups.length > 0) {
    const totalExtra = dups.reduce((s, d) => s + (Number(d.extraCopies) || 1), 0);
    const shown = dups.slice(0, 4)
      .map((d) => `"${d.subject || '(no subject)'}" (+${d.extraCopies} in ${(d.folders || []).join(', ')})`)
      .join('; ');
    const more = dups.length > 4 ? ` (+${dups.length - 4} more)` : '';
    return { status: 'fail', evidence: `${dups.length} message(s) duplicated within a destination folder (${totalExtra} extra copy(ies)): ${shown}${more}` };
  }

  const comp = ctx.comparison || {};
  const issues = Array.isArray(ctx.issues) ? ctx.issues : [];
  const noComparison =
    comp.defaultLabelsMatch === undefined && comp.customLabelsMatch === undefined && issues.length === 0;
  if (noComparison) return { status: 'na', evidence: 'No per-folder count comparison available this run' };

  // Folders where destination count exceeds source count → extra/duplicated mails.
  const extra = issues
    .map((i) => ({
      label: i.label,
      src: Number(i.sourceCount),
      dst: Number(i.destCount),
      delta: Number(i.destCount) - Number(i.sourceCount),
    }))
    .filter((x) => Number.isFinite(x.delta) && x.delta > 0);

  if (extra.length === 0) {
    return { status: 'pass', evidence: 'no folder has more mails at destination — no duplication detected' };
  }
  const totalExtra = extra.reduce((s, x) => s + x.delta, 0);
  const shown = extra.slice(0, 4).map((x) => `${x.label} (+${x.delta}: ${x.src}→${x.dst})`).join(', ');
  const more = extra.length > 4 ? ` (+${extra.length - 4} more folder(s))` : '';
  return { status: 'fail', evidence: `${totalExtra} extra mail(s) at destination — possible duplicates in: ${shown}${more}` };
}

/** Mailbox settings (inbox rules, conditional formatting, search folders) via settingsValidation. */
function evalSettings(ctx) {
  const sv = ctx.settingsValidation;
  if (!sv || !sv.available) return { status: 'na', evidence: 'Mailbox settings not validated in this run' };
  const parts = [['inbox rules', sv.inboxRules], ['conditional formatting', sv.conditionalFormatting], ['search folders', sv.searchFolders]];
  const missing = [];
  for (const [label, obj] of parts) {
    if (!obj) continue;
    const m = obj.missing;
    const n = Array.isArray(m) ? m.length : Number(m) || 0;
    if (n > 0) missing.push(`${n} ${label}`);
  }
  if (missing.length) return { status: 'fail', evidence: `missing at destination: ${missing.join(', ')}` };
  return { status: 'pass', evidence: 'inbox rules, formatting & search folders preserved' };
}

/** Not assessable by a mailbox migration run (calendar/contacts). */
const naFeature = (reason) => () => ({ status: 'na', evidence: reason || 'Not validated by a mailbox migration run' });
const NA_CAL = naFeature('Calendar data — not validated by a mailbox migration run');
const NA_CONTACT = naFeature('Contacts — not validated by a mailbox migration run');

/**
 * Curated feature checklist, keyed by migration type. Each entry maps a display feature to an
 * evaluator over the validation result. One-time and Delta share the mail features; Delta adds
 * calendar/contacts and drops Archive (per the migration scope).
 */
function buildFeatureList(isDelta) {
  const mailFolders = [
    { name: 'Inbox',         family: 'Folders', ev: (c) => evalDefaultFolder(c, 'inbox') },
    { name: 'Sent Items',    family: 'Folders', ev: (c) => evalDefaultFolder(c, 'sent') },
    { name: 'Draft Emails',  family: 'Folders', ev: (c) => evalDefaultFolder(c, 'drafts') },
    { name: 'Junk Emails',   family: 'Folders', ev: (c) => evalDefaultFolder(c, 'junk') },
    { name: 'Deleted Emails', family: 'Folders', ev: (c) => evalDefaultFolder(c, 'trash') },
  ];
  // One-time also migrates the Archive folder; Delta does not.
  if (!isDelta) mailFolders.push({ name: 'Archive', family: 'Folders', ev: (c) => evalArchive(c) });
  mailFolders.push({ name: 'Custom folders/labels', family: 'Folders', ev: (c) => evalCustomFolders(c) });
  mailFolders.push({ name: 'Nested folder / sub-folder order', family: 'Folders', ev: (c) => evalFolderNesting(c) });

  const mailCore = [
    { name: 'TimeStamp',                    family: 'Timestamp',      ev: (c) => evalTimestamp(c) },
    { name: 'Starred / Important Status',   family: 'Flags & State',  ev: (c) => evalFields(c, ['starred', 'important', 'importance', 'flag'], 'starred/important') },
    { name: 'Preserves read & unread status', family: 'Flags & State', ev: (c) => evalFields(c, ['readState'], 'read/unread') },
    { name: 'Threads',                      family: 'Threads',        ev: (c) => evalThreads(c) },
    { name: 'Mail Attachments',             family: 'Attachments',    ev: (c) => evalAttachments(c) },
    { name: 'Subject',                      family: 'Mail Fields',    ev: (c) => evalFields(c, ['subject'], 'subject') },
    { name: 'From',                         family: 'Mail Fields',    ev: (c) => evalFields(c, ['from'], 'from') },
    { name: 'To',                           family: 'Mail Fields',    ev: (c) => evalFields(c, ['to'], 'to') },
    { name: 'Cc',                           family: 'Mail Fields',    ev: (c) => evalFields(c, ['cc'], 'cc') },
    { name: 'Signature in mail body',       family: 'Content',        ev: (c) => evalFields(c, ['body'], 'body/signature') },
    { name: 'Emoji preserved in body',      family: 'Content',        ev: (c) => evalFields(c, ['emoji'], 'emoji') },
    { name: 'Links redirection in mail body', family: 'Content',      ev: (c) => evalFields(c, ['zoomLink', 'oneDriveLink', 'clickableLink'], 'link/clickability') },
    { name: 'No duplicate mails at destination', family: 'Integrity', ev: (c) => evalDuplicateMails(c) },
  ];

  const calendarContacts = isDelta ? [
    { name: 'Calendar Events (Normal / Recurring)', family: 'Calendar', ev: NA_CAL },
    { name: 'Calendar Event TimeStamps',            family: 'Calendar', ev: NA_CAL },
    { name: 'Calendar Event Attachments',           family: 'Calendar', ev: NA_CAL },
    { name: 'Contacts',                             family: 'Contacts', ev: NA_CONTACT },
    { name: 'Shared Contact',                       family: 'Contacts', ev: NA_CONTACT },
  ] : [];

  const sharedSettings = [
    { name: 'Distribution Lists / Groups', family: 'Shared', ev: (c) => evalDistributionList(c) },
    {
      name: isDelta ? 'Shared Mailboxes / Shared Calendars' : 'Shared Mailboxes',
      family: 'Shared', ev: (c) => evalSharedMailbox(c),
    },
    { name: 'Settings', family: 'Settings', ev: (c) => evalSettings(c) },
  ];

  return [...mailFolders, ...mailCore, ...calendarContacts, ...sharedSettings];
}

/**
 * Compute the functionality checklist for one execution's validation result.
 * The feature set is driven by migration type (one-time vs delta), not the docs snapshot.
 * @returns {null | { combination, migrationType, families: [{ family, features }], counts }}
 */
function computeFunctionalityChecklist(validation, sourceProvider, destinationProvider, opts = {}) {
  const key = snapshotKey(sourceProvider, destinationProvider);
  if (!key) return null;

  const isDelta = String(opts.migrationType || '').toUpperCase() === 'DELTA';
  const ctx = buildEvalContext(validation);
  const featureList = buildFeatureList(isDelta);

  const familyMap = new Map();
  const counts = { pass: 0, fail: 0, na: 0, total: 0 };

  for (const feat of featureList) {
    let result;
    try {
      result = feat.ev(ctx) || { status: 'na', evidence: 'No result' };
    } catch (_) {
      result = { status: 'na', evidence: 'Evaluation error' };
    }
    counts[result.status]++;
    counts.total++;
    if (!familyMap.has(feat.family)) familyMap.set(feat.family, []);
    familyMap.get(feat.family).push({ name: feat.name, status: result.status, evidence: result.evidence });
  }

  const families = [...familyMap.entries()].map(([family, features]) => ({ family, features }));
  return { combination: key, migrationType: isDelta ? 'Delta' : 'One-time', families, counts };
}

module.exports = { computeFunctionalityChecklist };
