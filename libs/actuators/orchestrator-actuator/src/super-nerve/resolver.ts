import { compileIntent, logger } from '@agent/core';
import { executeSuperPipeline } from './index.js';

/**
 * Intent Resolver: Resolves high-level semantic intents into Super-Nerve pipeline steps.
 * Delegates to the canonical intent-compiler in @agent/core.
 */

function extractServiceNameFromText(text: string): string | undefined {
  const serviceMatch =
    text.match(
      /([A-Za-z0-9._-]+)\s*(?:の|を)?\s*(?:再起動|restart|起動|停止|stop|status|状態|ログ)/i
    ) || text.match(/service\s+([A-Za-z0-9._-]+)/i);
  return serviceMatch?.[1];
}

function buildStopServiceShellCommand(serviceName?: string): string {
  const base = 'node dist/scripts/service_lifecycle_control.js --operation ';
  if (!serviceName) return `${base}list`;
  if (!/^[A-Za-z0-9._-]+$/.test(serviceName)) {
    throw new Error(`Invalid service name: ${serviceName}`);
  }
  return `${base}stop --service-name ${serviceName}`;
}

function buildStartServiceShellCommand(serviceName?: string): string {
  const base = 'node dist/scripts/service_lifecycle_control.js --operation ';
  if (!serviceName) return `${base}start`;
  if (!/^[A-Za-z0-9._-]+$/.test(serviceName)) {
    throw new Error(`Invalid service name: ${serviceName}`);
  }
  return `${base}start --service-name ${serviceName}`;
}

export async function resolveIntentToSteps(intentId: string, initialContext: any = {}): Promise<any[]> {
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

  if (result.intentId === 'stop-service') {
    const selectedService =
      typeof initialContext?.service_name === 'string' && initialContext.service_name.trim()
        ? initialContext.service_name.trim()
        : extractServiceNameFromText(intentId);

    logger.info(
      `[INTENT_RESOLVER] Stop-service selection flow: ${selectedService ? `target=${selectedService}` : 'listing running services'}`
    );
    return [
      {
        op: 'system:shell',
        params: {
          cmd: buildStopServiceShellCommand(selectedService),
          export_as: 'service_lifecycle_result',
        },
      },
    ];
  }

  if (result.intentId === 'start-service') {
    const selectedService =
      typeof initialContext?.service_name === 'string' && initialContext.service_name.trim()
        ? initialContext.service_name.trim()
        : extractServiceNameFromText(intentId);

    logger.info(
      `[INTENT_RESOLVER] Start-service selection flow: ${selectedService ? `target=${selectedService}` : 'listing startable services'}`
    );
    return [
      {
        op: 'system:shell',
        params: {
          cmd: buildStartServiceShellCommand(selectedService),
          export_as: 'service_lifecycle_result',
        },
      },
    ];
  }

  return result.steps;
}

export async function resolveAndExecuteIntent(intentId: string, initialContext: any = {}, options: any = {}) {
  const steps = await resolveIntentToSteps(intentId, initialContext);
  return await executeSuperPipeline(steps, initialContext, options);
}
