# Troubleshooting

## All providers are unresponsive

1. Run `opencode models` and confirm the configured model IDs exist.
2. Verify network connectivity and provider credentials.
3. Check runtime cooldown state under `.opencode/agent-loop-state/`.
4. Query recent provider and model-attempt events.
5. Wait for the configured cooldown or select a different provider.

```bash
node scripts/query-events.mjs --task <task-id> --format summary
```

## A task stops with `BUDGET_EXCEEDED`

Do not restart the request under a new task ID. Inspect the returned budget snapshot and event stream:

```bash
node scripts/query-events.mjs --task <task-id> --type budget.exceeded --format json
```

Raise a budget only after reviewing why the task consumed it. Persistent budget state lives under `.opencode/agent-loop-state/` and survives plugin restarts.

## `/feature` does nothing

The slash command requires OpenCode's interactive TUI. Start `opencode`, then enter `/feature <description>`. Use `/loop <description>` for direct access to the custom tool.

## Tests fail with no output

1. Run `npm ci` in this package.
2. Read the target project's `AGENTS.md` for its exact commands.
3. Run `npm run validate` in the agent-loop package.
4. Inspect the attempt log and structured event log.

## A model is not found

1. Run `opencode models`.
2. Check `config/free-first-pools.json` for the role.
3. Check `config/model-registry.json` for retirement or disabled status.
4. Confirm the provider adapter recognizes the model prefix.

## A local model times out too quickly

Local and Ollama IDs use the `local` timeout key, including IDs without a slash such as `ollama-9b-local`. Adjust `general.local_model_request_timeout_seconds` or `provider_timeouts_ms.local`.

## Retry behavior is unexpected

`maxRetries` controls retries of the same model for transient failures. Provider failover is separate. Authentication, billing, safety, invalid-request, task-quality, and budget failures are terminal and are not retried.

## A commit is blocked by pre-existing changes

The orchestrator preserves unrelated changes. Commit or stash them yourself, or ensure the intended feature diff can be staged independently. The loop must not discard unrelated work.

## The OpenCode patch no longer applies

Run the OpenCode compatibility workflow manually. It clones the configured upstream revision, checks the patch, installs Bun dependencies, builds a standalone binary, and runs the compatibility probe. A clean `git apply` is necessary but not sufficient; build and behavior checks must pass.

## Windows path or shell errors

Use WSL 2 or Git Bash for installation. The Node runtime is tested natively on Windows, but Bash installation and permission-validation scripts require a POSIX-compatible shell. See [Platform Support](platforms.md).

## Logs and sensitive material

Runtime logging recursively redacts credential-like fields and common token, bearer, environment-secret, and private-key formats. This is defense in depth. Never place credentials or production data in prompts, and review logs before sharing them.

Attempt logs are written under `.opencode/agent-loop-logs/`. Structured events and persistent budgets are under `.opencode/agent-loop-state/`.

## Validate the installation

```bash
npm ci
npm run validate
```
