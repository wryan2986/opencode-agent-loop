# OpenCode Agent Loop

[![Project Status](https://img.shields.io/badge/status-pre--release-yellow?style=for-the-badge)](https://github.com/opencode-ai/opencode-agent-loop)

A reusable OpenCode agent-loop package for autonomous feature development in any software project.

The agent-loop provides a complete feature lifecycle: plan → approve → test → build → verify → review → fix → escalate → commit, with automatic model routing and failover across multiple providers.

---

## 🚀 Quick Start (5 minutes)

1. **Clone the repository**
   ```bash
   git clone https://github.com/opencode-ai/opencode-agent-loop.git
   cd opencode-agent-loop
   ```

2. **Install the package**
   ```bash
   bash scripts/install.sh
   ```

3. **Activate for your shell**
   ```bash
   source ~/.bashrc  # or ~/.zshrc
   ```

4. **Initialize your project**
   ```bash
   cd /path/to/your/project
   opencode
   /loop-init
   ```

5. **Run a feature**
   ```bash
   opencode
   /feature Implement user authentication system
   ```

---

## 🏗️ Architecture

The agent-loop implements a complete feature development lifecycle with six specialized agents working in sequence:

```
                                   User request
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         Free-First Router                           │
│                  Model selection and failover                       │
│                                                                     │
│  Reads: config/free-first-pools.json                                │
│  Uses:  config/model-registry.json                                  │
│  Tries free models first, then falls back to paid models            │
└──────────────────────────────────┬──────────────────────────────────┘
                                   │ Selects a model for each role
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                           Orchestrator                              │
│                       DeepSeek V4 Flash                             │
│               Plans, delegates, and enforces stages                 │
└────────────┬────────────┬────────────┬────────────┬─────────────────┘
             │            │            │            │
             ▼            ▼            ▼            ▼             ▼
      ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐
      │    Test    │ │   Build    │ │   Review   │ │  Escalate  │ │  Recover   │
      │            │ │            │ │            │ │            │ │            │
      │ Free Pool  │ │ Free Pool  │ │ Free Pool  │ │ GPT-5.6 L  │ │ Paid DS Fl │
      └────────────┘ └────────────┘ └────────────┘ └────────────┘ └────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                         Model Registry                              │
│                  config/model-registry.json                         │
│                                                                     │
│  79 models across 5 providers                                      │
│  Capability scores, privacy classifications, and cooldowns          │
└─────────────────────────────────────────────────────────────────────┘
```PLANNING
│ Inspect repository, discover commands, produce plan
▼
AWAITING_APPROVAL
│ User reviews and approves the plan
▼
BASELINE_TESTING
│ Test agent establishes baseline metrics
▼
IMPLEMENTING
│ Build agent implements the requested feature
▼
VERIFYING
│ Test agent verifies implementation quality
▼
REVIEWING
│ Review agent inspects diff and quality gates
   ├── PASS ──► READY_TO_COMMIT
   │
   └── FAIL ──► FIXING (back to IMPLEMENTING, max 2 cycles)
         │
         └── 2 failures ──► ESCALATING
               │
               ▼
         (back to BASELINE_TESTING)
```

---

## 🎯 Commands

| Command | Description |
|---------|-------------|
| `/feature <description>` | Run the full agent workflow for a new feature |
| `/loop <description>` | Run the `agent_loop` custom tool through the orchestrator |
| `/loop-init` | Initialize a repository for agent-loop automation |

---

## 📁 Project Structure

```
opencode-agent-loop/
├── agents/              # Agent definitions (6 active agents)
├── commands/            # Slash commands for OpenCode TUI
├── config/              # Model routing configuration
│   ├── model-registry.json    # 79 models with capability scores
│   ├── free-first-pools.json # Ordered model pools per role
│   └── free-first-config.json # Global failover settings
├── lib/                 # Routing library modules
├── runtime/             # Node runtime controller and failover entry
├── .opencode/          # Project-local plugin and /loop command
│   ├── failover-handler.mjs    # Retry, cooldown, checkpointing
│   ├── paid-fallback.mjs        # Paid escalation controller
│   ├── privacy-classifier.mjs    # Task sensitivity classification
│   └── ntfy-enhancer.mjs       # Paid-fallback notifications
├── skills/             # Reusable skills
├── templates/          # Project template files
├── docs/               # Documentation
│   ├── agent-roles.md
│   ├── configuration.md
│   ├── safety-model.md
│   └── tui-agent-loop-integration.md
├── tests/              # Automated tests
│   ├── routing-tests.mjs         # Failover scenario tests
│   ├── runtime-tests.mjs         # Production runtime tests
│   ├── tool-integration-tests.mjs # agent_loop tool integration
│   └── bypass-detection.mjs     # Direct production tests
├── scripts/            # Utility scripts
│   ├── install.sh
│   ├── uninstall.sh
│   ├── validate.sh
│   ├── smoke-test.sh
│   └── activation-gate.sh
├── opencode.json       # Global configuration
├── CHANGELOG.md        # Release history
├── CONTRIBUTING.md     # Contribution guidelines
├── SECURITY.md         # Security reporting policy
└── LICENSE             # MIT License
```

---

## 📖 Documentation


- [Agent Roles](docs/agent-roles.md) - Detailed descriptions of each agent's responsibilities
- [Configuration Guide](docs/configuration.md) - How to configure model routing and failover
- [Safety Model](docs/safety-model.md) - Safety features and protections
- [TUI Integration](docs/tui-agent-loop-integration.md) - How the agent_loop tool integrates with OpenCode TUI

---

## 🤝 Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on how to report bugs, suggest features, and submit pull requests.


---

## 🛡️ Security


If you discover a security vulnerability, please review our [SECURITY.md](SECURITY.md) file for reporting instructions.


---

## 📜 License


Distributed under the MIT License. See [LICENSE](LICENSE) for more information.


---


*This is a pre-release version. Features and APIs may change without backward compatibility guarantees until v1.0.0.*