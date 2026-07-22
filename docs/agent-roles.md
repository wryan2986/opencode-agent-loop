# Agent Roles

## Overview

The framework defines specialized cloud and local roles with separate responsibilities, models, and permissions. The exact number of agent files may change as roles are added, retired, or split, so this guide describes capabilities rather than relying on a fixed count.

Agents do not communicate directly with one another. The orchestrator delegates work and passes structured context between roles.

## Orchestrator

**Primary coordinator** — drives the complete lifecycle.

- Default model: `opencode-go/deepseek-v4-flash`
- Access: read-only workspace access, task delegation, limited Git commands
- Responsibilities: repository inspection, acceptance criteria, dependency DAG, plan approval, state transitions, model failover, and final commit
- Restrictions: does not implement code, run verification itself, push, or rewrite history

## Build Worker

**Standard implementation role** — makes approved code changes.

- Default model: `opencode/deepseek-v4-flash-free`
- Access: read, edit, and bounded shell execution
- Responsibilities: implementation, focused verification, documentation updates, and structured handoff
- Restrictions: cannot commit, push, rewrite history, or delegate

## Trivial Builder

**Small-change role** — handles tightly bounded, low-risk edits.

- Intended scope: one or two files and roughly 20 changed lines or fewer
- Access: read, edit, and bounded shell execution
- Restrictions: same Git and delegation restrictions as the standard builder

Use the standard builder when a change has architectural consequences, unclear scope, migrations, security impact, or broad test requirements.

## Test Agent

**Verification authority** — establishes baselines and verifies final behavior.

- Default model: `opencode/deepseek-v4-flash-free`
- Access: read, test-file edits, and bounded shell execution
- Responsibilities: test discovery, baseline establishment, regression testing, post-change verification, and exact command/output reporting
- Restrictions: cannot modify production code merely to make tests pass, commit, push, or delegate

## Review Agent

**Independent reviewer** — evaluates the actual diff and surrounding code.

- Default model: `opencode/mimo-v2.5-free`
- Access: read-only repository and safe inspection commands
- Responsibilities: acceptance-criteria validation, correctness, security, regressions, edge cases, test quality, and documentation review
- Restrictions: cannot edit, commit, push, or delegate

## Explore Agent

**Codebase research role** — performs fast, read-only discovery.

- Access: read-only search and inspection
- Responsibilities: locating files, tracing behavior, identifying architecture, and answering bounded repository questions
- Restrictions: cannot edit or approve implementation

## Reconcile Agent

**Conflict-resolution role** — integrates overlapping parallel changes.

- Access: read, edit, and narrowly scoped merge-related operations
- Responsibilities: resolving conflicts, preserving both approved work units, and returning the result for independent verification
- Restrictions: cannot create the final commit or push

## Escalation Agent

**Repeated-failure diagnosis** — handles work that has exhausted normal repair paths.

- Primary escalation model: `openai/gpt-5.6-luna`
- Access: read, edit, and optionally approved web access
- Responsibilities: root-cause diagnosis, alternative approaches, complex debugging, and recovery recommendations
- Restrictions: cannot bypass testing and review gates, commit, or push

## Local Agents

Local Ollama roles support sensitive, offline, or low-cost bounded work. Current local capabilities may include:

- read-only exploration
- preliminary review
- narrow test repair
- private local-only implementation
- small-to-medium bounded builds
- short log or text analysis

Local models must not be used as the final authority for security review or primary orchestration. A local failure must not trigger paid fallback while suitable free cloud models remain, unless privacy classification prohibits those providers.

## Delegation rules

- The orchestrator selects roles based on task complexity and stage.
- Builders never approve their own output.
- Test and review run independently after implementation and after every fix cycle.
- Reconciliation returns to verification.
- Escalation does not skip baseline, test, or review requirements.
- Subagents cannot start another full agent loop.

## Permission guidance

Git commands are shell commands and must be restricted under the `bash` permission map. Do not assume a standalone `git:` block is enforced unless the active OpenCode build explicitly implements that tool.

See [Safety Model](safety-model.md) for the required permission patterns and deployment limitations.
