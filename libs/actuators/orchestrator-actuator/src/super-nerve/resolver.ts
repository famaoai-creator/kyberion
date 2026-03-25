import { compileIntent, logger } from '@agent/core';
import { executeSuperPipeline } from './index.js';

/**
 * Intent Resolver: Resolves high-level semantic intents into Super-Nerve pipeline steps.
 * Delegates to the canonical intent-compiler in @agent/core.
 */

export async function resolveIntentToSteps(intentId: string): Promise<any[]> {
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
