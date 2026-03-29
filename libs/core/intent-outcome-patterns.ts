import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';

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
  patterns?: IntentOutcomePattern[];
}

export function loadIntentOutcomePatterns(): IntentOutcomePattern[] {
  const filePath = pathResolver.knowledge('public/governance/intent-outcome-patterns.json');
  const parsed = JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as IntentOutcomePatternCatalog;
  return Array.isArray(parsed.patterns) ? parsed.patterns : [];
}

export function findIntentOutcomePattern(intentId?: string): IntentOutcomePattern | null {
  if (!intentId) return null;
  return loadIntentOutcomePatterns().find((pattern) => pattern.intent_id === intentId) || null;
}
