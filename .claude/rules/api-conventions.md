# API Conventions — Observed Patterns in This Codebase

## Express Route Registration (server.js)
```js
app.use('/api/agents',          agentRoutes);
app.use('/api/agents',          messageRoutes);      // message product (Teams/Slack/Chat) — same prefix, separate router
app.use('/api/chat-cleaner',    chatCleanerProxy);   // Google Chat / Teams / Slack message cleanup
app.use('/api/test-repository', testRepositoryRoutes);
app.use('/api/test-cases',      testCaseRoutes);
app.use('/api/auth',            authRoutes);
app.use('/api/scope',           scopeRoutes);
app.get('/api/health', ...);
```

## Controller Pattern
Controllers are **standalone exported functions** (not a class, not a router):
```js
// agentController.js
async function runAgents(req, res) { ... }
function getExecution(req, res) { ... }
module.exports = { runAgents, getExecution, ... };
```
Then in the route file:
```js
const controller = require('../controllers/agentController');
router.post('/run', controller.runAgents);
```

## Async Run — 202 Pattern
Starting a single migration run is **fire-and-forget**:
1. Controller validates input, creates `MigrationContext`, calls `executionService.create(context)`
2. Responds immediately: `res.status(202).json({ executionId, status: 'RUNNING', ... })`
3. Kicks off background work via `setImmediate(() => orchestrator.runFullFlow(context))`

```
POST /api/agents/run
Body: { sourceEmail, destinationEmail, migrationType, testType, sourceProvider, destinationProvider,
        includeMail, includeCalendar, includeContacts, userEmailMappings, sourceAdminEmail, destAdminEmail,
        migrationServerUrl, migrationServerEmail, migrationServerPassword }
  → 202 { executionId, status: 'RUNNING', message, context }
  → 400 { error: 'sourceEmail and destinationEmail are required' }

// Bulk: include mappedPairs array instead of sourceEmail/destinationEmail
POST /api/agents/run  (bulk)
Body: { mappedPairs: [{sourceEmail, destinationEmail, sourceProvider, destinationProvider}], ... }
  → 202 { bulk: true, executionId, totalPairs, executionIds, status: 'RUNNING', message }
```

## Execution Polling
Frontend polls `GET /api/agents/executions/:id` every **3 seconds** (`executionStore.js` → `setInterval(tick, 3000)`).  
Stops polling when `status` is `COMPLETED`, `FAILED`, `INTERRUPTED`, or `CANCELLED`.

```
GET /api/agents/executions/:id
  → 200 { executionId, status, currentAgent, progress, result, error, createdAt, completedAt, context }
  → 404 { error: 'Execution not found' }
```

## Execution Statuses
`PENDING` → `RUNNING` → `COMPLETED` | `FAILED` | `CANCELLED`  
`INTERRUPTED` — set on startup for any execution that was `RUNNING` when the server restarted  
Resume: `POST /api/agents/executions/:id/resume`

## Execution Shape
```js
{
  executionId: string,        // UUID
  status: string,             // see above
  currentAgent: string,       // e.g. 'MigrationAgent'
  progress: string,           // human-readable status line
  result: {                   // null until completed
    executionId, status, duration,
    agentResults: [ { name, status, startedAt, completedAt, result, error } ],
    sourceData, migrationResult, validationSummary
  },
  error: string | null,
  createdAt: ISO string,
  completedAt: ISO string | null,
  context: MigrationContext.toJSON()
}
```

## Error Response Format
All errors return: `{ error: 'message string' }`  
HTTP 400 — missing required fields  
HTTP 404 — execution not found  
HTTP 500 — unhandled error (also caught by global error middleware in server.js)

## Key Agent-Specific Endpoints

```
GET  /api/agents/executions              → array of all executions (sorted newest first)
GET  /api/agents/executions/:id/logs     → { executionId, logs: [{level, message, timestamp, ...}] }
GET  /api/agents/executions/:id/pdf      → PDF blob (Content-Disposition: attachment)
POST /api/agents/executions/:id/cancel   → cancels a running execution
POST /api/agents/executions/:id/resume   → resumes an INTERRUPTED execution
GET  /api/agents/stats                   → { total, completed, failed, running, successRate, lastRun }
GET  /api/agents/test-connections        → { gmail, outlook, migration } connectivity status
GET  /api/agents/users/source?adminEmail=&provider=   → list of source mailbox users
GET  /api/agents/users/destination?adminEmail=&provider=
GET  /api/agents/mailbox-stats?email=&includeCalendar=
POST /api/agents/clean-destination       → { email }
POST /api/agents/clean-source            → { email }
POST /api/agents/create-test-data        → { email, testType, ... }
```

## Execution Storage
`executionService` uses **two layers**:
1. In-memory `Map<executionId, execution>` — fast reads during a live run
2. `backend/data/executions.json` — persisted on every `create()` / `update()`; re-loaded on startup

On startup, any execution with `status: 'RUNNING'` or `'PENDING'` is flipped to `'INTERRUPTED'` automatically.
