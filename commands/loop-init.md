---
agent: orchestrator
description: >
  Initialize a repository for use with the global agent loop. Inspects the
  current repository, detects languages, frameworks, build/test/lint
  commands, and security-sensitive areas. Creates or updates the project's
  AGENTS.md with project-specific instructions.
---

# /loop-init — Initialize a repository for the agent loop

Prepare a new repository for use with the global agent loop by creating a project-specific AGENTS.md.

## Usage

```
/loop-init
```

## What the orchestrator must do

1. **Inspect the repository** to detect:
   - Languages and frameworks (Node.js, Python, Go, Rust, Java, etc.)
   - Package managers (npm, pip, poetry, cargo, go mod, bundler, etc.)
   - Build commands (from package.json scripts, Makefile targets, build.gradle, etc.)
   - Test commands (from package.json, pytest config, Cargo.toml, go test patterns, etc.)
   - Lint commands (from package.json, .eslintrc, .golangci.yml, etc.)
   - Type-check commands (tsconfig, mypy, pyright, etc.)
   - Database and migration systems (look for migration files, ORM config)
   - UI testing tools (Playwright, Cypress, Selenium, etc.)
   - CI configuration (.github/workflows/, .gitlab-ci.yml, Jenkinsfile)
   - Generated files and directories (build/, dist/, target/, node_modules/, etc.)
   - Security-sensitive areas (auth, tokens, encryption, payments, etc.)
   - Existing commit conventions (from git log)
   - Docker configuration (Dockerfile, docker-compose.yml)
   - Monorepo structure (workspaces, subprojects)

2. **Inspect any existing AGENTS.md** — preserve useful existing instructions.

3. **Create or update AGENTS.md** with project-specific instructions:
   - Project overview and repository structure
   - Languages and frameworks
   - Setup commands
   - Build commands
   - Test commands (targeted and full suite)
   - Lint and type-check commands
   - Database and migration conventions
   - Security-sensitive areas that agents should flag
   - Generated files and directories to exclude from commits
   - Files that should not be modified
   - Documentation requirements
   - UI validation requirements
   - Definition of done
   - Commit conventions
   - How to use /feature for autonomous work

4. **Present the proposed AGENTS.md** before replacing an existing file.

5. **Do not commit** unless explicitly requested.

6. **Do not modify application code.**

7. **Do not insert machine-specific paths or secrets.**

## Template sections

The generated AGENTS.md should include these sections when relevant information is discovered:

```
# <Project Name> — OpenCode Agent Instructions

## Architecture

<Repository structure overview>

## Setup

<Setup commands>

## Build

<Build commands>

## Test

<Test commands> (targeted and full suite)

## Lint and type-check

<Lint and type-check commands>

## Database and migration conventions

<Migration conventions>

## Security-sensitive boundaries

<Areas agents should flag>

## Generated files

<Files/directories to exclude>

## Files/directories that should not be modified

<Protected files>

## Documentation requirements

<Documentation expectations>

## UI validation requirements

<UI testing expectations>

## Definition of done

<Acceptance criteria>

## Commit conventions

<Commit message style>

## Using the agent workflow

/feature <description>
```
