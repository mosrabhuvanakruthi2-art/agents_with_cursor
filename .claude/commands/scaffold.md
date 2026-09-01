# /new-agent — Scaffold a New Migration QA Agent

## What It Does
Creates a new agent file extending `BaseAgent` with the correct CommonJS structure, logger setup, and error handling — ready to be dropped into `backend/src/agents/<category>/`.

## Template (based on actual BaseAgent.js pattern)

```js
// backend/src/agents/<category>/<AgentName>.js
const { BaseAgent } = require('../core/BaseAgent');
const logger = require('../../utils/logger');
// const someClient = require('../../clients/someClient');   ← add needed clients

class <AgentName> extends BaseAgent {
  constructor() {
    super('<AgentName>');   // must match class name exactly
  }

  async execute(context) {
    const log = logger.child({ agent: this.name, executionId: context.executionId });
    log.info('<AgentName> started');

    // ── TODO: implement agent logic ───────────────────────────────────────────

    const result = {
      // ... agent-specific result fields
    };

    log.info(`<AgentName> complete — ${JSON.stringify(result)}`);
    return result;
  }
}

module.exports = <AgentName>;
```

## Rules to Follow
- Override `execute(context)`, never `run()`.
- Always create a child logger with `{ agent: this.name, executionId: context.executionId }`.
- Return a plain object from `execute()` — it becomes `this.result` in `toJSON()`.
- For non-critical cleanup steps: catch errors, call `log.warn()`, do not re-throw.
- For critical steps: let errors propagate — `BaseAgent.run()` will catch them, call `setStatus(FAILED)`, log, and re-throw to the orchestrator.

## Registration
After creating the file:
1. Import it in `AgentOrchestrator.js` if it's part of the standard flow.
2. Or call `new <AgentName>().run(context)` directly from a controller for one-off use.
3. No router registration needed — agents are not exposed as HTTP endpoints directly.

## Other Slash Command Stubs

### /add-migration-route `<source> <dest>`
Stub for scaffolding a new migration direction:
1. Create a new `<Src>To<Dest>ValidationAgent.js` in `agents/`
2. Update `AgentOrchestrator.runFullFlow()` and `runBulkFlow()` to instantiate it for the new provider combination
3. Update `AgentForm.jsx` / `RunAgent.jsx` to offer the new direction in the UI

### /regenerate-pdf `<executionId>`
Regenerate the PDF report for an existing execution — the PDF is normally generated on-demand by `agentController.js` via `GET /executions/:id/pdf`. To regenerate manually:
```bash
# From backend/
node -e "
const pdfGenerator = require('./src/utils/pdfGenerator');
const executionService = require('./src/services/executionService');
const fs = require('fs');
const exec = executionService.get('<executionId>');
const stream = fs.createWriteStream('backend/logs/<executionId>.pdf');
pdfGenerator.generateValidationPdf(exec, stream).then(() => console.log('PDF written'));
"
```
