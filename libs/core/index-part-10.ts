/** Generated public API barrel part. Keep exports in source order. */

export type {
  DeliveredKnowledgeRef,
  KnowledgeDeliveryRecord,
  KnowledgeUsageAggregateEntry,
  HumanKnowledgeFeedback,
  KnowledgeGapRecord,
  SlackKnowledgeReactionInput,
  KnowledgeFeedbackCap,
} from './knowledge/knowledge-feedback-loop.js';

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
} from './knowledge/knowledge-curation-report.js';

export type {
  CurationSloConfig,
  CurationLowYieldHint,
  CurationFreshnessBreach,
  CurationArchiveAdvisory,
  KnowledgeCurationReport,
} from './knowledge/knowledge-curation-report.js';
// DA-08: tenant-ingested cards join the weekly curation cycle (advisory only).

export {
  computeTenantIngestCuration,
  TENANT_INGEST_DEFAULT_KIND,
} from './knowledge/knowledge-curation-tenant-ingest.js';

export type {
  TenantIngestCurationEntry,
  TenantIngestCurationSection,
} from './knowledge/knowledge-curation-tenant-ingest.js';

// JSON repair (Paper2Any pattern — lightweight structural repair before LLM escalation)

export { tryRepairJson, repairJsonString } from './json-repair.js';

// Semaphore (Paper2Any pattern — LLM concurrency guard, prevents 429 rate-limit errors)

export { Semaphore, llmSemaphore } from './semaphore.js';

// Prompt constraints (Paper2Any pattern — reusable output constraint fragments)

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
} from './knowledge/procedure-types.js';

export { PROCEDURE_RESOLUTION_THRESHOLDS } from './knowledge/procedure-types.js';

export {
  loadProcedures,
  invalidateProcedureCache,
  resolveAllowlistedRecordingRef,
  resolveProcedure,
} from './knowledge/procedure-registry.js';

export type { ResolveOptions } from './knowledge/procedure-registry.js';

export { isDryRunSafe, compileBrowserRecording } from './browser/browser-recording-compiler.js';

export type {
  CompiledBrowserStep,
  CompileOptions,
  CompileRecordingResult,
} from './browser/browser-recording-compiler.js';

export { promoteBrowserProcedure } from './browser/browser-procedure-promotion.js';

export type {
  PromoteBrowserProcedureOptions,
  PromoteBrowserProcedureResult,
} from './browser/browser-procedure-promotion.js';
// dispatchProcedure — re-exports extendLeaseForMfa from browser-extension-bridge (already exported above)

export { dispatchProcedure } from './knowledge/procedure-dispatcher.js';

export type {
  DispatchInput,
  DispatchResult,
  DispatchStatus,
} from './knowledge/procedure-dispatcher.js';

export {
  classifyFailure,
  createProcedureDelta,
  saveProcedureDelta,
  loadProcedureDelta,
  suggestRepairAnchor,
  applyProcedureDelta,
} from './knowledge/procedure-self-repair.js';

export { collectProcedureUserInputs } from './knowledge/procedure-inputs.js';

export type { ProcedureInputField } from './knowledge/procedure-inputs.js';
// Service substrate (intent-driven automation adapter)

export {
  validateServiceRecording,
  isExternalEffectStep,
  collectServiceInputNames,
} from './service/service-recording.js';

export type { ServiceRecording, ServiceRecordingStep } from './service/service-recording.js';

export { serviceRecordingContentHash } from './service/service-recording.js';

export { compileServiceRecording } from './service/service-recording-compiler.js';

export type {
  CompileServiceOptions,
  CompileServiceResult,
} from './service/service-recording-compiler.js';

export {
  assessServiceDistillCandidate,
  buildServiceProcedureCandidate,
} from './service/service-distill-candidate.js';

export type {
  BuildServiceProcedureCandidateOptions,
  ServiceDistillCandidateAssessment,
  ServiceDistillCandidateAssessmentInput,
  ServiceProcedureCandidateResult,
} from './service/service-distill-candidate.js';

export {
  ServiceRecordingSession,
  getServiceRecordingSession,
  recordServiceCall,
  startServiceRecordingSession,
  stopServiceRecordingSession,
} from './service/service-recording-session.js';

export type {
  RecordedServiceCall,
  ServiceCallObservation,
  ServiceRecordedParameterKind,
  ServiceRecordingSessionOptions,
} from './service/service-recording-session.js';

export { promoteServiceProcedure } from './service/service-procedure-promotion.js';

export type {
  PromoteServiceProcedureOptions,
  PromoteServiceProcedureResult,
} from './service/service-procedure-promotion.js';

export {
  executeServiceProcedure,
  resolveServiceParams,
} from './service/service-procedure-executor.js';

export type {
  ServicePresetRunner,
  ServiceStepResult,
  ExecuteServiceProcedureInput,
  ExecuteServiceProcedureResult,
} from './service/service-procedure-executor.js';

export { SERVICE_EXTERNAL_EFFECT_OP } from './knowledge/procedure-dispatcher.js';

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
} from './shell/shell-command-normalize.js';

export { shellCommandApprovalDescriptor } from './shell/shell-command-policy.js';

export type { SimpleCommand } from './shell/shell-command-normalize.js';

// QM-07: git-imported plugin packs (provenance-gated, archive-not-delete).

export type {
  PluginPackSyncMode,
  PluginPackPluginEntry,
  PluginPackRecord,
  PluginPackRegistry,
  PackImportRecord,
  ImportPluginPackParams,
  ImportPluginPackResult,
} from './plugin/plugin-pack.js';

export {
  loadPluginPackRegistry,
  listPackImportRecords,
  assertSafePackUrl,
  packIdFromUrl,
  discoverPackPluginDirs,
  importPluginPack,
} from './plugin/plugin-pack.js';

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
