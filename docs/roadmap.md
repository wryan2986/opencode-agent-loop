# Roadmap

## Vision

A reliable, safe, and extensible open-source framework for autonomous software-development task orchestration that works with multiple model providers and project types.

## Version 0.1 — Public foundation

**Focus:** Sanitized, documented, testable foundation.

- [x] Sanitized public release with no private references
- [x] Core orchestration loop with stage enforcement
- [x] Specialized cloud and local roles
- [x] Paid orchestrator with free-first delegated-role routing
- [x] Deterministic routing, runtime, integration, and security tests
- [x] CI, contribution, security, and release workflows
- [x] `/feature`, `/loop`, and `/loop-init` commands

## Version 0.2 — Reliability, portability, and observability

**Focus:** Durable budgets, provider abstraction, structured events, and cross-platform validation.

- [x] Configurable token, cost, and workflow-call budgets
- [x] Persistent budget state across plugin and process restarts
- [x] Same-model transient retries with exponential backoff and jitter
- [x] Provider adapter interface and custom adapter example
- [x] Local/Ollama provider recognition and timeout handling
- [x] Versioned structured event schema and append-only event log
- [x] Event query utility and recursive log redaction
- [x] Portable checkpoint paths
- [x] Linux, macOS, Windows, WSL, and Git Bash guidance
- [x] Cross-platform Node runtime CI
- [x] Scheduled OpenCode patch compatibility workflow
- [x] Runtime configuration schema and integration-contract validation

## Version 0.3 — Recovery and evaluation

**Focus:** Deeper resilience, performance measurement, and operational visibility.

- [ ] Resumable workflow controller with durable stage checkpoints
- [ ] Automatic recovery from interrupted build/test/review stages
- [ ] Reusable evaluation harness for agent quality, latency, and cost
- [ ] Optional task-progress dashboard backed by structured events
- [ ] Container-based execution profiles for stronger isolation
- [ ] Community-contributed role and provider packs
- [ ] Expanded local-model benchmarking and hardware guidance

## Version 0.4 — Team and enterprise workflows

**Focus:** Scale, audit, and administrative controls.

- [ ] Multi-project orchestration
- [ ] Persistent task queues and backlog processing
- [ ] Team role-based access control
- [ ] Tamper-evident audit storage
- [ ] Provider SLA and spend monitoring
- [ ] SSO and team authentication integration
- [ ] Compliance deployment guidance

## Version 1.0 — Stable API

**Focus:** Long-term compatibility and ecosystem growth.

- [ ] Stable, versioned public APIs
- [ ] Backward-compatible configuration migrations
- [ ] Extensive live-provider integration testing
- [ ] Published performance and reliability benchmarks
- [ ] Official npm, Homebrew, and container distributions
- [ ] Upstream or extension-based replacement for the OpenCode source patch

## How to influence the roadmap

Open an issue describing the use case, safety constraints, expected behavior, and evidence that would prove completion. The roadmap is a living document; reliability and security issues take priority over adding more agent roles.
