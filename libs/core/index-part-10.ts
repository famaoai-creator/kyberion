/** Generated public API barrel part. Keep exports in source order. */

export type {
  DeliveredKnowledgeRef,
  KnowledgeDeliveryRecord,
  KnowledgeUsageAggregateEntry,
  HumanKnowledgeFeedback,
  KnowledgeGapRecord,
  SlackKnowledgeReactionInput,
  KnowledgeFeedbackCap,
} from './src/knowledge-feedback-loop.js';

// KP-06: effectiveness-driven curation + freshness SLO report, built from
// KP-05's delivery/usage aggregate. Candidates only — no auto demotion.

export {
  computeCurationReport,
  generateKnowledgeCurationReport,
  loadCurationSloConfig,
  renderCurationReportMarkdown,
  writeCurationReport,
  knowledgeCurationReportPath,
  knowledgeCurationSloConfigPath,
} from './src/knowledge-curation-report.js';

export type {
  CurationSloConfig,
  CurationLowYieldHint,
  CurationFreshnessBreach,
  CurationArchiveAdvisory,
  KnowledgeCurationReport,
} from './src/knowledge-curation-report.js';
// DA-08: tenant-ingested cards join the weekly curation cycle (advisory only).

export {
  computeTenantIngestCuration,
  TENANT_INGEST_DEFAULT_KIND,
} from './src/knowledge-curation-tenant-ingest.js';

export type {
  TenantIngestCurationEntry,
  TenantIngestCurationSection,
} from './src/knowledge-curation-tenant-ingest.js';

// JSON repair (Paper2Any pattern — lightweight structural repair before LLM escalation)

export { tryRepairJson, repairJsonString } from './json-repair.js';

// Semaphore (Paper2Any pattern — LLM concurrency guard, prevents 429 rate-limit errors)

export { Semaphore, llmSemaphore } from './semaphore.js';

// Prompt constraints (Paper2Any pattern — reusable output constraint fragments)

export {
  JSON_OUTPUT_CONSTRAINTS,
  JSON_OBJECT_CONSTRAINTS,
  JSON_ARRAY_CONSTRAINTS,
  jsonOutputConstraints,
  VALIDATOR_CHAIN_PATTERN,
} from './prompt-constraints.js';

export type { ValidatorName } from './prompt-constraints.js';

// BlackHole routing guard (SIGINT safety — restores system mic on Ctrl+C)

export {
  markRouterActive,
  markRouterInactive,
  isRouterActive,
  resetRouterSync,
} from './blackhole-routing-guard.js';

// ---------------------------------------------------------------------------
// Intent-driven automation (P0-P4) — procedure catalog, compiler, dispatcher,
// and self-repair.  All browser-execution types are in browser-extension-bridge
// (already exported above).
// ---------------------------------------------------------------------------

export type {
  ProcedureEntry,
  ProcedureCatalog,
  ProcedureSubstrate,
  ProcedureResolution,
  ProcedureDelta,
  GoldenScenario,
  GoldenSuccessCondition,
  ProcedureRiskClass,
} from './procedure-types.js';

export { PROCEDURE_RESOLUTION_THRESHOLDS } from './procedure-types.js';

export {
  loadProcedures,
  invalidateProcedureCache,
  resolveAllowlistedRecordingRef,
  resolveProcedure,
} from './procedure-registry.js';

export type { ResolveOptions } from './procedure-registry.js';

export { isDryRunSafe, compileBrowserRecording } from './browser-recording-compiler.js';

export type {
  CompiledBrowserStep,
  CompileOptions,
  CompileRecordingResult,
} from './browser-recording-compiler.js';

export { promoteBrowserProcedure } from './browser-procedure-promotion.js';

export type {
  PromoteBrowserProcedureOptions,
  PromoteBrowserProcedureResult,
} from './browser-procedure-promotion.js';
// dispatchProcedure — re-exports extendLeaseForMfa from browser-extension-bridge (already exported above)

export { dispatchProcedure } from './procedure-dispatcher.js';

export type { DispatchInput, DispatchResult, DispatchStatus } from './procedure-dispatcher.js';

export {
  classifyFailure,
  createProcedureDelta,
  saveProcedureDelta,
  loadProcedureDelta,
  suggestRepairAnchor,
  applyProcedureDelta,
} from './procedure-self-repair.js';

export { collectProcedureUserInputs } from './procedure-inputs.js';

export type { ProcedureInputField } from './procedure-inputs.js';
// Service substrate (intent-driven automation adapter)

export {
  validateServiceRecording,
  isExternalEffectStep,
  collectServiceInputNames,
} from './service-recording.js';

export type { ServiceRecording, ServiceRecordingStep } from './service-recording.js';

export { serviceRecordingContentHash } from './service-recording.js';

