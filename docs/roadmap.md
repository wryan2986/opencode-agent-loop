# Roadmap

## Vision
A reliable, safe, and extensible open-source framework for autonomous software-development task orchestration that works with any model provider and any project.

## Version 0.1 — Initial Public Release (Current)
**Focus**: Sanitized, documented, testable foundation.

- [x] Sanitized public release with no private references
- [x] Core orchestration loop with stage enforcement
- [x] 10 specialized agent roles
- [x] Paid-primary model routing with multi-provider failover
- [x] Configuration validation and schema
- [x] Deterministic test fixtures (routing, runtime, integration)
- [x] Comprehensive documentation (architecture, providers, safety, etc.)
- [x] CI workflow with GitHub Actions
- [x] Security policy and vulnerability reporting
- [x] Contribution guidelines and code of conduct
- [x] CLI commands: /feature, /loop, /loop-init
- [x] Example fixtures for common workflows

## Version 0.2 — Provider Adapters and Improved Resilience
**Focus**: Provider abstraction, improved failover, structured events.

- [ ] Provider adapter interface for easier third-party model integration
- [ ] Structured event log schema for audit and debugging
- [ ] Improved checkpointing with partial progress recovery
- [ ] Budget enforcement (token and cost limits per task)
- [ ] Better retry strategies with exponential backoff configuration
- [ ] Additional example workflows (database migration, refactoring)
- [ ] Windows compatibility testing and fixes
- [ ] macOS compatibility validation

## Version 0.3 — Plugin System and Observability
**Focus**: Extensibility, monitoring, safety hardening.

- [ ] Plugin system for custom agent roles and workflow hooks
- [ ] Reusable evaluation harness for benchmarking agent performance
- [ ] Optional web dashboard for task progress visualization
- [ ] Stronger sandboxing (container-based execution)
- [ ] Community-contributed role packs
- [ ] Expanded local-model support documentation
- [ ] i18n of documentation

## Version 0.4 — Enterprise Readiness
**Focus**: Scale, audit, compliance.

- [ ] Multi-project orchestration
- [ ] Persistent task queues and backlog processing
- [ ] Role-based access control for team use
- [ ] Audit trail with tamper-evident logging
- [ ] Compliance documentation (SOC2, GDPR)
- [ ] SLA monitoring for model providers
- [ ] SSO and team authentication integration

## Version 1.0 — Stable API
**Focus**: API stability, production hardening, ecosystem growth.

- [ ] Stable, versioned configuration schema
- [ ] Backward-compatible migration paths
- [ ] Extensive integration testing across providers
- [ ] Performance benchmarks and optimization
- [ ] Official package registries (npm, Homebrew, Docker)
- [ ] Third-party provider certification program

## How to Influence the Roadmap
- Open GitHub issues with the "enhancement" label
- Participate in GitHub Discussions
- Submit pull requests for planned features
- Share your use cases and requirements

The roadmap is a living document. Priorities may shift based on community feedback, security requirements, and contributor availability.