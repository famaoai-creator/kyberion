import { compileIntent } from '@agent/core/src/intent-compiler';
import { logger } from '@agent/core/core';
import { executeRegisteredSuperPipeline } from '@agent/core/super-nerve-execution-port';
import { resolveIntentResolutionPacket } from '@agent/core/intent-resolution';

/**
 * Intent Resolver: Resolves high-level semantic intents into Super-Nerve pipeline steps.
 * Delegates to the canonical intent-compiler in @agent/core.
 */

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

export async function resolveIntentToSteps(
  intentId: string,
  initialContext: any = {}
): Promise<any[]> {
  const result = compileIntent(intentId);
  if (!result || result.steps.length === 0) {
    throw new Error(`Intent not resolved: ${intentId}`);
  }

  if (result.intentId === 'stop-service') {
    const sourceText =
      typeof initialContext?.source_text === 'string' && initialContext.source_text.trim()
        ? initialContext.source_text.trim()
        : intentId;
    const selectedService =
      typeof initialContext?.service_name === 'string' && initialContext.service_name.trim()
        ? initialContext.service_name.trim()
        : resolveIntentResolutionPacket(sourceText).selected_parameters?.service_name;

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
    const sourceText =
      typeof initialContext?.source_text === 'string' && initialContext.source_text.trim()
        ? initialContext.source_text.trim()
        : intentId;
    const selectedService =
      typeof initialContext?.service_name === 'string' && initialContext.service_name.trim()
        ? initialContext.service_name.trim()
        : resolveIntentResolutionPacket(sourceText).selected_parameters?.service_name;

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

export async function resolveAndExecuteIntent(
  intentId: string,
  initialContext: any = {},
  options: any = {}
) {
  const steps = await resolveIntentToSteps(intentId, initialContext);
  return await executeRegisteredSuperPipeline(steps, initialContext, options);
}
