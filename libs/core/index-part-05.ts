/** Generated public API barrel part. Keep exports in source order. */

export * from './governance/approval-store.js';

export * from './judge-route.js';

export * from './reasoning/judgment-backend.js';

export * from './typesafe-jev-judgment-backend.js';

export * from './laya-mlx-judgment-backend.js';

export * from './reasoning/judgment-provider-bootstrap.js';

export * from './reasoning/judgment-assist.js';

export * from './error-classifier-judgment.js';

export * from './knowledge/knowledge-relevance-judgment.js';

export * from './browser/browser-judgment.js';

export * from './reasoning/judgment-calibration-fit.js';

export * from './reasoning/judgment-callsite-eval.js';

export * from './task/task-routing-judgment.js';

export * from './agent/agent-runtime-readiness.js';

export * from './plugin/plugin-source-trust.js';

export * from './plugin/plugin-managed-install.js';

export * from './plugin/skill-plugin-loader.js';

export * from './provider/provider-capability-scanner.js';

export * from './governance/approval-gate-summary.js';

export { enforceApprovalGate, hasHuman } from './governance/approval-gate.js';

export type { ApprovalGateParams, ApprovalGateResult } from './governance/approval-gate.js';

export { RISKY_OPS, isKnownRiskyOp, requireApprovalForOp } from './risky-op-registry.js';

export type { RequireApprovalParams, RiskyOpId } from './risky-op-registry.js';

export {
  DEFAULT_THRESHOLDS as INTENT_DRIFT_THRESHOLDS,
  classifyDrift,
  computeIntentDelta,
  goalSimilarity,
  isBlockingDrift,
} from './intent/intent-delta.js';

export type {
  DriftThresholds,
  DriftVerdict,
  IntentBody,
  IntentDelta,
  IntentDeltaChanges,
  IntentSnapshot,
} from './intent/intent-delta.js';

export {
  emitIntentSnapshot,
  evaluateIntentDriftGate,
  loadIntentDeltasAtPath,
  loadIntentSnapshotsAtPath,
  latestSnapshot,
  listSnapshots,
  mapStageToLoopPhase,
  reclassifyDrift,
} from './intent/intent-snapshot-store.js';

export type { EmitSnapshotParams, IntentDriftGateResult } from './intent/intent-snapshot-store.js';

export {
  getTrustLevel,
  listNgTopics,
  readNode as readRelationshipNode,
  recordInteraction,
  suggestFieldUpdate,
} from './relationship-graph-store.js';

export {
  listHeuristics,
  queueHeuristicMemoryCandidate,
  readHeuristic,
  scoreValidity,
  summarizeHeuristics,
  validateHeuristic,
} from './heuristic-feedback.js';

export {
  evaluateCustomerSignoffGate,
  evaluateRequirementsCompletenessGate,
  readRequirementsDraft,
  recordCustomerSignoff,
  saveRequirementsDraft,
} from './requirements-draft-store.js';

export type {
  GateResult as RequirementsGateResult,
  RecordSignoffParams,
  RequirementsDraft,
  SaveRequirementsDraftParams,
  SignoffChannel,
  StakeholderSignoff,
} from './requirements-draft-store.js';

export {
  evaluateArchitectureReadyGate,
  evaluateQaReadyGate,
  evaluateTaskPlanReadyGate,
  readDesignSpec,
  readTaskPlan,
  readTestPlan,
  saveDesignSpec,
  saveTaskPlan,
  saveTestPlan,
} from './sdlc-artifact-store.js';

export { executeTaskPlan } from './task/task-executor.js';

export {
  getTaskPlanCoordinator,
  registerTaskPlanCoordinator,
  resetTaskPlanCoordinator,
} from './task/task-plan-coordinator-port.js';

export type {
  ExecuteTaskPlanParams,
  ExecuteTaskPlanResult,
  TaskExecutionRecord,
  TaskExecutionStatus,
  TaskPlanCoordinatorPort,
} from './task/task-plan-coordinator-port.js';

export {
  getAgentExecutionPort,
  registerAgentExecutionPort,
  resetAgentExecutionPort,
  SupervisorAgentExecutionPort,
} from './agent/agent-execution-port.js';

export type {
  AgentExecutionPort,
  AgentExecutionReceipt,
  AgentTaskEnvelope,
} from './agent/agent-execution-port.js';

export {
  CoordinatedAgentExecutionPort,
  delegateCoordinatedCliSubagentTask,
  delegateCoordinatedAgentTask,
  getCoordinatedAgentExecutionPort,
} from './coordinated-agent-execution-port.js';

export type {
  CoordinatedAgentExecutionReceipt,
  CoordinatedAgentTaskEnvelope,
} from './coordinated-agent-execution-port.js';

export {
  readCanonicalWorkGraph,
  readCanonicalWorkGraphTasks,
  projectWorkGraphToNextTasks,
} from './workforce/work-graph-projection.js';

export type {
  CanonicalWorkGraphRead,
  WorkGraphProjectionDrift,
  WorkGraphProjectionOptions,
  WorkGraphProjectionResult,
} from './workforce/work-graph-projection.js';

export {
  getActuatorForwardingPort,
  registerActuatorForwardingPort,
  resetActuatorForwardingPort,
  withActuatorForwardingPort,
} from './actuator/actuator-forwarding-port.js';

export type {
  ActuatorForwardingPort,
  ActuatorForwardStatus,
  ActuatorForwardRequest,
  ActuatorForwardReceipt,
} from './actuator/actuator-forwarding-port.js';

