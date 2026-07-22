# Examples

This directory contains example fixtures for testing and demonstrating the OpenCode Agent Loop.

## Available Examples

### fix-bug
A simple bug-fix task with a failing test. The calculateTotal function returns NaN when an item has a null price. Expected behavior: treat null/missing prices as 0.

Run: `node examples/fix-bug/fixture.test.mjs`

### documentation-task
A documentation update task. Add JSDoc for a new function parameter.

### safety-behavior
Tests that the agent loop rejects unsafe operations. Demonstrates path confinement and command validation.

## Usage

These fixtures can be used with the agent loop:
```bash
cd examples/fix-bug
opencode /feature Fix the calculateTotal bug - it returns NaN for null prices
```

## Adding Examples

To add a new example:
1. Create a directory under examples/
2. Add a README.md explaining the task
3. Include test files that demonstrate expected behavior
4. Add fixture data if needed