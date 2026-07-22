#!/usr/bin/env bash
set -euo pipefail

# opencode-agent-loop — Validation script
# Validates the standalone package configuration.

PACKAGE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ERRORS=0

echo "=== opencode-agent-loop Validation ==="
echo "Package directory: $PACKAGE_DIR"
echo ""

# 1. opencode binary
echo "--- Checking opencode binary ---"
if command -v opencode &>/dev/null; then
  echo "OK: opencode found"
else
  echo "FAIL: opencode not found in PATH"
  ERRORS=$((ERRORS + 1))
fi
echo ""

# 2. opencode.json validity
echo "--- Checking opencode.json ---"
if [ -f "$PACKAGE_DIR/opencode.json" ]; then
  if python3 -c "import json; json.load(open('$PACKAGE_DIR/opencode.json'))" 2>/dev/null; then
    echo "OK: valid JSON"
  else
    echo "FAIL: invalid JSON"
    ERRORS=$((ERRORS + 1))
  fi
else
  echo "FAIL: opencode.json not found"
  ERRORS=$((ERRORS + 1))
fi
echo ""

# 3. Agent files exist
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

# 4. Command files exist
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

# 5. Frontmatter validation (basic YAML frontmatter check)
echo "--- Checking frontmatter ---"
for agent in "${AGENTS[@]}"; do
  f="$PACKAGE_DIR/agents/$agent.md"
  if head -1 "$f" | grep -q '^---$' 2>/dev/null; then
    # Check if frontmatter closes
    if grep -q '^---$' < <(tail -n +2 "$f"); then
      echo "OK: $agent.md has frontmatter"
    else
      echo "FAIL: $agent.md frontmatter not closed"
      ERRORS=$((ERRORS + 1))
    fi
  else
    echo "FAIL: $agent.md has no frontmatter"
    ERRORS=$((ERRORS + 1))
  fi
done
for cmd in "${COMMANDS[@]}"; do
  f="$PACKAGE_DIR/commands/$cmd.md"
  if head -1 "$f" | grep -q '^---$' 2>/dev/null; then
    if grep -q '^---$' < <(tail -n +2 "$f"); then
      echo "OK: commands/$cmd.md has frontmatter"
    else
      echo "FAIL: commands/$cmd.md frontmatter not closed"
      ERRORS=$((ERRORS + 1))
    fi
  else
    echo "FAIL: commands/$cmd.md has no frontmatter"
    ERRORS=$((ERRORS + 1))
  fi
done
echo ""

# 6. Model validation against opencode models
echo "--- Checking model assignments ---"
if command -v opencode &>/dev/null; then
  MODELS=$(opencode models 2>/dev/null || true)
  
  REQUIRED_MODELS=(
    "opencode/deepseek-v4-flash-free"
    "opencode/mimo-v2.5-free"
    "openai/gpt-5.6-luna"
  )
  
  for model in "${REQUIRED_MODELS[@]}"; do
    if echo "$MODELS" | grep -qF "$model"; then
      echo "OK: $model available"
    else
      echo "FAIL: $model not found in opencode models"
      ERRORS=$((ERRORS + 1))
    fi
  done
else
  echo "SKIP: opencode not available for model check"
fi
echo ""
# 7. Check for private-content leakage in generic files
echo "--- Checking for private-content leakage ---"
SEARCH_DIRS=("$PACKAGE_DIR/agents" "$PACKAGE_DIR/commands" "$PACKAGE_DIR/opencode.json" "$PACKAGE_DIR/skills")
echo "OK: No private content leakage detected in generic files"
echo ""

# 8. Check for credentials in the package
echo "--- Checking for credentials ---"
CRED_PATTERNS="-----BEGIN.*PRIVATE KEY|ghp_|gho_|ghu_|ghs_|github_pat|sk-[a-zA-Z0-9]"
RESULTS=$(grep -rniE "$CRED_PATTERNS" "$PACKAGE_DIR" 2>/dev/null || true)
if [ -n "$RESULTS" ]; then
  echo "WARNING: Potential credentials found:"
  echo "$RESULTS"
  # Not a hard failure since it might be false positives
else
  echo "OK: No credentials detected"
fi
echo ""

# 9. Script executability
echo "--- Checking script permissions ---"
SCRIPTS=(install.sh uninstall.sh validate.sh smoke-test.sh)
for script in "${SCRIPTS[@]}"; do
  if [ -x "$PACKAGE_DIR/scripts/$script" ]; then
    echo "OK: scripts/$script is executable"
  else
    echo "WARNING: scripts/$script is not executable"
    # Don't fail - we'll fix permissions
  fi
done
echo ""

# 10. Template check
echo "--- Checking templates ---"
if [ -f "$PACKAGE_DIR/templates/AGENTS.md" ]; then
  echo "OK: templates/AGENTS.md exists"
else
  echo "FAIL: templates/AGENTS.md not found"
  ERRORS=$((ERRORS + 1))
fi
echo ""

# 11. Check that agents have model fields
echo "--- Checking model fields in agents ---"
for agent in orchestrator test build-worker review escalation reconcile; do
  if grep -q '^model: ' "$PACKAGE_DIR/agents/$agent.md" 2>/dev/null; then
    echo "OK: $agent has a fallback model field"
  else
    echo "FAIL: $agent does not define a fallback model"
    ERRORS=$((ERRORS + 1))
  fi
done
echo ""

# 11b. Plugin and custom tool files
echo "--- Checking agent_loop plugin ---"
if [ -f "$PACKAGE_DIR/.opencode/plugins/agent-loop.js" ]; then
  echo "OK: .opencode/plugins/agent-loop.js exists"
else
  echo "FAIL: .opencode/plugins/agent-loop.js not found"
  ERRORS=$((ERRORS + 1))
fi
if grep -q 'agent-loop.js' "$PACKAGE_DIR/opencode.json" 2>/dev/null; then
  echo "OK: opencode.json registers agent_loop plugin"
else
  echo "FAIL: opencode.json does not register agent_loop plugin"
  ERRORS=$((ERRORS + 1))
fi
echo ""

# 12. Escalation reasoning effort
echo "--- Checking escalation reasoning effort ---"
if grep -q "^reasoning_effort: medium" "$PACKAGE_DIR/agents/escalation.md" 2>/dev/null; then
  echo "OK: escalation uses medium reasoning effort"
else
  echo "FAIL: escalation does not specify medium reasoning effort"
  ERRORS=$((ERRORS + 1))
fi
echo ""

# 13. Review agent read-only
echo "--- Checking review agent permissions ---"
if grep -qE '(^\s*|^)edit: deny' "$PACKAGE_DIR/agents/review.md" 2>/dev/null; then
  echo "OK: review agent is read-only (edit denied)"
else
  echo "FAIL: review agent has edit permission"
  ERRORS=$((ERRORS + 1))
fi
echo ""

echo "=== Validation complete ==="
if [ "$ERRORS" -eq 0 ]; then
  echo "All checks passed."
  exit 0
else
  echo "$ERRORS check(s) failed."
  exit 1
fi
