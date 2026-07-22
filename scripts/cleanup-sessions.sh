#!/bin/bash
# Clean up opencode agent-loop sessions.
#
# Deletes sessions matching patterns (smoke-test, fork, task-)
# OR older than a configurable age (default 7 days).
#
# Usage:
#   bash scripts/cleanup-sessions.sh                               interactive, pattern + 7-day age
#   bash scripts/cleanup-sessions.sh --yes                         skip confirmation
#   bash scripts/cleanup-sessions.sh --days 3                      sessions older than 3 days
#   bash scripts/cleanup-sessions.sh --keep-recent 60              keep sessions younger than 60 min
#   bash scripts/cleanup-sessions.sh --pattern-only                only pattern-based deletion
#   bash scripts/cleanup-sessions.sh --age-only                    only age-based deletion
#   bash scripts/cleanup-sessions.sh --protect-current             also protect the current session ID

set -euo pipefail

MAX_DAYS=7
CONFIRM=true
PATTERN=true
AGE=true
KEEP_RECENT_MINUTES=0
PROTECT_CURRENT=false
CURRENT_SESSION=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes) CONFIRM=false; shift ;;
    --days) MAX_DAYS="$2"; shift 2 ;;
    --keep-recent) KEEP_RECENT_MINUTES="$2"; shift 2 ;;
    --pattern-only) AGE=false; PATTERN=true; shift ;;
    --age-only) PATTERN=false; AGE=true; shift ;;
    --protect-current) PROTECT_CURRENT=true; shift ;;
    *) shift ;;
  esac
done

# Auto-protect current session if OPENCODE_SESSION_ID is set
if [[ -n "${OPENCODE_SESSION_ID:-}" ]]; then
  PROTECT_CURRENT=true
  CURRENT_SESSION="$OPENCODE_SESSION_ID"
fi

SESSIONS=$(opencode session list 2>/dev/null || true)
if [[ -z "$SESSIONS" ]]; then
  echo "No sessions found or server not available."
  exit 0
fi

NOW_EPOCH=$(date +%s)
MAX_AGE_SECONDS=$((MAX_DAYS * 86400))
KEEP_RECENT_SECONDS=$((KEEP_RECENT_MINUTES * 60))
DELETABLE=""

while IFS= read -r line; do
  ID=$(echo "$line" | awk '{print $1}')
  # Extract the last column (date/time) and everything before it as title
  # Try to extract a date from the line
  # Format 1: ISO date in title — "2026-07-04T13:19:35.371Z"
  ISO_DATE=$(echo "$line" | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}T' | head -1 | tr -d 'T' || true)
  # Format 2: M/D/YYYY as last field — "7/5/2026"
  MDY_DATE=$(echo "$line" | grep -oE '[0-9]+/[0-9]+/[0-9]+' | head -1 || true)
  # Format 3: time like "3:12 PM" — assume today
  TIME_ONLY=$(echo "$line" | grep -oE '[0-9]+:[0-9]+ (AM|PM)' | head -1 || true)
  # Format 4: absolute epoch (ISO datetime with timezone)
  ISO_FULL=$(echo "$line" | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}' | head -1 || true)

  SESSION_EPOCH=""
  if [[ -n "$ISO_FULL" ]]; then
    SESSION_EPOCH=$(date -d "$ISO_FULL" +%s 2>/dev/null || true)
  elif [[ -n "$ISO_DATE" ]]; then
    SESSION_EPOCH=$(date -d "$ISO_DATE" +%s 2>/dev/null || true)
  elif [[ -n "$MDY_DATE" ]]; then
    SESSION_EPOCH=$(date -d "$MDY_DATE" +%s 2>/dev/null || true)
  elif [[ -n "$TIME_ONLY" ]]; then
    SESSION_EPOCH=$(date -d "$TIME_ONLY" +%s 2>/dev/null || true)
  fi

  TITLE=$(echo "$line" | awk '{$1=""; print $0}' | sed 's/^ *//')

  [[ -z "$ID" || "$ID" == "Session" ]] && continue

  DELETE=false

  # Protect current session
  if $PROTECT_CURRENT && [[ "$ID" == "$CURRENT_SESSION" ]]; then
    echo "  [PROTECTED] $ID  $TITLE  (current session)"
    continue
  fi

  # Keep-recent guard: skip sessions younger than the threshold
  if [[ $KEEP_RECENT_SECONDS -gt 0 && -n "$SESSION_EPOCH" ]]; then
    AGE_SECONDS=$((NOW_EPOCH - SESSION_EPOCH))
    if [[ $AGE_SECONDS -lt $KEEP_RECENT_SECONDS ]]; then
      AGE_MIN=$((AGE_SECONDS / 60))
      echo "  [SKIPPED] $ID  $TITLE  (${AGE_MIN}m old — younger than ${KEEP_RECENT_MINUTES}m threshold)"
      continue
    fi
  fi

  # Pattern-based check
  if $PATTERN && echo "$TITLE" | grep -qiE "smoke-test|\(fork|^task-"; then
    DELETE=true
  fi

  # Age-based check
  if $AGE && ! $DELETE && [[ -n "$SESSION_EPOCH" ]]; then
    AGE_SECONDS=$((NOW_EPOCH - SESSION_EPOCH))
    if [[ $AGE_SECONDS -gt $MAX_AGE_SECONDS ]]; then
      DELETE=true
    fi
  fi

  if $DELETE; then
    if [[ -n "$SESSION_EPOCH" ]]; then
      AGE_MIN=$(( (NOW_EPOCH - SESSION_EPOCH) / 60 ))
      echo "  $ID  $TITLE  (${AGE_MIN}m old)"
    else
      echo "  $ID  $TITLE  (age unknown)"
    fi
    DELETABLE="$DELETABLE $ID"
  fi
done < <(echo "$SESSIONS" | tail -n +4 | head -n -1)

if [[ -z "$DELETABLE" ]]; then
  echo "No deletable sessions found."
  exit 0
fi

echo ""
echo "Found $(echo "$DELETABLE" | wc -w) session(s) to delete."

if $CONFIRM; then
  read -p "Delete these sessions? (y/N): " CONFIRM_ANSWER
  if [[ "$CONFIRM_ANSWER" != "y" && "$CONFIRM_ANSWER" != "Y" ]]; then
    echo "Skipped."
    exit 0
  fi
fi

COUNT=0
for ID in $DELETABLE; do
  if opencode session delete "$ID" >/dev/null 2>&1; then
    COUNT=$((COUNT + 1))
  fi
done

echo "Deleted $COUNT session(s)."
