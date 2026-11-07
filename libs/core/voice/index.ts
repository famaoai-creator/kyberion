/** Domain barrel — public surface for libs/core/voice */
export * from './audio-bus-bridge.js';
export * from './audio-bus-providers.js';
// skipped './audio-bus-resolver.js' (all exports shadowed)
export * from './audio-bus.js';
export * from './audio-device-lease.js';
export * from './audio-playback.js';
export * from './audio-route.js';
export * from './audio-tee.js';
export * from './speech-languages.js';
export type {
  TranscribeInput,
  SpeechToTextCapabilities,
  TranscriptSegment,
  TranscribeResult,
  SpeechToTextBridge,
  SpeechToTextRequirements,
  SelectSpeechToTextBridgesOptions,
  SpeechToTextSelection,
  ShellSpeechToTextBridgeOptions,
} from './speech-to-text-bridge.js';
export {
  NO_TIMESTAMP_STT_CAPABILITIES,
  getSpeechToTextCapabilities,
  registerSpeechToTextBridge,
  getSpeechToTextBridge,
  getSpeechToTextBridges,
  resolveSpeechToTextBridge,
  SPEECH_TO_TEXT_SEAM,
  SpeechToTextSelectionError,
  listSpeechToTextCandidates,
  shouldSelectSpeechToTextBridges,
  selectSpeechToTextBridges,
  resetSpeechToTextBridge,
  normalizeSpeechToTextResult,
  parseSpeechToTextCapabilities,
  stubSpeechToTextBridge,
  ShellSpeechToTextBridge,
  installFluidAudioSpeechToTextBridgeIfAvailable,
  installShellSpeechToTextBridgeIfAvailable,
  buildWhisperKitTranscribeArgs,
  installWhisperKitSpeechToTextBridgeIfAvailable,
  installManagedMlxWhisperSpeechToTextBridgeIfAvailable,
  installSpeechCppSpeechToTextBridgeIfAvailable,
  installAvailableSpeechToTextBridges,
} from './speech-to-text-bridge.js';
export * from './speech-cpp-client.js';
export * from './streaming-stt-bridge.js';
export * from './streaming-tts-bridge.js';
export * from './vad-bridge-protocol.js';
export * from './vad-registry.js';
export * from './voice-activity-detector.js';
export * from './voice-bridge.js';
export * from './voice-consent.js';
export * from './voice-engine-registry.js';
export * from './voice-profile-registry.js';
export * from './voice-provider-adapters.js';
export * from './voice-respond-gate.js';
export * from './voice-stt.js';
export * from './voice-text-chunking.js';
export * from './voice-turn-taking-lexicon.js';
