import { compileIntent, logger } from '@agent/core';
import { executeSuperPipeline } from './index.js';

/**
 * Intent Resolver: Resolves high-level semantic intents into Super-Nerve pipeline steps.
 * Delegates to the canonical intent-compiler in @agent/core.
 */

export async function resolveIntentToSteps(intentId: string): Promise<any[]> {
  const deterministicByIntentId: Record<string, any[]> = {
    'verify-actuator-capability': [{ op: 'core:set', params: { export_as: 'intent_id', value: intentId } }, { op: 'system:shell', params: { cmd: 'pnpm capabilities' } }],
    'check-kyberion-baseline': [{ op: 'system:shell', params: { cmd: 'node dist/scripts/run_pipeline.js --input pipelines/baseline-check.json' } }],
    'diagnose-kyberion-system': [{ op: 'system:shell', params: { cmd: 'node dist/scripts/run_pipeline.js --input pipelines/system-diagnostics.json' } }],
    'verify-environment-readiness': [{ op: 'system:shell', params: { cmd: 'node dist/scripts/run_pipeline.js --input pipelines/baseline-check.json' } }],
    'inspect-runtime-supervisor': [{
      op: 'system:shell',
      params: {
        cmd: 'node -e "import(\'./dist/libs/core/agent-runtime-supervisor-client.js\').then(m=>m.ensureAgentRuntimeSupervisorDaemon()).then(()=>process.exit(0)).catch(()=>process.exit(0))" && node dist/scripts/agent_runtime_supervisor_status.js',
      },
    }],
  };
  if (deterministicByIntentId[intentId]) {
    logger.info(`[INTENT_RESOLVER] Deterministic map match: ${intentId}`);
    return deterministicByIntentId[intentId];
  }

  const result = compileIntent(intentId);
  if (!result || result.steps.length === 0) {
    throw new Error(`Intent not resolved: ${intentId}`);
  }
  return result.steps;
}

export async function resolveAndExecuteIntent(intentId: string, initialContext: any = {}, options: any = {}) {
  const steps = await resolveIntentToSteps(intentId);
  return await executeSuperPipeline(steps, initialContext, options);
}
