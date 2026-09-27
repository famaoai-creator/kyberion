/** Generated public API barrel part. Keep exports in source order. */

export * from './mission/mission-orchestration-worker.js';

export * from './mission/mission-orchestration-phase-gates.js';

export * from './mission/mission-next-task-reader.js';

export * from './mission/mission-ticket-dispatch-manifest.js';

export * from './mission/mission-ticket-provider-artifact.js';

export * from './mission/mission-task-events.js';

export * from './workforce/worker-assignment-policy.js';

export * from './pipeline/pipeline-contract.js';

export * from './graph-scheduler.js';

export * from './mission/mission-graph-handoff.js';

export * from './mission/mission-graph-run-journal.js';

export * from './pipeline/pipeline-run-journal.js';

export * from './pipeline/pipeline-approval-resume.js';

export * from './graph-run-artifact.js';

export * from './voice/realtime-voice-conversation.js';

export * from './realtime-media-session.js';

export * from './surface/surface-coordination-store.js';

export * from './surface/surface-delivery.js';

export * from './surface/surface-mutation-guard.js';

export * from './surface/surface-request-input.js';

export * from './ceo-surface-summary.js';

export * from './mic-capture.js';

export * from './in-room-minutes-recorder.js';

export * from './pcm-wav.js';

export * from './voice/vad-turn-recorder.js';

export * from './voice/audio-playback.js';

export * from './segmented-voice-playback.js';

export * from './streaming-voice-playback.js';

export * from './voice/audio-tee.js';

export * from './voice/vad-registry.js';

export * from './silero-vad-bridge.js';

export * from './voice/realtime-voice-loop.js';

export * from './actuator/actuator-serve-client.js';

export * from './in-room-meeting-driver.js';

export * from './browser/chrome-extension-meeting-driver.js';

export * from './surface/channel-directory.js';

export * from './tool/tool-loop-guardrail.js';

export * from './surface/surface-ingress-contract.js';

export * from './surface/surface-interaction-model.js';

export * from './surface/surface-ux.js';

export * from './surface/surface-provider-manifest.js';

export * from './surface/surface-query-overlay-catalog.js';

export * from './surface/surface-provider-manifest-catalog.js';

export * from './surface/surface-access-policy.js';

export * from './surface/surface-approval-ui.js';

export * from './service/service-bootstrap-catalog.js';

export * from './service/service-onboarding-catalog.js';

export * from './service/service-connection-readiness.js';

export * from './provider/claude-cli-resolution.js';

export * from './surface/surface-provider-policy.js';

export { resolveRef, handleStepError } from './pipeline/pipeline-engine.js';

export type { OnErrorConfig, RefParams } from './pipeline/pipeline-engine.js';

export * from './surface/channel-surface.js';

export * from './cowork-surface.js';
export {
  loadCoworkArtifactPacketAtPath,
  validateCoworkArtifactPacket,
} from './cowork-artifact-packet.js';

export * from './cowork-knowledge-bridge.js';

export {
  delegationChildrenRegistryPath,
  loadDelegationChildrenRegistryAtPath,
  writeDelegationChildrenRegistryAtPath,
} from './mission/delegation-child-registry.js';

export * from './cowork-health-check.js';

export * from './surface/surface-runtime-router.js';

export * from './surface/surface-runtime-orchestrator.js';

export * from './location-fallback.js';

export * from './surface/surface-response-blocks.js';

export * from './surface/surface-artifact-store.js';

export * from './surface/surface-mission-proposals.js';

export * from './integrations/slack-approval-ui.js';

export * from './integrations/slack-onboarding.js';

export * from './agent/agent-activity-board.js';

export * from './event-vocabulary.js';

export * from './agent/agent-collaboration-events.js';

export * from './agent/agent-collaboration-projection.js';

export * from './agent/agent-collaboration-tree.js';

export * from './media/native-subagent-adopter.js';
// Surface-level type definitions (importable without pulling in channel-surface implementation)

export type * from './surface/channel-surface-types.js';
export { isSurfaceAsyncChannel, SURFACE_ASYNC_CHANNELS } from './surface/channel-surface-types.js';

