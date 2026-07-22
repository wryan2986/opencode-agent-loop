#!/usr/bin/env bash
set -euo pipefail

ERRORS=0

echo "=== Free-First Cloud Routing Activation Gate ==="
echo ""

# ─── Helper ──────────────────────────────────────────────────────────────────

check() {
  local desc="$1"
  shift
  if "$@" > /dev/null 2>&1; then
    echo "  ✅ PASS: $desc"
  else
    echo "  ❌ FAIL: $desc"
    ERRORS=$((ERRORS + 1))
  fi
}

check_fail() {
  local desc="$1"
  shift
  if "$@" > /dev/null 2>&1; then
    echo "  ❌ FAIL: $desc"
    ERRORS=$((ERRORS + 1))
  else
    echo "  ✅ PASS: $desc"
  fi
}

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ─── 1. Config Validation ───────────────────────────────────────────────────

echo "[1] Config files"

# Check config directory exists
check "Config directory exists" test -d "$PROJECT_ROOT/config"

# Validate JSON using available tool (jq > python3 > node)
validate_json() {
  local file="$1"
  if command -v jq &>/dev/null; then
    jq -e . "$file" > /dev/null 2>&1
  elif command -v python3 &>/dev/null; then
    python3 -m json.tool "$file" > /dev/null 2>&1
  else
    node -e "JSON.parse(require('fs').readFileSync('$file','utf8'))" > /dev/null 2>&1
  fi
}

# Check model-registry.json exists and is valid JSON
if [ -f "$PROJECT_ROOT/config/model-registry.json" ]; then
  if validate_json "$PROJECT_ROOT/config/model-registry.json"; then
    echo "  ✅ PASS: config/model-registry.json exists and is valid JSON"
  else
    echo "  ❌ FAIL: config/model-registry.json is invalid JSON"
    ERRORS=$((ERRORS + 1))
  fi
else
  echo "  ⚠️  SKIP: config/model-registry.json not found (not blocking)"
fi

# Check free-first-pools.json exists and is valid JSON
if [ -f "$PROJECT_ROOT/config/free-first-pools.json" ]; then
  if validate_json "$PROJECT_ROOT/config/free-first-pools.json"; then
    echo "  ✅ PASS: config/free-first-pools.json exists and is valid JSON"
  else
    echo "  ❌ FAIL: config/free-first-pools.json is invalid JSON"
    ERRORS=$((ERRORS + 1))
  fi
else
  echo "  ⚠️  SKIP: config/free-first-pools.json not found (not blocking)"
fi

# Check free-first-config.json exists and is valid JSON
if [ -f "$PROJECT_ROOT/config/free-first-config.json" ]; then
  if validate_json "$PROJECT_ROOT/config/free-first-config.json"; then
    echo "  ✅ PASS: config/free-first-config.json exists and is valid JSON"
  else
    echo "  ❌ FAIL: config/free-first-config.json is invalid JSON"
    ERRORS=$((ERRORS + 1))
  fi
else
  echo "  ⚠️  SKIP: config/free-first-config.json not found (not blocking)"
fi

echo ""

# ─── 2. Library Files ────────────────────────────────────────────────────────

echo "[2] Library files"

for lib_file in failover-handler.mjs paid-fallback.mjs privacy-classifier.mjs; do
  check "lib/$lib_file exists" test -f "$PROJECT_ROOT/lib/$lib_file"
done

echo ""

# ─── 3. Disabled Qwythos Agents ─────────────────────────────────────────────

echo "[3] Disabled Qwythos agents (disabled, not enabled)"

for agent_file in local-qwythos-explore.md local-qwythos-test-fixer.md local-qwythos-review.md; do
  check "agents/$agent_file exists" test -f "$PROJECT_ROOT/agents/$agent_file"
  # Check that enabled: false is in the frontmatter (disabled, not active)
  if grep -q "^enabled: false" "$PROJECT_ROOT/agents/$agent_file" 2>/dev/null; then
    echo "  ✅ PASS: agents/$agent_file has enabled: false"
  else
    echo "  ❌ FAIL: agents/$agent_file does not have enabled: false"
    ERRORS=$((ERRORS + 1))
  fi
  # Check that model is qwythos-9b-local
  if grep -q "^model: qwythos-9b-local" "$PROJECT_ROOT/agents/$agent_file" 2>/dev/null; then
    echo "  ✅ PASS: agents/$agent_file references qwythos-9b-local model"
  else
    echo "  ❌ FAIL: agents/$agent_file does not reference qwythos-9b-local"
    ERRORS=$((ERRORS + 1))
  fi
done

echo ""

# ─── 4. Routing Tests ────────────────────────────────────────────────────────

echo "[4] Routing tests"

check "tests/routing-tests.mjs exists" test -f "$PROJECT_ROOT/tests/routing-tests.mjs"

if [ -f "$PROJECT_ROOT/tests/routing-tests.mjs" ]; then
  echo "  → Running routing tests..."
  if node "$PROJECT_ROOT/tests/routing-tests.mjs" 2>&1; then
    echo "  ✅ PASS: All routing tests pass"
  else
    echo "  ❌ FAIL: Some routing tests failed"
    ERRORS=$((ERRORS + 1))
  fi
fi

echo ""

# ─── 5. opencode.json Validity ───────────────────────────────────────────────

echo "[5] opencode.json validity"

