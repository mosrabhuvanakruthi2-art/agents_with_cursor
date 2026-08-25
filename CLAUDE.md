# CLAUDE.md — Migration QA Agent System

Guidance for Claude Code working in this repository. Read this before touching code.

Companion docs, all of them authoritative: [ARCHITECTURE.md](ARCHITECTURE.md) (how the system runs),
[CONTRIBUTING.md](CONTRIBUTING.md) (the combination-per-file rules — a hard structural constraint),
[README.md](README.md) (setup, endpoints, env vars), [docs/cloudfuze-apis.md](docs/cloudfuze-apis.md)
(which CloudFuze server each product migrates against).

---

## 1. What this project is

An AI-agent QA system for **cloud migrations**. It seeds test data in a source account, drives a
CloudFuze migration, then validates the destination and reports pass/fail. Three products:

| Product / domain | Combinations | Migration server |
|---|---|---|
| **mail** | Gmail→Outlook, Outlook→Gmail, Gmail→Gmail, Outlook→Outlook (`google`/`microsoft`) | `devemail.cloudfuze.com` |
| **content** | Box→SharePoint, Box→OneDrive, Drive→SharePoint, Drive→OneDrive | `qarelease.cloudfuze.com` |
| **message** | Slack↔Teams↔Google Chat combinations | `s2cdev.cloudfuze.com` |

The thing under test is itself QA automation, so "the run completed" is never a pass. A run that reports
`SUCCESS` while validating nothing is a bug.

## 2. Stack — as actually found in this repo

**Backend — `backend/`**

- **Node.js, CommonJS** (`require` / `module.exports`). No TypeScript, no build step, no transpiler.
- **Express 4** — routers in `src/routes/`, mounted in `src/server.js` under `/api/...`.
- **MongoDB 7 native driver**, no ORM/ODM. `src/db/mongo.js` (`connectMongo`, `getDb`); one
  `services/*MongoStore.js` per collection. The HTTP server starts **before** Mongo connects on purpose,
  so `getDb()` can return `null` — and JSON files under `backend/data/` are the fallback store.
- **Winston** — single logger in `src/utils/logger.js`, console + rotating `backend/logs/app.log`,
  a `maskEmail` format that masks addresses, `logger.child({ agent, executionId })`, and per-execution
  log files. Never `console.log` in `src/`.
- **Config** — `src/config/env.js` is the only place `process.env` is read (dotenv, `cleanEnvValue`,
  `validateEnv()` warns rather than crashes, `parseGoogleAccounts()`). Env vars are documented in
  `.env.example` at the repo **root**; real values live in the gitignored root `.env`
  (loaded by `config/env.js`; the frontend reads it via Vite `envDir: '../'`).
- **Auth** — Microsoft (MSAL) login → `POST /api/auth/microsoft/exchange` → app JWT signed with
  `env.JWT_SECRET` → `Authorization: Bearer` → `requireUser` in `src/middleware/authUser.js` sets
  `req.userEmail`; `ownsExecution()` scopes every execution read to its owner.
- **External clients** — `src/clients/`: Gmail, Google Calendar, Drive, Microsoft Graph, SharePoint, Box,
  Slack, Google Chat, CloudFuze devemail/chat/migration, Jira Xray, Grafana, plus Playwright browser
  clients. Wrap outbound calls with `src/utils/retry.js` (exponential backoff + rate limiting).
- **Agents** — extend `BaseAgent` (`src/agents/core/BaseAgent.js`, statuses
  `PENDING`/`RUNNING`/`SUCCESS`/`FAILED`), implement `async execute(context)`; `run()` owns status,
  timing, and logging. Sequenced by `src/orchestrator/AgentOrchestrator.js` /
  `MessageAgentOrchestrator.js` via `agentRegistry.js`.
- **Validation** — dispatcher `src/validation/index.js` → `validation/combinations/<combo>.js`;
  shared helpers in `validation/shared/deepMailCore.js` / `deepMessageCore.js`; comparison logic in
  `utils/mailMigrationComparator.js`; per-combination size/count bands in `utils/mailTolerance/`.
  Deep validation tiers: **Tier A** headers/recipients/attachment presence, **Tier B** SHA-256 attachment
  content hashes, **Tier C** normalized plain-text body.