export {
  getDeploymentAdapter,
  installShellDeploymentAdapterIfAvailable,
  registerDeploymentAdapter,
  resetDeploymentAdapter,
  ShellDeploymentAdapter,
  stubDeploymentAdapter,
} from './actuator/deployment-adapter.js';

export type {
  DeployInput,
  DeployResult,
  DeploymentAdapter,
  ShellDeploymentAdapterOptions,
} from './actuator/deployment-adapter.js';

export { MobileBetaDeploymentAdapter } from './actuator/deployment-adapters/mobile-beta.js';

export type { MobileBetaAdapterOptions } from './actuator/deployment-adapters/mobile-beta.js';

export {
  ChainAuditForwarder,
  getAuditForwarder,
  HttpAuditForwarder,
  installAuditForwarderIfAvailable,
  registerAuditForwarder,
  resetAuditForwarder,
  ShellAuditForwarder,
  stubAuditForwarder,
} from './governance/audit-forwarder.js';

export type {
  AuditForwarder,
  HttpAuditForwarderOptions,
  ShellAuditForwarderOptions,
} from './governance/audit-forwarder.js';

export {
  ChainSecretResolver,
  describeSecretResolver,
  getSecretResolver,
  installSecretResolverIfAvailable,
  registerSecretResolver,
  resetSecretResolver,
  resolveSecretAsync,
  resolveSecretReferenceAsync,
  resolveSecretReferenceSync,
  resolveSecretSync,
  ShellSecretResolver,
} from './secret/secret-resolver.js';

export type {
  ResolveSecretInput,
  SecretReference,
  SecretResolverDescription,
  SecretResolver,
  ShellSecretResolverOptions,
} from './secret/secret-resolver.js';

export {
  consumeTenantBudget,
  inspectTenantBudget,
  withTenantBudget,
  TenantRateLimitExceededError,
} from './organization/tenant-rate-limiter.js';

export type { RateLimitDecision } from './organization/tenant-rate-limiter.js';

export {
  findRelevantDistilledKnowledge,
  formatDistilledKnowledgeSummary,
} from './knowledge/distill-knowledge-injector.js';

export type {
  DistilledKnowledgeEntry,
  FindRelevantInput,
} from './knowledge/distill-knowledge-injector.js';

export {
  loadKnowledgeSlicesFile,
  resolveKnowledgeSlice,
  matchesKnowledgeGlob,
  isKnowledgePathExcluded,
  isKnowledgePathInSearchRoots,
  _resetKnowledgeSlicesCacheForTests,
} from './knowledge/knowledge-slices.js';

export type {
  KnowledgeSliceMatcher,
  KnowledgeSliceDefinition,
  KnowledgeSlicesFile,
  ResolveKnowledgeSliceInput,
  ResolvedKnowledgeSlice,
} from './knowledge/knowledge-slices.js';

export { loadRestrictedActionRules, matchRestrictedAction } from './restricted-action-policy.js';

export type { RestrictedActionMatch, RestrictedActionRule } from './restricted-action-policy.js';

export {
  assertCapabilityAllowed,
  checkCapabilityRestriction,
  evaluateCapabilityRestriction,
  loadCapabilityRestrictionPolicy,
} from './capability-restriction-policy.js';

export type {
  CapabilityRestrictionDecision,
  CapabilityRestrictionPolicy,
  CapabilityRestrictionRecord,
  CapabilityRestrictionStatus,
} from './capability-restriction-policy.js';

export { loadMeetingFacilitatorPolicy } from './meeting/meeting-facilitator-policy.js';

export type { MeetingFacilitatorPolicy } from './meeting/meeting-facilitator-policy.js';

export { MissionEvidenceDoc } from './mission/mission-evidence-doc.js';

export {
  grantVoiceConsent,
  isVoiceConsentRecord,
  loadVoiceConsentAtPath,
  readVoiceConsent,
  revokeVoiceConsent,
} from './voice/voice-consent.js';

export type { VoiceConsentRecord } from './voice/voice-consent.js';

export type { MissionEvidenceDocOptions } from './mission/mission-evidence-doc.js';

export {
  bootstrapManifest,
  computeManifestSignature,
  hasEnvironmentCapabilityProbe,
  loadEnvironmentManifest,
  listEnvironmentManifestIds,
  probeManifest,
  registerEnvironmentCapabilityProbe,
  resolveCapabilityInstall,
  resetEnvironmentCapabilityProbeRegistry,
  verifyManifestSignature,
  verifyReady,
} from './environment-capability.js';

export { installCoreEnvironmentProbes } from './environment-capability-probes.js';

export {
  formatEnvValidationReport,
  getRegisteredEnv,
  loadEnvRegistryFile,
  loadEnvRegistryEntries,
  validateEnv,
  validateEnvAgainstRegistry,
  validateStartupEnv,
  suggestRegisteredEnvNames,
} from './env-validator.js';

export type {
  EnvRegistryValidationEntry,
  EnvRegistryEntry,
  EnvRegistryFile,
  EnvValidationOptions,
  EnvValidationIssue,
  EnvValidationReport,
  RegisteredEnvReadOptions,
} from './env-validator.js';

export type {
  BootstrapOptions,
  CapabilityInstall,
  CapabilityInstallOverride,
  CapabilityKind,
  CapabilityProbe,
  CapabilityStatus,
  EnvironmentCapability,
  EnvironmentManifest,
  ReadinessReport,
  SetupReceipt,
} from './environment-capability.js';

export * from './seam-provider-selection.js';

export * from './seam-selection-rules.js';

export * from './seam-calibration.js';

export * from './authn-principal-resolver.js';

export * from './authn-providers.js';

export * from './authz-policy-engine.js';

export * from './authz-providers.js';

export * from './surface/surface-authn.js';
