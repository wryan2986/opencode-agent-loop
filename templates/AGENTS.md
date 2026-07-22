# <Project Name> — OpenCode Agent Instructions

## Architecture

<Overview of the repository structure and architecture>

```
/ <project-root>
├── src/            Source code
├── tests/          Test files
├── docs/           Documentation
└── ...
```

## Setup

```
<setup commands>
```

## Build

```
<build commands>
```

## Test

Use targeted test scripts matching the changed area:

| Area | Command |
|------|---------|
| <area> | `<command>` |
| <area> | `<command>` |
| Full suite | `<full test command>` |

## Lint and type-check

```
<lint command>
<type-check command>
```

## Database and migration conventions

<Migration rules, patterns, and conventions>

## Security-sensitive boundaries

Flag these when they appear in any diff:

- **Authentication**: login, registration, sessions, tokens, passwords
- **Authorization**: access control, role-based permissions, data scoping
- **Secrets**: API keys, encryption keys, database credentials, environment variables
- **Database migrations**: append-only, never rewrite, safe rollback
- **External integrations**: third-party APIs, webhooks, OAuth flows
- **File uploads**: validation, storage, access control
- **Background sync**: scheduled tasks, job queues
- **Destructive operations**: deletion, cleanup, reset

## Generated files

- `<generated directory>` — never commit
- `<generated file patterns>` — never commit

## Files/directories that should not be modified

- `<protected paths>` — explain why

## Documentation requirements

- Update docs when behavior, configuration, APIs, or workflows change.
- <additional project-specific requirements>

## UI validation requirements

- <UI testing tools and expectations>

## Definition of done

A feature is done when:

1. Acceptance criteria are met.
2. Focused tests pass.
3. Related module or integration tests pass.
4. No regressions introduced.
5. Independent review passes (no Critical or High issues).
6. Tests exist for new behavior.
7. Documentation is updated where applicable.
8. Commit is made — no push.

## Commit conventions

<Commit message style>

## Using the agent workflow

```
/feature <description of the work>
```

The orchestrator agent handles the full lifecycle. See the OpenCode agent-loop documentation for details.

## Agent workflow practices

### Orchestrator role
The orchestrator is a **project coordinator, not a task completer**. It does not write code or run tests. It:
- Builds a dependency DAG of work items before scheduling
- Delegates all implementation to build-workers
- Delegates all testing to the test agent
- Delegates all reviews to the review agent
- Parallelizes aggressively within each DAG level

### Parallel i18n pattern
When adding new i18n strings across many locale files simultaneously:
1. Use the **collector pattern**: each worker writes additions to a temp file
2. The orchestrator merges temp files into each locale file after all workers complete
3. Temp files are cleaned up after merge

### Pre-flight checks
- **API audit**: Before frontend work, verify backend endpoints exist
- **Seed data**: Create reproducible test data early if it doesn't exist
- **Health check**: Discover server health endpoint for lifecycle management

See the agent role files in the agent-loop system for detailed per-agent instructions.
