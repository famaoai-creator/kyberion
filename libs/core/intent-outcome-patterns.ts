import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';

export interface IntentOutcomePattern {
  intent_id: string;
  canonical_flow?: string[];
  contract_layers?: string[];
  primary_outcome_ids?: string[];
  evidence?: string[];
  completion_criteria?: string[];
  follow_up?: string[];
}

interface IntentOutcomePatternCatalog {
  version: string;
  notes: string[];
  patterns: IntentOutcomePattern[];
}

const intentOutcomePatternCatalog = defineCatalog<IntentOutcomePatternCatalog>({
  id: 'intent-outcome-patterns',
  path: () => pathResolver.knowledge('product/governance/intent-outcome-patterns.json'),
  schema: pathResolver.knowledge('product/schemas/intent-outcome-patterns.schema.json'),
});

export function loadIntentOutcomePatterns(): IntentOutcomePattern[] {
  return intentOutcomePatternCatalog.load().patterns;
}

export function findIntentOutcomePattern(intentId?: string): IntentOutcomePattern | null {
  if (!intentId) return null;
  return loadIntentOutcomePatterns().find((pattern) => pattern.intent_id === intentId) || null;
}
