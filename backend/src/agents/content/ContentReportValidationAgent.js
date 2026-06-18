const { BaseAgent } = require('../core/BaseAgent');

/**
 * Report-only content validation agent — base for ALL content combinations.
 *
 * Content (files/folders) migrations don't have deep source↔destination validation yet.
 * Instead, AgentOrchestrator sets `skipValidation` for content and surfaces the CloudFuze
 * content migration report (counts/status) from the MigrationAgent result.
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
