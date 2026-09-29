// #!/usr/bin/env node
// /**
//  * GStack enforcement hook — the only guardrails in this repo that are mechanically enforced.
//  *
//  * Wired as a PreToolUse hook in .claude/settings.json (committed, so the whole team gets it).
//  * Reads the tool call as JSON on stdin. Exit 0 = allow, exit 2 = BLOCK (stderr is shown to the model).
//  *
//  * Everything else in the GStack workflow — the design gate, the requirements gate, verdict gates,
//  * combination isolation, honest reporting — is INSTRUCTED ONLY in CLAUDE.md. This file is the
//  * difference between "the rules say don't" and "you cannot".
//  *
//  * What is enforced here:
//  *   1. Commit gate      — `git commit` is blocked unless a human created .claude/COMMIT_APPROVED
//  *                         (one-shot: consumed on use). Claude cannot create it — see rule 4.
//  *   2. Dangerous git    — force-push, --no-verify, `git add -A` / `git add .`, direct push to main.
//  *   3. Secret files     — no writing .env*, backend/config/*.json, oauth-tokens.json; no staging them.
//  *   4. Self-protection  — this hook, settings.json, and the approval sentinel cannot be edited by a
//  *                         tool call, so the lock cannot disable itself.
//  *
//  * No dependencies. Node only. Must never throw — a crashing hook that fails open is worse than none,
//  * so unexpected errors deliberately BLOCK on git operations and allow everything else.
//  */

// 'use strict';

// const fs = require('fs');
// const path = require('path');

// const SENTINEL = '.claude/COMMIT_APPROVED';

// // Resolve from this script's own location, never from the payload's `cwd`: that value may arrive in
// // POSIX form (/c/Users/...) on a Windows host, and path.join would turn it into a path that exists
// // nowhere — silently breaking the gate. This file is always at <repo>/.claude/hooks/gstack-guard.js.
// const CLAUDE_DIR = path.resolve(__dirname, '..');
// const REPO_ROOT = path.resolve(__dirname, '..', '..');
// const SENTINEL_PATH = path.join(CLAUDE_DIR, 'COMMIT_APPROVED');

// function block(message) {
//   process.stderr.write(`\n[GStack guard] BLOCKED\n${message}\n`);
//   process.exit(2);
// }

// function allow() {
//   process.exit(0);
// }

// /** Normalize a path for matching: forward slashes, lowercase, no leading ./ */
// function norm(p) {
//   return String(p || '')
//     .replace(/\\/g, '/')
//     .replace(/^\.\//, '')
//     .toLowerCase();
// }

// /** Collapse whitespace so `git   commit` and `git\tcommit` match too. */
// function flatten(cmd) {
//   return String(cmd || '').replace(/\s+/g, ' ').trim();
// }

// // ── Protected write targets ────────────────────────────────────────────────────
// // Real credentials live in these. .env.example is the documented placeholder file and stays writable.
// const PROTECTED_WRITE = [
//   { re: /(^|\/)\.env(\.|$)/, why: 'holds real credentials (.env.example is the placeholder file to edit instead)' },
//   { re: /(^|\/)backend\/config\/.*\.json$/, why: 'service-account / OAuth key material' },
//   { re: /(^|\/)oauth-tokens\.json$/, why: 'live OAuth refresh tokens' },
//   { re: /(^|\/)\.claude\/settings\.json$/, why: 'carries the GStack enforcement hooks — a tool call must not weaken its own guardrails' },
//   { re: /(^|\/)\.claude\/hooks\//, why: 'the enforcement hook itself — a tool call must not disable its own lock' },
//   { re: /(^|\/)\.claude\/commit_approved$/, why: 'the commit approval sentinel is a HUMAN action; create it yourself in a terminal' },
// ];

// function checkWrite(filePath) {
//   const p = norm(filePath);
//   if (!p) return allow();
//   // .env.example is explicitly allowed — it is how new env vars get documented.
//   if (/(^|\/)\.env\.example$/.test(p)) return allow();
//   for (const rule of PROTECTED_WRITE) {
//     if (rule.re.test(p)) {
//       block(
//         `Refusing to write: ${filePath}\nReason: ${rule.why}.\n\n` +
//         'If this is genuinely needed, the user must edit this file themselves outside the agent.'
//       );
//     }
//   }
//   return allow();
// }

// /**
//  * Staged file list, or null if git could not be run at all.
//  * Tries the git binary directly first (works where spawning a shell is restricted), then a shell.
//  * The command is fixed — no interpolated input, nothing to inject.
//  */
// function listStagedFiles(cwd) {
//   const cp = require('child_process');
//   const opts = { cwd: REPO_ROOT, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] };
//   const attempts = [
//     () => cp.execFileSync('git', ['diff', '--cached', '--name-only'], opts),
//     () => cp.execFileSync('git.exe', ['diff', '--cached', '--name-only'], opts),
//     () => cp.execSync('git diff --cached --name-only', opts),
//   ];
//   for (const attempt of attempts) {
//     try {
//       const out = attempt();
//       return String(out).split('\n').map((s) => s.trim()).filter(Boolean);
//     } catch {
//       /* try the next strategy */
//     }
//   }
//   return null;
// }

// // ── Git enforcement ───────────────────────────────────────────────────────────
// function checkBash(command, cwd) {
//   const cmd = flatten(command);

//   // Read-only git is always fine.
//   if (/^git (status|diff|log|show|branch|remote|check-ignore|rev-parse|merge-base|fetch|ls-files|stash list|config --get)\b/.test(cmd)) {
//     return allow();
//   }

//   const isCommit = /\bgit\b[^|;&]*\bcommit\b/.test(cmd);
//   const isPush = /\bgit\b[^|;&]*\bpush\b/.test(cmd);