export { compileServiceRecording } from './service-recording-compiler.js';

export type { CompileServiceOptions, CompileServiceResult } from './service-recording-compiler.js';

export {
  assessServiceDistillCandidate,
  buildServiceProcedureCandidate,
} from './service-distill-candidate.js';

export type {
  BuildServiceProcedureCandidateOptions,
  ServiceDistillCandidateAssessment,
  ServiceDistillCandidateAssessmentInput,
  ServiceProcedureCandidateResult,
} from './service-distill-candidate.js';

export {
  ServiceRecordingSession,
  getServiceRecordingSession,
  recordServiceCall,
  startServiceRecordingSession,
  stopServiceRecordingSession,
} from './service-recording-session.js';

export type {
  RecordedServiceCall,
  ServiceCallObservation,
  ServiceRecordedParameterKind,
  ServiceRecordingSessionOptions,
} from './service-recording-session.js';

export { promoteServiceProcedure } from './service-procedure-promotion.js';

export type {
  PromoteServiceProcedureOptions,
  PromoteServiceProcedureResult,
} from './service-procedure-promotion.js';

export { executeServiceProcedure, resolveServiceParams } from './service-procedure-executor.js';

export type {
  ServicePresetRunner,
  ServiceStepResult,
  ExecuteServiceProcedureInput,
  ExecuteServiceProcedureResult,
} from './service-procedure-executor.js';

export { SERVICE_EXTERNAL_EFFECT_OP } from './procedure-dispatcher.js';

// KD-04: untrusted input injection framing contract

export type { FrameUntrustedInputParams } from './untrusted-input-framing.js';

export { frameUntrustedInput, UNTRUSTED_DATA_BOILERPLATE } from './untrusted-input-framing.js';

// SA-03 Prompt Injection & Untrusted Content Defense

export type { ScanOptions } from './untrusted-content.js';

export {
  wrapUntrusted,
  scanForInjection,
  scanForInjectionAsync,
  isInjectionSuspected,
  setInjectionSuspected,
  processUntrustedContent,
  processUntrustedContentAsync,
  sanitizeUntrustedContentAsync,
} from './untrusted-content.js';

// QM-04: inbound security-screening primitives (shadow rollout, fail-closed
// verdicts, quarantine, posture floor). QM-05 lives in shell-command-normalize
// and is re-exported through shell-command-policy consumers.

export type {
  SecurityPosture,
  ScreenSource,
  ScreenPayload,
  ScreenDecision,
  ScreenOutcome,
  ShadowAgreement,
  ShadowComparison,
  QuarantineRecord,
} from './security-screen.js';

export {
  POSTURE_RANK,
  parsePosture,
  composeSecurityPosture,
  resolveConfiguredPosture,
  MAX_SCREEN_PAYLOAD_CHARS,
  buildScreenPayload,
  firstJsonObject,
  parseScreenVerdict,
  unscreenedNotice,
  runShadowScreen,
  auditShadowComparison,
  recordQuarantine,
  listQuarantineRecords,
  quarantineStub,
  filterTaintedForModelContext,
} from './security-screen.js';

export {
  compileSafeRegex,
  scannableCommand,
  scannableUnits,
  simpleCommands,
} from './shell-command-normalize.js';

export { shellCommandApprovalDescriptor } from './shell-command-policy.js';

export type { SimpleCommand } from './shell-command-normalize.js';

// QM-07: git-imported plugin packs (provenance-gated, archive-not-delete).

export type {
  PluginPackSyncMode,
  PluginPackPluginEntry,
  PluginPackRecord,
  PluginPackRegistry,
  PackImportRecord,
  ImportPluginPackParams,
  ImportPluginPackResult,
} from './plugin-pack.js';

export {
  loadPluginPackRegistry,
  listPackImportRecords,
  assertSafePackUrl,
  packIdFromUrl,
  discoverPackPluginDirs,
  importPluginPack,
} from './plugin-pack.js';

// QM-06: declared backend capability profiles + failover reset-on-switch.

export type {
  BackendDataEgress,
  BackendInputModality,
  BackendRouteCapability,
  BackendCapabilityProfile,
  BackendTransport,
  BackendUtilityFit,
  ConstrainedSampling,
  ConstrainedSamplingRequest,
  GrammarSamplingRequest,
  ThinkingLevel,
  ThinkingLevelMap,
} from './backend-capability-profile.js';

export {
  BACKEND_CAPABILITY_PROFILES,
  availableThinkingLevels,
  backendRouteCapabilities,
  backendCapabilityProfile,
  backendCapabilityProfileForIdentifier,
  isLocalOnlyReasoningBackend,
  modesWithUtilityFit,
  resolveConstrainedSampling,
  resolveThinkingLevel,
} from './backend-capability-profile.js';
