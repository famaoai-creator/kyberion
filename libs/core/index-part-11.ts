/** Generated public API barrel part. Keep exports in source order. */

export {
  runBackendConformance,
  type BackendConformanceExec,
  type BackendConformanceReport,
  type BackendConformanceResult,
  type ConformanceEvidenceStatus,
} from './backend-conformance.js';

// QM-09: gap-phase latency attribution for LLM delegations.

export type { BaseGapPhase, GapPhaseSample, GapRecorder } from './gap-phase.js';

export { GAP_PHASES, isKnownGapPhase, createGapRecorder, sanitizeGapSamples } from './gap-phase.js';

// QM-03: memory notebook line grammar — the single source of truth for
// bullet-notebook memory (`- (YYYY-MM-DD) fact`), fold, and consolidation.

export type {
  FoldCaptureResult,
  ConsolidationAction,
  ConsolidationPlan,
} from './memory-notebook.js';

export {
  RECALL_MAX_CHARS,
  MAX_FACTS,
  MEMORY_HEADER,
  isBullet,
  bulletText,
  captureDate,
  bullets,
  normalize,
  dateStr,
  capTail,
  recallBody,
  neutralizeUntrustedProvenance,
  normalizeMemoryFact,
  foldCapture,
  queryBullets,
  DEFAULT_CONSOLIDATE_AFTER,
  consolidationMarker,
  bulletsBelowMarker,
  MEMORY_CONSOLIDATION_PROMPT,
  parseConsolidationActions,
  applyConsolidationActions,
  planConsolidation,
} from './memory-notebook.js';

export {
  exerciseJsonRecordStoreContract,
  type JsonRecordStoreContractAdapter,
  type JsonRecordStoreContractResult,
} from './store-contract.js';

// Software QA lifecycle (QA-01)

export type {
  QualityCheckStatus,
  QualityCheck,
  AcceptanceCriterion,
  QualityWaiver,
  SoftwareQualityContract,
  TestInventoryItem,
  TestInventory,
  QualityEvaluation,
  TestExecutionResult,
  TestExecutionRecord,
  DefectCandidate,
  SoftwareQualityReportSummary,
} from './software-quality.js';

export * from './software-quality-operations.js';

export * from './source-analysis.js';

export * from './agentic-source-review.js';

export * from './agentic-source-review-verification.js';

export * from './windows-local-assist-bridge.js';

export * from './windows-native-image-recognition-bridge.js';

export * from './image-description-types.js';

export * from './image-description-bridge.js';

export * from './local-assist-bridge.js';

export {
  evaluateQualityContract,
  evaluateDefinitionOfReady,
  evaluateAcceptanceCriteria,
  evaluateDefinitionOfDone,
  evaluateTestTraceability,
  createDefectCandidates,
  buildSoftwareQualityReport,
} from './software-quality.js';

export * from './delegation-notifications.js';

export * from './work-graph.js';

export {
  ReasoningBackendExecutionAdapter,
  delegateWorkItemWithReasoningBackend,
} from './reasoning-backend-execution-adapter.js';

// SO-01: governed in-process facade over the mission lifecycle verbs
// (start/create/checkpoint/verify/finish/staff/prewarm/dispatch/pause/resume/status).
// Deliberately NOT barrel-exporting the raw mission-* internals (mission-system,
// mission-creation, mission-lifecycle, mission-state, ...) — those are reached
// only via their own @agent/core/mission-* subpath exports (used by the
// scripts/refactor/*.ts re-export shims), never through this barrel.

export {
  buildMissionLifecycleService,
  missionLifecycleService,
  MissionLifecycleGovernedError,
} from './mission-lifecycle-service.js';

export type {
  MissionLifecycleService,
  MissionLifecycleVerbOptions,
  MissionLifecycleCreateOptions,
  MissionLifecycleStartOptions,
  MissionLifecycleDispatchOptions,
} from './mission-lifecycle-service.js';