//   // --- Always-forbidden git flags, regardless of approval -------------------
//   if (isPush && /(--force\b|--force-with-lease\b|\s-f(\s|$))/.test(cmd)) {
//     block('Force-push is never allowed by GStack. Rewriting shared history is a human decision made deliberately, outside the agent.');
//   }
//   if ((isCommit || isPush) && /--no-verify\b/.test(cmd)) {
//     block('--no-verify bypasses repo hooks. Fix the underlying failure instead of skipping the check.');
//   }
//   if (/\bgit\s+add\s+(-A\b|--all\b|\.(\s|$))/.test(cmd)) {
//     block(
//       'Blanket staging (`git add -A` / `git add .`) is blocked — it is how untracked secrets and unrelated edits get committed.\n' +
//       'Stage only the files belonging to this change, by name.'
//     );
//   }
//   if (isPush && /\b(origin\s+)?(main|master)\b/.test(cmd)) {
//     block(
//       'Direct push to main/master is blocked. main is the PR target in this repo; work lands on dev or a feature branch and goes through review.'
//     );
//   }

//   if (!isCommit && !isPush) return allow();

//   // --- Never commit or push staged secrets ---------------------------------
//   // Independent of the approval sentinel: approval is not a licence to leak credentials.
//   const staged = listStagedFiles(cwd);

//   if (staged === null) {
//     // Could not run git at all (restricted environment: neither the git binary nor a shell was
//     // spawnable). Report it honestly rather than pretending the check passed — but do NOT hard-block,
//     // or the commit path breaks permanently wherever spawning is restricted. The primary secret
//     // defences still hold independently: .gitignore covers .env*, `git add -A` is blocked above, and
//     // writes to secret files are blocked in checkWrite().
//     process.stderr.write(
//       '[GStack guard] WARNING: could not run `git diff --cached` to verify staged files.\n' +
//       '  Staged-secret scanning is unavailable in this environment. Verify by hand before pushing:\n' +
//       '    git diff --cached --name-only\n'
//     );
//   } else {
//     const leaking = staged.filter((f) => {
//       const p = norm(f);
//       if (/(^|\/)\.env\.example$/.test(p)) return false;
//       return (
//         /(^|\/)\.env(\.|$)/.test(p) ||
//         /(^|\/)backend\/config\/.*\.json$/.test(p) ||
//         /(^|\/)oauth-tokens\.json$/.test(p) ||
//         /(^|\/)backend\/data\/(executions|custom-test-cases|test-repository|channel-cache)\.json$/.test(p) ||
//         /service-account/.test(p) ||
//         /-credentials\.json$/.test(p)
//       );
//     });

//     if (leaking.length) {
//       block(
//         `These staged files must never be committed:\n  ${leaking.join('\n  ')}\n\n` +
//         'Unstage them (`git restore --staged <file>`) and confirm .gitignore covers them.'
//       );
//     }
//   }

//   // --- The commit gate -----------------------------------------------------
//   if (fs.existsSync(SENTINEL_PATH)) {
//     // One-shot: consume it so a single approval cannot authorize an unbounded series of commits.
//     try {
//       fs.unlinkSync(SENTINEL_PATH);
//     } catch {
//       /* if it cannot be removed, the next call simply re-checks — never fail open silently */
//     }
//     return allow();
//   }

//   block(
//     `The GStack Commit Decision Gate has not been passed.\n\n` +
//     `${isCommit ? 'Commit' : 'Push'} requires explicit human approval. Ask the user:\n` +
//     `  1. whether to commit at all, and\n` +
//     `  2. which branch (current / an existing one / a new one) — never assume.\n\n` +
//     `Then the USER — not the agent — authorizes it by running:\n` +
//     `  cmd //c "type nul > ${SENTINEL}"      (Windows cmd)\n` +
//     `  New-Item -ItemType File ${SENTINEL}   (PowerShell)\n` +
//     `  touch ${SENTINEL}                     (bash)\n\n` +
//     `That file authorizes exactly one git commit/push and is consumed on use.`
//   );
// }

// // ── Entry ─────────────────────────────────────────────────────────────────────
// let raw = '';
// process.stdin.setEncoding('utf8');
// process.stdin.on('data', (c) => {
//   raw += c;
// });
// process.stdin.on('end', () => {
//   let payload = {};
//   try {
//     payload = JSON.parse(raw || '{}');
//   } catch {
//     // Malformed payload — must NOT fail open, or a badly-escaped path (e.g. an unescaped Windows
//     // backslash) becomes a way to slip a commit past the gate. Fall back to scanning the raw text:
//     // anything that looks like a commit/push or a write to a protected file is refused.
//     if (/\bgit\b[^"]*\b(commit|push)\b/.test(raw) || /\.env|oauth-tokens|backend\/config/.test(raw)) {
//       block(
//         'Hook payload could not be parsed, and the raw call looks like a commit/push or a protected-file write.\n' +
//         'Refusing rather than failing open. Retry, or perform this step manually.'
//       );
//     }
//     return allow();
//   }

//   const tool = payload.tool_name || '';
//   const input = payload.tool_input || {};
//   const cwd = payload.cwd || process.cwd();

//   try {
//     if (tool === 'Bash') return checkBash(input.command, cwd);
//     if (tool === 'Write' || tool === 'Edit' || tool === 'NotebookEdit') {
//       return checkWrite(input.file_path || input.notebook_path);
//     }
//     return allow();
//   } catch (err) {
//     // Unexpected failure: block git, allow the rest. Never fail open on a commit.
//     if (tool === 'Bash' && /\bgit\b[^|;&]*\b(commit|push)\b/.test(flatten(input.command))) {
//       block(`Guard error on a git operation (${err.message}). Refusing rather than failing open.`);
//     }
//     return allow();
//   }
// });
