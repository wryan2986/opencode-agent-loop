import { tool } from '@opencode-ai/plugin';
import { runAgentLoop } from '../../runtime/agent-loop-controller.mjs';
import { OrchestrationPolicyKernel } from '../../lib/orchestration-policy.mjs';

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
    code: result.code || undefined,
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
    policy: result.policy || undefined,
    steps
  };
}

function blocked(title, code, summary, extra = {}) {
  const structured = {
    status: 'blocked',
    code,
    summary,
    requiresUserInput: false,
    ...extra
  };
  return {
    title,
    output: JSON.stringify(structured, null, 2),
    metadata: structured
  };
}

function failed(title, error, fallbackCode) {
  const structured = error?.structured || {
    status: 'failed',
    code: error?.code || fallbackCode,
    summary: error?.message || String(error),
    requiresUserInput: false
  };
  return {
    title,
    output: JSON.stringify(structured, null, 2),
    metadata: structured
  };
}

function policyKernel(context) {
  return new OrchestrationPolicyKernel({ cwd: context.directory });
}

export default async function AgentLoopPlugin() {
  const evidenceSchema = tool.schema.object({
    type: tool.schema.enum([
      'approval',
      'baseline',
      'baseline_skip',
      'smoke',
      'build',
      'test',
      'integration_test',
      'validation',
      'candidate',
      'review',
      'rollback_plan',
      'isolation',
      'human_checkpoint',
      'push_approval',
      'budget',
      'commit',
      'note'
    ]),
    status: tool.schema.string().min(1).max(64),
    ref: tool.schema.string().max(512).optional(),
    candidateHash: tool.schema.string().max(128).optional(),
    details: tool.schema.object({
      justification: tool.schema.string().max(2000).optional(),
      notes: tool.schema.string().max(4000).optional(),
      commands: tool.schema.array(tool.schema.string().max(1000)).max(50).optional(),
      files: tool.schema.array(tool.schema.string().max(1000)).max(500).optional()
    }).optional()
  });

  return {
    tool: {
      orchestration_policy: tool({
        description: 'Propose the orchestrator next action to the hybrid policy kernel. The model chooses the action and rationale; the kernel enforces invariants, risk gates, durable evidence, and one-time permits.',
        args: {
          taskId: tool.schema.string().min(1).max(128).describe('Stable task ID reused for the entire feature.'),
          action: tool.schema.enum([
            'inspect',
            'request_approval',
            'record_approval',
            'record_evidence',
            'baseline',
            'skip_baseline',
            'smoke',
            'build',
            'test',
            'stage_candidate',
            'review',
            'fix',
            'escalate',
            'commit',
            'push',
            'ask_user',
            'replan',
            'stop'
          ]),
          reason: tool.schema.string().min(1).max(4000).describe('Why this is the appropriate next action.'),
          task: tool.schema.string().max(12000).optional().describe('Task summary used for semantic risk inference.'),
          riskLevel: tool.schema.enum(['low', 'medium', 'high', 'critical']).optional().describe('The orchestrator proposed risk level. The kernel may elevate but never lower it.'),
          riskReasons: tool.schema.array(tool.schema.string().max(500)).max(30).optional(),
          plannedPaths: tool.schema.array(tool.schema.string().max(1000)).max(500).optional(),
          evidence: tool.schema.array(evidenceSchema).max(100).optional()
        },
        async execute(args, context) {
          if (process.env.AGENT_LOOP_CHILD === '1') {
            return blocked(
              'orchestration_policy recursion blocked',
              'POLICY_RECURSION_BLOCKED',
              'Worker processes cannot authorize orchestration actions.'
            );
          }
          try {
            const decision = policyKernel(context).propose(args);
            const title = `${decision.decision} risk:${decision.effectiveRisk || 'unknown'} action:${args.action}`;
            context.metadata?.({
              title,
              metadata: {
                action: args.action,
                decision: decision.decision,
                observedDecision: decision.observedDecision,
                risk: decision.effectiveRisk,
                missingEvidence: decision.missingEvidence,
                permitId: decision.permit?.id
              }
            });
            return {
              title,
              output: JSON.stringify(decision, null, 2),
              metadata: decision
            };
          } catch (error) {
            return failed('orchestration_policy failed', error, 'POLICY_ERROR');
          }
        }
      }),

      agent_loop: tool({
        description: 'Run one delegated OpenCode role after orchestration_policy authorizes it. A matching one-time policy permit is required when policy enforcement is enabled.',
        args: {
          task: tool.schema.string().min(1).describe('The complete user request to run through the agent loop.'),
          mode: tool.schema.enum(['build', 'test', 'review', 'smoke', 'escalate']).optional().describe('Which role to run: build, test, review, smoke (model test), or escalate (GPT-5.6 diagnosis)'),
          maxRetries: tool.schema.number().int().min(0).max(5).optional().describe('Maximum same-model retries for transient failures. Provider failover begins after these retries are exhausted.'),
          models: tool.schema.array(tool.schema.string()).optional().describe('Pre-verified model IDs from a prior smoke call to restrict which models are used.'),
          taskId: tool.schema.string().min(1).max(128).optional().describe('Stable task ID shared by the policy kernel, budgets, and all delegated stages.'),
          policyPermit: tool.schema.string().min(1).max(128).optional().describe('One-time permit ID returned by orchestration_policy for this exact action and mode.')
        },
        async execute(args, context) {
          if (process.env.AGENT_LOOP_CHILD === '1') {
            return blocked(
              'agent_loop recursion blocked',
              'AGENT_LOOP_RECURSION_BLOCKED',
              'Worker processes are not allowed to start a complete agent loop.'
            );
          }

          const task = String(args.task || '').trim();
          if (!task) {
            return {
              title: 'agent_loop invalid input',
              output: JSON.stringify({ status: 'failed', code: 'INVALID_INPUT', summary: 'Please describe the work to be done.', requiresUserInput: true }, null, 2)
            };
          }

          const mode = args.mode || 'build';
          const kernel = policyKernel(context);
          let consumedPermit = null;
          if (kernel.config.requireAgentLoopPermit) {
            try {
              consumedPermit = kernel.consumePermit({
                taskId: args.taskId,
                permitId: args.policyPermit,
                mode
              });
            } catch (error) {
              return blocked(
                'agent_loop policy blocked',
                error.code || 'POLICY_PERMIT_REQUIRED',
                error.message,
                { taskId: args.taskId || null, mode }
              );
            }
          }

          context.metadata?.({ title: 'Running agent_loop', metadata: { mode, policyAction: consumedPermit?.action } });
          try {
            const progressCallback = (msg) => {
              try {
                context.metadata?.({ title: msg?.title || 'agent_loop', metadata: msg?.metadata || {} });
              } catch {}
            };
            progressCallback({ title: 'Running agent_loop', metadata: { mode, status: 'starting', policyAction: consumedPermit?.action } });
            const result = await runAgentLoop({
              task,
              mode,
              maxRetries: args.maxRetries,
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
            if (consumedPermit) {
              result.policy = kernel.recordAgentLoopResult({
                taskId: args.taskId,
                permitId: args.policyPermit,
                mode,
                result
              });
            }
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
            if (consumedPermit) {
              try {
                kernel.recordAgentLoopResult({
                  taskId: args.taskId,
                  permitId: args.policyPermit,
                  mode,
                  result: {
                    status: 'failed',
                    code: error.code || 'AGENT_LOOP_ERROR',
                    summary: error.message
                  }
                });
              } catch {}
            }
            return failed('agent_loop failed', error, 'AGENT_LOOP_ERROR');
          }
        }
      }),

      orchestration_commit: tool({
        description: 'Create the final local Git commit from the staged candidate after orchestration_policy grants a commit permit. The tool rechecks the candidate hash before committing.',
        args: {
          taskId: tool.schema.string().min(1).max(128),
          policyPermit: tool.schema.string().min(1).max(128),
          message: tool.schema.string().min(1).max(500)
        },
        async execute(args, context) {
          if (process.env.AGENT_LOOP_CHILD === '1') {
            return blocked(
              'orchestration_commit recursion blocked',
              'POLICY_RECURSION_BLOCKED',
              'Worker processes cannot create the final orchestration commit.'
            );
          }
          try {
            const result = policyKernel(context).commit({
              taskId: args.taskId,
              permitId: args.policyPermit,
              message: args.message
            });
            return {
              title: `committed ${result.commitHash.slice(0, 12)}`,
              output: JSON.stringify(result, null, 2),
              metadata: result
            };
          } catch (error) {
            return failed('orchestration_commit blocked', error, 'POLICY_COMMIT_FAILED');
          }
        }
      })
    }
  };
}