export * from './browser/browser-conversation-session.js';

export * from './mesh/peer-conversation.js';

export * from './browser/browser-distill-candidate.js';

export * from './browser/browser-extension-bridge.js';

export * from './video/narrated-video-preference-profile.js';

export * from './video/narrated-video-upload-package.js';

export * from './meeting/meeting-operations-profile.js';

export * from './meeting/meeting-attendees.js';

export * from './mission/mission-seed-assessment.js';

export * from './mission/mission-assessment.js';

export * from './task/task-distill-candidate.js';

export * from './presence-surface.js';

export * from './presence-avatar.js';

export * from './presence-bridge.js';

export * from './surface/surface-agent-catalog.js';

export * from './surface/surface-query.js';

export * from './surface/surface-ux-contract.js';

export * from './next-action-contract.js';

export * from './task/task-session.js';

export * from './intent/intent-resolution.js';

export * from './intent/intent-resolution-contract.js';

export * from './intent/intent-track-resolver.js';

export * from './capability-bundle-registry.js';

export * from './outcome-contract.js';

export * from './analysis/analysis-contract.js';

export * from './intent/intent-reconciliation.js';

export * from './governance/approval-policy.js';

export * from './router-contract.js';

export * from './analysis/analysis-intent-support.js';

export * from './intent/intent-outcome-patterns.js';

export * from './analysis/analysis-corpus.js';

export * from './analysis/analysis-impact-bands.js';

export * from './analysis/analysis-findings.js';

export * from './analysis/analysis-execution-contract.js';

export * from './workforce/work-design.js';

export * from './workforce/work-scope-decision.js';

export * from './mission/mission-execution-surface.js';

export * from './productivity-task-plan.js';

export * from './meeting/booking-preference-profile.js';

export * from './presentation-preference-profile.js';

export * from './project/project-registry.js';

export * from './project/project-management.js';

export * from './project/project-operational-state-registry.js';

export * from './project/project-track-registry.js';

export * from './sdlc-gate-readiness.js';

export * from './service/service-binding-registry.js';

export * from './workforce/artifact-record.js';

export * from './workforce/artifact-bundle.js';

export * from './workforce/artifact-registry.js';

export * from './control-plane-client.js';

export * from './virtual/computer-surface.js';

export * from './apple-event-bridge.js';

export * from './virtual/os-automation-platform.js';

export * from './platform-command-adapters.js';

export * from './virtual/desktop-launch-adapter.js';

export * from './windows-native-image-generation-bridge.js';

export * from './virtual/os-automation-bridge.js';

export * from './macos-automation-bridge.js';

export * from './virtual/os-app-adapters.js';

export * from './service/service-binding.js';

export * from './oauth-broker.js';

export * from './cloudflare-os-control-plane.js';

export * from './cloudflare-os-surface.js';

export * from './share-grant-graph.js';

export * from './share-grant-live-sessions.js';

export * from './share-grant-authorizer.js';

export * from './provenance-taint.js';

export * from './organization/tenant-registry.js';

export * from './organization/tenant-activation.js';

export * from './organization/tenant-governance.js';

export * from './entity-scope.js';

export * from './organization/tenant-knowledge-retrieval.js';

export * from './ingest-asset-ledger.js';

export * from './ingest-quota.js';

export * from './ingest-sync-cursors.js';

export * from './pii-scrubber.js';

export * from './frame-redaction.js';

export * from './virtual/screen-frame-redaction.js';

export * from './virtual/desktop-recording.js';

export * from './virtual/desktop-recording-compiler.js';

export * from './virtual/desktop-promotion-transaction.js';

export * from './virtual/desktop-pipeline.js';

export * from './virtual/desktop-event-feed.js';

export * from './virtual/desktop-intent-reconstruction.js';

export * from './media/native-op-mapping.js';

export * from './analysis/trace-procedure-candidate.js';

export * from './ingest-tier-gate.js';

export * from './generation-scheduler.js';

export * from './generation-quota.js';

export * from './pipeline/pipeline-scheduler.js';

export * from './pipeline/pipeline-preview.js';

