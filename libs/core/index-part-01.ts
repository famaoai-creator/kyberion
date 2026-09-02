/** Generated public API barrel part. Keep exports in source order. */

/**
 * @agent/core - Unified Entry Point
 * All shared utilities and wrappers are centralized here.
 * [STABLE RECONSTRUCTION VERSION 2]
 */

// Core Foundation (logger, ui, sre, Cache, fileUtils, errorHandler)
export * from './core.js';
export * from './governance-action-recorder.js';

// Specific Wrappers & Metrics

export * from './skill-wrapper.js';

export * from './capability-wrapper.js';

export * from './metrics.js';

export * from './generation-cost-settlement.js';

export * from './error-codes.js';

export * from './wire-error.js';

export * from './trust-requiring-resources.js';

export * from './project-trust.js';

export * from './resource-provenance.js';

export * from './skill-resource-loader.js';

export * from './agent-instruction-loader.js';

export * from './prompt-visibility-ledger.js';

export * from './scoped-registry.js';

export * from './usage-accounting.js';

export * from './reasoning-provider-registry.js';

export * from './reasoning-cli-provider.js';

export * from './reasoning-api-provider.js';

export * from './trace-schema.js';

export * from './testing/reasoning-backend-conformance.js';

export * from './reasoning-auth-preflight.js';

// Secure IO & Filesystem (Shield Layer)

export * as secureIo from './secure-io.js';

export {
  safeReadFile,
  loadJson,
  safeWriteFile,
  safeAppendFileSync,
  safeCopyFileSync,
  safeMoveSync,
  safeSymlinkSync,
  safeRmSync,
  safeUnlinkSync,
  safeMkdir,
  ensureDir,
  safeExistsSync,
  safeExec,
  safeExecResult,
  safeExecResultAsync,
  safeSpawn,
  buildSafeExecEnv,
  safeReaddir,
  safeStat,
  safeLstat,
  safeReadlink,
  safeOpenAppendFile,
  safeFsyncFile,
  safeCreateExclusiveFileSync,
  safeChmodSync,
  loadJsonIfPresent,
} from './secure-io.js';

// Backward compatibility aliases

export { safeAppendFileSync as safeAppendFile, safeUnlinkSync as safeUnlink } from './secure-io.js';

// Paths & Navigation

export * as pathResolver from './path-resolver.js';

export * from './model-registry-directory.js';

export * from './model-registry-contract.js';

export * from './chronos-access-registry.js';

export * from './context-boundary.js';

export * from './scope-context.js';

export * from './knowledge-scope.js';

export type { VolatileScope, VolatileCadence } from './path-resolver.js';

export * as customerResolver from './customer-resolver.js';

// Error Classification (Phase A-7)

export {
  classifyError,
  buildUserFacingError,
  formatClassification,
  getRuleIds as getErrorClassifierRuleIds,
} from './error-classifier.js';

export type {
  ErrorCategory,
  ErrorClassification,
  UserFacingErrorEnvelope,
} from './error-classifier.js';

// Native OS TTS (Phase A-5, voice tier 0)

export {
  speak as nativeTtsSpeak,
  probeNativeTts,
  currentPlatform as nativeTtsCurrentPlatform,
  hasBuiltInTts as nativeTtsHasBuiltIn,
} from './native-tts.js';

export type {
  SpeakOptions as NativeTtsSpeakOptions,
  SpeakResult as NativeTtsSpeakResult,
  Platform as NativeTtsPlatform,
} from './native-tts.js';

export {
  rootDir,
  knowledge,
  scripts,
  active,
  vault,
  capabilityAssets,
  shared,
  sharedTmp,
  sharedExports,
  isProtected,
  capabilityEntry,
  capabilityDir,
  skillDir,
  missionDir,
  projectWorkspaceDir,
  projectOsDir,
  projectStateDir,
  tenantMissionDir,
  missionEvidenceDir,
  findMissionPath,
  resolve,
  rootResolve,
} from './path-resolver.js';

export { resolveTenantDesign } from './tenant-design-resolver.js';

export * from './channel-registry.js';

export * from './creative-design-resolver.js';

export * from './campaign-suite.js';

export * from './marketing-workload.js';

export * from './artifact-review.js';

export * from './customer-channel-binding.js';

export * from './deal-store.js';

export * from './customer-conversation.js';

export * from './customer-conversation-modes.js';

export * from './operator-notifications.js';

export * from './deal-documents.js';

export * from './mission-retrospective.js';

export * from './model-performance-index.js';

export * from './working-principles.js';

export * from './reasoning-runtime-instructions.js';

