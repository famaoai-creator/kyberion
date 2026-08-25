/** Generated public API barrel part. Keep exports in source order. */

export * from './approval-store.js';

export * from './judge-route.js';

export * from './plugin-source-trust.js';

export * from './plugin-managed-install.js';

export * from './skill-plugin-loader.js';

export * from './provider-capability-scanner.js';

export * from './approval-gate-summary.js';

export { enforceApprovalGate, hasHuman } from './approval-gate.js';

export type { ApprovalGateParams, ApprovalGateResult } from './approval-gate.js';

export * from './lead-score.js';

export * from './inbound-inquiry-adapter.js';

export { RISKY_OPS, isKnownRiskyOp, requireApprovalForOp } from './risky-op-registry.js';

export type { RequireApprovalParams, RiskyOpId } from './risky-op-registry.js';

export {
  DEFAULT_THRESHOLDS as INTENT_DRIFT_THRESHOLDS,
  classifyDrift,
  computeIntentDelta,
  goalSimilarity,
  isBlockingDrift,
} from './intent-delta.js';

export type {
  DriftThresholds,
  DriftVerdict,
  IntentBody,
  IntentDelta,
  IntentDeltaChanges,
  IntentSnapshot,
} from './intent-delta.js';

export {
  emitIntentSnapshot,
  evaluateIntentDriftGate,
  latestSnapshot,
  listSnapshots,
  mapStageToLoopPhase,
  reclassifyDrift,
} from './intent-snapshot-store.js';

export type { EmitSnapshotParams, IntentDriftGateResult } from './intent-snapshot-store.js';

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

export { executeTaskPlan } from './task-executor.js';

export {
  getTaskPlanCoordinator,
  registerTaskPlanCoordinator,
  resetTaskPlanCoordinator,
} from './task-plan-coordinator-port.js';

export type {
  ExecuteTaskPlanParams,
  ExecuteTaskPlanResult,
  TaskExecutionRecord,
  TaskExecutionStatus,
  TaskPlanCoordinatorPort,
} from './task-plan-coordinator-port.js';

export {
  getAgentExecutionPort,
  registerAgentExecutionPort,
  resetAgentExecutionPort,
  SupervisorAgentExecutionPort,
} from './agent-execution-port.js';

export type {
  AgentExecutionPort,
  AgentExecutionReceipt,
  AgentTaskEnvelope,
} from './agent-execution-port.js';

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
} from './work-graph-projection.js';

export type {
  CanonicalWorkGraphRead,
  WorkGraphProjectionDrift,
  WorkGraphProjectionOptions,
  WorkGraphProjectionResult,
} from './work-graph-projection.js';

export {
  getActuatorForwardingPort,
  registerActuatorForwardingPort,
  resetActuatorForwardingPort,
  withActuatorForwardingPort,
} from './actuator-forwarding-port.js';

export type {
  ActuatorForwardingPort,
  ActuatorForwardStatus,
  ActuatorForwardRequest,
  ActuatorForwardReceipt,
} from './actuator-forwarding-port.js';

export {
  getDeploymentAdapter,
  installShellDeploymentAdapterIfAvailable,
  registerDeploymentAdapter,
  resetDeploymentAdapter,
  ShellDeploymentAdapter,
  stubDeploymentAdapter,
} from './deployment-adapter.js';

export type {
  DeployInput,
  DeployResult,
  DeploymentAdapter,
  ShellDeploymentAdapterOptions,
} from './deployment-adapter.js';

export { MobileBetaDeploymentAdapter } from './deployment-adapters/mobile-beta.js';

export type { MobileBetaAdapterOptions } from './deployment-adapters/mobile-beta.js';

export {
  ChainAuditForwarder,
  getAuditForwarder,
  HttpAuditForwarder,
  installAuditForwarderIfAvailable,
  registerAuditForwarder,
  resetAuditForwarder,
  ShellAuditForwarder,
  stubAuditForwarder,
} from './audit-forwarder.js';

export type {
  AuditForwarder,
  HttpAuditForwarderOptions,
  ShellAuditForwarderOptions,
} from './audit-forwarder.js';

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
} from './secret-resolver.js';

export type {
  ResolveSecretInput,
  SecretReference,
  SecretResolverDescription,
  SecretResolver,
  ShellSecretResolverOptions,
} from './secret-resolver.js';

export {
  consumeTenantBudget,
  inspectTenantBudget,
  withTenantBudget,
  TenantRateLimitExceededError,
} from './tenant-rate-limiter.js';

export type { RateLimitDecision } from './tenant-rate-limiter.js';

export {
  findRelevantDistilledKnowledge,
  formatDistilledKnowledgeSummary,
} from './distill-knowledge-injector.js';

export type { DistilledKnowledgeEntry, FindRelevantInput } from './distill-knowledge-injector.js';

export {
  loadKnowledgeSlicesFile,
  resolveKnowledgeSlice,
  matchesKnowledgeGlob,
  isKnowledgePathExcluded,
  isKnowledgePathInSearchRoots,
  _resetKnowledgeSlicesCacheForTests,
} from './knowledge-slices.js';

export type {
  KnowledgeSliceMatcher,
  KnowledgeSliceDefinition,
  KnowledgeSlicesFile,
  ResolveKnowledgeSliceInput,
  ResolvedKnowledgeSlice,
} from './knowledge-slices.js';

export { loadRestrictedActionRules, matchRestrictedAction } from './restricted-action-policy.js';

export type { RestrictedActionMatch, RestrictedActionRule } from './restricted-action-policy.js';

export { loadMeetingFacilitatorPolicy } from './meeting-facilitator-policy.js';

export type { MeetingFacilitatorPolicy } from './meeting-facilitator-policy.js';

export { MissionEvidenceDoc } from './mission-evidence-doc.js';

export type { MissionEvidenceDocOptions } from './mission-evidence-doc.js';

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
  loadEnvRegistryEntries,
  validateEnv,
  validateEnvAgainstRegistry,
} from './env-validator.js';

export type {
  EnvRegistryValidationEntry,
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
