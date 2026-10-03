/** Domain barrel — public surface for libs/core/voice */
export * from './audio-bus-bridge.js';
export * from './audio-bus-providers.js';
// skipped './audio-bus-resolver.js' (all exports shadowed)
export * from './audio-bus.js';
export * from './audio-device-lease.js';
export * from './audio-playback.js';
export * from './audio-route.js';
export * from './audio-tee.js';
export * from './audio-text-similarity.js';
export * from './realtime-voice-conversation.js';
export * from './realtime-voice-loop.js';
export * from './realtime-voice-preferences.js';
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
  installAvailableSpeechToTextBridges,
} from './speech-to-text-bridge.js';
export * from './streaming-stt-bridge.js';
export * from './streaming-tts-bridge.js';
export * from './tts-loopback-verifier.js';
export * from './vad-bridge-protocol.js';
export * from './vad-registry.js';
export * from './vad-turn-recorder.js';
export * from './voice-activity-detector.js';
export * from './voice-bridge.js';
export * from './voice-capability-bridge.js';
export * from './voice-consent.js';
export * from './voice-engine-registry.js';
export * from './voice-eot-scorer.js';
export * from './voice-first-phrase-cache.js';
export * from './voice-generation-runtime.js';
export * from './voice-path-policy.js';
export * from './voice-phrase-chunker.js';
export * from './voice-profile-promotion.js';
export * from './voice-profile-registry.js';
export * from './voice-provider-adapters.js';
export * from './voice-respond-gate.js';
export * from './voice-runtime-policy.js';
export * from './voice-sample-collection.js';
export * from './voice-sample-ingestion-policy.js';
export * from './voice-sample-recorder.js';
export * from './voice-selection-preferences.js';
export type {
  DetectPowerSourceOptions,
  SpeculativeReplyPolicy,
  ResolveSpeculativePolicyInput,
} from './voice-speculative-policy.js';
export {
  SPECULATIVE_REPLY_ENV,
  DEFAULT_TENTATIVE_SILENCE_MS,
  DEFAULT_MIN_PARTIAL_CHARS,
  normalizeSpeculativeTranscript,
  transcriptsMatchForSpeculation,
} from './voice-speculative-policy.js';
export * from './voice-stt.js';
export * from './voice-synth.js';
export * from './voice-text-chunking.js';
export * from './voice-transcript-alignment.js';
export * from './voice-tts-config.js';
export * from './voice-turn-cancellation.js';
export * from './voice-turn-taking-lexicon.js';
export * from './gemini-live-client.js';
export * from './voice-turn-taking.js';
export * from './voice-workbench.js';
