# Required OpenCode Fork

The OpenCode Agent Loop requires a **patched version of OpenCode** to function correctly. The stock OpenCode release does not expose subagent task failures to the orchestrator — it treats all subagent exits as success.

## The Problem

When a subagent (build-worker, test agent, review agent, etc.) fails — whether due to a provider error, rate limit, or task failure — the standard OpenCode `task` tool returns success to the caller. The orchestrator cannot distinguish between "task completed successfully" and "task failed with an error."

## The Fix

The patch in `patches/opencode-subagent-failure-exposure.patch` applies the following changes to OpenCode:

| File | Change |
|------|--------|
| `packages/opencode/src/provider/classify.ts` | (New) Provider error classification: rate_limit, quota, auth_error, context_overflow, etc. |
| `packages/opencode/src/tool/task.ts` | Capture provider errors as structured `taskError` in tool release phase |
| `packages/opencode/src/session/processor.ts` | Surface subagent retry status and failure details through processor cleanup |
| `packages/opencode/src/session/retry.ts` | Only retry truly transient errors; fail fast for non-retryable failures |
| `packages/opencode/src/session/llm.ts` | Handle provider selection with model override from task tool |

## Applying the Patch

```bash
# Clone OpenCode
git clone https://github.com/sst/opencode.git
cd opencode

# Apply the patch
git apply /path/to/opencode-agent-loop/patches/opencode-subagent-failure-exposure.patch

# Build
npm run build
```

## Verifying the Patch

After applying, run the task tool tests to confirm:

```bash
cd packages/opencode
npm test -- --grep "task"
```

The following test behaviors should be present:

1. **Subagent provider failures are surfaced** — When a subagent encounters a provider error (429, 503, etc.), the task tool returns a structured `taskError` instead of success.
2. **Non-retryable errors fail fast** — Auth failures, billing errors, and content-filter rejections are not retried.
3. **Free-usage limits are non-retryable** — When a free tier model hits its usage limit, it fails immediately rather than retrying, allowing the orchestrator to fall back to a paid model.
4. **Provider errors are classified** — Errors are classified as rate_limit, quota, auth_error, context_overflow, content_filter, cancelled, or api_error.

## Without the Patch

The agent loop will **not work correctly** without these patches. The orchestrator will:

- Treat failed subagent calls as successful
- Continue to the next stage even when implementation failed
- Not detect when a model provider returns an error
- Be unable to differentiate between transient and permanent failures

## Alternative: Use the OpenCode Fork

If you prefer not to patch manually, you can use the maintainer's fork which includes these changes:

```bash
git clone https://github.com/sst/opencode.git
# Or use a fork that includes these commits
```

The specific commits (in order):
1. `feat(opencode): allow task model override`
2. `fix(opencode): surface subagent task failures`
3. `fix(opencode): classify subagent provider failures`
4. `fix(opencode): surface subagent retry status`
5. `fix(opencode): surface subagent retry detail through processor cleanup`
6. `fix(opencode): read task child session ID from part.metadata too`
7. `fix(opencode): write subagentFailure to part metadata on abort before child cancel`
8. `fix(opencode): capture retry status in task tool release phase before child cancel`
9. `fix(opencode): make FreeUsageLimitError non-retryable to unblock orchestrator fallback`
10. `fix(opencode): only retry truly transient errors, fail fast for all others`
