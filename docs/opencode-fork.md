# Required OpenCode Patch

OpenCode Agent Loop currently requires a patched OpenCode build. The stock release does not expose all subagent failure information needed for reliable model failover.

## Why the patch is required

When a delegated agent fails because of a provider error, rate limit, timeout, quota problem, or non-retryable request error, the orchestrator must receive a structured failure. Without the patch, some failed task-tool calls can appear successful to the caller.

That can cause the workflow to:

- advance after an implementation failed
- skip model failover
- misclassify transient and permanent provider errors
- verify or review an incomplete change

## Patch contents

The repository includes:

```text
patches/opencode-subagent-failure-exposure.patch
```

The patch adds or updates behavior for:

- task-level model overrides
- provider-error classification
- subagent retry and failure metadata
- non-retryable free-usage-limit handling
- child-session failure propagation
- resilient session-title generation

## Build process

OpenCode's source repository and build commands can change. Follow the current upstream development instructions for prerequisites and building, then apply this repository's patch before compiling.

A typical flow is:

```bash
# Clone the current official OpenCode source repository.
git clone https://github.com/anomalyco/opencode.git
cd opencode

# Apply the patch from this repository.
git apply /absolute/path/to/opencode-agent-loop/patches/opencode-subagent-failure-exposure.patch

# Install and build using the commands documented by upstream.
```

Do not assume an old `npm run build` command remains valid. Use the package manager and build procedure specified by the checked-out OpenCode revision.

## Verify the patched behavior

At minimum, verify these cases before using the loop on important work:

1. A subagent provider failure is surfaced as a structured failure.
2. A rate limit is classified separately from authentication or billing errors.
3. Non-retryable failures stop retrying promptly.
4. A free-usage-limit failure allows the orchestrator to select another model.
5. A task-level model override reaches the child session.
6. Cancelling or aborting a child task does not erase its failure metadata.

Run the relevant upstream task, retry, session, and provider tests for the exact revision you built.

## Compatibility warning

This patch is revision-sensitive. It may fail to apply cleanly after upstream changes, or it may apply while no longer producing the intended behavior. Treat a clean `git apply` as necessary but not sufficient; run the verification tests.

The long-term goal is to remove this requirement by relying on equivalent upstream behavior or a stable provider/task extension interface.
