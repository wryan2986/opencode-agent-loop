# Structured event logging

The runtime writes append-only JSON Lines events to:

```text
<project>/.opencode/agent-loop-state/events.jsonl
```

Each event conforms to `config/agent-loop-event.schema.json` and includes:

- schema version and unique event ID
- timestamp and task ID
- event type
- optional stage, role, and model ID
- recursively redacted structured data

Current event families include:

- `workflow.call`, `workflow.call.completed`, and `workflow.call.failed`
- `stage.started`, `stage.completed`, `stage.failed`, and `stage.blocked`
- `smoke.completed`
- `model.attempt.*`, `model.invocation.*`, and `model.retry.scheduled`
- `provider.cooldown`, `provider.skipped`, and `provider.cooldown-reaped`
- `paid-fallback.denied`
- `budget.updated` and `budget.exceeded`
- `routing.event` for backward-compatible routing events that do not yet have a dedicated type

## Querying

```bash
node scripts/query-events.mjs --task feature-auth-20260722 --format summary
node scripts/query-events.mjs --type budget.exceeded --format json
node scripts/query-events.mjs --model opencode/deepseek-v4-flash-free --limit 50
```

The stream supports debugging, audit history, budget recovery, performance analysis, and later dashboard integrations. It is local runtime state and must not be committed.

## Backward compatibility

The structured stream supplements rather than replaces existing attempt and progress logs under `.opencode/agent-loop-logs/`. Existing log consumers can continue reading those files. New integrations should prefer the versioned event stream and treat unknown event types as forward-compatible records.

## Redaction

The logger recursively redacts fields with credential-like names and common token, bearer, private-key, and environment-secret formats. Redaction is defense in depth, not permission to log secrets deliberately. Worker prompts, environment files, credentials, and production data should never be emitted.