if [ -f "$PROJECT_ROOT/opencode.json" ]; then
  if validate_json "$PROJECT_ROOT/opencode.json"; then
    echo "  ✅ PASS: opencode.json is valid JSON"
  else
    echo "  ❌ FAIL: opencode.json is invalid JSON"
    ERRORS=$((ERRORS + 1))
  fi
else
  echo "  ❌ FAIL: opencode.json does not exist"
  ERRORS=$((ERRORS + 1))
fi

echo ""

# ─── 6. Original Agent Files Intact ──────────────────────────────────────────

echo "[6] Original agent files unchanged"

for agent_file in orchestrator.md build-worker.md review.md test.md escalation.md reconcile.md; do
  check "agents/$agent_file exists (original agent intact)" test -f "$PROJECT_ROOT/agents/$agent_file"
done

echo ""

# ─── 7. No Credentials Leaked ────────────────────────────────────────────────

echo "[7] No credentials in git diff or staged files"

# Check for potential credential patterns in unstaged diff
if git -C "$PROJECT_ROOT" diff --name-only 2>/dev/null | grep -qE '\.env|credentials|secrets|\.pem|\.key|token'; then
  echo "  ❌ FAIL: Unstaged changes include potential credential files"
  ERRORS=$((ERRORS + 1))
else
  echo "  ✅ PASS: No credential files in unstaged changes"
fi

# Check for credential patterns in staged files
if git -C "$PROJECT_ROOT" diff --cached --name-only 2>/dev/null | grep -qE '\.env|credentials|secrets|\.pem|\.key|token'; then
  echo "  ❌ FAIL: Staged changes include potential credential files"
  ERRORS=$((ERRORS + 1))
else
  echo "  ✅ PASS: No credential files in staged changes"
fi

# Check for actual credential values in the diff (not config/instruction text mentioning the word)
# Look for patterns that indicate actual secrets: assignment, env vars, file contents
# Avoid flagging the word "secrets" or "tokens" in instructional/config text
SECRET_PATTERNS='(export\s+[A-Z_]*KEY|export\s+[A-Z_]*TOKEN|export\s+[A-Z_]*SECRET|export\s+[A-Z_]*PASSWORD|^[A-Z_]*KEY=|^[A-Z_]*TOKEN=|^[A-Z_]*SECRET=|^[A-Z_]*PASSWORD=)'
if git -C "$PROJECT_ROOT" diff 2>/dev/null | grep -qiE "$SECRET_PATTERNS"; then
  echo "  ❌ FAIL: Potential secrets found in git diff content"
  ERRORS=$((ERRORS + 1))
else
  echo "  ✅ PASS: No secrets detected in git diff content"
fi

# Also check for actual credential files (not just mentions of the word)
if git -C "$PROJECT_ROOT" diff --name-only 2>/dev/null | grep -qiE '\.env$|\.env\.|credentials\.|secrets\.|\.pem$|\.key$'; then
  echo "  ❌ FAIL: Potential credential files in diff"
  ERRORS=$((ERRORS + 1))
else
  echo "  ✅ PASS: No credential files in diff"
fi

echo ""

# ─── 8. Canonical Pool Schema / Runtime Gates ────────────────────────────────

echo "[8] Canonical pool schema and bypass detection"

if [ -f "$PROJECT_ROOT/config/free-first-pools.json" ]; then
  for role in orchestrator builder reviewer; do
    count=$(node --input-type=module -e "
      import { readFileSync } from 'node:fs';
      import { normalizePoolConfig } from '$PROJECT_ROOT/lib/pool-normalizer.mjs';
      const d = JSON.parse(readFileSync('$PROJECT_ROOT/config/free-first-pools.json','utf8'));
      const n = normalizePoolConfig(d, { role: '$role' });
      console.log(n.freeCloud.length + n.openRouterFree.length + n.trialCreditModels.length);
    " 2>/dev/null || echo "0")
    if [ "$count" -ge 2 ]; then
      echo "  ✅ PASS: $role canonical models normalize with $count free/trial providers (≥2)"
    else
      echo "  ⚠️  WARN: $role canonical models normalize with $count free/trial providers (expected ≥2, not blocking)"
    fi
  done
else
  echo "  ⚠️  SKIP: free-first-pools.json not found"
fi

if node "$PROJECT_ROOT/tests/bypass-detection.mjs" 2>&1; then
  echo "  ✅ PASS: production OpenCode invocation bypass check"
else
  echo "  ❌ FAIL: production OpenCode invocation bypass check"
  ERRORS=$((ERRORS + 1))
fi

if node "$PROJECT_ROOT/tests/runtime-tests.mjs" 2>&1; then
  echo "  ✅ PASS: runtime failover tests"
else
  echo "  ❌ FAIL: runtime failover tests"
  ERRORS=$((ERRORS + 1))
fi

if node "$PROJECT_ROOT/tests/tool-integration-tests.mjs" 2>&1; then
  echo "  ✅ PASS: custom tool integration tests"
else
  echo "  ❌ FAIL: custom tool integration tests"
  ERRORS=$((ERRORS + 1))
fi

echo ""

# ─── Summary ─────────────────────────────────────────────────────────────────

echo ""
if [ "$ERRORS" -eq 0 ]; then
  echo "=== ALL CHECKS PASSED ==="
  echo "Free-first cloud routing is ready for activation."
  exit 0
else
  echo "=== $ERRORS CHECK(S) FAILED ==="
  echo "Free-first cloud routing is NOT activated."
  echo "Fix failures above, then re-run this script."
  exit 1
fi
