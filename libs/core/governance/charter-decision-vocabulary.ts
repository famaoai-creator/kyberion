/**
 * Charter decision vocabulary — which business decision types an
 * accountability charter can speak about, and the action facts it evaluates
 * for each (`knowledge/product/governance/charter-decision-vocabulary.json`).
 *
 * A missing or invalid catalog degrades to an empty vocabulary: every decision
 * then keeps the legacy approval path (a human decides), never an allow.
 */

import { logger } from '../core.js';
import { defineCatalog } from '../foundation/governed-catalog.js';
import { pathResolver } from '../path-resolver.js';
import type { ReputationalClass } from './accountability-charter.js';

export type CharterDecisionActionClass =
  | 'send_message_external'
  | 'publish_public'
  | 'sign_contract'
  | 'payment'
  | 'credential_change'
  | 'internal_decision';

export interface CharterDecisionEntry {
  decision_type: string;
  label: { ja: string; en: string };
  action_class: CharterDecisionActionClass;
  reversible: boolean;
  amount_semantics: 'spend' | 'exposure' | 'none';
  reputational_class?: ReputationalClass;
  default_recipients?: number;
  systems?: number;
  requires_delegation: boolean;
}

export interface CharterDecisionVocabulary {
  version: string;
  decisions: CharterDecisionEntry[];
}

const vocabularyCatalog = defineCatalog<CharterDecisionVocabulary>({
  id: 'charter-decision-vocabulary',
  path: () => pathResolver.knowledge('product/governance/charter-decision-vocabulary.json'),
  schema: pathResolver.knowledge('product/schemas/charter-decision-vocabulary.schema.json'),
  fallback: { version: '0.0.0', decisions: [] },
  fallbackOnInvalid: true,
  onFallback: (error) =>
    logger.warn(
      `[charter-vocabulary] catalog unavailable — every decision keeps the legacy approval path | fix knowledge/product/governance/charter-decision-vocabulary.json | ${error instanceof Error ? error.message : String(error)}`
    ),
});

export function loadCharterDecisionVocabulary(): CharterDecisionVocabulary {
  return vocabularyCatalog.load();
}

export function findCharterDecision(
  decisionType: string,
  vocabulary: CharterDecisionVocabulary = loadCharterDecisionVocabulary()
): CharterDecisionEntry | undefined {
  return vocabulary.decisions.find((entry) => entry.decision_type === decisionType);
}

/** Decision types a charter form may delegate by name. */
export function delegableCharterDecisions(
  vocabulary: CharterDecisionVocabulary = loadCharterDecisionVocabulary()
): CharterDecisionEntry[] {
  return vocabulary.decisions.filter((entry) => entry.requires_delegation);
}
