/** Domain barrel — public surface for libs/core/reasoning */
export * from './judgment-assist.js';
export * from './judgment-backend.js';
export * from './judgment-calibration-fit.js';
export * from './judgment-callsite-eval.js';
export * from './model-performance-index.js';
export * from './model-registry-contract.js';
export * from './model-registry-directory.js';
export * from './model-role-fitness-runner.js';
export * from './model-role-fitness.js';
export * from './prompt-cache-discipline.js';
export * from './prompt-constraints.js';
export * from './prompt-visibility-ledger.js';
export * from './reasoning-api-provider.js';
export * from './reasoning-auth-preflight.js';
export * from './reasoning-backend-contracts.js';
export * from './reasoning-backend-execution-adapter.js';
export * from './reasoning-backend-policy.js';
export type {
  LastServedReasoningMode,
  UntrustedDataParams,
  StubServedRecord,
} from './reasoning-backend.js';
export {
  getLastServedReasoningMode,
  resetReasoningFailoverTracking,
  FailoverReasoningBackend,
  RoleAwareReasoningBackend,
  buildFailoverReasoningBackend,
  buildRoleAwareReasoningBackend,
  delegateStructured,
  delegateBestOf,
  delegateTaskWithUntrustedData,
  requestPeerAdvice,
  registerReasoningBackend,
  getReasoningBackend,
  resetReasoningBackend,
  stubExplicitlyRequested,
  getStubServedOps,
  resetStubServedOps,
  snapshotStubServedOps,
  restoreStubServedOps,
  stubReasoningBackend,
  DELEGATION_SUMMARY_MIN_CHARS,
  STRUCTURED_DELEGATION_PROMPT_HEADER,
  delegationSummaryRetryEnabled,
  buildDelegationSummaryContinuationPrompt,
} from './reasoning-backend.js';
export type { InstallReasoningOptions, InstallAnthropicOptions } from './reasoning-bootstrap.js';
export {
  consultCapabilityBrokerForMode,
  installReasoningBackends,
  reselectReasoningBackends,
  installAnthropicBackendsIfAvailable,
  resetReasoningBootstrap,
  getInstalledReasoningMode,
} from './reasoning-bootstrap.js';
export * from './reasoning-cli-provider.js';
export * from './reasoning-degradation.js';
// skipped './reasoning-delegation-policy.js' (all exports shadowed)
export * from './reasoning-drift-watchdog.js';
export * from './reasoning-egress-scope.js';
export * from './reasoning-endpoint-discovery.js';
export * from './reasoning-failover.js';
export * from './reasoning-failure-taxonomy.js';
export * from './reasoning-level-policy.js';
export type {
  ModelCompatibilityOverrides,
  ModelRegistryEntry,
  ModelRegistryFile,
  ReasoningModelRoute,
  TaskModelHint,
  TaskModelHintInput,
  RuntimeModelRole,
} from './reasoning-model-routing.js';
export {
  loadModelRegistry,
  resolveModelProvider,
  resolveTaskModelHint,
  raiseTaskModelHintToTier,
  resolveReasoningModelRoute,
  resetReasoningModelRoutingCache,
  resolveRuntimeModelId,
} from './reasoning-model-routing.js';
export * from './reasoning-openai-compatible-provider.js';
export * from './reasoning-participant.js';
export * from './reasoning-provider-readiness.js';
export * from './reasoning-provider-registry.js';
export * from './reasoning-retry-policy.js';
export * from './reasoning-route-doctor.js';
export * from './reasoning-route-resolver.js';
export * from './reasoning-runtime-instructions.js';
export * from './reasoning-tier-declaration.js';
