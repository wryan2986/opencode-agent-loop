# Troubleshooting

## Common Issues

### "All providers unresponsive"

**Cause**: No model provider responded to the smoke test.

**Solutions**:
1. Check your OpenCode installation: `opencode models`
2. Verify network connectivity
3. Check if models are in cooldown: check `config/free-first-pools-state.json`
4. Wait for cooldown to expire (configurable in `free-first-config.json`)
5. Try a different model provider

### "/feature does nothing"

**Cause**: The /feature command requires the TUI (interactive mode).

**Solutions**:
1. Run `opencode` (without arguments) to enter TUI mode
2. Type `/feature <your task>` in the chat
3. Or use `/loop <task>` for the agent_loop tool path

### "Tests fail with no output"

**Cause**: Missing test dependencies or incorrect test configuration.

**Solutions**:
1. Run `npm install` to ensure dependencies are installed
2. Check the project's `AGENTS.md` for test commands
3. Run `bash scripts/validate.sh` to check your setup

### "Model X not found"

**Cause**: The model might not be available in your OpenCode installation.

**Solutions**:
1. Run `opencode models` to list available models
2. Check `config/free-first-pools.json` for enabled models
3. Check `config/model-registry.json` for the model entry

### "Commit blocked by pre-existing changes"

**Cause**: There are unstaged or uncommitted changes in the working tree.

**Solutions**:
1. Commit or stash your changes before running /feature
2. The orchestrator will not discard unrelated changes

## Debugging

### Enable verbose logging

Agent loop logs are written to `.opencode/agent-loop-logs/`. Check these files for detailed execution traces:

```bash
ls .opencode/agent-loop-logs/
```

### Run individual steps

You can test individual agent roles with the agent_loop tool:

```bash
# Test model availability
opencode run "smoke test"

# Run just the test step
opencode run "test the implementation"
```

### Validate configuration

```bash
bash scripts/validate.sh
bash scripts/validate-agent-configs.sh
```