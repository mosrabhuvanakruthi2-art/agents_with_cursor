// Deep mail validation dispatcher. Routes to the per-combination validators.
const { intEnv, boolEnv } = require('./shared/deepMailCore');
const { validateGmailSource } = require('./combinations/gmailToOutlook');
const { validateOutlookSource } = require('./combinations/outlookToOutlook');
const { validateOutlookToGmailDestination } = require('./combinations/outlookToGmail');
const { validateGmailToGmailSource } = require('./combinations/gmailToGmail');

/**
 * @param {import('../models/MigrationContext')} context
 * @param {import('../models/ValidationResult')} result
 */
async function runDeepMailValidation(context, result, log) {
  const maxMessages = intEnv('DEEP_VALIDATION_MAX_MESSAGES', 500);
  const subjectPrefix = (process.env.DEEP_VALIDATION_SUBJECT_PREFIX || 'QA ').trim();
  /** Full body comparison (normalized plain text) — default on; set MAIL_DEEP_VALIDATE_BODY=false to skip. */
  const tierC = boolEnv('MAIL_DEEP_VALIDATE_BODY', true);
  const tierB = boolEnv('MAIL_DEEP_VALIDATE_ATTACHMENT_HASH', false);

  result.deepMailValidation.enabled = true;
  result.deepMailValidation.summary = '';

  const destUser = context.destinationEmail;
  const srcUser = context.sourceEmail;
  const srcProvider = context.sourceProvider || 'google';
  const dstProvider = context.destinationProvider || 'microsoft';

  if (srcProvider === 'google' && dstProvider === 'microsoft') {
    await validateGmailSource({ context, result, destUser, srcUser, maxMessages, subjectPrefix, tierB, tierC, log });
  } else if (srcProvider === 'microsoft' && dstProvider === 'microsoft') {
    await validateOutlookSource({ context, result, destUser, srcUser, maxMessages, subjectPrefix, tierB, tierC, log });
  } else if (srcProvider === 'microsoft' && dstProvider === 'google') {
    // Enable Tier B attachment hash for O→G by default (env MAIL_DEEP_VALIDATE_ATTACHMENT_HASH_OG=false to disable)
    const tierBOG = tierB || boolEnv('MAIL_DEEP_VALIDATE_ATTACHMENT_HASH_OG', true);
    await validateOutlookToGmailDestination({ context, result, destUser, srcUser, maxMessages, subjectPrefix, tierB: tierBOG, tierC, log });
  } else if (srcProvider === 'google' && dstProvider === 'google') {
    await validateGmailToGmailSource({ context, result, destUser, srcUser, maxMessages, subjectPrefix, tierB, tierC, log });
  } else {
    throw new Error(`Deep validation: unsupported combination sourceProvider=${srcProvider} → destinationProvider=${dstProvider}`);
  }

  const paired = result.deepMailValidation.messageResults.filter((r) => r.destMessageId).length;
  const failed = result.deepMailValidation.messageResults.filter((r) => !r.pass).length;
  result.deepMailValidation.pairedCount = paired;
  const threadChains = result.deepMailValidation.threadChainResults?.length || 0;
  const threadChainsFailed = result.deepMailValidation.threadChainResults?.filter((t) => !t.pass).length || 0;
  const threadSuffix = threadChains > 0
    ? `, threads ${threadChains - threadChainsFailed}/${threadChains} OK`
    : '';
  result.deepMailValidation.summary = `Deep mail: scanned ${result.deepMailValidation.scannedSourceMessages}, paired ${paired}, failed ${failed}${threadSuffix}`;
}

module.exports = { runDeepMailValidation };
