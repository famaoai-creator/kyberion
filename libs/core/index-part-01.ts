/** Generated public API barrel part. Keep exports in source order. */

/**
 * @agent/core - Unified Entry Point
 * All shared utilities and wrappers are centralized here.
 * [STABLE RECONSTRUCTION VERSION 2]
 */

// Core Foundation (logger, ui, sre, Cache, fileUtils, errorHandler)
export * from './core.js';
export * from './governance/governance-action-recorder.js';

// Specific Wrappers & Metrics

export * from './plugin/skill-wrapper.js';

export * from './metrics.js';

export * from './generation-cost-settlement.js';

export * from './wire-error.js';

export * from './trust-requiring-resources.js';

export * from './project/project-trust.js';

export * from './resource-provenance.js';

export * from './plugin/skill-resource-loader.js';

export * from './agent/agent-instruction-loader.js';

export * from './reasoning/prompt-visibility-ledger.js';

export * from './scoped-registry.js';

export * from './usage-accounting.js';

export * from './reasoning/reasoning-provider-registry.js';

export * from './reasoning/reasoning-cli-provider.js';

export * from './reasoning/reasoning-api-provider.js';

export * from './analysis/trace-schema.js';

export * from './testing/reasoning-backend-conformance.js';

export * from './reasoning/reasoning-auth-preflight.js';

// Secure IO & Filesystem (Shield Layer)

export * as secureIo from './secure-io.js';

export {
  safeReadFile,
  safeReadFileTail,
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

export * from './reasoning/model-registry-directory.js';

export * from './reasoning/model-registry-contract.js';

export * from './chronos-access-registry.js';

export * from './context-boundary.js';

export * from './scope-context.js';

export * from './knowledge/knowledge-scope.js';

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
} from './media/native-tts.js';

export type {
  SpeakOptions as NativeTtsSpeakOptions,
  SpeakResult as NativeTtsSpeakResult,
  Platform as NativeTtsPlatform,
} from './media/native-tts.js';

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

export { resolveTenantDesign } from './organization/tenant-design-resolver.js';

export * from './surface/channel-registry.js';

export * from './creative-design-resolver.js';

export * from './brand-tokens.js';

export * from './golden-output.js';

export * from './documentation-source-map.js';

export * from './campaign-suite.js';

export * from './config-mission.js';

export * from './marketing-workload.js';

export * from './workforce/artifact-review.js';

export * from './customer-channel-binding.js';

export * from './deal-store.js';

export * from './customer-conversation.js';

export * from './customer-conversation-modes.js';

export * from './surface/operator-notifications.js';

export * from './deal-documents.js';

export * from './mission/mission-retrospective.js';

export * from './reasoning/model-performance-index.js';

export * from './working-principles.js';

export * from './reasoning/reasoning-runtime-instructions.js';

export * from './report-contract.js';

export * from './facet-registry.js';

export * from './design-qa.js';

export * from './apple-intelligence-bridge.js';

export * from './apple-speech-file-stt-bridge.js';

export * from './ten-vad-bridge.js';

export * from './mission/mission-hygiene.js';

export * from './operational-learning.js';

export * from './mission/mission-work-reconciliation.js';

export * from './context-security-scope.js';

export * from './scope-context.js';

export * from './event-scope.js';

export * from './tool/runtime-scope.js';

export * from './scope-migration.js';

export * from './physical-namespace.js';

export * from './config-change.js';

export * from './mcp-request-context.js';

export * from './protocol-service-registry.js';

export * from './protocol-service-lifecycle.js';

export * from './knowledge/memory-scope.js';

export * from './reasoning/reasoning-participant.js';

export * from './participant-context-resolver.js';

// Utils

export * from './fs-utils.js';

export * from './cli-utils.js';

export * from './async-utils.js';

export * from './recovery-policy.js';

export * from './command-runner.js';

export * from './job-lifecycle.js';

export * from './voice/voice-capability-bridge.js';

export * from './voice/voice-path-policy.js';

export * from './camera-output-bridge.js';

export * from './ledger.js';

export * from './text-escaping.js';

export * from './pipeline/logic-utils.js';

export * from './foundation/lock-utils.js';

export * from './pipeline/retry-utils.js';

export * from './validators.js';

export * from './mobile-profile-validators.js';

export * from './schema-loader.js';

export * from './question-resolver.js';

export * from './pipeline/op-input-contracts.js';

export * from './seam.js';

export * from './pipeline/op-suggestions.js';

export * from './pipeline/adf-engine.js';

export * from './pipeline/adf-lifecycle.js';

export * from './surface/channel-adapter.js';

export * from './actuator/actuator-sdk.js';
export * from './actuator/actuator-op-discovery.js';
export * from './pipeline/pipeline-input-contract.js';
export * from './super-nerve-execution-port.js';

export * from './tool/tool-call-scheduler.js';

export * from './autonomous-repair.js';

export * from './pipeline/adf-repair-agent.js';

export * from './operation-policy-gate.js';

export * from './video/video-visual-direction.js';

export * from './video/video-motion-direction.js';

export * from './video/video-scene-composition.js';

export * from './video/video-composition-lint.js';

export * from './reasoning/reasoning-egress-scope.js';

export * from './visual-raster.js';

export * from './visual-review.js';

export * from './visual-review-loop.js';

export * from './workforce/artifact-verification.js';
export * from './training-catalog.js';
export * from './hearing-scenario-catalog.js';

export * from './media/media-brief-lock.js';

export * from './deck-theme-direction.js';

export * from './semantic-decide.js';

export * from './observation-distill.js';

export * from './ranking-signals.js';

export * from './knowledge/knowledge-weight-recalculation.js';

export * from './operation-policy-gate.js';

export * from './ranking-signals.js';

export * from './tool/runtime-health-history.js';

export * from './bridge-typing.js';

export * from './draft-refine.js';

export * from './provider/gemini-embedding-backend.js';

export * from './process-guards.js';

export * from './process-guards.js';

export * from './guided-coordination-brief.js';

export * from './integrations/email-workflow.js';

export * from './meeting/calendar-workflow.js';

export * from './pipeline/op-vocabulary.js';

export * from './mission/mission-gate-engine.js';

export * from './mission/mission-process-task-expansion.js';

export * from './mesh/handoff-packet.js';

export * from './presentation-slide-pattern.js';

export * from './web-design-system.js';

export * from './managed-process.js';

export * from './trigger-correlation.js';

export * from './trigger-runner.js';

export * from './jsonl-tail.js';

export * from './meeting/meeting-environment-policy.js';

export * from './meeting/meeting-participation-runtime-plan.js';

export * from './deliverable-quality.js';

export * from './deliverable-inbox.js';

export * from './media/font-stack.js';

export { resolveInputBindings, classifyInputId, isPathInput } from './input-binding.js';

export type { InputBinding, InputBindingType } from './input-binding.js';

export * from './governance/autonomous-ops-gate.js';

export * from './pipeline/patch-decision.js';
export * from './governance/approval-veto-window.js';

export * from './governance/approval-decision-card.js';

export * from './governance/approval-digest.js';

export * from './governance/approval-decision-routing.js';

export {
  buildNextAction,
  buildNextActionFromError,
  buildCompletionNextAction,
  formatCompletionNextAction,
  formatNextAction,
} from './next-action.js';

export { buildCompletionSummary, reconcileCompletion } from './intent/intent-reconciliation.js';
