/** Public surface for @agent/shared-voice — voice runtime moved out of @agent/core. */
export * from './audio-text-similarity.js';
export * from './realtime-voice-conversation.js';
export * from './realtime-voice-loop.js';
export * from './realtime-voice-preferences.js';
export * from './ten-vad-bridge.js';
export * from './tts-loopback-verifier.js';
export * from './two-stage-barge-in.js';
export * from './vad-turn-recorder.js';
export * from './voice-capability-bridge.js';
export * from './voice-eot-scorer.js';
export * from './voice-first-phrase-cache.js';
export * from './voice-generation-runtime.js';
export * from './voice-path-policy.js';
export * from './voice-phrase-chunker.js';
export * from './voice-profile-promotion.js';
export * from './voice-runtime-policy.js';
export * from './voice-sample-collection.js';
export * from './voice-sample-ingestion-policy.js';
export * from './voice-sample-recorder.js';
export * from './voice-selection-preferences.js';
export * from './voice-synth.js';
export * from './voice-transcript-alignment.js';
export * from './voice-tts-config.js';
export * from './voice-turn-cancellation.js';
export * from './gemini-live-client.js';
export * from './voice-turn-taking.js';
export * from './voice-workbench.js';
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
// native-tts shares names with voice-synth (speak, SpeakOptions); import it from @agent/shared-voice/native-tts.
