#!/usr/bin/env bash
set -euo pipefail

# opencode-agent-loop — Smoke test
# Creates a temporary repository, validates agent configuration,
# and performs safe non-interactive checks.

PACKAGE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TEMP_DIR=$(mktemp -d /tmp/opencode-smoke-XXXXXX)
ERRORS=0

cleanup() {
  echo ""
  echo "Cleaning up..."
  rm -rf "$TEMP_DIR"
}

trap cleanup EXIT

echo "=== opencode-agent-loop Smoke Test ==="
echo ""

# Create a minimal test project
echo "--- Creating minimal test project ---"
mkdir -p "$TEMP_DIR/test-project"
cd "$TEMP_DIR/test-project"
git init -q
git config user.email "test@example.com"
git config user.name "Test User"

# Create a minimal package.json
cat > package.json << 'EOF'
{
  "name": "test-project",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "test": "echo 'Tests passed' && exit 0",
    "test:unit": "echo 'Unit tests passed' && exit 0"
  }
}
EOF

# Create a minimal AGENTS.md
cat > AGENTS.md << 'EOF'
# Test Project — OpenCode Agent Instructions

## Architecture

Simple test project for smoke testing the agent loop.

## Build

No build step required.

## Test

- `npm test` — full test suite
- `npm run test:unit` — unit tests

## Security-sensitive boundaries

- No security-sensitive areas in this test project.

## Generated files

- `node_modules/` — never commit
EOF

git add -A
git commit -m "initial commit" -q
echo "OK: Test project created at $TEMP_DIR/test-project"
echo ""

# Validate opencode config
echo "--- Checking opencode binary ---"
if command -v opencode &>/dev/null; then
  echo "OK: opencode found"
else
  echo "FAIL: opencode not found"
  ERRORS=$((ERRORS + 1))
fi
echo ""

# Check agent files exist
echo "--- Checking agent files ---"
AGENTS=(orchestrator test build-worker review escalation reconcile)
for agent in "${AGENTS[@]}"; do
  if [ -f "$PACKAGE_DIR/agents/$agent.md" ]; then
    echo "OK: agents/$agent.md"
  else
    echo "FAIL: agents/$agent.md not found"
    ERRORS=$((ERRORS + 1))
  fi
done
echo ""

# Check command files exist
echo "--- Checking command files ---"
COMMANDS=(feature loop-init loop)
for cmd in "${COMMANDS[@]}"; do
  if [ -f "$PACKAGE_DIR/commands/$cmd.md" ]; then
    echo "OK: commands/$cmd.md"
  else
    echo "FAIL: commands/$cmd.md not found"
    ERRORS=$((ERRORS + 1))
  fi
done
echo ""

# Check opencode.json is valid JSON
echo "--- Checking opencode.json ---"
if python3 -c "import json; json.load(open('$PACKAGE_DIR/opencode.json'))" 2>/dev/null; then
  echo "OK: valid JSON"
else
  echo "FAIL: invalid JSON"
  ERRORS=$((ERRORS + 1))
fi
echo ""

# Check models (timeout-protected)
echo "--- Checking model availability ---"
if command -v opencode &>/dev/null; then
  MODELS=$(timeout 30 opencode models 2>/dev/null || echo "TIMEOUT")
  if [ "$MODELS" = "TIMEOUT" ]; then
    echo "SKIP: opencode models timed out"
  else
    for model in "opencode/deepseek-v4-flash-free" "opencode/mimo-v2.5-free" "openai/gpt-5.5"; do
      if echo "$MODELS" | grep -qF "$model"; then
        echo "OK: $model available"
      else
        echo "WARNING: $model not found (may not affect all tests)"
      fi
    done
  fi
fi
echo ""



# Check model assignments
echo "--- Checking model field in agent frontmatter ---"
for agent in orchestrator test build-worker review escalation reconcile; do
  if ! grep -q '^model: ' "$PACKAGE_DIR/agents/$agent.md" 2>/dev/null; then
    echo "FAIL: $agent model field missing"
    ERRORS=$((ERRORS + 1))
  fi
done
echo "OK: Model assignments verified"
echo ""

# Check escalation reasoning effort
echo "--- Checking escalation reasoning_effort ---"
if grep -q "^reasoning_effort: medium" "$PACKAGE_DIR/agents/escalation.md" 2>/dev/null; then
  echo "OK: medium reasoning configured"
else
  echo "FAIL: medium reasoning not configured for escalation"
  ERRORS=$((ERRORS + 1))
fi
echo ""

# Check review is read-only
echo "--- Checking review permissions ---"
if grep -qE '(^\s*|^)edit: deny' "$PACKAGE_DIR/agents/review.md" 2>/dev/null; then
  echo "OK: review is read-only"
else
  echo "FAIL: review has edit permission"
  ERRORS=$((ERRORS + 1))
fi
echo ""

# Exercise the custom tool with a fake OpenCode executable so no provider calls are made.
echo "--- Running custom tool integration smoke ---"
if node "$PACKAGE_DIR/tests/tool-integration-tests.mjs"; then
  echo "OK: agent_loop custom tool reaches runtime/failover/worker adapter"
else
  echo "FAIL: agent_loop custom tool integration smoke failed"
  ERRORS=$((ERRORS + 1))
fi
echo ""

echo "=== Smoke Test Complete ==="
if [ "$ERRORS" -eq 0 ]; then
  echo "All checks passed. The package is functional."
  echo ""
  echo "Note: Full /feature delegation requires the interactive OpenCode TUI."
  echo "To test manually:"
  echo "  1. cd <project>"
  echo "  2. opencode"
  echo "  3. /feature <task description>"
  echo ""
  echo "Temporary test repository: $TEMP_DIR/test-project"
  echo "This will be cleaned up automatically."
  exit 0
else
  echo "$ERRORS check(s) failed."
  exit 1
fi