// Governance (Agent Governance Toolkit inspired)

export * from './governance/policy-engine.js';

export * from './trust-engine.js';

export * from './governance/audit-chain.js';

export * from './agent/agent-slo.js';

export * from './governance/kill-switch.js';

export * from './subagent-capability-profiles.js';

export * from './subagent-prompt-framing.js';

export * from './provider/claude-native-subagent.js';

export {
  buildBridgeErrorReplyText,
  buildBridgeEmptyReplyText,
  shouldPostBridgeError,
  resetBridgeErrorRateLimiter,
  postBridgeError,
  chunkBridgeMessage,
  chunkSurfaceMessage,
  getSurfaceCapability,
  listSurfaceCapabilities,
  isSurfaceFormatError,
  stripSurfaceMarkup,
  sendSurfaceTextWithFallback,
} from './bridge-error-reply.js';

export {
  recordConfigFallback,
  listFallbacks,
  markResolved,
  pruneResolved,
} from './config-fallback-registry.js';

export type { ConfigFallbackEntry, ConfigFallbackReason } from './config-fallback-registry.js';

export {
  recordUnclassifiedError,
  listUnclassifiedErrors,
  markReconciled as markUnclassifiedReconciled,
  pruneReconciled as pruneUnclassifiedReconciled,
} from './unclassified-error-registry.js';

export type { UnclassifiedErrorEntry } from './unclassified-error-registry.js';

export {
  recordUnhandledIntent,
  listUnhandledIntents,
  markIntentsReconciled,
  pruneReconciledIntents,
} from './unhandled-intent-registry.js';

export type { UnhandledIntentEntry, IntentMissType } from './unhandled-intent-registry.js';

// Shared Business Types

export * from './shared-business-types.js';

export * from './types.js';
// export * as visionJudge from './vision-judge.js';

// Actuator Capability Contracts (Dynamic Runtime Detection)

export {
  checkActuatorCapabilities,
  checkAllActuatorCapabilities,
  registerCapabilityProbe,
} from './actuator/actuator-capability.js';

export type { ActuatorCapability, ActuatorStatus } from './actuator/actuator-capability.js';

export {
  buildActuatorManifestIndexSnapshot,
  loadActuatorManifest,
  loadActuatorManifestCatalog,
} from './actuator/actuator-manifest-index.js';

export type {
  ActuatorCatalogEntry,
  ActuatorManifestCapability,
  ActuatorManifestCapabilityPrerequisites,
  ActuatorManifestCapabilityRequirements,
  ActuatorManifestFile,
} from './actuator/actuator-manifest-index.js';

// Pre-Flight Check (Sovereign Sentinel)

export * from './pfc/PfcController.js';

export * from './pfc/PhysicalLayer.js';

export * from './pfc/ServiceValidator.js';

export * from './pfc/SovereignSentinel.js';

// Observability (Unified Trace Model)

export {
  TraceContext,
  persistTrace,
  finalizeAndPersist,
  traceLogDir,
  exportTraceOtlp,
} from './analysis/trace.js';

export { createActuatorTrace, finalizeActuatorTrace } from './actuator/actuator-trace.js';

export type { Trace, TraceSpan, TraceEvent, TraceArtifact } from './analysis/trace.js';

// Feedback Loop (Closed-Loop Automation)

export {
  extractHintsFromTrace,
  persistHints,
  readHintsByCategory,
  checkScheduleHealth,
  recordPipelineResult,
  runFeedbackLoop,
  collectFailedSchedules,
  sweepFailedSchedules,
} from './knowledge/feedback-loop.js';

export type { FailedScheduleFinding } from './knowledge/feedback-loop.js';

// KP-05: knowledge delivery telemetry + task_result knowledge_feedback aggregation

export {
  recordKnowledgeDelivery,
  recordKnowledgeUsageFeedback,
  recordHumanKnowledgeFeedback,
  recordSlackKnowledgeReaction,
  recordKnowledgeGap,
  loadKnowledgeUsageAggregate,
  knowledgeDeliveryLogDir,
  knowledgeUsageAggregatePath,
} from './knowledge/knowledge-feedback-loop.js';
