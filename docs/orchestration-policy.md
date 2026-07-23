# Hybrid orchestration policy

The orchestration policy kernel keeps semantic development decisions with the orchestration model while enforcing objective safety, evidence, budget, and candidate-integrity rules in code.

> **Authority boundary:** the model proposes; the kernel validates; an authorized tool executes.

## What remains flexible

The orchestration model decides:

- how to understand and decompose the task
- which architecture or implementation approach is appropriate
- whether a baseline is useful
- which validation methods fit the repository and risk
- whether to build, test existing behavior, review, replan, ask the user, escalate, or stop
- what semantic risk applies and why
- whether a discovered issue belongs in scope

The kernel does not choose files to edit, design the solution, select test commands, or force one universal stage sequence.

## What is deterministic

The kernel controls:

- stable task identity and durable task state
- explicit approval records
- terminal budget state
- one-time action permits
- retry and fix-cycle ceilings
- risk-level minimum evidence
- staged candidate hashing
- test and review evidence bound to the candidate hash
- final commit authorization and candidate rechecking

`agent_loop` requires a matching permit. The orchestrator cannot directly run `git commit`; `orchestration_commit` consumes a commit permit and rechecks the staged hash.

## Phases

Set `mode` in `config/orchestration-policy.json` or temporarily override it with `AGENT_LOOP_POLICY_MODE`.

### Phase 1: `shadow`

The kernel evaluates every proposal and records the decision it would make, but returns `allow` and issues permits. Results include:

- `decision: "allow"`
- `enforced: false`
- `observedDecision`
- `advisoryMissingEvidence`

Use this mode to measure disagreements and false positives without blocking work.

### Phase 2: `invariants`

The kernel enforces non-negotiable safeguards while reporting risk gates as advisory. It blocks or requests evidence for conditions such as:

- implementation before approval
- missing or invalid permits
- permit reuse or mode mismatch
- terminal budget exhaustion
- too many fix cycles
- empty staged candidate
- review missing for the current candidate
- candidate changes after commit authorization

Risk-specific minimums appear in `advisoryMissingEvidence` but do not block yet.

### Phase 3: `risk`

This is the default. It enforces invariants plus risk-based minimum evidence.

| Effective risk | Minimum final evidence |
|---|---|
| Low | Relevant validation or test plus independent review |
| Medium | Baseline or justified skip, focused test, review |
| High | Baseline, runtime test, representative integration evidence, review, recovery evidence when applicable |
| Critical | High-risk evidence plus isolation and a final human checkpoint |

The orchestrator proposes a risk level. The kernel independently evaluates task text, planned paths, and actual staged paths. It may elevate the level but never lower the model's proposal.

## Decisions

`orchestration_policy` returns:

- `allow` — proceed; delegated and commit actions include a one-time permit
- `needs_evidence` — obtain or record the listed evidence, replan, ask the user, or select another legitimate action
- `deny` — the action is prohibited or the task is terminal; do not repeat or bypass it

The model should treat policy feedback as machine-readable requirements, not as a prompt to argue with the kernel.

## Actions

Supported proposals include:

- `inspect`
- `request_approval`
- `record_approval`
- `record_evidence`
- `baseline`
- `skip_baseline`
- `smoke`
- `build`
- `test`
- `stage_candidate`
- `review`
- `fix`
- `escalate`
- `commit`
- `push`
- `ask_user`
- `replan`
- `stop`

Delegated action mapping:

| Policy action | `agent_loop` mode |
|---|---|
| baseline | test |
| smoke | smoke |
| build | build |
| test | test |
| review | review |
| fix | build |
| escalate | escalate |

## Evidence

The runtime automatically records:

- worker outcomes
- budget exhaustion
- staged candidate identity
- test and review status
- final commit hash

The model may record semantic evidence that cannot be inferred reliably from process state, including:

- baseline-skip justification
- why a failing baseline reproduces the target bug
- representative integration or end-to-end coverage
- rollback or forward-recovery plan
- isolation method
- explicit human checkpoints

Evidence references should point to commands, event logs, screenshots, artifacts, files, or user messages. Unsupported statements such as `done` are not meaningful evidence.

## Candidate binding

`stage_candidate` calculates a SHA-256 digest of the staged binary diff and records the staged file list. Test and review permits capture that digest. Final evidence must match the current digest.

Before committing, the kernel recalculates the digest. A changed candidate fails with `POLICY_CANDIDATE_CHANGED` and must be restaged, retested, and rereviewed.

## Persistent state and observation

Policy state is stored at:

```text
.opencode/agent-loop-state/policy.json
```

Policy proposals, decisions, permit consumption, execution recording, and commit completion are also appended to the structured event log. This allows comparison of:

- the action the model proposed
- the risk the model proposed
- any kernel risk elevation
- the enforced decision
- the decision that would have been made in shadow mode
- missing or advisory evidence
- how the model adapted after feedback

Use the existing event query utility to inspect policy events:

```bash
npm run events -- --task <task-id> --type policy.decision
```

## Configuration

`config/orchestration-policy.json` controls:

- phase mode
- permit requirement and lifetime
- policy-controlled commit requirement
- task-state retention
- maximum fix cycles
- risk path and keyword signals
- documented risk gates

The environment variables below are useful for evaluation and tests:

- `AGENT_LOOP_POLICY_MODE=shadow|invariants|risk`
- `AGENT_LOOP_POLICY_STATE_PATH=/custom/path/policy.json`

Do not use environment overrides to bypass a production repository's approved policy.
