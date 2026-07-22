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
- redacted structured data

Typical event types include `workflow.started`, `stage.started`, `model.attempt.started`, `model.attempt.completed`, `budget.updated`, `budget.exceeded`, `provider.cooldown`, `stage.completed`, and `workflow.completed`.

## Querying

```bash
node scripts/query-events.mjs --task feature-auth-20260722 --format summary
node scripts/query-events.mjs --type budget.exceeded --format json
node scripts/query-events.mjs --model opencode/deepseek-v4-flash-free --limit 50
```

The event stream is intended for debugging, audit history, budget recovery, performance analysis, and later dashboard integrations. It is local runtime state and must not be committed.

## Redaction

The logger recursively redacts fields with credential-like names and common token, bearer, private-key, and environment-secret formats. Redaction is defense in depth, not permission to log secrets deliberately. Worker prompts, environment files, credentials, and production data should never be emitted.
