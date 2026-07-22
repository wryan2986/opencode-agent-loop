# Changelog

## [Unreleased]

## [0.2.0] - 2026-07-22

### Added

- Added configurable token, cost, and workflow-call budgets shared by one stable task ID.
- Added atomic budget persistence across OpenCode and plugin restarts with TTL and task-count retention limits.
- Added same-model transient retries with exponential backoff and jitter before provider failover.
- Added provider adapters for provider identity, aliases, timeout selection, local-model recognition, and error normalization.
- Added a custom provider-adapter example and extension documentation.
- Added a versioned structured event schema, append-only JSONL event stream, recursive redaction, and query utility. Closes #5.
- Added Linux, macOS, Windows, WSL, and Git Bash guidance plus a cross-platform Node CI matrix. Closes #6.
- Added scheduled and manually configurable patched-OpenCode compatibility builds.
- Added portable task-checkpoint paths.
- Added a workflow-call ceiling and reduced parent-orchestrator turn cap.
- Added v0.2 configuration, event, feature-contract, and reliability validation.

### Changed

- Routed every `/feature` worker stage through the budget-enforced `agent_loop` tool.
- Moved provider-specific runtime behavior behind the provider-adapter interface. Closes #7.
- Updated runtime state layout under `.opencode/agent-loop-state/`.
- Updated package and policy schema versions to 0.2.0 and 2.0.0 respectively.
- Updated architecture, configuration, platform, troubleshooting, event, and provider documentation.

### Fixed

- Made the public `maxRetries` option perform actual same-model retries for transient failures.
- Corrected timeout selection for local/Ollama model IDs without a slash.
- Removed the hardcoded `/usr/local/bin/opencode` executable path so PATH resolution works across operating systems.
- Treat local-unmetered models as zero-cost.
- Account for final usage events emitted without a trailing newline or during budget-triggered shutdown.
- Stop retries, failover, and escalation immediately after `BUDGET_EXCEEDED`.
- Prevent replacement task IDs from being used to evade an exhausted feature budget.
- Strengthened recursive redaction for structured event and attempt logs.
- Clarified that exact parent-orchestrator token and dollar usage is unavailable, while parent workflow calls and turns are bounded.

## [0.1.1] - 2026-07-22

### Fixed

- Repaired README Markdown rendering and mobile-safe architecture diagram.
- Corrected repository badge and clone URLs.
- Documented the required patched OpenCode build before Quick Start.
- Clarified the paid orchestrator plus free-first subagent routing strategy.
- Removed inconsistent hardcoded agent counts from public documentation.
- Added missing configuration and TUI integration guides.
- Moved destructive Git restrictions into enforced Bash permission patterns for every agent role.
- Normalized local and paid builder frontmatter and explicit model assignments.
- Removed mutable cooldown, failure, provider-error, and health-check state from committed routing configuration.
- Aligned the orchestrator role pool with the paid DeepSeek orchestrator.
- Added repository-wide agent permission and clean-routing validation to CI.
- Fixed CI secret-scan exclusions and environment-file detection.
- Added local Markdown link validation.
- Removed the invalid Dependabot reviewer entry.
- Added complete package metadata and synchronized lockfile version metadata.

## [0.1.0] - 2026-07-22

### Added

- Initial public release.
- Orchestrator agent with stage-enforced workflow lifecycle.
- Specialized cloud and local agent roles with configurable model routing.
- Provider-aware failover and cooldown management.
- Privacy-aware model routing with data-policy classification.
- Task-state checkpointing for interrupted runs.
- Server lifecycle management helpers.
- Smoke-test model responsiveness checking.
- Structured handoff format between build and review agents.
- Deterministic routing, runtime, integration, and security tests.
- OpenCode TUI integration through the `agent_loop` custom tool.
- Installation, validation, governance, contribution, and security documentation.
