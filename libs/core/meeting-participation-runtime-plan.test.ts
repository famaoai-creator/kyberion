import { describe, expect, it } from 'vitest';
import { resolveMeetingParticipationRuntimePlan } from './meeting-participation-runtime-plan.js';

describe('resolveMeetingParticipationRuntimePlan', () => {
  it('defaults to transcribe-first with real audio and STT only', () => {
    expect(resolveMeetingParticipationRuntimePlan()).toEqual({
      transport_mode: 'transcribe_first',
      dry_run: false,
      require_real_audio_bus: true,
      require_streaming_stt: true,
      require_streaming_tts: false,
      require_voice_profile: false,
      require_recording_consent: true,
      require_voice_consent: false,
    });
  });

  it('requires full voice path for realtime voice mode', () => {
    expect(resolveMeetingParticipationRuntimePlan({ transport_mode: 'realtime_voice' })).toEqual({
      transport_mode: 'realtime_voice',
      dry_run: false,
      require_real_audio_bus: true,
      require_streaming_stt: true,
      require_streaming_tts: true,
      require_voice_profile: true,
      require_recording_consent: true,
      require_voice_consent: true,
    });
  });

  it('disables hard requirements in dry-run mode', () => {
    expect(
      resolveMeetingParticipationRuntimePlan({
        transport_mode: 'realtime_voice',
        dry_run: true,
      }),
    ).toEqual({
      transport_mode: 'realtime_voice',
      dry_run: true,
      require_real_audio_bus: false,
      require_streaming_stt: false,
      require_streaming_tts: false,
      require_voice_profile: false,
      require_recording_consent: false,
      require_voice_consent: false,
    });
  });
});
