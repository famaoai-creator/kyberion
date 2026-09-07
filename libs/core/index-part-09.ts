/** Generated public API barrel part. Keep exports in source order. */

export * from './mission-orchestration-worker.js';

export * from './mission-orchestration-phase-gates.js';

export * from './mission-next-task-reader.js';

export * from './mission-ticket-dispatch-manifest.js';

export * from './mission-ticket-provider-artifact.js';

export * from './mission-task-events.js';

export * from './worker-assignment-policy.js';

export * from './pipeline-contract.js';

export * from './graph-scheduler.js';

export * from './mission-graph-handoff.js';

export * from './mission-graph-run-journal.js';

export * from './pipeline-run-journal.js';

export * from './pipeline-approval-resume.js';

export * from './graph-run-artifact.js';

export * from './realtime-voice-conversation.js';

export * from './surface-coordination-store.js';

export * from './surface-delivery.js';

export * from './surface-mutation-guard.js';

export * from './surface-request-input.js';

export * from './ceo-surface-summary.js';

export * from './mic-capture.js';

export * from './in-room-minutes-recorder.js';

export * from './pcm-wav.js';

export * from './vad-turn-recorder.js';

export * from './audio-playback.js';

export * from './segmented-voice-playback.js';

export * from './streaming-voice-playback.js';

export * from './audio-tee.js';

export * from './vad-registry.js';

export * from './silero-vad-bridge.js';

export * from './realtime-voice-loop.js';

export * from './actuator-serve-client.js';

export * from './in-room-meeting-driver.js';

export * from './chrome-extension-meeting-driver.js';

export * from './channel-directory.js';

export * from './tool-loop-guardrail.js';

export * from './surface-ingress-contract.js';

export * from './surface-interaction-model.js';

export * from './surface-ux.js';

export * from './surface-provider-manifest.js';

export * from './surface-query-overlay-catalog.js';

export * from './surface-provider-manifest-catalog.js';

export * from './surface-access-policy.js';

export * from './surface-approval-ui.js';

export * from './service-bootstrap-catalog.js';

export * from './service-onboarding-catalog.js';

export * from './service-connection-readiness.js';

export * from './claude-cli-resolution.js';

export * from './surface-provider-policy.js';

export { resolveRef, handleStepError } from './src/pipeline-engine.js';

export type { OnErrorConfig, RefParams } from './src/pipeline-engine.js';

export * from './channel-surface.js';

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
} from './delegation-child-registry.js';

export * from './cowork-health-check.js';

export * from './surface-runtime-router.js';

export * from './surface-runtime-orchestrator.js';

export * from './location-fallback.js';

export * from './surface-response-blocks.js';

export * from './surface-artifact-store.js';

export * from './surface-mission-proposals.js';

export * from './slack-approval-ui.js';

export * from './slack-onboarding.js';

export * from './agent-activity-board.js';

export * from './event-vocabulary.js';

export * from './agent-collaboration-events.js';

export * from './agent-collaboration-projection.js';

export * from './agent-collaboration-tree.js';

export * from './native-subagent-adopter.js';
// Surface-level type definitions (importable without pulling in channel-surface implementation)

export type * from './channel-surface-types.js';
export { isSurfaceAsyncChannel, SURFACE_ASYNC_CHANNELS } from './channel-surface-types.js';

export * from './browser-conversation-session.js';

export * from './peer-conversation.js';

export * from './browser-distill-candidate.js';

export * from './browser-extension-bridge.js';

export * from './narrated-video-preference-profile.js';

export * from './narrated-video-upload-package.js';

export * from './meeting-operations-profile.js';

export * from './meeting-attendees.js';

export * from './mission-seed-assessment.js';

export * from './mission-assessment.js';

export * from './task-distill-candidate.js';

export * from './presence-surface.js';

export * from './presence-avatar.js';

export * from './presence-bridge.js';

export * from './surface-agent-catalog.js';

export * from './surface-query.js';

export * from './surface-ux-contract.js';

export * from './next-action-contract.js';

export * from './task-session.js';

export * from './intent-resolution.js';

export * from './intent-resolution-contract.js';

export * from './intent-track-resolver.js';

export * from './capability-bundle-registry.js';

export * from './outcome-contract.js';

export * from './analysis-contract.js';

export * from './intent-reconciliation.js';

