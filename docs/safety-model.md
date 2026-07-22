# Safety Model

## Overview

OpenCode Agent Loop combines workflow gates, role separation, command permissions, privacy-aware routing, and validation checks. These controls reduce risk but do not constitute an operating-system sandbox.

## Permission model

Agent permissions are declared in frontmatter. Shell commands, including Git commands, must be controlled through explicit `bash` patterns.

```yaml
permission:
  edit: deny
  webfetch: deny
  task: deny
  bash:
    "*": deny
    "git status*": allow
    "git diff*": allow
    "git log*": allow
    "git push*": deny
    "git reset*": deny
    "git clean*": deny
```

Do not rely on an undocumented standalone `git:` permission block. The effective restrictions must apply to the shell commands agents can actually execute.

## Role separation

| Role | Edit | Web | Delegate | Commit | Push |
|------|------|-----|----------|--------|------|
| Orchestrator | No | No | Yes | Yes | No |
| Build worker | Yes | No | No | No | No |
| Test agent | Test files only | No | No | No | No |
| Review agent | No | No | No | No | No |
| Explore agent | No | No | No | No | No |
| Reconcile agent | Yes | No | No | No | No |
| Escalation agent | Yes | With explicit policy | No | No | No |

The builder must never approve its own work. Test and review must independently pass before the orchestrator commits.

## Git restrictions

Agents must not run destructive or remote-changing Git commands unless the project explicitly changes the policy and the user approves it. Denied commands include:

- `git push`
- `git reset`
- `git clean`
- `git checkout`
- `git restore`
- history rewriting or force operations

Command rules should use wildcard suffixes so options and arguments cannot bypass exact-string checks.

## Privacy safeguards

- Tasks are classified as normal, sensitive, local-only, or trusted-provider-only.
- Sensitive tasks exclude models that disallow sensitive code.
- Local-only tasks remain on approved local models.
- Credentials, tokens, private keys, `.env` files, and production data must not be printed or committed.
- Runtime logs and issue reports must be sanitized before sharing.

Provider policies can change. Registry labels are configuration hints, not legal guarantees. Confirm current provider terms before routing confidential code.

## Workflow safeguards

- explicit plan approval
- baseline testing before implementation
- independent verification and review after changes
- limited fix cycles before escalation
- state-transition validation
- checkpointing for interrupted work
- final staged-diff and secret inspection
- no automatic push

## Limitations

- Prompt instructions can be misunderstood or ignored by a model.
- Command-pattern permissions can have gaps if patterns are incomplete.
- The package does not isolate processes, networks, or filesystems at the OS level.
- Provider availability and data handling are external dependencies.
- A patched OpenCode build is currently required for reliable subagent failure reporting.

## Recommended deployment

For meaningful or untrusted work:

1. run the target repository in a disposable container or VM
2. mount only required directories
3. use least-privilege credentials
4. keep production secrets outside the workspace
5. review changes before push or deployment
6. enable repository branch protection and CI checks
7. periodically audit agent permissions and routing configuration
