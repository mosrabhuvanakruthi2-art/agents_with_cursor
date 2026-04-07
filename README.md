# Migration QA Agent System

AI Agent System for Gmail → Outlook migration quality assurance. Three intelligent agents orchestrated via a Node.js backend and React dashboard.

## Architecture

- **GmailTestDataAgent** — Generates test emails (plain, HTML, attachments, inline images), labels, drafts, and calendar events using the Gmail INSERT API
- **MigrationAgent** — Triggers and monitors an external migration tool via API polling with exponential backoff
- **OutlookValidationAgent** — Validates migrated data in Outlook via Microsoft Graph API (mail counts, folder mapping, attachments, calendar events)

## Tech Stack

| Layer    | Technology                                     |
|----------|------------------------------------------------|
| Backend  | Node.js 20+, Express, Winston, node-cron       |
| Frontend | React (Vite), Tailwind CSS, React Router       |
| APIs     | Gmail API, Google Calendar API, Microsoft Graph |

## Quick Start

### 1. Backend

```bash
cd backend
cp .env.example .env
# Fill in your API credentials in .env
npm install
npm run dev
```

The server starts on `http://localhost:5000`.

### 2. Frontend

```bash
cd frontend
npm install
npm run dev
```

The dashboard opens at `http://localhost:3000` (proxies API calls to the backend).

## API Endpoints

| Method | Endpoint                          | Description              |
|--------|-----------------------------------|--------------------------|
| POST   | `/api/agents/run`                 | Trigger full QA flow     |
| GET    | `/api/agents/executions`          | List all executions      |
| GET    | `/api/agents/executions/:id`      | Get execution details    |
| GET    | `/api/agents/executions/:id/logs` | Get execution logs       |
| GET    | `/api/agents/stats`               | Get execution statistics |
| GET    | `/api/health`                     | Health check             |

## Environment Variables

See `backend/.env.example` for all required variables:

- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` — Google OAuth2
- `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET`, `GRAPH_TENANT_ID` — Microsoft Graph
- `MIGRATION_API_URL`, `MIGRATION_API_KEY` — External migration tool
- `SCHEDULER_ENABLED` — Enable daily 2 AM scheduled runs

## Project Structure

```
backend/
  src/
    agents/core/BaseAgent.js          # Base agent class
    agents/gmail/GmailTestDataAgent.js
    agents/migration/MigrationAgent.js
    agents/outlook/OutlookValidationAgent.js
    orchestrator/AgentOrchestrator.js  # Sequential agent runner
    clients/                           # API client wrappers
    controllers/agentController.js
    routes/agentRoutes.js
    services/executionService.js       # In-memory execution store
    models/                            # MigrationContext, ValidationResult
    utils/logger.js                    # Winston with email masking
    utils/retry.js                     # Exponential backoff + rate limiting
    config/scheduler.js                # node-cron daily scheduler
    ai/agentBrain.js                   # Future AI integration placeholder

frontend/
  src/
    pages/Dashboard.jsx
    pages/RunAgent.jsx
    pages/ExecutionLogs.jsx
    pages/ValidationResults.jsx
    components/                        # Layout, Sidebar, StatusBadge, etc.
    services/api.js                    # Axios API client
    hooks/useAgentExecution.js         # Custom hook for run + poll
```
