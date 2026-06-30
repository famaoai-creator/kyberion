/**
 * Meeting participation runtime plan.
 *
 * Turns the operator's requested transport mode into explicit runtime
 * requirements so `meeting_participate` can fail closed before a live
 * meeting starts.
 *
 * The plan deliberately separates:
 *   - what is required for an actual meeting run
 *   - what may be stubbed for dry runs and tests
 */

export type MeetingParticipationTransportMode =
  | 'transcribe_first'
  | 'realtime_voice';

export interface MeetingParticipationRuntimePlan {
  transport_mode: MeetingParticipationTransportMode;
  dry_run: boolean;
  require_real_audio_bus: boolean;
  require_streaming_stt: boolean;
  require_streaming_tts: boolean;
  require_voice_profile: boolean;
  require_recording_consent: boolean;
  require_voice_consent: boolean;
}

export function resolveMeetingParticipationRuntimePlan(input: {
  transport_mode?: MeetingParticipationTransportMode;
  dry_run?: boolean;
} = {}): MeetingParticipationRuntimePlan {
  const transport_mode = input.transport_mode ?? 'transcribe_first';
  const dry_run = Boolean(input.dry_run);

  if (dry_run) {
    return {
      transport_mode,
      dry_run: true,
      require_real_audio_bus: false,
      require_streaming_stt: false,
      require_streaming_tts: false,
      require_voice_profile: false,
      require_recording_consent: false,
      require_voice_consent: false,
    };
  }

  if (transport_mode === 'realtime_voice') {
    return {
      transport_mode,
      dry_run: false,
      require_real_audio_bus: true,
      require_streaming_stt: true,
      require_streaming_tts: true,
      require_voice_profile: true,
      require_recording_consent: true,
      require_voice_consent: true,
    };
  }

  return {
    transport_mode,
    dry_run: false,
    require_real_audio_bus: true,
    require_streaming_stt: true,
    require_streaming_tts: false,
    require_voice_profile: false,
    require_recording_consent: true,
    require_voice_consent: false,
  };
}
