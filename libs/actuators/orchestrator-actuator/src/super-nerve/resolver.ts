import { logger, safeReadFile } from '@agent/core';
import * as path from 'node:path';
import { executeSuperPipeline } from './index.js';

/**
 * Intent Resolver: Resolves high-level semantic intents into Super-Nerve pipeline steps.
 */

export async function resolveIntentToSteps(intentId: string): Promise<any[]> {
  const dictionaryPath = path.resolve(process.cwd(), 'knowledge/governance/standard-intents.json');
  const dictionary = JSON.parse(safeReadFile(dictionaryPath, { encoding: 'utf8' }) as string);

  const intent = dictionary.intents.find((i: any) => i.id === intentId);
  if (!intent) {
    const fuzzyMatch = dictionary.intents.find((i: any) => i.trigger_keywords?.some((k: string) => intentId.toLowerCase().includes(k.toLowerCase())));
    if (!fuzzyMatch) throw new Error(`Intent not recognized: ${intentId}`);
    logger.info(`🔍 [RESOLVER] Fuzzy matched intent: ${fuzzyMatch.id}`);
    return fuzzyMatch.pipeline;
  }

  logger.info(`🎯 [RESOLVER] Resolved intent: ${intent.id}`);
  return intent.pipeline;
}

export async function resolveAndExecuteIntent(intentId: string, initialContext: any = {}, options: any = {}) {
  const steps = await resolveIntentToSteps(intentId);
  return await executeSuperPipeline(steps, initialContext, options);
}
