import { defineCatalog } from '../foundation/governed-catalog.js';
import { pathResolver } from '../path-resolver.js';
import { createLogger } from '../logger.js';

export interface AutonomyLearningPolicy {
  version: string;
  enabled: boolean;
  window_ms: number;
  cooldown_ms: number;
  notify_min_decisions: number;
  auto_min_decisions: number;
  min_outcome_success: number;
  max_incidents: number;
}

const logger = createLogger('autonomy-learning-policy');
const disabledPolicy: AutonomyLearningPolicy = {
  version: 'disabled',
  enabled: false,
  window_ms: 1,
  cooldown_ms: 1,
  notify_min_decisions: 1,
  auto_min_decisions: 1,
  min_outcome_success: 1,
  max_incidents: 0,
};

const catalog = defineCatalog<AutonomyLearningPolicy>({
  id: 'autonomy-learning-policy',
  path: () => pathResolver.knowledge('product/governance/autonomy-learning-policy.json'),
  schema: pathResolver.knowledge('product/schemas/autonomy-learning-policy.schema.json'),
  fallbackOnInvalid: true,
  fallback: disabledPolicy,
  onFallback: (error) =>
    logger.warn(
      `Autonomy learning disabled — policy is missing or invalid | next: repair autonomy-learning-policy.json | evidence: ${String(error)}`
    ),
});

export function loadAutonomyLearningPolicy(): AutonomyLearningPolicy {
  try {
    const policy = catalog.load();
    if (policy.auto_min_decisions < policy.notify_min_decisions) {
      throw new Error('auto_min_decisions must be at least notify_min_decisions');
    }
    return policy;
  } catch (error) {
    logger.warn(
      `Autonomy learning disabled — policy could not be read | next: inspect policy access | evidence: ${String(error)}`
    );
    return { ...disabledPolicy };
  }
}
