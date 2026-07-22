# OpenCode TUI Integration

OpenCode Agent Loop exposes two related entry points inside the OpenCode terminal UI.

## `/feature`

`/feature <description>` starts the full orchestrated lifecycle. The orchestrator inspects the repository, creates acceptance criteria and a dependency-aware plan, waits for approval, then delegates implementation and independent verification.

Use `/feature` for normal feature, bug-fix, refactor, migration, and documentation work.

## `/loop`

`/loop <description>` invokes the `agent_loop` custom tool through the runtime controller. It is useful for direct runtime testing, diagnostics, and workflows that need the centralized failover controller.

## Plugin registration

The package registers `.opencode/plugins/agent-loop.js` from `opencode.json`. The plugin exposes the `agent_loop` tool and calls `runtime/agent-loop-controller.mjs`.

Worker processes are protected by the `AGENT_LOOP_CHILD` recursion guard and cannot start another complete agent loop.

## Project initialization

Run `/loop-init` from the target repository. The command installs or prepares the project-specific files required by the loop, including an `AGENTS.md` template where appropriate.

Agents read the target project's `AGENTS.md` before performing work. Put repository-specific build commands, test commands, security boundaries, generated-file rules, and architectural conventions there.

## Failure reporting

The current pre-release depends on patched OpenCode behavior that surfaces subagent task failures to the caller. Without that patch, a provider failure may be returned as a successful task-tool call and the orchestrator cannot reliably trigger failover.

See [Required OpenCode Fork](opencode-fork.md).

## Troubleshooting

Verify that the package is active:

```bash
printf '%s\n' "$OPENCODE_CONFIG_DIR"
opencode agent list
```

Then validate the repository:

```bash
npm run validate
```

When reporting a problem, include sanitized logs, OpenCode version, Node.js version, operating system, failed role, and attempted model IDs. Never include credentials or private source code unless the recipient is authorized to receive it.
