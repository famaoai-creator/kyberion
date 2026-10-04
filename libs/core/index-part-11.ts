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
} from './knowledge/memory-notebook.js';

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
} from './knowledge/memory-notebook.js';

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

export * from './software-quality-report-reader.js';

export * from './source-analysis.js';

export * from './agent/agentic-source-review.js';

export * from './agent/agentic-source-review-verification.js';

export * from './windows-local-assist-bridge.js';

export * from './windows-native-image-recognition-bridge.js';

export * from './media/image-description-types.js';

export * from './media/image-description-bridge.js';

export {
  evaluateQualityContract,
  evaluateDefinitionOfReady,
  evaluateAcceptanceCriteria,
  evaluateDefinitionOfDone,
  evaluateTestTraceability,
  parseSoftwareQualityContract,
  parseTestInventoryItem,
  parseTestInventory,
  parseTestExecutionRecord,
  createDefectCandidates,
  buildSoftwareQualityReport,
} from './software-quality.js';

export * from './mission/delegation-notifications.js';

export * from './workforce/work-graph.js';

export {
  ReasoningBackendExecutionAdapter,
  delegateWorkItemWithReasoningBackend,
} from './reasoning/reasoning-backend-execution-adapter.js';

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
} from './mission/mission-lifecycle-service.js';

export type {
  MissionLifecycleService,
  MissionLifecycleVerbOptions,
  MissionLifecycleCreateOptions,
  MissionLifecycleStartOptions,
  MissionLifecycleDispatchOptions,
} from './mission/mission-lifecycle-service.js';

// WI-02: work inventory taxonomy, classification, and tenant/personal-scoped
// storage for the business-inventory discovery stage (work-inventory.v1).
export * from './workforce/work-inventory.js';
export * from './workforce/work-inventory-scoring.js';
export * from './workforce/work-inventory-consent.js';
export * from './workforce/work-inventory-observation.js';
export * from './workforce/work-inventory-decompose.js';
export * from './workforce/work-inventory-harvest.js';
export * from './workforce/work-inventory-promotion.js';
export * from './html-to-markdown.js';

// Dot charters: declarative standing-responsibility contracts for resident
// agents (see dots/README.md and knowledge/product/architecture/resident-dot-model.md).
export * from './dot/dot-charter.js';
export * from './dot/dot-runtime.js';
export * from './dot/dot-wake-orchestration.js';
export * from './dot/dot-lifecycle.js';
export * from './dot/dot-inbox.js';
export * from './dot/dot-proposals.js';
export * from './dot/dot-dispatch.js';
export * from './dot/dot-feedback.js';
export * from './dot/dot-state-paths.js';
export * from './key-result-spec.js';
export * from './dot/dot-extensions.js';
export * from './dot/dot-extension-registry.js';
export * from './dot/dot-extension-bootstrap.js';
export * from './dot/dot-wake-backend.js';
export * from './dot/dot-key-results.js';
export * from './dot/dot-memory.js';
export * from './dot/dot-followups.js';
export * from './dot/dot-event-intake.js';
export * from './dot/dot-budget.js';
export * from './dot/dot-executor.js';
export * from './governance/org-budget-governor.js';
export * from './dot/dot-outcomes.js';
export * from './dot/dot-arbitration.js';
export * from './dot/dot-autonomy.js';
export * from './ingress/public-ingress-contract.js';
export * from './ingress/public-ingress-seam.js';
export * from './ingress/public-ingress-provider-registry.js';
