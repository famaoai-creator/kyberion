/** Generated public API barrel part. Keep exports in source order. */

export * from './governance/approval-store.js';

export * from './contracts/judge-route.js';

export * from './reasoning/judgment-backend.js';

export * from './provider/typesafe-jev-judgment-backend.js';

export * from './provider/laya-mlx-judgment-backend.js';

export * from './reasoning/judgment-provider-bootstrap.js';

export * from './reasoning/judgment-assist.js';

export * from './reasoning/error-classifier-judgment.js';

export * from './knowledge/knowledge-relevance-judgment.js';

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

export { RISKY_OPS, isKnownRiskyOp, requireApprovalForOp } from './governance/risky-op-registry.js';

export type { RequireApprovalParams, RiskyOpId } from './governance/risky-op-registry.js';

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
} from './organization/relationship-graph-store.js';

export {
  listHeuristics,
  queueHeuristicMemoryCandidate,
  readHeuristic,
  scoreValidity,
  summarizeHeuristics,
  validateHeuristic,
} from './knowledge/heuristic-feedback.js';

export {
  evaluateCustomerSignoffGate,
  evaluateRequirementsCompletenessGate,
  readRequirementsDraft,
  recordCustomerSignoff,
  saveRequirementsDraft,
} from './mission/requirements-draft-store.js';

export type {
  GateResult as RequirementsGateResult,
  RecordSignoffParams,
  RequirementsDraft,
  SaveRequirementsDraftParams,
  SignoffChannel,
  StakeholderSignoff,
} from './mission/requirements-draft-store.js';

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
} from './mission/sdlc-artifact-store.js';

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
} from './agent/coordinated-agent-execution-port.js';

export type {
  CoordinatedAgentExecutionReceipt,
  CoordinatedAgentTaskEnvelope,
} from './agent/coordinated-agent-execution-port.js';

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

/** @deprecated D8 aliases over the promoted lane; removed in the next release. */
export {
  findRelevantDistilledKnowledge,
  formatDistilledKnowledgeSummary,
} from './knowledge/promoted-knowledge-retrieval.js';

export type {
  DistilledKnowledgeEntry,
  FindRelevantInput,
} from './knowledge/promoted-knowledge-retrieval.js';

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

export {
  assertCapabilityAllowed,
  checkCapabilityRestriction,
  evaluateCapabilityRestriction,
  loadCapabilityRestrictionPolicy,
} from './governance/capability-restriction-policy.js';

export type {
  CapabilityRestrictionDecision,
  CapabilityRestrictionPolicy,
  CapabilityRestrictionRecord,
  CapabilityRestrictionStatus,
} from './governance/capability-restriction-policy.js';

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
} from './daemon/environment-capability.js';

export { installCoreEnvironmentProbes } from './daemon/environment-capability-probes.js';

export {
  formatEnvValidationReport,
  getRegisteredEnv,
  loadEnvRegistryFile,
  loadEnvRegistryEntries,
  validateEnv,
  validateEnvAgainstRegistry,
  validateStartupEnv,
  suggestRegisteredEnvNames,
} from './harnessing/env-validator.js';

export type {
  EnvRegistryValidationEntry,
  EnvRegistryEntry,
  EnvRegistryFile,
  EnvValidationOptions,
  EnvValidationIssue,
  EnvValidationReport,
  RegisteredEnvReadOptions,
} from './harnessing/env-validator.js';

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
} from './daemon/environment-capability.js';

export * from './provider/seam-provider-selection.js';

export * from './provider/seam-selection-defaults.js';
export * from './provider/seam-selection-rules.js';

export * from './provider/seam-calibration.js';

export * from './authn/authn-principal-resolver.js';

export * from './authn/authn-providers.js';

export * from './governance/authz-policy-engine.js';

export * from './governance/authz-providers.js';

export * from './surface/surface-authn.js';
