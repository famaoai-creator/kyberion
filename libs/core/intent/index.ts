/** Domain barrel — public surface for libs/core/intent */
export * from './intent-clarification-format.js';
export * from './intent-compilation-events.js';
export * from './intent-compiler.js';
export * from './intent-contract-learning.js';
export * from './intent-contract-types.js';
export {
  parseIntentModelJsonObject,
  summarizeRelevantIntents,
  inferGovernedDeliveryMode,
  resolveIntentCompilerTarget,
  deriveIntentDeliveryDecision,
  deriveAgentRoutingDecision,
  compileUserIntentFlow,
  isSimpleGreetingText,
} from './intent-contract.js';
// skipped './intent-delivery-decision.js' (all exports shadowed)
export * from './intent-delta.js';
export * from './intent-execution-profile-registry.js';
export * from './intent-extractor.js';
export * from './intent-flow-cache.js';
export * from './intent-handoff.js';
export * from './intent-input-context.js';
export * from './intent-outcome-patterns.js';
export * from './intent-path-utils.js';
export * from './intent-reconciliation.js';
export * from './intent-resolution-contract-parser.js';
export type { IntentResolutionContractOptions } from './intent-resolution-contract.js';
export {
  renderIntentAuthorityLabel,
  renderIntentOutcomeLabel,
  resolveIntentResolutionContract,
} from './intent-resolution-contract.js';
export type {
  IntentDomainOntologyEntry,
  IntentDomainOntologyFile,
  IntentResolutionCandidate,
  IntentResolutionBundleCandidate,
  IntentResolutionSelectedParameters,
  IntentResolutionPacket,
  IntentResolutionTier,
  IntentResolutionOptions,
} from './intent-resolution.js';
export {
  loadStandardIntentCatalog,
  loadResolvedStandardIntentCatalog,
  loadIntentDomainOntologyCatalog,
  normalizeForTriggerMatch,
  resolveIntentResolutionPacket,
  chooseExecutionIntent,
  gatherImprovementHints,
} from './intent-resolution.js';
export type { IntentRoutingDecisionDependencies } from './intent-routing-decision.js';
export * from './intent-snapshot-store.js';
export * from './intent-track-resolver.js';
export * from './intent-use-case-scenario.js';
