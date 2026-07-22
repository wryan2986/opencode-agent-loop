# Design Decisions

## Why Free-First (Now Paid-Primary)?
Originally, the system used free-tier models to minimize costs. After experiencing frequent rate limits and availability issues with free tiers, the default was changed to paid-primary routing with free models as fallback. Users can configure either mode.

## Why YAML-like Frontmatter Instead of JSON?
Agent definitions use Markdown files with YAML-like frontmatter because:
- OpenCode natively supports this format
- It allows long-form instructions in the body
- Easy to read and edit
- Frontmatter is machine-parseable

## Why a Custom Runtime Instead of Pure OpenCode?
Some features cannot be expressed in OpenCode alone:
- Multi-model failover at the pool level
- Task state checkpointing between model switches
- Provider-wide cooldown management
- Privacy-classification-based model filtering
- Deterministic test execution

The runtime controller provides these capabilities without modifying OpenCode.

## Why Agent-Specific Permissions?
Each agent has minimal permissions for its role. This reduces the blast radius if an agent produces incorrect output. The review agent is read-only, build workers cannot commit, and most agents cannot make web requests.

## Why Separate Agent Files?
Each agent has its own `.md` file with instructions and permissions. This allows:
- Independent model assignment per role
- Granular permission control
- Easy addition of new agent types
- Clear separation of concerns

## Why Two Command Paths (/feature and /loop)?
- `/feature` uses the orchestrator agent directly with task tool delegation
- `/loop` uses the agent_loop custom tool and Node runtime controller

The two paths converge on the same runtime execution but have different dispatch mechanisms. /feature is simpler; /loop provides more control.