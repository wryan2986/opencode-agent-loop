# OpenCode Agent Loop

[![Project Status](https://img.shields.io/badge/status-v0.2.0--pre--release-yellow?style=for-the-badge)](https://github.com/wryan2986/opencode-agent-loop)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A reusable OpenCode agent-loop package for policy-constrained feature development with specialized planning, building, testing, independent review, recovery, and local agents.

> **Independent project:** OpenCode Agent Loop is a community project. It is not built, maintained, or endorsed by the OpenCode team.

`model proposes → policy validates → permitted worker executes → evidence is recorded`

The paid DeepSeek parent orchestrator retains judgment over planning, decomposition, validation strategy, risk, replanning, and user communication. Delegated workers use free-first model pools with retries, provider failover, local-model support, persistent budgets, structured events, controlled paid fallback, and one-time policy permits.

## Important prerequisite

This pre-release requires a **patched OpenCode build**. Stock OpenCode does not expose every subagent failure signal required for reliable failover.

Read [Required OpenCode Patch](docs/opencode-fork.md) before installation. A scheduled compatibility workflow verifies that the patch applies, builds, and retains its required source contracts against the configured upstream revision.

## Quick start

### 1. Prepare patched OpenCode

Follow [docs/opencode-fork.md](docs/opencode-fork.md), place the resulting executable on `PATH`, and verify it:

```bash
opencode --version
```

### 2. Install the agent loop

```bash
git clone https://github.com/wryan2986/opencode-agent-loop.git
cd opencode-agent-loop
bash scripts/install.sh
source ~/.bashrc  # or ~/.zshrc
```

Windows users should prefer WSL 2 or use Git Bash. See [Platform Support](docs/platforms.md).

### 3. Initialize a project

```bash
cd /path/to/your/project
opencode
/loop-init
```

### 4. Run a feature

```text
/feature Implement user authentication
```

## Hybrid orchestration architecture

```text
                 User request
                      |
                      v
+--------------------------------------------+
| Parent orchestrator                        |
| Plans, reasons, proposes risk + next action|
+--------------------------------------------+
                      |
                      v
+--------------------------------------------+
| Orchestration policy kernel                |
| Approval | Evidence | Risk | Permit | Hash |
+--------------------------------------------+
                      |
               one-time permit
                      |
                      v
+--------------------------------------------+
| agent_loop runtime                         |
| Retry | Route | Failover | Worker Budget   |
+--------------------------------------------+
                      |
                      v
+--------------------------------------------+
| Provider adapters and worker pools         |
| Free/local models -> controlled paid use   |
+--------------------------------------------+
                      |
                      v
+--------------------------------------------+
| Persistent state and structured events     |
| Policy | Budgets | Candidate | JSONL audit |
+--------------------------------------------+
```

The kernel is a referee, not the primary conductor. It does not choose the architecture, files, test commands, or next semantic step. It validates the model's proposed action and returns:

- `allow` — proceed, using the returned permit when applicable
- `needs_evidence` — gather evidence, replan, ask the user, or choose another legitimate action
- `deny` — stop or select a different legal action; do not bypass the decision

Policy modes support staged evaluation:

- `shadow` — observe what would be blocked without blocking it
- `invariants` — enforce non-negotiable safeguards; risk gates remain advisory
- `risk` — enforce invariants and risk-based minimum evidence; this is the default

See [Hybrid Orchestration Policy](docs/orchestration-policy.md).

Stable configuration lives in:

- `config/orchestration-policy.json` — policy mode, permits, risk signals, and minimum evidence
- `config/free-first-config.json` — routing, retry, timeout, budget, and event policy
- `config/free-first-pools.json` — ordered model pools by role
- `config/model-registry.json` — capabilities, privacy, retirement, and pricing metadata
- `config/orchestration-policy-schema.json` — orchestration policy schema
- `config/free-first-config-schema.json` — runtime policy schema
- `config/agent-loop-event.schema.json` — versioned event schema

See [Architecture](docs/architecture.md) and [Configuration](docs/configuration.md).

## Commands

| Command | Description |
|---------|-------------|
| `/feature <description>` | Run the full flexible policy-constrained workflow |
| `/loop <description>` | Run a compact policy-controlled workflow |
| `/loop-init` | Install project-specific agent-loop files |
| `npm run events -- --task <id>` | Query the local structured event log |

## Safeguards

- one stable task ID across policy, workers, failover, and budgets
- explicit approval recorded before implementation
- one-time action- and mode-bound worker permits
- low, medium, high, and critical risk evidence gates
- model-proposed risk that the kernel may elevate but never lower
- persistent token, cost, workflow-call, policy, and paid-use state
- terminal budget exhaustion with no replacement-ID bypass
- bounded paid parent orchestration turns
- same-model transient retries with exponential backoff and jitter
- provider adapters for identity, timeout, and error normalization
- append-only, versioned, recursively redacted event logs
- staged-candidate SHA-256 binding for final test, review, and commit
- policy-controlled commit with a final candidate-drift check
- portable state paths and cross-platform Node CI
- scheduled patched-OpenCode compatibility builds
- independent test and review gates before the final local commit

Budget dollar and token totals cover delegated workers. The parent orchestrator's precise token and dollar use is not available from OpenCode's plugin event surface, so results state that limitation explicitly.

## Project structure

```text
opencode-agent-loop/
├── agents/              Agent definitions
├── commands/            OpenCode slash commands
├── config/              Policy, pools, registry, and schemas
├── lib/                 Policy, routing, adapters, budgets, events, and failover
├── runtime/             Controller and worker execution
├── .opencode/           Plugin and project-local commands
├── skills/              Reusable project-analysis skills
├── templates/           Files installed into target projects
├── docs/                Architecture, operations, safety, and usage
├── examples/            Extension examples
├── tests/               Deterministic and integration tests
├── scripts/             Installation, validation, query, and maintenance tools
└── .github/workflows/   CI, release, compatibility, and platform matrices
```

## Safety model

The package requires explicit approval before implementation, routes workers through a policy- and budget-enforced runtime, runs independent testing and review, blocks automatic pushes, denies destructive Git commands, guards against recursion, and filters providers by privacy policy.

Prompt permissions, policy checks, and redaction are not an operating-system sandbox. Use a container or VM for untrusted repositories. See [Safety Model](docs/safety-model.md).

## Validation

```bash
npm ci
npm run validate
npm run validate:portable
```

The full command includes Bash permission checks. The portable command is exercised on Linux, macOS, and Windows.

## Documentation

- [Architecture](docs/architecture.md)
- [Agent Roles](docs/agent-roles.md)
- [Configuration](docs/configuration.md)
- [Hybrid Orchestration Policy](docs/orchestration-policy.md)
- [Provider Adapters](docs/provider-adapters.md)
- [Structured Event Logging](docs/event-logging.md)
- [Platform Support](docs/platforms.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Model Providers](docs/providers.md)
- [Safety Model](docs/safety-model.md)
- [Required OpenCode Patch](docs/opencode-fork.md)
- [TUI Integration](docs/tui-agent-loop-integration.md)
- [Roadmap](docs/roadmap.md)

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Report vulnerabilities privately according to [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).

---

This is a pre-release project. APIs and configuration may change before v1.0.0.
