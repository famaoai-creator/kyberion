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
  VideoFormat,
  VideoFrame,
} from './meeting/meeting-session-types.js';

export { abortableAudioChunks } from './meeting/meeting-session-types.js';

export * from './barge-in-controller.js';

export { StubAudioBus } from './voice/audio-bus.js';

export type { AudioBus, AudioBusProbe } from './voice/audio-bus.js';

export { BlackHoleAudioBus } from './blackhole-audio-bus.js';

export type { BlackHoleBusOptions } from './blackhole-audio-bus.js';

export { PulseAudioBus } from './pulse-audio-bus.js';

export type { PulseAudioBusOptions } from './pulse-audio-bus.js';

export { resolveAudioBus } from './voice/audio-bus-resolver.js';

export type { AudioBusId } from './voice/audio-bus-resolver.js';

export * from './voice/audio-route.js';

export * from './bounded-audio-queue.js';

export * from './voice/audio-text-similarity.js';

export * from './coreaudio-device-inventory.js';

export * from './coreaudio-output-bridge.js';

export * from './voice/tts-loopback-verifier.js';

export * from './voice/audio-device-lease.js';

export { StubVideoFrameBus } from './video/video-frame-bus.js';

export type {
  VideoFrameBus,
  VideoFrameBusProbe,
  VideoFrameBusId,
  StubVideoFrameBusOptions,
} from './video/video-frame-bus.js';

export * from './video/video-route.js';

export * from './bounded-video-queue.js';

export * from './video/video-device-lease.js';

export {
  pipeMp4ToVideoFrameBus,
  readVideoFramesFromMp4,
  writeVideoFrameBusToMp4,
  writeVideoFramesToMp4,
} from './video/video-frame-archive.js';

export type {
  VideoFrameArchiveOptions,
  VideoFrameArchiveResult,
} from './video/video-frame-archive.js';

export {
  SCREEN_CAPTURE_BRIDGE_ID,
  createScreenCaptureBridge,
  registerScreenCaptureBackend,
} from './virtual/screen-capture-bridge.js';

export type {
  ScreenCaptureBridge,
  ScreenCaptureBridgeOptions,
  ScreenCaptureBridgeProbe,
  ScreenCaptureBackendId,
  ScreenCaptureBackendAdapter,
  ScreenCaptureBackendInput,
  ScreenCaptureRequest,
  ScreenCaptureStreamRequest,
  ScreenCaptureResult,
} from './virtual/screen-capture-bridge.js';

export {
  SCREEN_RECORDING_BRIDGE_ID,
  createScreenRecordingBridge,
} from './virtual/screen-recording-bridge.js';

export type {
  ScreenRecordingBridge,
  ScreenRecordingBridgeOptions,
  ScreenRecordingBridgeProbe,
} from './virtual/screen-recording-bridge.js';

export {
  SCREEN_DISPLAY_INVENTORY_BRIDGE_ID,
  createScreenDisplayInventoryBridge,
} from './virtual/screen-display-inventory-bridge.js';

export type {
  ScreenDisplayInventoryBridge,
  ScreenDisplayInventoryOptions,
  ScreenDisplayInventoryProbe,
  ScreenDisplayInventory,
  ScreenDisplayRecord,
} from './virtual/screen-display-inventory-bridge.js';

export {
  VIRTUAL_AUDIO_DEVICE_BRIDGE_ID,
  createVirtualAudioDeviceBridge,
} from './virtual/virtual-audio-device-bridge.js';

export type {
  VirtualAudioDeviceBridge,
  VirtualAudioDeviceBridgeOptions,
  VirtualAudioDeviceBridgeProbe,
} from './virtual/virtual-audio-device-bridge.js';

export {
  VIRTUAL_AUDIO_OUTPUT_PLAYBACK_BRIDGE_ID,
  createVirtualAudioOutputPlaybackBridge,
  registerAudioPlaybackBackend,
} from './virtual/virtual-audio-output-playback-bridge.js';

export type {
  VirtualAudioOutputPlaybackBridge,
  VirtualAudioOutputPlaybackBridgeOptions,
  VirtualAudioOutputPlaybackProbe,
  VirtualAudioOutputPlaybackTargetResult,
  AudioPlaybackBackendAdapter,
  AudioOutputPlaybackBackendRequest,
} from './virtual/virtual-audio-output-playback-bridge.js';

export {
  VIRTUAL_AUDIO_INPUT_RECORDING_BRIDGE_ID,
  createVirtualAudioInputRecordingBridge,
  registerAudioInputRecordingBackend,
} from './virtual/virtual-audio-input-recording-bridge.js';

export type {
  VirtualAudioInputRecordingBridge,
  VirtualAudioInputRecordingBridgeOptions,
  VirtualAudioInputRecordingProbe,
  VirtualAudioInputRecordingRequest,
  VirtualAudioInputRecordingTargetResult,
  AudioInputRecordingBackendAdapter,
} from './virtual/virtual-audio-input-recording-bridge.js';

export {
  VIRTUAL_DEVICE_INVENTORY_BRIDGE_ID,
  createVirtualDeviceInventoryBridge,
  registerVirtualDeviceInventoryProvider,
} from './virtual/virtual-device-inventory-bridge.js';

export type {
  VirtualDeviceInventory,
  VirtualDeviceInventoryBridge,
  VirtualDeviceInventoryOptions,
  VirtualDeviceInventoryProbe,
  VirtualDeviceInventoryProvider,
  VirtualDeviceKind,
  VirtualDeviceRecord,
} from './virtual/virtual-device-inventory-bridge.js';

