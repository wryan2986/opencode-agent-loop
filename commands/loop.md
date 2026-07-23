---
agent: orchestrator
description: Run a compact task through the hybrid policy kernel and agent_loop workers.
---

# /loop — Compact policy-controlled workflow

Treat the user's direct `/loop` invocation as approval for the stated scope, but do not assume approval for material scope expansion.

1. Create one stable `taskId`.
2. Call `orchestration_policy` with `action: "inspect"`, the task, proposed risk, and likely paths.
3. Record approval with `action: "record_approval"` and approval evidence referencing the `/loop` request.
4. Decide whether baseline evidence is useful. Propose `baseline` or a justified `skip_baseline`.
5. Propose `smoke`; on `allow`, pass its permit to `agent_loop` with `mode: "smoke"`.
6. Propose each needed worker action. Pass the returned permit to the matching `agent_loop` call.
7. For changes, stage only intended files, propose `stage_candidate`, and run final policy-authorized test and review against that candidate.
8. Propose `commit` only when the requested work includes a local commit and all required evidence exists; use `orchestration_commit`, never direct `git commit`.

On `needs_evidence`, gather it or choose another legitimate action. On `deny`, stop, replan, or ask the user. Report policy decisions, worker results, budget state, and partial completion honestly.

Task:

```text
$ARGUMENTS
```
