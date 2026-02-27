import { validateInjection, scanForConfidentialMarkers } from '@agent/core/tier-guard';

export interface InjectResult {
  injected: boolean;
  sourceTier: string;
  outputTier: string;
}

export function injectContext(
  data: any,
  knowledgeContent: string,
  knowledgePath: string,
  outputTier: string
): InjectResult {
  const tierCheck = validateInjection(knowledgePath, outputTier);
  if (!tierCheck.allowed) {
    throw new Error(`Tier violation: \${tierCheck.reason}`);
  }

  if (outputTier === 'public') {
    const scan = scanForConfidentialMarkers(knowledgeContent);
    if (scan.hasMarkers) {
      throw new Error(
        `Confidential markers detected in public output: \${scan.markers.join(', ')}`
      );
    }
  }

  data._context = data._context || {};
  data._context.injected_knowledge = knowledgeContent;
  data._context.knowledge_tier = tierCheck.sourceTier;

  return { injected: true, sourceTier: tierCheck.sourceTier, outputTier };
}