- **Content validation** — the same shape for files/folders: shared helpers in
  `validation/shared/deepContentCore.js` (tree pairing, SharePoint rename + 400-char encoded-path rules,
  the file-conversion table, Tier B byte hashes, permission/link/version/timestamp comparators), bands in
  `utils/contentTolerance/<combo>.js`, and a per-feature rollup in
  `validation/shared/contentFunctionalityChecklist.js`. A combination opts in with
  `static supportsDeepValidation = true`; without it the orchestrator falls back to the report-only
  `ContentReportValidationAgent`, which compares nothing. Live today: `box→sharepoint`,
  `googledrive→sharepoint`. The documented feature list per combination lives in
  `backend/data/feature-scope/<combo>-inscope.md` / `-outscope.md` — **read it before changing a content
  validator**; an out-of-scope limitation (e.g. Google merging file revisions, so version counts cannot
  match) must be reported as INFO and must never fail a run.
- **Reports** — `utils/pdfGenerator.js` (pdfkit), `docx`, `exceljs`/`xlsx`.
- **Other** — `node-cron` scheduler (`config/scheduler.js`, `SCHEDULER_ENABLED`), Playwright automation
  (`services/cfBrowserAutomation.js`), AI analysis (`ai/agentBrain.js`, OpenAI `gpt-4o`;
  `@anthropic-ai/sdk` also present).
- **Tests** — plain **`node` + `assert`** scripts in `backend/test/*.test.js`, chained with `&&` in the
  `test` script of `backend/package.json`. **No Jest/Mocha/Vitest** — a new test file is invisible until
  it is added to that chain.
- **Lint** — ESLint 9 flat config `backend/eslint.config.js` (`no-undef` error, `no-unused-vars` warn).
  `npm run lint` is **clean: 0 errors**, ~160 `no-unused-vars` warnings. **Any error is yours.**
  The config has a second block giving browser globals (`document`/`window`/`CSS`) to the three
  Playwright files — `services/cfBrowserAutomation.js`, `clients/devemailBrowserClient.js`,
  `clients/qareleaseBrowserClient.js` — because the callbacks passed to `page.evaluate()` run in the
  browser, not in Node.

**Frontend — `frontend/`** (a real SPA, so frontend work has its own agent)

- **React 19 + Vite 8, ESM** (`type: module`), `.jsx`. **Tailwind CSS 4** via `@tailwindcss/vite` —
  utilities only, no `tailwind.config.js`. **React Router 7**. axios. `xlsx` for client-side export.
- `src/App.jsx` holds the routes and the `RequireAuth` gate; screens in `src/pages/`; shared components in
  `src/components/` (`Layout`, `Sidebar`, `StatusBadge`, `LogViewer`, `ValidationTable`, `ResultsView`,
  `DonutChart`); the run wizard in `src/components/runwizard/`.
- **`src/services/api.js` is the only axios instance**: `baseURL: '/api'`, request interceptor attaching
  the `sessionStorage` `app_token`, response interceptor clearing the session and redirecting on `401`.
- Polling hooks `useAgentExecution` / `useMessageAgentExecution`; `usePersistedState` for wizard state
  (never for credentials). Vite dev proxy sends `/api` to `localhost:5000` with no timeout.
- **No frontend test runner** — verification is `npm run lint` and `npm run build`.

**API conventions**

- Errors are flat JSON with an `error` string: `res.status(400).json({ error: '…' })`. Statuses in use:
  `400` validation, `401` unauthenticated, `404` missing, `409` conflict, `500` internal (the terminal
  middleware returns `{ error: 'Internal server error' }` — stack traces never reach the client).
- **Long operations return `202`** with an `executionId`, then continue in
  `setImmediate(() => orchestrator.runFullFlow(ctx).catch(...))` while the UI polls
  `GET /api/agents/executions/:id`.

**Formatting** — 2-space indent, single quotes, semicolons, ~100 cols, trailing commas (es5),
**LF endings** (`.gitattributes` + `.editorconfig`; CRLF causes whitespace-only conflicts).
Root `.prettierrc.json` holds the shared settings.

**Branches** — work happens on `dev`; `main` is the usual PR target.

---

## 3. GStack Multi-Agent Workflow

Fourteen specialist agents in [.claude/agents/](.claude/agents/), each prefixed `gstack-`, driven by two
playbooks in [.claude/workflows/](.claude/workflows/). One agent per SDLC role a human would otherwise
own; `Developer` is the only role split in two (backend / frontend), because those are different stacks.

Four splits are deliberate and must not be merged back together:

- **requirements** (`business-analyst`) is separate from **design** (`architect`)
- **diagnosis** (`debugger`, read-only) is separate from **the fix** (engineers)
- **code quality**, **security**, and **functional QA** are three independent passes in that order
- **automated tests** (`test-engineer`) are separate from **seeded QA cases** (`test-case-author`)

