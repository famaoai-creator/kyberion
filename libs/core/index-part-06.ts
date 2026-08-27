/** Generated public API barrel part. Keep exports in source order. */

export type {
  AudioChunk,
  AudioFormat,
  MeetingPlatform,
  MeetingSession,
  MeetingSessionState,
  MeetingSessionStatus,
  MeetingTarget,
  TranscriptChunk,
} from './meeting-session-types.js';

export { abortableAudioChunks } from './meeting-session-types.js';

export * from './barge-in-controller.js';

export { StubAudioBus } from './audio-bus.js';

export type { AudioBus, AudioBusProbe } from './audio-bus.js';

export { BlackHoleAudioBus } from './blackhole-audio-bus.js';

export type { BlackHoleBusOptions } from './blackhole-audio-bus.js';

export { PulseAudioBus } from './pulse-audio-bus.js';

export type { PulseAudioBusOptions } from './pulse-audio-bus.js';

export { resolveAudioBus } from './audio-bus-resolver.js';

export type { AudioBusId } from './audio-bus-resolver.js';

export * from './audio-route.js';

export * from './bounded-audio-queue.js';

export * from './audio-text-similarity.js';

export * from './coreaudio-device-inventory.js';

export * from './coreaudio-output-bridge.js';

export * from './tts-loopback-verifier.js';

export * from './audio-device-lease.js';

export { StubVideoFrameBus } from './video-frame-bus.js';

export type { VideoFrameBus, VideoFrameBusProbe } from './video-frame-bus.js';

export {
  pipeMp4ToVideoFrameBus,
  readVideoFramesFromMp4,
  writeVideoFrameBusToMp4,
  writeVideoFramesToMp4,
} from './video-frame-archive.js';

export type { VideoFrameArchiveOptions, VideoFrameArchiveResult } from './video-frame-archive.js';

export { SCREEN_CAPTURE_BRIDGE_ID, createScreenCaptureBridge } from './screen-capture-bridge.js';

export type {
  ScreenCaptureBridge,
  ScreenCaptureBridgeOptions,
  ScreenCaptureBridgeProbe,
  ScreenCaptureBackendId,
  ScreenCaptureRequest,
  ScreenCaptureStreamRequest,
  ScreenCaptureResult,
} from './screen-capture-bridge.js';

export {
  SCREEN_RECORDING_BRIDGE_ID,
  createScreenRecordingBridge,
} from './screen-recording-bridge.js';

export type {
  ScreenRecordingBridge,
  ScreenRecordingBridgeOptions,
  ScreenRecordingBridgeProbe,
} from './screen-recording-bridge.js';

export {
  SCREEN_DISPLAY_INVENTORY_BRIDGE_ID,
  createScreenDisplayInventoryBridge,
} from './screen-display-inventory-bridge.js';

export type {
  ScreenDisplayInventoryBridge,
  ScreenDisplayInventoryOptions,
  ScreenDisplayInventoryProbe,
  ScreenDisplayInventory,
  ScreenDisplayRecord,
} from './screen-display-inventory-bridge.js';

export {
  VIRTUAL_AUDIO_DEVICE_BRIDGE_ID,
  createVirtualAudioDeviceBridge,
} from './virtual-audio-device-bridge.js';

export type {
  VirtualAudioDeviceBridge,
  VirtualAudioDeviceBridgeOptions,
  VirtualAudioDeviceBridgeProbe,
} from './virtual-audio-device-bridge.js';

export {
  VIRTUAL_AUDIO_OUTPUT_PLAYBACK_BRIDGE_ID,
  createVirtualAudioOutputPlaybackBridge,
} from './virtual-audio-output-playback-bridge.js';

export type {
  VirtualAudioOutputPlaybackBridge,
  VirtualAudioOutputPlaybackBridgeOptions,
  VirtualAudioOutputPlaybackProbe,
  VirtualAudioOutputPlaybackTargetResult,
} from './virtual-audio-output-playback-bridge.js';

export {
  VIRTUAL_AUDIO_INPUT_RECORDING_BRIDGE_ID,
  createVirtualAudioInputRecordingBridge,
} from './virtual-audio-input-recording-bridge.js';

export type {
  VirtualAudioInputRecordingBridge,
  VirtualAudioInputRecordingBridgeOptions,
  VirtualAudioInputRecordingProbe,
  VirtualAudioInputRecordingRequest,
  VirtualAudioInputRecordingTargetResult,
} from './virtual-audio-input-recording-bridge.js';

export {
  VIRTUAL_DEVICE_INVENTORY_BRIDGE_ID,
  createVirtualDeviceInventoryBridge,
} from './virtual-device-inventory-bridge.js';

export type {
  VirtualDeviceInventory,
  VirtualDeviceInventoryBridge,
  VirtualDeviceInventoryOptions,
  VirtualDeviceInventoryProbe,
  VirtualDeviceKind,
  VirtualDeviceRecord,
} from './virtual-device-inventory-bridge.js';

export {
  VIRTUAL_INPUT_DEVICE_INVENTORY_BRIDGE_ID,
  createVirtualInputDeviceInventoryBridge,
} from './virtual-input-device-inventory-bridge.js';

export type {
  VirtualInputDeviceInventory,
  VirtualInputDeviceInventoryBridge,
  VirtualInputDeviceInventoryOptions,
  VirtualInputDeviceInventoryProbe,
  VirtualInputDeviceKind,
  VirtualInputDeviceRecord,
} from './virtual-input-device-inventory-bridge.js';

