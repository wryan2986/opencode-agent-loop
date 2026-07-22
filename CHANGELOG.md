# Changelog

## 1.0.0 (2026-06-28)

Initial release of the standalone OpenCode Agent Loop package.

### Features

- Six reusable agents with explicit model routing:
  - **orchestrator**: DeepSeek V4 Flash — plans, delegates, enforces workflow stages
  - **test**: DeepSeek V4 Flash — baseline and verification testing
  - **build-worker**: DeepSeek V4 Flash — implementation
  - **review**: MiMo V2.5 — independent read-only code review
  - **escalation**: GPT-5.5 with medium reasoning — stalled task recovery
  - **reconcile**: DeepSeek V4 Flash — conflict resolution
- `/feature` command — autonomous feature workflow with full life cycle
- `/loop-init` command — repository initialization for the agent loop
- Project analysis skill for detecting languages, frameworks, and build systems
- Template AGENTS.md for new project setup
- Installation, uninstallation, validation, and smoke-test scripts
- Least-privilege permission boundaries
- No automatic push policy
- Destructive Git command denial

## 2.0.0 (2026-07-03)

Free-first cloud routing with multi-provider failover, model capability registry, and paid-fallback controls.

### Features

- **Free-first cloud routing** across 5 providers: OpenCode Zen, Cerebras, Groq, NVIDIA, OpenRouter
- **Model capability registry** (`config/model-registry.json`) with 79 models scored for coding, orchestration, review, and debugging
- **Role-based model pools** (`config/free-first-pools.json`) with ordered failover (free → OpenRouter → Qwythos → paid)
- **Failover handler** (`lib/failover-handler.mjs`) with exponential backoff, jitter, cooldown management, and task state checkpointing
- **Paid fallback controller** (`lib/paid-fallback.mjs`) with configurable limits, role whitelist, and escalation logging
- **Privacy-aware routing** (`lib/privacy-classifier.mjs`) — classifies tasks as normal/sensitive/local-only/trusted-provider-only
- **Ntfy notification enhancer** (`lib/ntfy-enhancer.mjs`) — notifies on paid fallback, provider exhaustion, credential errors
- **24 automated routing tests** (`tests/routing-tests.mjs`) — all pass, uses mocks only
- **Activation gate** (`scripts/activation-gate.sh`) — validates all requirements before enabling free-first routing
- **Qwythos local model staged** — 3 disabled agents (explore, test-fixer, review) pending GPU audit

### Model classification

Free models from each provider classified as:

| Source | Recurring Free | Promotional Free | Paid |
|--------|---------------|-----------------|------|
| OpenCode Zen | 0 | 5 | 12 |
| Cerebras | 3 | 0 | 0 |
| Groq | 14 | 0 | 0 |
| NVIDIA | 17 | 0 | 4 |
| OpenRouter | 0 | 23 | 0+ |
| **Total** | **34** | **28** | **17** |

### Agent updates

All 6 agent files updated with free-first routing instructions (failover, checkpointing, privacy-aware model selection).

| Agent | Primary (Free) | Pool |
|-------|---------------|------|
| orchestrator | `opencode/deepseek-v4-flash-free` | orchestrator |
| build-worker | `opencode/deepseek-v4-flash-free` | builder |
| test | `opencode/deepseek-v4-flash-free` | test-fixer |
| review | `opencode/mimo-v2.5-free` | reviewer |
| escalation | `openai/gpt-5.5` | direct (paid) |
| reconcile | `opencode/deepseek-v4-flash-free` | direct (free) |

### Configuration

```
config/
├── model-registry.json       79 models, capability scores, privacy
├── free-first-pools.json     Role pools with ordered failover
└── free-first-config.json    Cooldowns, retry rules, privacy map
```

### Model assignments

| Agent | Model | Reasoning |
|-------|-------|-----------|
| orchestrator | `opencode/deepseek-v4-flash-free` | default |
| build-worker | `opencode/deepseek-v4-flash-free` | default |
| test | `opencode/deepseek-v4-flash-free` | default |
| review | `opencode/mimo-v2.5-free` | default |
| escalation | `openai/gpt-5.5` | medium |
| reconcile | `opencode/deepseek-v4-flash-free` | default |
