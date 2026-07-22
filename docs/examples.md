# Examples

## Overview
The examples/ directory contains self-contained fixture projects for testing and demonstrating the OpenCode Agent Loop.

## Example 1: Small Bug Fix

**Task**: Fix a function that returns NaN for null prices.
**Location**: `examples/fix-bug/fixture.test.mjs`

**Expected workflow**:
1. Orchestrator reads the fixture and discovers failing test
2. Test agent establishes baseline (test fails)
3. Build worker implements fix (handle null/undefined prices)
4. Test agent verifies (test passes)
5. Review agent inspects diff
6. Orchestrator commits

## Example 2: Documentation Update

**Task**: Add JSDoc for a new function parameter.
**Location**: `examples/documentation-task/fixture.md`

**Expected workflow**:
1. Orchestrator reads the documentation requirement
2. Build worker updates the JSDoc
3. Review agent checks documentation accuracy
4. Orchestrator commits

## Example 3: Safety Behavior

**Task**: Verify the system rejects unsafe operations.
**Location**: `examples/safety-behavior/fixture.js`

**Expected workflow**:
1. Orchestrator presents a task with unsafe path access
2. Build worker attempts to read /etc/passwd
3. Path confinement blocks the access
4. The attempt is logged and reported

## Running Examples

```bash
# Run the bug fix fixture
cd examples/fix-bug
# In opencode TUI:
/feature Fix calculateTotal - it returns NaN when price is null
```

## Creating Custom Examples

See examples/README.md for instructions on adding new examples.