# Agent Roles

## Overview

The framework defines 10 agent roles, each with specific capabilities, tools, and permissions. Agents communicate through the orchestrator using structured task delegation.

## Orchestrator

**Primary agent** — drives the full feature lifecycle.

- Model: `opencode-go/deepseek-v4-flash`
- Permission: read-only for itself; task delegation to subagents
- Key capabilities: Planning, dependency DAG construction, stage enforcement, model failover management, commit creation
- Restrictions: Cannot push, reset, or rewrite history

## Build Worker

**Execution agent** — implements approved changes.

- Model: `opencode-go/deepseek-v4-flash`
- Permission: read, write, edit, shell (limited)
- Key capabilities: Code search, implementation, build verification
- Restrictions: Cannot commit, push, or use agent_loop

## Test Agent

**Verification authority** — establishes baselines and validates implementations.

- Model: `opencode-go/deepseek-v4-flash`
- Permission: read, edit (test files only), shell
- Key capabilities: Test discovery, baseline establishment, regression testing, screenshot capture, server lifecycle management
- Restrictions: Cannot modify production code to make tests pass

## Review Agent

**Independent reviewer** — inspects diffs for correctness and security.

- Model: `opencode-go/mimo-v2.5`
- Permission: read-only
- Key capabilities: Diff inspection, AC validation, security review, visual screenshot inspection
- Restrictions: Cannot edit files, commit, or push

## Escalation Agent

**Stalled task recovery** — diagnoses and fixes repeatedly failing tasks.

- Model: `opencode-go/deepseek-v4-flash`
- Permission: read, edit, web fetch (with permission)
- Key capabilities: Root cause analysis, alternative approach implementation
- Restrictions: Cannot commit or push

## Reconcile Agent

**Conflict resolution** — integrates overlapping changes.

- Model: `opencode-go/mimo-v2.5`
- Permission: read, edit, git merge
- Key capabilities: Merge conflict resolution, parallel output integration
- Restrictions: Cannot commit or push

## Explore Agent

**Codebase research** — fast read-only exploration.

- Model: `opencode-go/deepseek-v4-flash`
- Permission: read-only
- Key capabilities: File search, pattern matching, architectural analysis
- Restrictions: Cannot edit files

## Trivial Builder

**Fast small changes** — bounded edits under 20 lines.

- Model: `opencode-go/mimo-v2.5`
- Permission: read, edit, shell (limited)
- Restrictions: Cannot commit or push

## Local Agents (Qwythos 9B)

Five specialized local agents for sensitive or offline work:

- **local-qwythos-explore**: Read-only exploration
- **local-qwythos-test-fixer**: Narrow test repair
- **local-qwythos-review**: Preliminary read-only review
- **local-qwythos-private-worker**: Sensitive/local-only tasks
- **local-qwythos-builder**: Small-medium bounded changes

All local agents run on the Qwythos 9B model (local GPU) and are restricted from sending data to external providers.