export * from './approval-policy.js';

export * from './router-contract.js';

export * from './analysis-intent-support.js';

export * from './intent-outcome-patterns.js';

export * from './analysis-corpus.js';

export * from './analysis-impact-bands.js';

export * from './analysis-findings.js';

export * from './analysis-execution-contract.js';

export * from './work-design.js';

export * from './work-scope-decision.js';

export * from './mission-execution-surface.js';

export * from './productivity-task-plan.js';

export * from './booking-preference-profile.js';

export * from './presentation-preference-profile.js';

export * from './project-registry.js';

export * from './project-management.js';

export * from './project-operational-state-registry.js';

export * from './project-track-registry.js';

export * from './sdlc-gate-readiness.js';

export * from './service-binding-registry.js';

export * from './artifact-record.js';

export * from './artifact-bundle.js';

export * from './artifact-registry.js';

export * from './control-plane-client.js';

export * from './computer-surface.js';

export * from './apple-event-bridge.js';

export * from './os-automation-platform.js';

export * from './platform-command-adapters.js';

export * from './desktop-launch-adapter.js';

export * from './windows-native-image-generation-bridge.js';

export * from './os-automation-bridge.js';

export * from './macos-automation-bridge.js';

export * from './os-app-adapters.js';

export * from './service-binding.js';

export * from './oauth-broker.js';

export * from './cloudflare-os-control-plane.js';

export * from './cloudflare-os-surface.js';

export * from './share-grant-graph.js';

export * from './share-grant-live-sessions.js';

export * from './share-grant-authorizer.js';

export * from './provenance-taint.js';

export * from './tenant-registry.js';

export * from './tenant-activation.js';

export * from './tenant-governance.js';

export * from './entity-scope.js';

export * from './tenant-knowledge-retrieval.js';

export * from './ingest-asset-ledger.js';

export * from './ingest-quota.js';

export * from './ingest-sync-cursors.js';

export * from './pii-scrubber.js';

export * from './frame-redaction.js';

export * from './screen-frame-redaction.js';

export * from './desktop-recording.js';

export * from './desktop-recording-compiler.js';

export * from './desktop-promotion-transaction.js';

export * from './desktop-pipeline.js';

export * from './desktop-event-feed.js';

export * from './desktop-intent-reconstruction.js';

export * from './native-op-mapping.js';

export * from './trace-procedure-candidate.js';

export * from './ingest-tier-gate.js';

export * from './generation-scheduler.js';

export * from './generation-quota.js';

export * from './src/pipeline-scheduler.js';

export * from './src/pipeline-preview.js';

// Governance (Agent Governance Toolkit inspired)

export * from './policy-engine.js';

export * from './trust-engine.js';

export * from './audit-chain.js';

export * from './agent-slo.js';

export * from './kill-switch.js';

export * from './subagent-capability-profiles.js';

export * from './subagent-prompt-framing.js';

export * from './claude-native-subagent.js';

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
} from './src/actuator-capability.js';

export type { ActuatorCapability, ActuatorStatus } from './src/actuator-capability.js';

export {
  buildActuatorManifestIndexSnapshot,
  loadActuatorManifest,
  loadActuatorManifestCatalog,
} from './src/actuator-manifest-index.js';

export type {
  ActuatorCatalogEntry,
  ActuatorManifestCapability,
  ActuatorManifestCapabilityPrerequisites,
  ActuatorManifestCapabilityRequirements,
  ActuatorManifestFile,
} from './src/actuator-manifest-index.js';

// Pre-Flight Check (Sovereign Sentinel)

export * from './src/pfc/PfcController.js';

export * from './src/pfc/PhysicalLayer.js';

export * from './src/pfc/ServiceValidator.js';

export * from './src/pfc/SovereignSentinel.js';

// Observability (Unified Trace Model)

export {
  TraceContext,
  persistTrace,
  finalizeAndPersist,
  traceLogDir,
  exportTraceOtlp,
} from './src/trace.js';

export { createActuatorTrace, finalizeActuatorTrace } from './actuator-trace.js';

export type { Trace, TraceSpan, TraceEvent, TraceArtifact } from './src/trace.js';

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
} from './src/feedback-loop.js';

export type { FailedScheduleFinding } from './src/feedback-loop.js';

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
} from './src/knowledge-feedback-loop.js';