export { VIRTUAL_CAMERA_BRIDGE_ID, createVirtualCameraBridge } from './virtual-camera-bridge.js';

export type {
  VirtualCameraBackendId,
  VirtualCameraBridge,
  VirtualCameraBridgeOptions,
  VirtualCameraBridgeProbe,
  VirtualCameraCaptureRequest,
  VirtualCameraCaptureResult,
  VirtualCameraCaptureStreamRequest,
} from './virtual-camera-bridge.js';

export {
  VIRTUAL_CAMERA_INJECTION_BRIDGE_ID,
  createVirtualCameraInjectionBridge,
} from './virtual-camera-injection-bridge.js';

export type {
  VirtualCameraInjectionBackendId,
  VirtualCameraInjectionBridge,
  VirtualCameraInjectionBridgeOptions,
  VirtualCameraInjectionHostPlan,
  VirtualCameraInjectionMode,
  VirtualCameraInjectionProbe,
  VirtualCameraInjectionRequest,
  VirtualCameraInjectionResult,
  VirtualCameraInjectionStatus,
} from './virtual-camera-injection-bridge.js';

export {
  VIRTUAL_MEDIA_DEVICE_CONTROL_BRIDGE_ID,
  createVirtualMediaDeviceControlBridge,
} from './virtual-media-device-control-bridge.js';

export type {
  VirtualMediaDeviceControlAction,
  VirtualMediaDeviceControlBridgeOptions,
  VirtualMediaDeviceControlProbe,
  VirtualMediaDeviceControlRequest,
  VirtualMediaDeviceControlResult,
  VirtualMediaDeviceControlScope,
  VirtualMediaDeviceSelection,
} from './virtual-media-device-control-bridge.js';

export {
  StubStreamingSpeechToTextBridge,
  getStreamingSttBridge,
  registerStreamingSttBridge,
  resetStreamingSttBridges,
} from './streaming-stt-bridge.js';

export type { StreamingSpeechToTextBridge } from './streaming-stt-bridge.js';

export {
  StubStreamingTextToSpeechBridge,
  getStreamingTtsBridge,
  registerStreamingTtsBridge,
  resetStreamingTtsBridges,
} from './streaming-tts-bridge.js';

export type { StreamingTextToSpeechBridge } from './streaming-tts-bridge.js';

export {
  ShellStreamingSpeechToTextBridge,
  installManagedMlxWhisperStreamingSttBridgeIfAvailable,
  installShellStreamingSttBridge,
  installShellStreamingSttBridgeFromEnv,
} from './shell-streaming-stt-bridge.js';

export type { ShellStreamingSttOptions } from './shell-streaming-stt-bridge.js';

export {
  ShellStreamingTextToSpeechBridge,
  installShellStreamingTtsBridge,
  installShellStreamingTtsBridgeFromEnv,
} from './shell-streaming-tts-bridge.js';

export type { ShellStreamingTtsOptions } from './shell-streaming-tts-bridge.js';

export { EnergyVad, computeChunkDurationMs, computeChunkRms } from './voice-activity-detector.js';

export type {
  EnergyVadOptions,
  VoiceActivityDetector,
  VoiceActivityState,
} from './voice-activity-detector.js';

export {
  StubMeetingJoinDriver,
  getMeetingJoinDriver,
  listMeetingJoinDriversFor,
  registerMeetingJoinDriver,
  resetMeetingJoinDriverRegistry,
} from './meeting-join-driver.js';

export type { MeetingJoinDriver } from './meeting-join-driver.js';

export {
  MeetingParticipationCoordinator,
  checkMeetingParticipationConsent,
} from './meeting-participation-coordinator.js';

export type {
  ConversationAgent,
  MeetingParticipationOptions,
  MeetingParticipationReport,
} from './meeting-participation-coordinator.js';

export {
  redactMeetingUrl,
  resolveMeetingPlatform,
  resolveMeetingPlatformFromUrl,
  validateMeetingTarget,
} from './meeting-join-driver.js';

export {
  recordActionItem,
  updateActionItemStatus,
  appendReminder,
  listActionItems,
  listOperatorSelfPending,
  listOthersPending,
  listPendingSpeakerReview,
  listPartialStatePending,
  listRestrictedPending,
  clearPartialState,
  confirmActionItemBySpeaker,
  nextActionItemId,
  summarizeActionItemLifecycle,
} from './action-item-store.js';

export type {
  ActionItem,
  ActionItemAssignee,
  ActionItemAssigneeKind,
  ActionItemExecution,
  ActionItemMeetingRef,
  ActionItemModality,
  ActionItemPolicy,
  ActionItemProvenance,
  ActionItemReminder,
  ActionItemReminderRelationship,
  ActionItemReviewState,
  ActionItemStatus,
  ActionItemLifecycleSummary,
} from './action-item-store.js';

export type {
  DesignSpec,
  GateResult as SdlcGateResult,
  SaveDesignSpecParams,
  SaveTaskPlanParams,
  SaveTestPlanParams,
  TaskPlan,
  TestPlan,
} from './sdlc-artifact-store.js';

export {
  signA2AContent,
  verifyA2AContent,
  canonicalA2AEnvelopeContent,
} from './a2a-envelope-signature.js';
// NI-02: actor-string verification against the NHI registry (warn -> enforce).
