#!/usr/bin/env bash
set -euo pipefail

# opencode-agent-loop — Uninstaller
# Removes the OPENCODE_CONFIG_DIR export line from shell configuration.
# Does NOT delete the standalone repository or project AGENTS.md files.

PACKAGE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
EXPORT_LINE="export OPENCODE_CONFIG_DIR=\"$PACKAGE_DIR\""
COMMENT_LINE="# opencode-agent-loop configuration"

echo "=== opencode-agent-loop Uninstaller ==="
echo ""

# Detect shell config files
SHELL_CONFIGS=()
[ -f "$HOME/.bashrc" ] && SHELL_CONFIGS+=("$HOME/.bashrc")
[ -f "$HOME/.bash_profile" ] && SHELL_CONFIGS+=("$HOME/.bash_profile")
[ -f "$HOME/.zshrc" ] && SHELL_CONFIGS+=("$HOME/.zshrc")

if [ ${#SHELL_CONFIGS[@]} -eq 0 ]; then
  echo "No shell config files found. Nothing to uninstall."
  exit 0
fi

REMOVED=false
for CONFIG in "${SHELL_CONFIGS[@]}"; do
  if grep -F "$EXPORT_LINE" "$CONFIG" &>/dev/null; then
    # Create backup
    cp "$CONFIG" "$CONFIG.backup.$(date +%Y%m%d%H%M%S)"
    echo "Backup created: $CONFIG.backup.*"

    # Remove the export line and the comment line above it
    # Use temporary file to avoid sed -i compatibility issues
    grep -vF "$EXPORT_LINE" "$CONFIG" > "${CONFIG}.tmp"
    # Also remove the comment line if it's right above
    grep -vF "$COMMENT_LINE" "${CONFIG}.tmp" > "${CONFIG}.tmp2"
    mv "${CONFIG}.tmp2" "$CONFIG"
    rm -f "${CONFIG}.tmp"

    echo "Removed configuration from: $CONFIG"
    REMOVED=true
  else
    echo "Not found in: $CONFIG"
  fi
done

echo ""
if [ "$REMOVED" = true ]; then
  echo "OPENCODE_CONFIG_DIR has been removed from shell configuration."
  echo "OpenCode will return to its normal configuration resolution in a new shell."
  echo ""
  echo "The standalone repository has NOT been deleted:"
  echo "  $PACKAGE_DIR"
  echo ""
  echo "Project AGENTS.md files have NOT been modified."
else
  echo "OPENCODE_CONFIG_DIR was not configured in any shell config file."
fi
echo ""
echo "To unset in the current shell without starting a new one:"
echo "  unset OPENCODE_CONFIG_DIR"
echo ""
