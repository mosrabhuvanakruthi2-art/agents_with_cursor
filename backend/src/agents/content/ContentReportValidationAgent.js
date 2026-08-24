const { BaseAgent } = require('../core/BaseAgent');

/**
 * Report-only content validation agent — base for ALL content combinations.
 *
 * This is the FALLBACK for content combinations that have no deep validation of their own: the
 * AgentOrchestrator sets `skipValidation` and surfaces the CloudFuze content migration report
 * (counts/status) from the MigrationAgent result. A report-only result compares nothing — it repeats
 * CloudFuze's own claim — so it is a placeholder, not a verdict.
 *
 * Combinations that DO validate deeply (they set `static supportsDeepValidation = true`, which makes
 * the orchestrator stop skipping validation):
 *   - box → sharepoint            validation/combinations/content/boxToSharepoint.js
 *   - googledrive → sharepoint    validation/combinations/content/googledriveToSharepoint.js
 * Both compare the real destination against the real source; the Drive one runs on
 * validation/shared/deepContentCore.js and reports per-feature results through
 * validation/shared/contentFunctionalityChecklist.js.
 *
 * This base exists so every content combination resolves to a ValidationAgent and the
 * structure is ready for real validation later: a combination simply overrides execute()
 * in its own file (backend/src/validation/combinations/content/<combo>.js) to add
 * file/folder/permission comparison — no change to the orchestrator or other combinations.
 *
 * While `skipValidation` is true, run() is not invoked during the flow; it is fully
 * functional if a combination opts into validation.
 */
class ContentReportValidationAgent extends BaseAgent {
  constructor(name = 'ContentValidationAgent') {
    super(name);
  }

  async execute(context) {
    return {
      reportOnly: true,
      domain: 'content',
      sourceProvider: context.sourceProvider,
      destinationProvider: context.destinationProvider,
      note: 'Content validation is report-only — see contentMigrationReport for counts/status.',
    };
  }
}

module.exports = ContentReportValidationAgent;
