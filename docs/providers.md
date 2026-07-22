# Model Providers

## Overview

The OpenCode Agent Loop supports multiple model providers for agent orchestration. Models are organized into role-based pools with ordered failover.

## Provider Configuration

Model providers are configured through two files:
1. `config/model-registry.json` — Model capabilities and metadata
2. `config/free-first-pools.json` — Role-to-model assignments

## Supported Providers

### opencode-go (Default Primary)

Paid models with zero-retention privacy policy.

| Model | Roles | Capabilities |
|-------|-------|-------------|
| deepseek-v4-flash | Orchestrator, Build, Test, Escalation | Coding: 9, Orchestration: 9, Debugging: 8 |
| mimo-v2.5 | Review, Reconcile, Trivial Builder | Review: 8, Coding: 8, Debugging: 7 |
| deepseek-v4-pro | Paid fallback | Coding: 9, Review: 9, Debugging: 9 |

### nvidia (Free Tier Fallback)

| Model | Roles | Notes |
|-------|-------|-------|
| mistral-large-3-675b | Review, Orchestrator fallback | Good review quality |
| mistral-small-4-119b | Build, Test fallback | Fast execution |
| llama-3.3-70b | Explore | Code search |
| kimi-k2.6 | Reconcile | Conflict resolution |
| qwen3-coder-480b | Build (currently disabled) | Good coding |

### cerebras (Free Tier Fallback)

| Model | Roles | Notes |
|-------|-------|-------|
| gpt-oss-120b | Build, Test, Review fallback | Fast inference |

### opencode (Free Tier Fallback)

| Model | Roles | Notes |
|-------|-------|-------|
| deepseek-v4-flash-free | Free fallback | Data may be used for improvement |
| mimo-v2.5-free | Free fallback | Promotional free tier |
| north-mini-code-free | Utility | Lightweight |

### openai (Paid Fallback)

| Model | Roles | Notes |
|-------|-------|-------|
| gpt-5.6-luna | Escalation primary | Medium reasoning |
| gpt-5.5 | Escalation fallback | Available as backup |

### Local Ollama 9B

Runs on local GPU (RX 580) for sensitive or offline tasks.

| Agent | Purpose |
|-------|---------|
| local-ollama-explore | Read-only exploration |
| local-ollama-test-fixer | Narrow test repair |
| local-ollama-review | Preliminary review |
| local-ollama-private-worker | Sensitive/local-only tasks |
| local-ollama-builder | Small-medium bounded changes |

## Privacy Classification

Models are classified by data-handling policy:

| Classification | Description | Sensitive Code |
|---------------|-------------|----------------|
| paid | Zero-retention, trusted provider | ✅ |
| trusted-provider-only | Contractual data protection | ✅ |
| promotional free | Limited time, data may be used | ❌ |
| data-used-for-improvement | Output used for training | ❌ |
| data-retained-for-improvement | Data retained for improvement | ❌ |
| trial-only-logged | Trial access, data logged | ❌ |
| local-private | Runs on local hardware | ✅ |

## Adding a Provider

1. Add model entry to config/model-registry.json
2. Add model pool entry to config/free-first-pools.json
3. Add provider timeout to config/free-first-config.json
4. Optional: Add provider-specific smoke test timeout