export * from './report-contract.js';

export * from './facet-registry.js';

export * from './design-qa.js';

export * from './apple-intelligence-bridge.js';

export * from './apple-speech-file-stt-bridge.js';

export * from './ten-vad-bridge.js';

export * from './mission-hygiene.js';

export * from './operational-learning.js';

export * from './mission-work-reconciliation.js';

export * from './context-security-scope.js';

export * from './scope-context.js';

export * from './event-scope.js';

export * from './runtime-scope.js';

export * from './scope-migration.js';

export * from './physical-namespace.js';

export * from './config-change.js';

export * from './mcp-request-context.js';

export * from './protocol-service-registry.js';

export * from './protocol-service-lifecycle.js';

export * from './memory-scope.js';

export * from './reasoning-participant.js';

export * from './participant-context-resolver.js';

export * from './context-promotion-ledger.js';

// Utils

export * from './fs-utils.js';

export * from './cli-utils.js';

export * from './async-utils.js';

export * from './recovery-policy.js';

export * from './command-runner.js';

export * from './job-lifecycle.js';

export * from './voice-capability-bridge.js';

export * from './voice-path-policy.js';

export * from './ledger.js';

export * from './text-utils.js';

export * from './text-escaping.js';

export * from './src/logic-utils.js';

export * from './src/lock-utils.js';

export * from './src/retry-utils.js';

export { parseData, stringifyData } from './data-utils.js'; // Explicitly avoid detectFormat conflict

export * from './detectors.js';

export * from './validators.js';

export * from './mobile-profile-validators.js';

export * from './schema-loader.js';

export * from './operator-learning.js';

export * from './question-resolver.js';

export * from './op-input-contracts.js';

export * from './seam.js';

export * from './op-suggestions.js';

export * from './adf-engine.js';

export * from './adf-lifecycle.js';

export * from './channel-adapter.js';

export * from './actuator-sdk.js';
export * from './pipeline-input-contract.js';
export * from './super-nerve-execution-port.js';

export * from './tool-call-scheduler.js';

export * from './autonomous-repair.js';

export * from './adf-repair-agent.js';

export * from './operation-policy-gate.js';

export * from './video-visual-direction.js';

export * from './video-motion-direction.js';

export * from './video-scene-composition.js';

export * from './video-composition-lint.js';

export * from './reasoning-egress-scope.js';

export * from './visual-raster.js';

export * from './visual-review.js';

export * from './visual-review-loop.js';

export * from './media-brief-lock.js';

export * from './house-style-distillation.js';

export * from './deck-theme-direction.js';

export * from './semantic-decide.js';

export * from './observation-distill.js';

export * from './ranking-signals.js';

export * from './knowledge-weight-recalculation.js';

export * from './operation-policy-gate.js';

export * from './ranking-signals.js';

export * from './runtime-health-history.js';

export * from './bridge-typing.js';

export * from './draft-refine.js';

export * from './gemini-embedding-backend.js';

export * from './process-guards.js';

export * from './process-guards.js';

export * from './guided-coordination-brief.js';

export * from './email-workflow.js';

export * from './calendar-workflow.js';

export * from './op-vocabulary.js';

export * from './mission-gate-engine.js';

export * from './mission-process-task-expansion.js';

export * from './handoff-packet.js';

export * from './presentation-slide-pattern.js';

export * from './web-design-system.js';

export * from './managed-process.js';

export * from './trigger-correlation.js';

export * from './trigger-runner.js';

export * from './jsonl-tail.js';

export * from './meeting-environment-policy.js';

export * from './meeting-participation-runtime-plan.js';

export * from './deliverable-quality.js';

export * from './deliverable-inbox.js';

export * from './src/font-stack.js';

export { resolveInputBindings, classifyInputId, isPathInput } from './input-binding.js';

export type { InputBinding, InputBindingType } from './input-binding.js';

export { distillIncident, summarizeIncidents } from './incident-distiller.js';

export type { IncidentInput, IncidentRecord } from './incident-distiller.js';

export * from './autonomous-ops-gate.js';

export * from './patch-decision.js';

export { recordTelemetryEvent, isTelemetryEnabled, readTelemetryStats } from './telemetry.js';

export type { TelemetryEvent, TelemetryEventType, TelemetryStats } from './telemetry.js';

export {
  buildNextAction,
  buildNextActionFromError,
  buildCompletionNextAction,
  formatCompletionNextAction,
  formatNextAction,
} from './next-action.js';

export { buildCompletionSummary, reconcileCompletion } from './intent-reconciliation.js';
