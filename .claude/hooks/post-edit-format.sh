#!/bin/bash
# Post-edit hook: validates that modified agent files follow the BaseAgent pattern.
# Triggered after Write or Edit on any .js file under backend/src/agents/.
# This hook warns only — it does not block the edit.

set -euo pipefail

# Read the file path from the hook input (passed as the first argument or from stdin)
FILE_PATH="${1:-}"
if [ -z "$FILE_PATH" ]; then
  # Try reading from stdin (Claude Code hooks pass input via stdin as JSON)
  INPUT=$(cat)
  FILE_PATH=$(echo "$INPUT" | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"file_path"[[:space:]]*:[[:space:]]*"//;s/"//')
fi

# Only act on agent files in the backend
if [[ "$FILE_PATH" != *"backend/src/agents/"* ]] || [[ "$FILE_PATH" != *.js ]]; then
  exit 0
fi

WARNINGS=()

# Check 1: extends BaseAgent
if ! grep -q "extends BaseAgent" "$FILE_PATH" 2>/dev/null; then
  WARNINGS+=("WARN: No 'extends BaseAgent' found in $FILE_PATH")
fi

# Check 2: super() called with a string argument (should match class name)
if grep -q "class.*extends BaseAgent" "$FILE_PATH" 2>/dev/null; then
  if ! grep -q "super('" "$FILE_PATH" 2>/dev/null; then
    WARNINGS+=("WARN: No super('ClassName') call found in constructor in $FILE_PATH")
  fi
fi

# Check 3: execute() is implemented, not run()
if grep -q "async run(context)" "$FILE_PATH" 2>/dev/null; then
  WARNINGS+=("WARN: run(context) is overridden in $FILE_PATH — override execute(context) instead")
fi

# Check 4: child logger pattern
if grep -q "logger.child" "$FILE_PATH" 2>/dev/null; then
  if ! grep -q "agent: this.name" "$FILE_PATH" 2>/dev/null; then
    WARNINGS+=("WARN: logger.child() found but 'agent: this.name' is missing in $FILE_PATH")
  fi
fi

# Check 5: validation agents — pdfGenerator call
if [[ "$FILE_PATH" == *"ValidationAgent"* ]]; then
  if ! grep -q "pdfGenerator.generatePdf" "$FILE_PATH" 2>/dev/null; then
    WARNINGS+=("WARN: Validation agent $FILE_PATH does not call pdfGenerator.generatePdf()")
  fi
fi

# Output warnings
if [ ${#WARNINGS[@]} -gt 0 ]; then
  echo "--- post-edit-format.sh: BaseAgent pattern check ---" >&2
  for w in "${WARNINGS[@]}"; do
    echo "  $w" >&2
  done
  echo "--- end check ---" >&2
fi

# Always exit 0 — this is a warning hook, not a blocking hook
exit 0
