# OpenCode Agent Loop

A standalone, reusable OpenCode agent-loop package for autonomous feature development in any software project.

This package now includes a real OpenCode TUI integration: chat with the primary orchestrator normally, and for development work it calls the `agent_loop` custom tool. The tool invokes the Node runtime, which routes delegated worker tasks through centralized failover and launches workers with explicit `opencode run --agent ... --model ...` invocations.

## Architecture

Six reusable agents implement a complete feature lifecycle: plan → approve → test → build → test → review → fix → escalate → commit.

The system uses a **free-first cloud routing** layer with automatic failover across 5 connected providers (OpenCode Zen, Cerebras, Groq, NVIDIA, OpenRouter).

```
User request
     │
     ▼
┌──────────────────────────────────────┐
│  Free-First Router                    │  Reads config/free-first-pools.json
│  (model selection + failover)         │  Tries free → paid fallback
└──────────┬───────────────────────────┘
           │ selects model for each role
           ▼
┌──────────────────────────┐
│  Orchestrator             │  DeepSeek V4 Flash (paid orchestrator)
│  (primary)                │  Plans, delegates, enforces stages
└───────┬──────────────────┘
        │ delegates to
   ┌────┼────┬────┬────┬────┐
   │    │    │    │    │    │
   ▼    ▼    ▼    ▼    ▼    ▼
┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐
│test│ │bld │ │rev │ │esc │ │rec │
│Free│ │Free│ │Free│ │GPT5│ │Paid│
│Pool│ │Pool│ │Pool│ │.5  │ │DS  │
└────┘ └────┘ └────┘ └────┘ └────┘
  │       │      │       │      │
  └──┬────┘      │       │      │
     │    ┌──────┘       │      │
     │    │    ┌─────────┘      │
     │    │    │    ┌───────────┘
     ▼    ▼    ▼    ▼
┌──────────────────────────────┐
│  Model Registry               │  79 models, 5 providers
│  config/model-registry.json   │  Capability scores, privacy, cooldown
└──────────────────────────────┘
```

## Model routing

The system uses **paid-primary cloud routing** with ordered failover. Each role has a pool of models tried in sequence: paid models first, then free fallback only when all paid options are exhausted.

| Agent | Primary (Paid) | Pool File Reference |
|-------|---------------|---------------------|
| orchestrator | `opencode-go/deepseek-v4-flash` | `config/free-first-pools.json` → orchestrator pool |
| test-fixer | `opencode-go/deepseek-v4-flash` | `config/free-first-pools.json` → test-fixer pool |
| build-worker | `opencode-go/deepseek-v4-flash` | `config/free-first-pools.json` → builder pool |
| reconcile | `opencode-go/deepseek-v4-flash` | Direct assignment (paid) |
| review | `opencode-go/mimo-v2.5` | `config/free-first-pools.json` → reviewer pool |
| escalation | `opencode-go/deepseek-v4-flash` | Direct assignment (paid) |

Pools are defined in `config/free-first-pools.json` and support automatic failover across providers when a model is rate-limited, cooldowned, or unavailable.

### Key principles

- **Paid-primary**: Each role tries paid models from multiple providers before attempting free fallback.
- **Provider diversity**: No provider is a single point of failure; models from different providers back each other up.
- **Cooldown management**: Models that fail (429, 503, timeout) are placed in cooldown for configurable durations.
- **Task state preservation**: Before switching models, task state is checkpointed so the new model can continue seamlessly.
- **Privacy-aware routing**: Sensitive tasks exclude models from providers with unsuitable data policies.

## Installation

```bash
# Clone or copy the package
cd opencode-agent-loop

# Run the installer
bash scripts/install.sh

# Activate for the current shell
source ~/.bashrc  # or ~/.zshrc
```

The installer adds `OPENCODE_CONFIG_DIR` to your shell configuration, pointing OpenCode to this package.

## Validation

```bash
bash scripts/validate.sh
```

## Initialize a project

```bash
cd /path/to/your/project
opencode
```

Then in the OpenCode TUI:

```
/loop-init
```

This analyzes your repository and creates or updates `AGENTS.md` with project-specific instructions.

## Run a feature

```bash
cd /path/to/your/project
opencode
```

