---
agent: orchestrator
description: Run a task through the agent_loop custom tool. Starts with smoke test then build.
---

Call the `agent_loop` tool one role at a time.

1. First call `agent_loop` with `mode: "smoke"` and this task:
   ```
   $ARGUMENTS
   ```
2. If smoke test succeeds, call `agent_loop` with `mode: "build"` + `models` from smoke results.
3. Then `mode: "test"`, then `mode: "review"`.

Report the tool result honestly, including partial completion, failed tests, model attempts, and log paths.
