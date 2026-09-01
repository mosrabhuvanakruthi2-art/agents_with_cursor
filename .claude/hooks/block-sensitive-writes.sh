#!/bin/sh
# Claude Code PreToolUse hook: block writes to sensitive files.
# Tool input arrives as JSON on stdin. Exit 0 = allow. Exit 2 = block.

# ── Extract target file path from stdin JSON ─────────────────────────────────
INPUT=$(cat)

if command -v jq > /dev/null 2>&1; then
  FILE=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
elif command -v python3 > /dev/null 2>&1; then
  FILE=$(printf '%s' "$INPUT" | python3 -c \
    "import sys,json; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('file_path',''))" \
    2>/dev/null)
else
  echo "BLOCKED: block-sensitive-writes.sh requires jq or python3 to inspect write targets."
  echo "Install jq (https://stedolan.github.io/jq/) to enable sensitive-file protection."
  echo "Until then, all writes to sensitive files are blocked as a safe default."
  exit 2
fi

if [ -z "$FILE" ]; then
  exit 0
fi

# Normalize path separators (handle Windows backslashes)
NORMALIZED=$(printf '%s' "$FILE" | tr '\\' '/')

# ── Rule 1: Block writes to .env files ───────────────────────────────────────
case "$NORMALIZED" in
  */.env|.env)
    echo "BLOCKED: Refusing to write to .env — this file contains credentials."
    echo "Blocked file: $FILE"
    echo "Edit .env.example instead, or set variables directly in your shell."
    exit 2
    ;;
esac

# ── Rule 2: Block writes to token JSON files ─────────────────────────────────
if printf '%s' "$NORMALIZED" | grep -qiE 'token[^/]*\.json$|oauth[^/]*\.json$'; then
  echo "BLOCKED: Refusing to write to token/OAuth JSON file."
  echo "Blocked file: $FILE"
  echo "Reason: OAuth tokens are managed by oauthTokenStore.js and the /api/auth endpoints."
  exit 2
fi

# ── Rule 3: Block writes to executions.json ──────────────────────────────────
# Checked before the backend/data/ catch-all so this path gets a specific message.
if printf '%s' "$NORMALIZED" | grep -qE 'executions\.json$'; then
  echo "BLOCKED: Refusing to write to executions.json."
  echo "Blocked file: $FILE"
  echo "Reason: Execution records are managed exclusively by executionService.js."
  exit 2
fi

# ── Rule 4: Block writes inside backend/data/ ────────────────────────────────
if printf '%s' "$NORMALIZED" | grep -qE '(^|/)backend/data/'; then
  echo "BLOCKED: Refusing to write to backend/data/ directory."
  echo "Blocked file: $FILE"
  echo "Reason: data/ contains runtime state (executions, tokens, test repos). Modify via API or designated scripts only."
  exit 2
fi

# Allow
exit 0