Then in the OpenCode TUI:

```
/feature <description>
```

Example:

```
/feature Implement user profile editing
```

## Run the agent_loop tool

Open the project:

```bash
opencode
```

Then chat normally with the orchestrator:

```text
Audit the recipe import flow, fix any defects, run the relevant tests, and review the result.
```

Or explicitly force the tool path:

```text
/loop Audit the entire settings section and fix broken functionality
```

Both normal orchestrator delegation and `/loop` use the same `agent_loop` custom tool and Node runtime. See `docs/tui-agent-loop-integration.md` for the execution path, configuration, paid fallback policy, logs, tests, and limitations.

## Workflow stages

```
PLANNING
│ Inspect repository, discover commands, produce plan
▼
AWAITING_APPROVAL
│ User reviews and approves the plan
▼
BASELINE_TESTING
│ Test agent (DeepSeek V4 Flash) establishes baseline
▼
IMPLEMENTING
│ Build worker (DeepSeek V4 Flash) implements the change
▼
VERIFYING
│ Test agent (DeepSeek V4 Flash) verifies implementation
▼
REVIEWING
│ Review agent (MiMo V2.5) inspects diff
│ 
├── PASS ──► READY_TO_COMMIT
│
└── FAIL ──► FIXING (back to IMPLEMENTING, max 2 cycles)
│
└── 2 failures ──► ESCALATING (DeepSeek V4 Flash)
│
▼
(back to BASELINE_TESTING)
```

## Configuration precedence

1. **OPENCODE_CONFIG_DIR** — This package's agents/ and commands/ are available globally.
2. **Project AGENTS.md** — Each project's root `AGENTS.md` supplies project-specific instructions that agents read at runtime.
3. **Project .opencode/** — Project-level overrides for agents, commands, and opencode.json when genuinely needed. Use sparingly.

If a project has both global and local agents with the same name, the local one wins.

## Limitations

- Workflow stages are prompt-enforced unless a deterministic plugin is added.
- Retry counters depend on orchestrator session state.
- `/feature` requires the interactive OpenCode TUI; `opencode run` does not execute project slash commands.
- The loop handles one primary task at a time.
- Persistent queues, backlog processing, and unattended batch runs are outside this package.

## Uninstall

```bash
bash scripts/uninstall.sh
```

This removes the `OPENCODE_CONFIG_DIR` export from your shell config. It does not delete the package or project AGENTS.md files.

## Commands

| Command | Description |
|---------|-------------|
| `/feature <desc>` | Run the full agent workflow |
| `/loop <desc>` | Run the `agent_loop` custom tool through the orchestrator |
| `/loop-init` | Initialize a repository for the agent loop |

## Project structure

```
opencode-agent-loop/
├── agents/               Agent definitions (6 active + 3 disabled Qwythos)
├── commands/             Slash commands
├── config/               Free-first routing configuration
│   ├── model-registry.json   79 models from 5 providers with scores
│   ├── free-first-pools.json Ordered model pools per role
│   └── free-first-config.json Global failover, cooldown, privacy settings
├── lib/                  Routing library modules
├── runtime/              Node runtime controller, failover entry, OpenCode adapter
├── .opencode/            Project-local plugin and /loop command
│   ├── failover-handler.mjs  Retry, cooldown, checkpointing
│   ├── paid-fallback.mjs     Paid escalation controller
│   ├── privacy-classifier.mjs Task sensitivity classification
│   └── ntfy-enhancer.mjs     Paid-fallback notifications
├── skills/               Reusable skills
├── templates/            Project template files
├── tests/                Automated routing tests
│   ├── routing-tests.mjs     24 mocked failover scenarios
│   ├── runtime-tests.mjs     Production runtime/failover scenarios
│   ├── tool-integration-tests.mjs  agent_loop tool to runtime smoke
│   └── bypass-detection.mjs  Fails direct production OpenCode invocations
├── scripts/              Installation, validation, activation
│   ├── install.sh
│   ├── uninstall.sh
│   ├── validate.sh
│   ├── smoke-test.sh
│   └── activation-gate.sh    Pre-activation checks
├── opencode.json         Global configuration
├── README.md             This file
├── CHANGELOG.md          Release history
└── LICENSE               License
```

## License

MIT
