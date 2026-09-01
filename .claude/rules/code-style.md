# Code Style — Observed Patterns in This Codebase

## Module System
**CommonJS** throughout the backend — `require()` / `module.exports`. Do not use ESM `import`/`export` in `backend/`.  
Frontend is **ESM** (`"type": "module"` in frontend/package.json) — use `import`/`export` there.

## Agent Structure (follow BaseAgent.js exactly)

```js
// backend/src/agents/<category>/<AgentName>.js
const { BaseAgent } = require('../core/BaseAgent');
const logger = require('../../utils/logger');

class MyAgent extends BaseAgent {
  constructor() {
    super('MyAgent');   // ← string name must match class name for toJSON/logging
  }

  async execute(context) {
    const log = logger.child({ agent: this.name, executionId: context.executionId });
    log.info('MyAgent started');
    // ... do work ...
    return result; // plain object
  }
}

module.exports = MyAgent;
```

- Override **`execute(context)`**, not `run()`. `run()` is final — it wraps execute() with status tracking and error re-throw.
- Call `log.info/warn/error` using the child logger, not the root logger.
- Return a plain object from `execute()`. Never return `this`.

## Singleton exports
API clients and the orchestrator export a **singleton instance**, not the class:
```js
module.exports = new AgentOrchestrator();   // AgentOrchestrator.js
module.exports = new AgentBrain();          // agentBrain.js
```
Services (`executionService`) export a plain object literal.

## Logging (Winston)
- Import: `const logger = require('../../utils/logger');`
- Always create a **child logger** in each agent/controller: `logger.child({ agent, executionId, route })`
- Log levels: `info` for normal progress, `warn` for non-blocking recoverable issues, `error` for thrown errors
- The logger applies `maskEmail()` automatically — do not manually redact emails from log messages
- Per-execution file transport: `createExecutionLogger(executionId)` adds a file transport; call the returned `removeExecLogger()` in `finally` to clean up

## Async Patterns
- All agent methods are `async/await`.
- Retry with backoff: `const { retryWithBackoff } = require('../../utils/retry');`
  - Respects `Retry-After` header on HTTP 429
  - Does NOT retry 4xx (except 429)
  - Defaults: `maxRetries=5`, `baseDelay=1000ms`, `maxDelay=30000ms`
- Never use raw `setTimeout` for wait loops — use `await new Promise(r => setTimeout(r, ms))`.

## Client Structure
Clients in `backend/src/clients/` are **function-based modules** (not always classes). Most export a plain object or singleton instance. Check the export shape before using.

## Error Handling
- Agents re-throw — `BaseAgent.run()` re-throws after `setStatus(FAILED)`, so the orchestrator controls recovery.
- Cleanup/non-critical paths: catch and `log.warn()`, do NOT re-throw.
- Controllers: `try/catch` at the top; `res.status(500).json({ error: err.message })` on failure.
- `Promise.all()` in bulk phases: individual pair errors are caught inside each `async(pair)` callback — one failing pair does not abort others.

## Naming Conventions
- Files: `PascalCase` for classes (`CleanupAgent.js`), `camelCase` for utilities (`retryWithBackoff.js`, `logger.js`)
- Classes: `PascalCase`
- Methods/variables: `camelCase`
- Agent names (passed to `super()`) match the class name exactly — used in `toJSON()`, `executionService.update({ currentAgent })`, and log `agent:` field

## No Comments Policy (default)
Only add a comment when the WHY is non-obvious — hidden constraints, workarounds, or API quirks. See existing agents for examples: comments appear on non-intuitive things like "devemail uses a separate auth flow" or "INBOX alongside SENT for outbound mail".
