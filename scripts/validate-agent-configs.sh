#!/usr/bin/env bash
# Validate repository or installed OpenCode agent Markdown frontmatter.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PACKAGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
AGENTS_DIR="$PACKAGE_DIR/agents"
QUIET=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --installed)
      AGENTS_DIR="${HOME}/.config/opencode/agents"
      shift
      ;;
    --agents-dir)
      AGENTS_DIR="$2"
      shift 2
      ;;
    --quiet)
      QUIET=true
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [[ ! -d "$AGENTS_DIR" ]]; then
  echo "ERROR: Agents directory not found: $AGENTS_DIR" >&2
  exit 1
fi

ERRORS=0
FILES_CHECKED=0

report_failure() {
  local file="$1"
  local message="$2"
  ERRORS=$((ERRORS + 1))
  $QUIET || echo "[FAIL] $(basename "$file") — $message"
}

for FILE in "$AGENTS_DIR"/*.md; do
  [[ -e "$FILE" ]] || continue
  FILES_CHECKED=$((FILES_CHECKED + 1))

  if [[ "$(head -n 1 "$FILE")" != "---" ]]; then
    report_failure "$FILE" "missing opening YAML frontmatter delimiter"
    continue
  fi

  CLOSING_LINE=$(awk 'NR > 1 && $0 == "---" { print NR; exit }' "$FILE")
  if [[ -z "$CLOSING_LINE" ]]; then
    report_failure "$FILE" "missing closing YAML frontmatter delimiter"
    continue
  fi

  FRONTMATTER=$(sed -n "2,$((CLOSING_LINE - 1))p" "$FILE")
  MODE=$(printf '%s\n' "$FRONTMATTER" | sed -n 's/^mode:[[:space:]]*//p' | head -n 1)

  for FIELD in mode model description permission; do
    if ! printf '%s\n' "$FRONTMATTER" | grep -Eq "^${FIELD}:"; then
      report_failure "$FILE" "missing required top-level field '$FIELD'"
    fi
  done

  # Tool permissions belong inside the permission block, never at top level.
  for KEY in read write glob grep edit bash webfetch agent_loop task git todo question; do
    if printf '%s\n' "$FRONTMATTER" | grep -Eq "^${KEY}:"; then
      report_failure "$FILE" "permission key '$KEY' is outside the permission block"
    fi
  done

  # OpenCode shell restrictions must be bash command patterns. A nested
  # permission.git block looks plausible but is not an enforced shell policy.
  if printf '%s\n' "$FRONTMATTER" | grep -Eq '^  git:'; then
    report_failure "$FILE" "contains unsupported permission.git block; use permission.bash command patterns"
  fi

  if printf '%s\n' "$FRONTMATTER" | grep -Eq '^  bash:'; then
    REQUIRED_DENIALS="push reset clean checkout restore"
    if [[ "$MODE" == "subagent" ]]; then
      REQUIRED_DENIALS="commit $REQUIRED_DENIALS"
    fi

    for COMMAND in $REQUIRED_DENIALS; do
      if ! printf '%s\n' "$FRONTMATTER" | grep -Eq "^[[:space:]]{4}[\"']?git ${COMMAND}\\*[\"']?:[[:space:]]*deny[[:space:]]*$"; then
        report_failure "$FILE" "missing explicit bash denial for 'git ${COMMAND}*'"
      fi
    done
  fi
done

if [[ "$FILES_CHECKED" -eq 0 ]]; then
  echo "ERROR: No agent Markdown files found in $AGENTS_DIR" >&2
  exit 1
fi

$QUIET || echo "=== Results: $FILES_CHECKED files checked, $ERRORS errors ==="
exit $((ERRORS > 0 ? 1 : 0))
