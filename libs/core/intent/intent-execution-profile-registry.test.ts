import { describe, expect, it } from 'vitest';
import {
  loadIntentExecutionProfileRegistry,
  resolveExecutionProfileForIntent,
  summarizeRelevantExecutionProfilesForIntentIdsCompact,
} from './intent-execution-profile-registry.js';

describe('intent-execution-profile-registry', () => {
  it('loads the governed profile registry', () => {
    const registry = loadIntentExecutionProfileRegistry();
    expect(registry.version).toBe('1.0.0');
    expect(registry.profiles.length).toBeGreaterThan(0);
  });

  it('resolves intent-scoped voice, video, and meeting profiles', () => {
    expect(resolveExecutionProfileForIntent('speak-with-my-voice')?.profile_id).toBe(
      'voice-speak-with-my-voice-local-say'
    );
    expect(resolveExecutionProfileForIntent('generate-narrated-video')?.profile_id).toBe(
      'media-generate-narrated-video-default'
    );
    expect(resolveExecutionProfileForIntent('generate-video')?.profile_id).toBe(
      'media-generate-video-default'
    );
    expect(resolveExecutionProfileForIntent('transcribe-audio')?.profile_id).toBe(
      'audio-transcribe-default'
    );
    expect(resolveExecutionProfileForIntent('live-voice')?.profile_id).toBe(
      'voice-live-conversation-default'
    );
    expect(resolveExecutionProfileForIntent('meeting-operations')?.profile_id).toBe(
      'meeting-operations-google-meet-transcribe'
    );
  });

  it('prefers explicit stt runtime hints when provided', () => {
    const profile = resolveExecutionProfileForIntent('live-voice', {
      surface: 'voice',
      runtime_context: {
        stt: {
          engine_id: 'mlx_audio_qwen3',
        },
      },
    });
    expect(profile?.profile_id).toBe('voice-live-conversation-default');
    expect(profile?.provider_selection?.stt?.engine_id).toBe('mlx_audio_qwen3');
  });

  it('prefers the explicit meeting runtime hint when provided', () => {
    const profile = resolveExecutionProfileForIntent('meeting-operations', {
      surface: 'meeting',
      runtime_context: {
        meeting: {
          provider: 'teams_pipeline',
          mode: 'realtime',
        },
      },
    });
    expect(profile?.profile_id).toBe('meeting-operations-teams-pipeline-realtime');
    expect(profile?.provider_selection?.meeting?.provider).toBe('teams_pipeline');
  });

  it('renders a compact profile summary with provider hints', () => {
    const summary = summarizeRelevantExecutionProfilesForIntentIdsCompact(['meeting-operations']);
    expect(summary).toContain('meeting-operations-google-meet-transcribe');
    expect(summary).toContain('bundle=meeting-operations-governed');
    expect(summary).toContain('provider=meeting=google_meet/transcribe');
  });
});
