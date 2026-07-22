#!/usr/bin/env bash
set -euo pipefail

# opencode-agent-loop — Installer
# Adds the OPENCODE_CONFIG_DIR environment variable to your shell configuration.

PACKAGE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
EXPORT_LINE="export OPENCODE_CONFIG_DIR=\"$PACKAGE_DIR\""

echo "=== opencode-agent-loop Installer ==="
echo ""
echo "Installing from: $PACKAGE_DIR"

# Check prerequisites
if ! command -v opencode &>/dev/null; then
  echo "ERROR: 'opencode' binary not found in PATH."
  echo "Install OpenCode first: https://opencode.ai"
  exit 1
fi

# Verify package structure
REQUIRED=(
  "$PACKAGE_DIR/agents/orchestrator.md"
  "$PACKAGE_DIR/agents/test.md"
  "$PACKAGE_DIR/agents/build-worker.md"
  "$PACKAGE_DIR/agents/review.md"
  "$PACKAGE_DIR/agents/escalation.md"
  "$PACKAGE_DIR/agents/reconcile.md"
  "$PACKAGE_DIR/commands/feature.md"
  "$PACKAGE_DIR/commands/loop.md"
  "$PACKAGE_DIR/commands/loop-init.md"
  "$PACKAGE_DIR/.opencode/plugins/agent-loop.js"
  "$PACKAGE_DIR/opencode.json"
)

for f in "${REQUIRED[@]}"; do
  if [ ! -f "$f" ]; then
    echo "ERROR: Required file not found: $f"
    exit 1
  fi
done
echo "Package structure verified."

# Detect shell config file
SHELL_CONFIG=""
if [ -n "$BASH_VERSION" ]; then
  if [ -f "$HOME/.bashrc" ]; then
    SHELL_CONFIG="$HOME/.bashrc"
  elif [ -f "$HOME/.bash_profile" ]; then
    SHELL_CONFIG="$HOME/.bash_profile"
  fi
elif [ -n "$ZSH_VERSION" ]; then
  SHELL_CONFIG="$HOME/.zshrc"
else
  # Default to .bashrc if zsh detection failed
  [ -f "$HOME/.bashrc" ] && SHELL_CONFIG="$HOME/.bashrc"
  [ -f "$HOME/.zshrc" ] && SHELL_CONFIG="$HOME/.zshrc"
fi

if [ -z "$SHELL_CONFIG" ]; then
  echo "WARNING: Could not detect shell config file."
  echo "Add this line manually to your shell startup file:"
  echo ""
  echo "  $EXPORT_LINE"
  echo ""
  exit 0
fi

# Check if already installed
if grep -F "$EXPORT_LINE" "$SHELL_CONFIG" &>/dev/null; then
  echo "Export already present in $SHELL_CONFIG. Nothing to do."
  echo "If it is not active, run: source $SHELL_CONFIG"
  exit 0
fi

# Backup
cp "$SHELL_CONFIG" "$SHELL_CONFIG.backup.$(date +%Y%m%d%H%M%S)"
echo "Backup created: $SHELL_CONFIG.backup.*"

# Add export line
echo "" >> "$SHELL_CONFIG"
echo "# opencode-agent-loop configuration" >> "$SHELL_CONFIG"
echo "$EXPORT_LINE" >> "$SHELL_CONFIG"

echo ""
echo "=== Installation complete ==="
echo ""
echo "Added to $SHELL_CONFIG:"
echo "  $EXPORT_LINE"
echo ""
echo "To activate in the current shell, run:"
echo ""
echo "  source $SHELL_CONFIG"
echo ""
echo "Then verify:"
echo ""
echo "  opencode agent list"
echo ""
