#!/bin/sh
# Claude Code pre-tool hook: validate backend code before writes.
# Exit 0 = proceed. Exit 2 = block the operation.

# NOTE: do NOT use set -e here — grep returns exit 1 when a pattern is not found,
# which is exactly the condition we want to catch, not abort on.

# ── 1. Block if .env is staged for commit ────────────────────────────────────
if git diff --cached --name-only 2>/dev/null | grep -qE '(^|/)\.env$'; then
  echo "BLOCKED: .env file is staged for commit. Remove it with: git reset HEAD .env"
  echo "Use .env.example for template; never commit actual credentials."
  exit 2
fi

# ── 2. Run ESLint on backend/src/ if available ───────────────────────────────
# backend/package.json includes eslint ^9.39.4 in devDependencies.
if command -v npx > /dev/null 2>&1; then
  REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
  if [ -f "$REPO_ROOT/backend/.eslintrc.js" ] || \
     [ -f "$REPO_ROOT/backend/.eslintrc.cjs" ] || \
     [ -f "$REPO_ROOT/backend/.eslintrc.json" ] || \
     [ -f "$REPO_ROOT/backend/.eslintrc.yaml" ] || \
     [ -f "$REPO_ROOT/backend/.eslintrc.yml" ] || \
     [ -f "$REPO_ROOT/backend/eslint.config.js" ] || \
     [ -f "$REPO_ROOT/backend/eslint.config.cjs" ] || \
     [ -f "$REPO_ROOT/backend/eslint.config.mjs" ]; then
    echo "Running ESLint on backend/src/..."
    npx --prefix "$REPO_ROOT/backend" eslint "$REPO_ROOT/backend/src/" --quiet 2>/dev/null && \
      echo "ESLint: OK" || \
      echo "ESLint: warnings/errors found (non-blocking)"
  else
    echo "ESLint: no eslint config found in backend/ — skipping"
  fi
fi

# ── 3. Warn if any file in backend/src/agents/ does not extend BaseAgent ─────
REPO_ROOT=${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}
AGENT_FILES=$(find "$REPO_ROOT/backend/src/agents" -name '*.js' ! -name 'BaseAgent.js' 2>/dev/null)
MISSING_BASE=""
for f in $AGENT_FILES; do
  if ! grep -q "BaseAgent" "$f" 2>/dev/null; then
    MISSING_BASE="$MISSING_BASE\n  $f"
  fi
done

if [ -n "$MISSING_BASE" ]; then
  echo ""
  echo "WARNING: The following agent files do not appear to extend BaseAgent:"
  printf "$MISSING_BASE\n"
  echo "All agents should extend BaseAgent from agents/core/BaseAgent.js."
  echo "(Non-blocking — continuing)"
fi

echo "validate-code.sh: all checks passed"
exit 0
