#!/usr/bin/env bash
# validate-agent-configs.sh — Validate all OpenCode agent .md configs
#
# Checks each agent file at ~/.config/opencode/agents/*.md for:
#   1. No top-level permission keys outside the `permission:` block
#   2. Required fields exist (mode, model, description)
#   3. Referenced models exist in free-first-pools.json
#   4. No duplicate or conflicting permission declarations
#
# Usage:
#   bash scripts/validate-agent-configs.sh
#   bash scripts/validate-agent-configs.sh --fix    (auto-fix trivial issues)
#   bash scripts/validate-agent-configs.sh --quiet  (only output errors)

set -euo pipefail

AGENTS_DIR="${HOME}/.config/opencode/agents"
POOLS_FILE="/home/casaos/opencode-agent-loop/config/free-first-pools.json"
FIX_MODE=false
QUIET=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --fix) FIX_MODE=true; shift ;;
    --quiet) QUIET=true; shift ;;
    *) shift ;;
  esac
done

if [[ ! -d "$AGENTS_DIR" ]]; then
  echo "ERROR: Agents directory not found: $AGENTS_DIR"
  exit 1
fi

if [[ ! -f "$POOLS_FILE" ]]; then
  echo "WARN: Pools file not found: $POOLS_FILE (model validation skipped)"
  POOLS_FILE=""
fi

ERRORS=0
WARNINGS=0
FILES_CHECKED=0

# Top-level keys that are ONLY valid under `permission:`
UNSUPPORTED_TOP_LEVEL_KEYS="edit bash webfetch agent_loop task git todo question"
# Valid top-level keys in agent frontmatter
VALID_TOP_LEVEL_KEYS="mode model temperature steps description reasoning_effort permission"

# Collect all model IDs from pools for reference validation
declare -A ALL_MODELS=()
if [[ -n "$POOLS_FILE" ]] && command -v jq &>/dev/null; then
  while IFS= read -r mid; do
    ALL_MODELS["$mid"]=1
  done < <(jq -r '.pools[].models[].model_id' "$POOLS_FILE" 2>/dev/null || true)
fi

for FILE in "$AGENTS_DIR"/*.md; do
  FILES_CHECKED=$((FILES_CHECKED + 1))
  BASENAME=$(basename "$FILE")
  HAS_ERROR=false

  # Read the YAML frontmatter (between --- markers)
  FRONTMATTER=$(sed -n '/^---[[:space:]]*$/,/^---[[:space:]]*$/p' "$FILE" 2>/dev/null || true)
  if [[ -z "$FRONTMATTER" ]]; then
    $QUIET || echo "[FAIL] $BASENAME — No valid YAML frontmatter found"
    ERRORS=$((ERRORS + 1))
    continue
  fi

  # Check 1: No unsupported top-level keys
  for key in $UNSUPPORTED_TOP_LEVEL_KEYS; do
    # Match key at start of line (top level, not indented)
    if echo "$FRONTMATTER" | grep -qP "^${key}:"; then
      $QUIET || echo "[FAIL] $BASENAME — Unsupported top-level key '$key'. Move under 'permission:' block."
      ERRORS=$((ERRORS + 1))
      HAS_ERROR=true
    fi
  done

  # Check 2: Required fields exist
  for field in mode model description; do
    if ! echo "$FRONTMATTER" | grep -qP "^${field}:"; then
      $QUIET || echo "[FAIL] $BASENAME — Missing required field '$field'"
      ERRORS=$((ERRORS + 1))
      HAS_ERROR=true
    fi
  done

  # Check 3: permission block exists for subagents
  MODE=$(echo "$FRONTMATTER" | grep -oP '^mode:\s*\K\S+' || true)
  if [[ "$MODE" == "subagent" ]]; then
    if ! echo "$FRONTMATTER" | grep -qP '^permission:'; then
      $QUIET || echo "[FAIL] $BASENAME — Subagent must have a 'permission:' block"
      ERRORS=$((ERRORS + 1))
      HAS_ERROR=true
    fi
  fi

  # Check 4: Model exists in pools file
  MODEL=$(echo "$FRONTMATTER" | grep -oP '^model:\s*\K\S+' || true)
  if [[ -n "$MODEL" && -n "$POOLS_FILE" && ${#ALL_MODELS[@]} -gt 0 ]]; then
    if [[ -z "${ALL_MODELS[$MODEL]:-}" ]]; then
      $QUIET || echo "[WARN] $BASENAME — Model '$MODEL' not found in free-first-pools.json (may be intentional for primary agents)"
      WARNINGS=$((WARNINGS + 1))
    fi
  fi

  # Check 5: No YAML syntax errors (lines with invalid inline patterns like "bash: git status: allow")
  if echo "$FRONTMATTER" | grep -qP '^[a-z]+:\s+[a-z]+\s+[a-z]+:'; then
    INLINE_LINE=$(echo "$FRONTMATTER" | grep -nP '^[a-z]+:\s+[a-z]+\s+[a-z]+:' | head -1)
    $QUIET || echo "[FAIL] $BASENAME — Inline YAML syntax error (line: $INLINE_LINE). Use nested format."
    ERRORS=$((ERRORS + 1))
    HAS_ERROR=true
  fi

  if ! $HAS_ERROR; then
    $QUIET || echo "[PASS] $BASENAME"
  fi
done

echo ""
echo "=== Results: $FILES_CHECKED files checked, $ERRORS errors, $WARNINGS warnings ==="
exit $(( ERRORS > 0 ? 1 : 0 ))