| Agent | Role |
|---|---|
| [`gstack-business-analyst`](.claude/agents/gstack-business-analyst.md) | Business Analyst. **First** in `new-feature`. Turns a request into a requirements doc with numbered, individually testable behaviour rules. Writes `ai-sdlc/requirements/specs/NNN-slug.md` at `Status: Draft` — never approves it. |
| [`gstack-tech-lead`](.claude/agents/gstack-tech-lead.md) | Tech Lead. Feasibility against the real repo + **blast radius** (Contained / Cross-combination / Contract / Platform) + pipeline routing. Read-only, no design. |
| [`gstack-product-owner`](.claude/agents/gstack-product-owner.md) | Product Owner. User stories with Given/When/Then acceptance criteria that QA later tests **by name**, each with an expected verdict and ≥1 negative case. |
| [`gstack-architect`](.claude/agents/gstack-architect.md) | Architect. System design **only** — consumes the *approved* requirements doc; does not gather requirements. Produces a design the **user** must approve. |
| [`gstack-debugger`](.claude/agents/gstack-debugger.md) | Debugger. **First** in `bug-fix`. Establishes root cause with `file:line` evidence, rules out alternatives, names the fault owner — then **stops**. Read-only; never applies the fix. |
| [`gstack-test-engineer`](.claude/agents/gstack-test-engineer.md) | Test Engineer. Writes `node+assert` tests **and wires them into the `&&` chain** in `backend/package.json` — a test file missing from that chain never runs. Never edits production code. |
| [`gstack-test-case-author`](.claude/agents/gstack-test-case-author.md) | Test Case Author. Adds seeded migration cases to `gmail-test-cases.xlsx` / `outlook-test-cases.xlsx` / the content-seeding path, so **future** runs cover the new behaviour, not just this one. |
| [`gstack-sre`](.claude/agents/gstack-sre.md) | SRE. Advisory reliability pass before the commit gate: unbounded external calls, `Promise.all` barrier deadlocks, orphaned `RUNNING` executions, log hygiene, degradation. **Never deployment.** |
| [`gstack-backend-engineer`](.claude/agents/gstack-backend-engineer.md) | Implements the approved design in `backend/` — models, orchestrator combinations, agents, routes, validation, auth, logging, `node+assert` tests. |
| [`gstack-frontend-engineer`](.claude/agents/gstack-frontend-engineer.md) | Implements client-side work in `frontend/` — pages, wizard steps, `api.js` functions, polling hooks, Tailwind UI. |
| [`gstack-code-reviewer`](.claude/agents/gstack-code-reviewer.md) | Quality and maintainability. Runs **twice**: after implementation, and as the final pass after QA + security. |
| [`gstack-qa-engineer`](.claude/agents/gstack-qa-engineer.md) | Functional validation — happy path, input validation, error paths, edge cases, plus this repo's domain checks (four combinations, Tier A/B/C, mapping, tolerances, bulk runs, per-user scoping, cleanup, reports, persistence fallback). |
| [`gstack-security-reviewer`](.claude/agents/gstack-security-reviewer.md) | Security audit — injection, XSS, SSRF, authn/authz isolation, secret exposure, unsafe file handling. **Critical/High findings block the commit gate.** |
| [`gstack-documentation-engineer`](.claude/agents/gstack-documentation-engineer.md) | Updates docs after the reviews pass, before the commit gate. |

### Workflows

**[`new-feature.yaml`](.claude/workflows/new-feature.yaml)** — requirements analysis (BA) → feasibility &
blast radius (tech lead) → user stories (PO) → **Requirements approval gate (blocking)** → architecture
design → **Design approval gate (blocking)** → implementation → automated tests → code review (verdict
gate) → QA (verdict gate) → security review (**blocking on Critical/High**) → final code review (verdict
gate) → seeded test cases → documentation → reliability review (advisory) →
**Commit Decision Gate (last step)**.

**[`bug-fix.yaml`](.claude/workflows/bug-fix.yaml)** — root-cause diagnosis (`gstack-debugger`, read-only,
before any edit) → **Diagnosis confirmation gate (blocking)** → implementation → QA → security review
(**conditional** — only when the fix touches auth, input handling, file handling, uploads, external calls,
secrets, cleanup/delete endpoints, or Playwright/eval surfaces; **blocking on Critical/High**) → code
review (verdict gate) → documentation (**only if behavior or a contract changed**) →
**Commit Decision Gate (last step)**.

**Loop-back ceiling.** Every verdict gate that returns work to implementation does so at most **twice**
(`max_retries: 2`). On the third failure, stop and escalate to the user with what was tried and why it
did not hold — do not grind indefinitely.

