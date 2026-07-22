# Required OpenCode Patch

OpenCode Agent Loop currently requires a patched OpenCode build. The stock release does not expose all subagent failure information needed for reliable failover.

## Why the patch is required

Delegated provider errors, rate limits, timeouts, quota failures, and non-retryable request failures must reach the parent as structured failures. Without the patch, a failed child call can appear successful and allow the workflow to advance incorrectly.

## Supported revision

The known-good upstream repository and commit are recorded in:

```text
config/supported-opencode.json
```

Use that pinned revision for normal installations. The moving upstream `dev` branch is probed separately because the patch is revision-sensitive and does not necessarily apply to current development head.

## Patch contents

```text
patches/opencode-subagent-failure-exposure.patch
```

The patch covers task-level model overrides, provider-error classification, retry metadata, free-usage-limit behavior, child-session failure propagation, and resilient session titles.

## Build process

```bash
git clone https://github.com/anomalyco/opencode.git
cd opencode

git checkout "$(node -e "const fs=require('fs'); const p=JSON.parse(fs.readFileSync('/absolute/path/to/opencode-agent-loop/config/supported-opencode.json','utf8')); process.stdout.write(p.ref)")"
git apply /absolute/path/to/opencode-agent-loop/patches/opencode-subagent-failure-exposure.patch

# Install and build using the checked-out revision's upstream instructions.
```

OpenCode's source layout and build procedure can change. Do not substitute the latest `dev` revision merely because cloning it succeeds, and do not assume an old npm build command remains valid.

## Automated compatibility workflow

`.github/workflows/opencode-patch-compat.yml` runs for compatibility-related pull requests, weekly, and on manual request.

The required job:

1. reads the pinned revision from `config/supported-opencode.json`
2. verifies and applies the patch
3. installs upstream Bun dependencies
4. builds a standalone OpenCode binary
5. verifies the patched source contracts
6. publishes the exact tested revision as a workflow artifact

A separate non-blocking job probes the moving `dev` branch. Its purpose is early warning that the patch needs rebasing; failure of that probe does not invalidate the pinned supported build.

## Verify behavior

Before important use, verify:

1. provider failures surface as structured failures
2. rate limits differ from authentication and billing failures
3. non-retryable failures stop promptly
4. free-usage exhaustion permits another eligible model
5. task-level model overrides reach the child session
6. cancellation preserves failure metadata
7. JSON usage and cost events remain available to budget enforcement

Run the relevant upstream task, retry, session, provider, and CLI tests for the exact revision you built.

## Compatibility warning

The patch may fail to apply, fail to build, or apply while no longer producing the intended behavior. Treat `git apply` success as necessary but insufficient.

The long-term goal is to replace the patch with equivalent upstream behavior or a stable provider/task extension interface.
