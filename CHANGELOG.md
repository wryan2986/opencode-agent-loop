# Changelog

## [0.1.1] - 2026-07-22

### Fixed

- Repaired README Markdown rendering and mobile-safe architecture diagram.
- Corrected repository badge and clone URLs.
- Documented the required patched OpenCode build before Quick Start.
- Clarified the paid orchestrator plus free-first subagent routing strategy.
- Removed inconsistent hardcoded agent counts from public documentation.
- Added missing configuration and TUI integration guides.
- Corrected safety documentation to place Git command restrictions under Bash permissions.
- Added explicit destructive-Git denials to the build, test, and review agents.
- Fixed CI secret-scan exclusions and environment-file detection.
- Added local Markdown link validation.
- Removed the invalid Dependabot reviewer entry.
- Added complete package metadata and validation scripts.

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