export {
  VIRTUAL_INPUT_DEVICE_INVENTORY_BRIDGE_ID,
  createVirtualInputDeviceInventoryBridge,
} from './virtual/virtual-input-device-inventory-bridge.js';

export type {
  VirtualInputDeviceInventory,
  VirtualInputDeviceInventoryBridge,
  VirtualInputDeviceInventoryOptions,
  VirtualInputDeviceInventoryProbe,
  VirtualInputDeviceKind,
  VirtualInputDeviceRecord,
} from './virtual/virtual-input-device-inventory-bridge.js';

export {
  VIRTUAL_CAMERA_BRIDGE_ID,
  createVirtualCameraBridge,
  listCameraCaptureAdapters,
  registerCameraCaptureAdapter,
} from './virtual/virtual-camera-bridge.js';

export type {
  VirtualCameraBackendId,
  VirtualCameraBridge,
  VirtualCameraBridgeOptions,
  VirtualCameraBridgeProbe,
  VirtualCameraCaptureRequest,
  VirtualCameraCaptureResult,
  VirtualCameraCaptureStreamRequest,
  CameraCaptureAdapter,
} from './virtual/virtual-camera-bridge.js';

export {
  VIRTUAL_CAMERA_INJECTION_BRIDGE_ID,
  createVirtualCameraInjectionBridge,
} from './virtual/virtual-camera-injection-bridge.js';

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
} from './virtual/virtual-camera-injection-bridge.js';

export {
  V4L2_VIRTUAL_CAMERA_BRIDGE_ID,
  V4L2_VIRTUAL_CAMERA_CAPABILITIES,
  V4l2VirtualCameraOutputBridge,
  installV4l2VirtualCameraOutputBridge,
} from './v4l2-virtual-camera-output.js';

export type { V4l2VirtualCameraOutputOptions } from './v4l2-virtual-camera-output.js';

export {
  VIRTUAL_MEDIA_DEVICE_CONTROL_BRIDGE_ID,
  createVirtualMediaDeviceControlBridge,
} from './virtual/virtual-media-device-control-bridge.js';

export type {
  VirtualMediaDeviceControlAction,
  VirtualMediaDeviceControlBridgeOptions,
  VirtualMediaDeviceControlProbe,
  VirtualMediaDeviceControlRequest,
  VirtualMediaDeviceControlResult,
  VirtualMediaDeviceControlScope,
  VirtualMediaDeviceSelection,
} from './virtual/virtual-media-device-control-bridge.js';

export {
  StubStreamingSpeechToTextBridge,
  getStreamingSttBridge,
  registerStreamingSttBridge,
  resetStreamingSttBridges,
} from './voice/streaming-stt-bridge.js';

export type { StreamingSpeechToTextBridge } from './voice/streaming-stt-bridge.js';

export {
  StubStreamingTextToSpeechBridge,
  getStreamingTtsBridge,
  registerStreamingTtsBridge,
  resetStreamingTtsBridges,
} from './voice/streaming-tts-bridge.js';

export type { StreamingTextToSpeechBridge } from './voice/streaming-tts-bridge.js';

export {
  ShellStreamingSpeechToTextBridge,
  installManagedMlxWhisperStreamingSttBridgeIfAvailable,
  installShellStreamingSttBridge,
  installShellStreamingSttBridgeFromEnv,
} from './shell/shell-streaming-stt-bridge.js';

export type { ShellStreamingSttOptions } from './shell/shell-streaming-stt-bridge.js';

export {
  ShellStreamingTextToSpeechBridge,
  installShellStreamingTtsBridge,
  installShellStreamingTtsBridgeFromEnv,
} from './shell/shell-streaming-tts-bridge.js';

export type { ShellStreamingTtsOptions } from './shell/shell-streaming-tts-bridge.js';

export {
  EnergyVad,
  computeChunkDurationMs,
  computeChunkRms,
} from './voice/voice-activity-detector.js';

export type {
  EnergyVadOptions,
  VoiceActivityDetector,
  VoiceActivityState,
} from './voice/voice-activity-detector.js';

export {
  StubMeetingJoinDriver,
  getMeetingJoinDriver,
  listMeetingJoinDriversFor,
  registerMeetingJoinDriver,
  resetMeetingJoinDriverRegistry,
} from './meeting/meeting-join-driver.js';

export type { MeetingJoinDriver } from './meeting/meeting-join-driver.js';

export {
  MeetingParticipationCoordinator,
  checkMeetingParticipationConsent,
} from './meeting/meeting-participation-coordinator.js';

export type {
  ConversationAgent,
  MeetingParticipationOptions,
  MeetingParticipationReport,
} from './meeting/meeting-participation-coordinator.js';

export {
  redactMeetingUrl,
  resolveMeetingPlatform,
  resolveMeetingPlatformFromUrl,
  validateMeetingTarget,
} from './meeting/meeting-join-driver.js';

export * from './meeting/meeting-platform-registry.js';

export {
  installObsVirtualCameraOutputBridge,
  OBS_VIRTUAL_CAMERA_BRIDGE_ID,
  OBS_VIRTUAL_CAMERA_CAPABILITIES,
  ObsVirtualCamera,
  ObsVirtualCameraOutputBridge,
} from './obs-virtual-camera-output.js';

export type {
  ObsVirtualCameraBridgeOptions,
  ObsVirtualCameraOptions,
} from './obs-virtual-camera-output.js';

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
} from './mesh/a2a-envelope-signature.js';
// NI-02: actor-string verification against the NHI registry (warn -> enforce).