**Artifacts.** Requirements live at `ai-sdlc/requirements/specs/NNN-slug.md` (the BA writes it; the tech
lead and PO **append sections to the same file**, so one document is reviewed at the requirements gate).
Designs live at `ai-sdlc/design/NNN-slug-design.md`, sharing the same `NNN`.

These YAML files are declarative playbooks for Claude to follow — not scripts for the `Workflow` tool
(which expects JavaScript). Read the relevant one and execute its steps in order.

### Guardrails — what is actually enforced vs merely instructed

Be honest about the difference. Only the first table is mechanically enforced; everything in the second
holds exactly as long as the agent chooses to comply.

**(a) ENFORCED** — by [`.claude/hooks/gstack-guard.js`](.claude/hooks/gstack-guard.js), wired as a
`PreToolUse` hook in [`.claude/settings.json`](.claude/settings.json). The hook exits `2`, which
**blocks the tool call outright** regardless of what the model decided. `settings.json` is committed on
purpose so the whole team gets it; only `settings.local.json` (personal prefs) stays gitignored.

| Rule | Mechanism |
|---|---|
| No commit or push without human approval | Blocked unless `.claude/COMMIT_APPROVED` exists. **One-shot** — consumed on use, so one approval never authorizes a series |
| Agents cannot self-authorize a commit | Writing `.claude/COMMIT_APPROVED` via a tool call is blocked; only a human can create it in a terminal |
| No force-push, no `--no-verify` | Blocked unconditionally |
| No blanket staging (`git add -A` / `git add .`) | Blocked — this is how untracked secrets get committed |
| No direct push to `main`/`master` | Blocked — `main` is the PR target |
| No staged secrets | `git commit`/`push` blocked if `.env*`, `backend/config/*.json`, `oauth-tokens.json`, `*service-account*`, or runtime `backend/data/*.json` is staged — **approval does not override this** |
| No writing secret files | `Write`/`Edit` to `.env*`, `backend/config/*.json`, `oauth-tokens.json` blocked (`.env.example` stays writable) |
| The lock cannot disable itself | `Write`/`Edit` to the guard script or `settings.json` is blocked |

To authorize one commit, **the user** runs (agents cannot):

```bash
touch .claude/COMMIT_APPROVED
```

Known limitation, stated plainly: where spawning `git` from the hook is restricted, staged-secret
scanning degrades to a printed **warning** rather than a block — it does not silently pass. The other
defences (`.gitignore` covering `.env*`, blocked blanket staging, blocked secret writes) still apply.

**(b) INSTRUCTED ONLY** — real rules, no mechanical enforcement. Nothing in this list can be blocked by
this tool; they hold because the agent follows this file.

- The Requirements, Design, and Diagnosis approval gates
- Verdict gates (code review / QA / security) and the `max_retries: 2` ceiling
- Review ordering — quality, then security, then QA
- Combination isolation and the one-combination-per-file rule
- No new dependency / framework / TypeScript / test runner
- Honest reporting — a test that could not run is reported NOT RUN, never as passed
- Asking **which branch** at the commit gate (the hook enforces *that* approval happened, not that the
  branch question was asked)

There is **no CI** in this repo (`.github/` does not exist), so there is no server-side backstop for any
of the above. Adding one is a separate, team-owned decision and is out of GStack's scope.

### Gate rules — not negotiable

- **The design approval gate is the user's.** `gstack-architect` never approves its own design. Silence,
  "sounds good in principle", or agent confidence is not approval. Implementation does not start until the
  user says so explicitly. If requirements change after approval, re-approve.
- **A `CHANGES REQUESTED` or `FAIL` verdict returns the work to the engineer.** The workflow does not
  advance past a failed gate.
- **Critical/High security findings block the commit gate** until fixed and re-audited.
- **Never auto-commit and never auto-push.** The Commit Decision Gate is always the last step. It asks
  **"commit and push?"** and then, only on yes, **which branch — current (`dev`), an existing branch, or a
  new one.** Never assume the branch; wait for the answer. Stage only this change's files, and verify no
  `.env`, `backend/config/*.json`, `oauth-tokens.json`, or `backend/data/*.json` is staged.

### There is no DevOps / deployment agent — by design

Deployment, CI/CD, release automation, infrastructure, and environment provisioning are **out of scope**
for GStack and are handled by automation that already exists outside this workflow. Do not create a
deployment agent, do not add a deploy step to a workflow, do not modify CI config as part of GStack work,
and do not offer to deploy after a push. The workflow ends at the commit gate.

