# Changelog

## [0.1.0] - 2026-07-22

### Added
- Initial public release
- Orchestrator agent with stage-enforced workflow lifecycle
- 10 specialized agent roles with configurable model routing
- Paid-primary model routing with multi-provider failover
- Provider-wide cooldown management for rate limits
- Privacy-aware model routing with data-policy classification
- Task state checkpointing for seamless failover
- Server lifecycle management helpers
- Smoke-test model responsiveness checking
- Structured handoff format between build and review agents
- Collector pattern for parallel i18n additions
- Deterministic test fixtures
- 6 test suites covering routing, runtime, integration, and security
- Runtime controller with centralized failover
- OpenCode TUI integration via agent_loop custom tool
- Installation and validation scripts
- Free-first configuration with ordered model pools
- Local Ollama 9B model support for sensitive tasks
- Privacy-classification-based model filtering
- Recursion guard to prevent agent loop cycles
- Paid fallback with per-task and global limits
- Documentation: architecture, configuration, providers, safety model

### Changed
- Standardized agent permissions across all roles
- Unified runtime controller architecture