# Safety Model

## Overview

The OpenCode Agent Loop implements multiple layers of safety controls to prevent accidental damage, data leakage, and unauthorized operations.

## Permission System

Each agent has a defined permission set in its frontmatter:

```yaml
permission:
  edit: deny          # Cannot modify files
  webfetch: deny      # Cannot make HTTP requests
  agent_loop: deny     # Cannot start another agent loop
  task: deny           # Cannot delegate to subagents
  bash: deny           # Cannot use shell commands
  git push: deny       # Cannot push to remotes
  git reset: deny      # Cannot rewrite history
  git: push: deny
  reset: deny
```

## Default Restrictions

Applied to all agents:

- **No git push**: Only the orchestrator can create commits; no agent can push
- **No history rewrite**: Reset, clean, checkout, restore are denied
- **No agent loop recursion**: Worker processes cannot start new loops
- **No web fetch**: Most agents cannot make external HTTP requests
- **Task delegation blocked**: Subagents cannot spawn further subagents

## Role-Based Access

| Agent | Edit | Web | Task | Commit | Push | Git Destructive |
|-------|------|-----|------|--------|------|-----------------|
| Orchestrator | ❌ | ❌ | ✅ | ✅ | ❌ | ❌ |
| Build worker | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Test agent | ✅¹ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Review agent | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Escalation | ✅ | ⚠️² | ❌ | ❌ | ❌ | ❌ |
| Reconcile | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Explore | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

¹ Test files only
² Requires user permission

## Privacy Safeguards

- **Task classification**: Tasks are classified as normal, sensitive, local-only, or trusted-provider-only before routing
- **Model filtering**: Sensitive tasks exclude models with unsuitable data policies
- **Local-only routing**: Local-only tasks only use models with `privacy_classification: trusted-provider-only`
- **No credential exposure**: Agents are instructed to never expose credentials, tokens, or secrets
- **Secret detection**: Staged changes are checked for .env files and credential patterns before commit

## Workflow Safeguards

- **Stage enforcement**: The orchestrator validates state transitions
- **Independent review**: Review agent is a separate model with read-only access
- **Dual verification**: Both test and review must pass before commit
- **Tiered escalation**: Max 2 fix cycles per tier before escalation
- **Interruption recovery**: State file allows resuming interrupted runs

## Limitations

- Safety depends on prompt enforcement (not deterministic code)
- No OS-level sandboxing for shell commands
- Path confinement relies on tool scoping
- Model providers have their own data policies

## Recommended Additional Safeguards

For production use, consider:

- Running in a container or VM
- Using read-only filesystem mounts
- Implementing approval gates for destructive operations
- Regular security audits of agent prompts and configurations