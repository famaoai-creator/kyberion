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

export * from './analysis/metrics.js';

export * from './finance/generation-cost-settlement.js';

export * from './contracts/wire-error.js';

export * from './governance/trust-requiring-resources.js';

export * from './project/project-trust.js';

export * from './contracts/resource-provenance.js';

export * from './plugin/skill-resource-loader.js';

export * from './agent/agent-instruction-loader.js';

export * from './reasoning/prompt-visibility-ledger.js';

export * from './governance/scoped-registry.js';

export * from './finance/usage-accounting.js';

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
  withSafeAppendFile,
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

export * from './authn/chronos-access-registry.js';

export * from './contracts/context-boundary.js';

export * from './scope-context.js';

export * from './knowledge/knowledge-scope.js';

export type { VolatileScope, VolatileCadence } from './path-resolver.js';

export * as customerResolver from './authn/stance-resolver.js';

// Error Classification (Phase A-7)

export {
  classifyError,
  buildUserFacingError,
  formatClassification,
  getRuleIds as getErrorClassifierRuleIds,
} from './analysis/error-classifier.js';

export type {
  ErrorCategory,
  ErrorClassification,
  UserFacingErrorEnvelope,
} from './analysis/error-classifier.js';

// Native OS TTS (Phase A-5, voice tier 0)

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

export * from './design/creative-design-resolver.js';

export * from './design/brand-tokens.js';

export * from './harnessing/golden-output.js';

export * from './harnessing/documentation-source-map.js';

export * from './media/campaign-suite.js';

export * from './mission/config-mission.js';

export * from './organization/marketing-workload.js';

export * from './workforce/artifact-review.js';

export * from './organization/customer-channel-binding.js';

export * from './organization/deal-store.js';

export * from './organization/customer-conversation.js';

export * from './organization/customer-conversation-modes.js';

export * from './surface/operator-notifications.js';

export * from './organization/deal-documents.js';

export * from './mission/mission-retrospective.js';

export * from './reasoning/model-performance-index.js';

export * from './workforce/working-principles.js';

export * from './reasoning/reasoning-runtime-instructions.js';

export * from './task/report-contract.js';

export * from './plugin/facet-registry.js';

export * from './design/design-qa.js';
export * from './provider/apple-intelligence-bridge.js';

export * from './mission/mission-hygiene.js';

export * from './knowledge/operational-learning.js';

export * from './mission/mission-work-reconciliation.js';

export * from './governance/context-security-scope.js';

export * from './scope-context.js';

export * from './scope-envelope.js';

export * from './event/event-scope.js';

export * from './tool/runtime-scope.js';

export * from './governance/scope-migration.js';

export * from './storage/physical-namespace.js';

export * from './storage-layout.js';

export * from './storage/scratch-promotion.js';

export * from './governance/config-change.js';

export * from './service/protocol-service-registry.js';

export * from './service/protocol-service-lifecycle.js';

export * from './knowledge/memory-scope.js';

export * from './reasoning/reasoning-participant.js';

export * from './reasoning/participant-context-resolver.js';

// Utils

export * from './storage/fs-utils.js';

export * from './harnessing/cli-utils.js';

export * from './pipeline/async-utils.js';

export * from './pipeline/recovery-policy.js';

export * from './harnessing/command-runner.js';

export * from './tool/job-lifecycle.js';

export * from './media/camera-output-bridge.js';

export * from './governance/ledger.js';

export * from './foundation/text-escaping.js';

export * from './pipeline/logic-utils.js';

export * from './foundation/lock-utils.js';

export * from './pipeline/retry-utils.js';

export * from './foundation/validators.js';

export * from './integrations/mobile-profile-validators.js';

export * from './schema-loader.js';

export * from './intent/question-resolver.js';

export * from './pipeline/op-input-contracts.js';

export * from './seam.js';

export * from './pipeline/op-suggestions.js';

export * from './pipeline/adf-engine.js';

export * from './pipeline/adf-lifecycle.js';

export * from './surface/channel-adapter.js';
export * from './surface/channel-adapter-registry.js';

export * from './actuator/actuator-sdk.js';
export * from './actuator/actuator-op-discovery.js';
export * from './pipeline/pipeline-input-contract.js';
export * from './pipeline/super-nerve-execution-port.js';

export * from './tool/tool-call-scheduler.js';

export * from './pipeline/autonomous-repair.js';

export * from './pipeline/adf-repair-agent.js';

export * from './governance/operation-policy-gate.js';

export * from './video/video-visual-direction.js';

export * from './video/video-motion-direction.js';

export * from './video/video-scene-composition.js';

export * from './reasoning/reasoning-egress-scope.js';

export * from './media/visual-raster.js';

export * from './media/visual-review.js';

export * from './media/visual-review-loop.js';

export * from './workforce/artifact-verification.js';
export * from './organization/training-catalog.js';
export * from './surface/hearing-scenario-catalog.js';

export * from './reasoning/semantic-decide.js';

export * from './reasoning/observation-distill.js';

export * from './knowledge/ranking-signals.js';

export * from './knowledge/knowledge-weight-recalculation.js';

export * from './governance/operation-policy-gate.js';

export * from './knowledge/ranking-signals.js';

export * from './tool/runtime-health-history.js';

export * from './integrations/bridge-typing.js';
export * from './integrations/bridge-poll-loop.js';

export * from './reasoning/draft-refine.js';

export * from './provider/gemini-embedding-backend.js';

export * from './daemon/process-guards.js';

export * from './daemon/process-guards.js';

export * from './intent/guided-coordination-brief.js';
export * from './actuator/coordination-actuator-routing.js';

export * from './integrations/email-workflow.js';

export * from './meeting/calendar-workflow.js';

export * from './pipeline/op-vocabulary.js';

export * from './mission/mission-gate-engine.js';

export * from './mission/mission-process-task-expansion.js';

export * from './mesh/handoff-packet.js';

export * from './design/presentation-slide-pattern.js';

export * from './design/web-design-system.js';

export * from './tool/managed-process.js';

export * from './event/trigger-correlation.js';

export * from './daemon/trigger-runner.js';

export * from './storage/jsonl-tail.js';

export * from './meeting/meeting-environment-policy.js';

export * from './meeting/meeting-participation-runtime-plan.js';

export * from './task/deliverable-quality.js';

export * from './task/deliverable-inbox.js';

export { resolveInputBindings, classifyInputId, isPathInput } from './contracts/input-binding.js';

export type { InputBinding, InputBindingType } from './contracts/input-binding.js';

export * from './governance/autonomous-ops-gate.js';

export * from './pipeline/patch-decision.js';
export * from './governance/approval-veto-window.js';
export * from './governance/operations-halt.js';
export * from './governance/pr-shadow.js';
export * from './governance/mandate-shadow.js';

export * from './governance/approval-decision-card.js';

export * from './governance/approval-digest.js';

export * from './governance/approval-decision-routing.js';

export {
  buildNextAction,
  buildNextActionFromError,
  buildCompletionNextAction,
  formatCompletionNextAction,
  formatNextAction,
} from './surface/next-action.js';

export { buildCompletionSummary, reconcileCompletion } from './intent/intent-reconciliation.js';

export * from './harnessing/build-coordination.js';
export * from './harnessing/build-readiness.js';
export * from './harnessing/build-generation.js';
