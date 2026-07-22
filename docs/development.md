# Development Guide

## Prerequisites

- Node.js 18+
- OpenCode 1.17.x
- npm

## Setup

```bash
git clone <repository-url>
cd opencode-agent-loop
npm install
```

## Project Structure

```
opencode-agent-loop/
├── agents/                  Agent definition files (.md with frontmatter)
├── commands/                OpenCode slash commands
├── config/                  Model routing configuration
├── lib/                     Core library modules
├── runtime/                 Runtime controller and executor
├── scripts/                 Shell scripts for install/validate
├── tests/                   Automated test suite
├── docs/                    Documentation
├── skills/                  Reusable OpenCode skills
└── templates/               Project template files
```

## Testing

```bash
# Run all tests
npm test

# Run individual test suites
node tests/routing-tests.mjs
node tests/runtime-tests.mjs
node tests/tool-integration-tests.mjs
node tests/bypass-detection.mjs
```

## Validation

```bash
# Smoke test the installation
bash scripts/validate.sh

# Check agent configuration
bash scripts/validate-agent-configs.sh
```

## Adding an Agent

1. Create an agent file in agents/ with frontmatter:
   - mode: subagent
   - model: <provider/model-id>
   - temperature: 0.1-0.2
   - steps: <max steps>
   - description: Brief role description
   - permission: tool access controls

2. Add the agent to the orchestrator's allowed task types
3. Register the agent in opencode.json if needed
4. Add model entries to free-first-pools.json if needed
5. Add the model to model-registry.json if new
6. Test with a small task

## Adding a Command

1. Create a .md file in commands/ with frontmatter:
   - agent: orchestrator
   - description: What the command does

2. The command body is passed to the orchestrator as the task description

## Code Style

- JavaScript: ES modules (import/export)
- Use const/let, not var
- Async/await for asynchronous operations
- JSDoc comments for exported functions
- Follow existing patterns in lib/ and runtime/