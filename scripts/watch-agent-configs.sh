#!/usr/bin/env bash
# watch-agent-configs.sh — Watch agent configs for changes and auto-restart OpenCode
#
# Uses Node.js's fs.watch via a small inline script. Detects changes to agent .md
# files or config/*.json files and gracefully restarts the opencode process.
#
# Usage:
#   bash scripts/watch-agent-configs.sh                    # start watching (foreground)
#   bash scripts/watch-agent-configs.sh --daemon           # start as background process
#   bash scripts/watch-agent-configs.sh --stop             # stop the daemon
#   bash scripts/watch-agent-configs.sh --status           # check if watcher is running

set -euo pipefail

PID_FILE="/tmp/opencode-config-watcher.pid"
LOG_FILE="/tmp/opencode-config-watcher.log"
WATCH_DIRS=(
  "${PACKAGE_DIR:-.}/agents"
  "${PACKAGE_DIR:-.}/config"
)

daemon() {
  nohup bash "$0" --daemon > "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  echo "Watcher started (PID $!) — logging to $LOG_FILE"
  exit 0
}

stop() {
  if [ -f "$PID_FILE" ]; then
    pid=$(cat "$PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid"
      echo "Watcher (PID $pid) stopped"
    fi
    rm -f "$PID_FILE"
  else
    echo "Watcher not running"
  fi
  exit 0
}

status() {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "Watcher is running (PID $(cat "$PID_FILE"))"
  else
    echo "Watcher is not running"
  fi
  exit 0
}

# Validate that all dirs exist
for dir in "${WATCH_DIRS[@]}"; do
  if [ ! -d "$dir" ]; then
    echo "ERROR: Watch directory does not exist: $dir"
    exit 1
  fi
done

case "${1:-watch}" in
  --daemon)
    # Daemon mode — run in background, already forked
    exec > "$LOG_FILE" 2>&1
    shift
    ;;
  --stop) stop ;;
  --status) status ;;
  watch) ;;
  *)
    echo "Usage: $0 [watch|--daemon|--stop|--status]"
    exit 1
    ;;
esac

echo "=== Agent Config Watcher ==="
echo "Watching: ${WATCH_DIRS[*]}"
echo "Started at: $(date)"
echo ""

# Use node.js for cross-platform file watching
exec node -e "
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const watchDirs = ${WATCH_DIRS[*]@Q};
const debounceMs = 2000;
const restartCmd = 'pkill -HUP opencode';

let debounceTimer = null;
let lastRestart = 0;
const minRestartInterval = 10000; // Don't restart more than once per 10s

function restartOpenCode() {
  const now = Date.now();
  if (now - lastRestart < minRestartInterval) {
    console.log('[skip] Too soon since last restart');
    return;
  }
  lastRestart = now;
  console.log('[' + new Date().toISOString() + '] Config changed — restarting OpenCode...');
  try {
    const result = require('child_process').execSync('pkill -HUP opencode 2>/dev/null; echo done');
    console.log('  → Restart signal sent');
  } catch(e) {
    console.log('  → Could not send restart signal:', e.message);
  }
}

function onChange(eventType, filename) {
  if (!filename || !filename.endsWith('.md') && !filename.endsWith('.json')) return;
  
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(restartOpenCode, debounceMs);
}

// Watch each directory
const watchers = [];
for (const dir of watchDirs) {
  try {
    const w = fs.watch(dir, { recursive: false }, onChange);
    watchers.push(w);
    console.log('Watching: ' + dir);
  } catch(e) {
    console.error('Failed to watch ' + dir + ': ' + e.message);
  }
}

console.log('Watcher ready — will restart OpenCode on config changes');
console.log('');

// Keep alive
process.on('SIGTERM', () => {
  for (const w of watchers) w.close();
  process.exit(0);
});
process.on('SIGINT', () => {
  for (const w of watchers) w.close();
  process.exit(0);
});
" 2>&1