---

## 4. Which workflow to use

**Use GStack (default) for:**

- Any new feature or user-facing capability
- Any medium-to-large change, or one spanning three or more files
- A multi-file bug fix, or a bug whose root cause is not yet known (`bug-fix.yaml`)
- Anything touching **auth** — login, the app JWT, `requireUser`, `ownsExecution`, per-user scoping
- Anything touching the **data model** — `MigrationContext`, `MessageMigrationContext`,
  `ValidationResult`, or a persisted Mongo document shape
- A new or changed **external integration** — Gmail, Graph, a CloudFuze server, Slack, Box, Drive,
  Jira Xray, OpenAI/Anthropic
- A new migration combination, a new domain, or any edit to `validation/shared/*` or
  `utils/mailMigrationComparator.js` (shared contracts across all four mail combinations)
- Changes to cleanup/delete endpoints, or to validation logic that decides pass/fail

**Use Direct mode (no agents, just do it) for:**

- Typos, comment fixes, wording
- Docs-only edits
- A single-file change with obvious, contained behavior
- Formatting, import ordering, lint-only fixes
- Adding a log line, renaming a local variable
- Answering a question about the codebase without changing it

**User override, always wins:**

- **"use gstack"** — run the full workflow even for something small
- **"quick fix"** / **"direct"** — skip the workflow and make the change directly

When it is genuinely ambiguous, say which mode you are taking and why, in one line, then proceed. Do not
stop and ask unless the choice changes the work materially. A Direct-mode change that turns out to be
larger than it looked escalates to GStack — say so and switch.

---

## 5. Repository Awareness Requirements

These apply to every agent and to Direct mode alike.

**Inspect the real repo state, every time.** Read the files you are about to change and their neighbours
before writing. Do not reason from memory of "typical Node/Express/React projects" or from an earlier
session's picture of this repo — it is a fast-moving tree. Verify a path, a function name, an env var, or
an endpoint exists before referencing it. Check `git status` and `git diff` before assuming the working
tree is clean.

**Reuse existing conventions rather than importing your own.** Match the module system (CommonJS in
`backend/`, ESM in `frontend/`), the error-response shape (`{ error: '…' }`), the `202`-and-poll pattern,
`config/env.js` for configuration, the Winston logger, `utils/retry.js` for outbound calls, `BaseAgent`
for agents, `getDb()` for Mongo, `api.js` for frontend requests, and the surrounding file's comment
density and naming. When a helper already exists — `mailMigrationComparator`, `gmailOutlookLabelMatch`,
`deepMailCore`, `mailTolerance`, `StatusBadge`, `LogViewer` — extend it instead of writing a parallel one.

**Use the existing test framework.** Tests are plain `node` + `assert` files in `backend/test/`, wired
into the `&&` chain in `backend/package.json`. Do not introduce Jest, Mocha, Vitest, a frontend test
runner, or any assertion library. If something cannot be unit-tested that way, hand it to
`gstack-qa-engineer` as explicit manual steps rather than adding a framework.

**Do not introduce new technology.** No new dependency, framework, language, ORM, TypeScript, build step,
or architectural pattern unless an **approved `gstack-architect` design** names it and the user has
approved that design. The existing dependency set is broad — reach for what is already installed first.
Bug fixes never add a dependency.

**Respect the combination-per-file structure.** One combination = its own files
(`orchestrator/combinations/<domain>/<combo>.js`, `validation/combinations/<combo>.js`,
`utils/mailTolerance/<combo>.js`). Do not edit another combination's files in your change. A new
combination is **new files only** — both registries auto-load by scanning their directory. Changes to
`validation/shared/*` or `utils/mailMigrationComparator.js` affect all four mail combinations: keep them
minimal, verify every combination, and flag them for review.

**Preserve existing content when appending.** When adding to this file or any other doc, append and
integrate — never drop, reorder, or rewrite sections that are already here because you would have
structured them differently. The same holds for `README.md`, `ARCHITECTURE.md`, `CONTRIBUTING.md`, and
`docs/cloudfuze-apis.md`.

**Never commit secrets.** The root `.env`, `backend/config/*.json`, and the runtime JSON files under
`backend/data/` are gitignored deliberately. New env vars go into the root `.env.example` as
**placeholders**. Tokens, passwords, and JWTs must never reach a log line, an HTTP response, a PDF report,
or a doc — the logger masks email addresses only.

**Report outcomes honestly.** If a test fails, say so and paste the output. If a scenario could not be
run, report it as not run with the manual steps a human needs. If part of the scope was left undone, say
which part and why.
