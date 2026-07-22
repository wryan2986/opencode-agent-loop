const DEFAULT_MAX_DEPTH = 1;

export function getCurrentDepth(env = process.env) {
  const depth = Number.parseInt(env.AGENT_LOOP_DEPTH || '0', 10);
  return Number.isFinite(depth) ? depth : 0;
}

export function assertCanStartLoop({ env = process.env, maxDepth = DEFAULT_MAX_DEPTH, agent, toolName = 'agent_loop' } = {}) {
  if (env.AGENT_LOOP_CHILD === '1') {
    const error = new Error('Recursive agent_loop invocation blocked inside worker process');
    error.code = 'AGENT_LOOP_RECURSION_BLOCKED';
    error.structured = { status: 'blocked', code: error.code, reason: error.message };
    throw error;
  }
  if (getCurrentDepth(env) >= maxDepth) {
    const error = new Error(`Maximum agent loop depth (${maxDepth}) reached`);
    error.code = 'AGENT_LOOP_DEPTH_EXCEEDED';
    error.structured = { status: 'blocked', code: error.code, reason: error.message };
    throw error;
  }
  if (agent && String(agent).toLowerCase().includes('worker') && toolName === 'agent_loop') {
    const error = new Error(`Self-invocation blocked for worker agent "${agent}"`);
    error.code = 'AGENT_LOOP_SELF_INVOCATION_BLOCKED';
    error.structured = { status: 'blocked', code: error.code, reason: error.message };
    throw error;
  }
}

export function childLoopEnv(env = {}, maxDepth = DEFAULT_MAX_DEPTH) {
  return {
    ...env,
    AGENT_LOOP_CHILD: '1',
    AGENT_LOOP_DEPTH: String(Math.min(getCurrentDepth(process.env) + 1, maxDepth))
  };
}
