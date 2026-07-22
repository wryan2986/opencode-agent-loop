#!/usr/bin/env bash
# subagent-failover.sh — Promote a subagent to its next available model when rate-limited.
#
# Usage:
#   ./subagent-failover.sh <agent_name>                  # Promote to next model, print new model_id
#   ./subagent-failover.sh <agent_name> --dry-run         # Show what would change
#   ./subagent-failover.sh <agent_name> --status          # Show current model and pool state
#
# Agent name maps to pool name in free-first-pools.json:
#   build-worker  → builder
#   test          → test-fixer
#   review        → reviewer
#   reconcile     → reconcile
#   escalation    → escalation
#   explore       → explore
#   trivial-builder → trivial-builder
#
# Config: reads cooldown durations from free-first-config.json
#   provider_wide_rate_limit_minutes is used for the cooldown duration
#
# Ntfy: sends notification if NTFY_TOPIC is set

set -euo pipefail

AGENTS_DIR="$HOME/.config/opencode/agents"
POOLS_FILE="${PACKAGE_DIR:-.}/config/free-first-pools.json"
CONFIG_FILE="${PACKAGE_DIR:-.}/config/free-first-config.json"

AGENT_NAME="${1:-}"
ACTION="${2:-promote}"

if [ -z "$AGENT_NAME" ]; then
  echo "Usage: $0 <agent_name> [--dry-run|--status]"
  echo ""
  echo "Maps: build-worker→builder, test→test-fixer, review→reviewer, etc."
  exit 1
fi

# Map agent name to pool name
declare -A POOL_MAP=(
  ["build-worker"]="builder"
  ["build-worker-local"]="builder"
  ["build-worker-paid"]="builder"
  ["test"]="test-fixer"
  ["review"]="reviewer"
  ["reconcile"]="reconcile"
  ["escalation"]="escalation"
  ["explore"]="explore"
  ["trivial-builder"]="trivial-builder"
)

POOL_NAME="${POOL_MAP[$AGENT_NAME]:-$AGENT_NAME}"

# Read the agent's current model
AGENT_FILE="$AGENTS_DIR/$AGENT_NAME.md"
if [ ! -f "$AGENT_FILE" ]; then
  echo "Error: Agent file not found: $AGENT_FILE"
  exit 1
fi

CURRENT_MODEL=$(grep '^model: ' "$AGENT_FILE" | sed 's/^model: //')

if [ "$ACTION" = "--status" ]; then
  echo "Agent: $AGENT_NAME"
  echo "Pool: $POOL_NAME"
  echo "Current model: $CURRENT_MODEL"
  echo ""
  echo "Pool models:"
  python3 -c "
import json, sys
with open('$POOLS_FILE') as f:
    data = json.load(f)
now = '$(date -u +%Y-%m-%dT%H:%M:%SZ)'
pool = data['pools'].get('$POOL_NAME', {})
for m in pool.get('models', []):
    status = 'ACTIVE'
    if m.get('cooldown_until') and m['cooldown_until'] > now:
        status = 'COOLDOWN until ' + m['cooldown_until']
    elif m.get('consecutive_failures', 0) > 0:
        status = str(m['consecutive_failures']) + ' failures'
    print(f'  {m[\"model_id\"]:55s} {status}')
  "
  exit 0
fi

# Find the next available model in the pool
echo "Agent: $AGENT_NAME → Pool: $POOL_NAME"
echo "Current model: $CURRENT_MODEL"

NEXT_MODEL=$(python3 -c "
import json, sys
from datetime import datetime, timezone

with open('$POOLS_FILE') as f:
    data = json.load(f)
with open('$CONFIG_FILE') as f:
    config = json.load(f)

now = datetime.now(timezone.utc)
now_str = now.strftime('%Y-%m-%dT%H:%M:%SZ')
pool = data['pools'].get('$POOL_NAME', {})
current = '$CURRENT_MODEL'
found = False

for m in pool.get('models', []):
    if m['model_id'] == current:
        found = True
        continue
    if not found:
        continue
    # Skip if not enabled
    if not m.get('enabled', True):
        continue
    # Skip if in cooldown
    cd = m.get('cooldown_until')
    if cd and cd > now_str:
        continue
    # Found next available
    print(m['model_id'])
    sys.exit(0)

# No next model found
sys.exit(1)
")

if [ -z "$NEXT_MODEL" ]; then
  echo "ERROR: No available model found in pool '$POOL_NAME' after '$CURRENT_MODEL'"
  echo "All models may be in cooldown. Check: $POOLS_FILE"
  exit 1
fi

if [ "$ACTION" = "--dry-run" ]; then
  echo "Would update $AGENT_FILE:"
  echo "  model: $CURRENT_MODEL → $NEXT_MODEL"
  echo "  (set cooldown for NVIDIA models in pools)"
  exit 0
fi

# Apply provider-wide cooldown for NVIDIA
COOLDOWN_MIN=$(python3 -c "
import json
with open('$CONFIG_FILE') as f:
    config = json.load(f)
print(config['cooldowns']['provider_wide_rate_limit_minutes'])
")

python3 -c "
import json
from datetime import datetime, timezone, timedelta

with open('$POOLS_FILE') as f:
    data = json.load(f)

now = datetime.now(timezone.utc)
cd_minutes = $COOLDOWN_MIN
cd_until = (now + timedelta(minutes=cd_minutes)).strftime('%Y-%m-%dT%H:%M:%SZ')

# Find which provider the current model belongs to
current = '$CURRENT_MODEL'
provider = current.split('/')[0] if '/' in current else 'local'

updated = 0
for pool_name, pool in data['pools'].items():
    for m in pool['models']:
        mid = m['model_id']
        mp = mid.split('/')[0] if '/' in mid else 'local'
        if mp == provider:
            if m.get('cooldown_until') != cd_until:
                m['cooldown_until'] = cd_until
                m['consecutive_failures'] = (m.get('consecutive_failures', 0) or 0) + 1
                updated += 1

with open('$POOLS_FILE', 'w') as f:
    json.dump(data, f, indent=2)

print(f'Cooldowned {updated} models from provider \"{provider}\" until {cd_until}')
"

# Update the agent file
sed -i "s/^model: .*/model: $NEXT_MODEL/" "$AGENT_FILE"
echo "Updated $AGENT_NAME agent: $CURRENT_MODEL → $NEXT_MODEL"

# Send ntfy notification
if [ -n "${NTFY_TOPIC:-}" ]; then
  NTFY_URL="${NTFY_URL:-https://ntfy.sh}"
  PROJECT_NAME="${OPENCODE_PROJECT:-opencode}"
  curl -sf -H "Title: ⚡ Provider Failover" \
       -H "Priority: 4" \
       -H "Tags: satellite,computer" \
       -d "$PROJECT_NAME: $AGENT_NAME swapped $CURRENT_MODEL → $NEXT_MODEL (provider $provider cooldowned)" \
       "$NTFY_URL/$NTFY_TOPIC" 2>/dev/null || true
fi

echo "Failover complete."
