# OpenCode Agent Loop

[![Project Status](https://img.shields.io/badge/status-pre--release-yellow?style=for-the-badge)](https://github.com/wryan2986/opencode-agent-loop)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A reusable OpenCode agent-loop package for structured feature development with specialized planning, building, testing, review, recovery, and local agents.

> **Independent project:** OpenCode Agent Loop is a community project. It is not built, maintained, or endorsed by the OpenCode team.

The workflow is:

`plan → approve → baseline test → build → verify → review → fix/escalate → commit`

The orchestrator uses a paid DeepSeek model for reliable coordination. Subagent roles use free-first model pools with automatic provider failover and controlled paid fallback.

## Important prerequisite

This pre-release currently requires a **patched OpenCode build**. Stock OpenCode does not expose every subagent failure signal required by the orchestrator's failover logic.

Read [Required OpenCode Fork](docs/opencode-fork.md) before installation. The loop may incorrectly treat failed subagent work as successful without the patch.

## Quick start

### 1. Prepare the patched OpenCode build

Follow [docs/opencode-fork.md](docs/opencode-fork.md), place the resulting `opencode` executable in your `PATH`, and verify it:

```bash
opencode --version
```

### 2. Clone this repository

```bash
git clone https://github.com/wryan2986/opencode-agent-loop.git
cd opencode-agent-loop
```

### 3. Install the package

```bash
bash scripts/install.sh
```

### 4. Activate it in the current shell

```bash
source ~/.bashrc  # or ~/.zshrc
```

### 5. Initialize a project

```bash
cd /path/to/your/project
opencode
/loop-init
```

### 6. Run a feature

```text
/feature Implement user authentication
```

## Architecture

```text
              User request
                   |
                   v
+--------------------------------------+
| Orchestrator                         |
| Paid DeepSeek V4 Flash               |
| Plans, delegates, enforces stages    |
+--------------------------------------+
                   |
                   v
+--------------------------------------+
| Free-first role routing              |
| Test, build, review, explore         |
| Free models -> controlled fallback   |
+--------------------------------------+
                   |
                   v
+--------------------------------------+
| Model registry and role pools        |
| Capability, privacy, cooldown state  |
+--------------------------------------+
```

The routing configuration lives in:

- `config/free-first-config.json` — global routing and fallback policy
- `config/free-first-pools.json` — ordered model pools by role
- `config/model-registry.json` — capabilities and privacy classifications

See [Architecture](docs/architecture.md) and [Configuration](docs/configuration.md) for details.

## Commands

| Command | Description |
|---------|-------------|
| `/feature <description>` | Run the staged feature workflow through the orchestrator |
| `/loop <description>` | Run the `agent_loop` custom tool directly |
| `/loop-init` | Add the project-specific agent-loop files to a repository |

## Project structure

```text
opencode-agent-loop/
├── agents/              Agent definitions
├── commands/            OpenCode slash commands
├── config/              Routing and model configuration
├── lib/                 Routing and failover modules
├── runtime/             Runtime controller and worker execution
├── .opencode/           Plugin and project-local command integration
├── skills/              Reusable project-analysis skills
├── templates/           Files installed into target projects
├── docs/                Architecture, configuration, safety, and usage
├── tests/               Deterministic automated tests
├── scripts/             Install, validation, and maintenance utilities
├── opencode.json        Package-level OpenCode configuration
├── CHANGELOG.md         Release history
├── CONTRIBUTING.md      Contribution guidelines
├── SECURITY.md          Vulnerability-reporting policy
└── LICENSE              MIT License
```

## Safety model

The package applies several layers of protection:

- explicit approval before implementation
- baseline and post-change testing
- independent read-only review
- no automatic push
- explicit Bash denials for destructive Git commands
- recursion guards for worker agents
- privacy-aware model filtering
- state checkpoints for interrupted work

Prompt and permission controls are not an OS sandbox. Use a container or VM for untrusted repositories. See [Safety Model](docs/safety-model.md).

## Validation

```bash
npm ci
npm test
bash scripts/validate.sh
node scripts/check-doc-links.mjs
```

## Documentation

- [Architecture](docs/architecture.md)
- [Agent Roles](docs/agent-roles.md)
- [Configuration](docs/configuration.md)
- [Model Providers](docs/providers.md)
- [Safety Model](docs/safety-model.md)
- [Required OpenCode Fork](docs/opencode-fork.md)
- [TUI Integration](docs/tui-agent-loop-integration.md)
- [Roadmap](docs/roadmap.md)

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening an issue or pull request.

## Security

Do not report vulnerabilities in public issues. Follow [SECURITY.md](SECURITY.md).

## License

Distributed under the MIT License. See [LICENSE](LICENSE).

---

This is a pre-release project. Features and APIs may change before v1.0.0.