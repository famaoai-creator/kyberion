import { logger, safeReadFile } from '@agent/core';
import * as path from 'node:path';
import { executeSuperPipeline } from './index.js';

/**
 * Intent Resolver: Resolves high-level semantic intents into Super-Nerve pipeline steps.
 */

export async function resolveAndExecuteIntent(intentId: string, initialContext: any = {}, options: any = {}) {
  const dictionaryPath = path.resolve(process.cwd(), 'knowledge/governance/standard-intents.json');
  const dictionary = JSON.parse(safeReadFile(dictionaryPath, { encoding: 'utf8' }) as string);

  const intent = dictionary.intents.find((i: any) => i.id === intentId);
  if (!intent) {
    // Attempt fuzzy matching via keywords if exact ID not found
    const fuzzyMatch = dictionary.intents.find((i: any) => i.trigger_keywords.some((k: string) => intentId.toLowerCase().includes(k)));
    if (!fuzzyMatch) throw new Error(`Intent not recognized: ${intentId}`);
    
    logger.info(`🔍 [RESOLVER] Fuzzy matched intent: ${fuzzyMatch.id}`);
    return await executeSuperPipeline(fuzzyMatch.pipeline, initialContext, options);
  }

  logger.info(`🎯 [RESOLVER] Resolved intent: ${intent.id}`);
  return await executeSuperPipeline(intent.pipeline, initialContext, options);
}
