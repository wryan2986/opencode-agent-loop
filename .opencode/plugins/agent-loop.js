import { tool } from '@opencode-ai/plugin';
import { runAgentLoop } from '../../runtime/agent-loop-controller.mjs';

function concise(result) {
  const steps = (result.steps || []).map(s => ({
    step: s.step,
    status: s.status,
    successfulModel: s.successfulModel,
    attemptedModels: s.attemptedModels,
    code: s.code,
    logPath: s.logPath,
    attemptDetails: s.attemptDetails ? s.attemptDetails.map(a => ({
      modelId: a.modelId,
      timedOut: a.timedOut,
      success: a.success,
      code: a.code,
      startedAt: a.startedAt,
      finishedAt: a.finishedAt,
      progressLogPath: a.progressLogPath,
      usage: a.usage || undefined,
      reportedCostUsd: a.reportedCostUsd || 0,
      budgetExceeded: a.budgetExceeded === true,
      budget: a.budget || undefined
    })) : undefined,
    smokeResults: s.smokeResults || undefined,
    stepStartedAt: s.stepStartedAt || undefined,
    budget: s.budget || undefined
  }));

  return {
    status: result.status,
    taskId: result.taskId,
    summary: result.summary,
    successfulModel: result.successfulModel,
    attemptedModels: result.attemptedModels,
    changedFiles: result.changedFiles || [],
    smokeResults: result.smokeResults || undefined,
    runtimeMetadata: result.runtimeMetadata || undefined,
    tests: result.tests,
    review: result.review,
    requiresUserInput: result.requiresUserInput === true,
    logPath: result.logPath,
    eventLogPath: result.eventLogPath || undefined,
    budget: result.budget || undefined,
    steps
  };
}

export default async function AgentLoopPlugin() {
  return {
    tool: {
      agent_loop: tool({
        description: 'Run the OpenCode agent-loop runtime for a development task. Use for non-trivial build/test/review work; do not use for simple questions.',
        args: {
          task: tool.schema.string().min(1).describe('The complete user request to run through the agent loop.'),
          mode: tool.schema.enum(['build', 'test', 'review', 'smoke', 'escalate']).optional().describe('Which role to run: build, test, review, smoke (model test), or escalate (GPT-5.6 diagnosis)'),
          maxRetries: tool.schema.number().int().min(0).max(5).optional().describe('Maximum task-level retry cycles. Provider failover is handled separately.'),
          models: tool.schema.array(tool.schema.string()).optional().describe('Pre-verified model IDs from a prior smoke call to restrict which models are used.'),
          taskId: tool.schema.string().min(1).max(128).optional().describe('Stable task ID used to share token and cost budgets across smoke, build, test, review, fix, and escalation calls.')
        },
        async execute(args, context) {
          if (process.env.AGENT_LOOP_CHILD === '1') {
            return {
              title: 'agent_loop recursion blocked',
              output: JSON.stringify({
                status: 'blocked',
                code: 'AGENT_LOOP_RECURSION_BLOCKED',
                summary: 'Worker processes are not allowed to start a complete agent loop.',
                requiresUserInput: false
              }, null, 2)
            };
          }

          const task = String(args.task || '').trim();
          if (!task) {
            return {
              title: 'agent_loop invalid input',
              output: JSON.stringify({ status: 'failed', code: 'INVALID_INPUT', summary: 'Please describe the work to be done.', requiresUserInput: true }, null, 2)
            };
          }

          context.metadata?.({ title: 'Running agent_loop', metadata: { mode: args.mode || 'build' } });
          try {
            const progressCallback = (msg) => {
              try {
                context.metadata?.({ title: msg?.title || 'agent_loop', metadata: msg?.metadata || {} });
              } catch {}
            };
            progressCallback({ title: 'Running agent_loop', metadata: { mode: args.mode || 'build', status: 'starting' } });
            const result = await runAgentLoop({
              task,
              mode: args.mode || 'build',
              maxRetries: args.maxRetries || 0,
              cwd: context.directory,
              parentSessionId: context.sessionID,
              signal: context.abort,
              metadata: {
                agent: context.agent,
                maxDepth: Number.parseInt(process.env.AGENT_LOOP_MAX_DEPTH || '1', 10)
              },
              progressCallback,
              forceModels: args.models || undefined,
              taskId: args.taskId || undefined
            });
            const cr = concise(result);
            const status = result.status;
            const modelSummary = result.successfulModel ? result.successfulModel.split('/').pop() : 'none';
            const smokeCount = result.smokeResults ? `${result.smokeResults.responsive.length}/${result.smokeResults.responsive.length + result.smokeResults.unresponsive.length}` : '';
            const stepInfo = (result.steps || []).map(s => `${s.step}=${s.status}`).join(' ');
            return {
              title: `${status} ${modelSummary}${smokeCount ? ` smoke:${smokeCount}` : ''}${stepInfo ? ` [${stepInfo}]` : ''}`,
              output: JSON.stringify(cr, null, 2),
              metadata: cr
            };
          } catch (error) {
            const structured = error.structured || {
              status: 'failed',
              code: error.code || 'AGENT_LOOP_ERROR',
              summary: error.message,
              requiresUserInput: false
            };
            return {
              title: `agent_loop ${structured.status}`,
              output: JSON.stringify(structured, null, 2),
              metadata: structured
            };
          }
        }
      })
    }
  };
}
