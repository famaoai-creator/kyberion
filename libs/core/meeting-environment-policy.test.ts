import { describe, expect, it } from 'vitest';
import {
  loadMeetingEnvironmentPolicy,
  resolveMeetingEnvironment,
  type MeetingEnvironmentPolicy,
} from './meeting-environment-policy.js';
import type { MeetingOperationsProfile } from './src/types/meeting-operations-profile.js';

const profile: MeetingOperationsProfile = {
  kind: 'meeting-operations-profile',
  profile_id: 'kyberion-meeting-default',
  brief_question_sets: [],
  role_sets: [],
  facilitation_policy: {
    ask_before_join: true,
    ask_before_speaking: true,
    ask_before_shared_decision: true,
  },
  tracking_policy: {
    default_follow_up_channel: 'task_session',
    default_tracking_cadence: 'daily',
    require_owner: true,
    require_deadline: true,
    track_until_closed: true,
  },
  exit_policy: {
    stop_after_agenda_complete: true,
    stop_on_missing_authority: true,
  },
};

const speakingProfile: MeetingOperationsProfile = {
  ...profile,
  facilitation_policy: {
    ...profile.facilitation_policy,
    ask_before_speaking: false,
  },
};

describe('meeting-environment-policy', () => {
  it('loads the governed policy file', () => {
    const policy = loadMeetingEnvironmentPolicy();
    expect(policy.version).toBe('1.0.0');
    expect(policy.base_items.map((item) => item.kind)).toContain('audio');
    expect(policy.camera.explicit_patterns).toContain('camera');
  });

  it('resolves deterministic setup items from the policy', () => {
    const policy = loadMeetingEnvironmentPolicy();
    const environment = resolveMeetingEnvironment(
      {
        meeting_title: 'Planning sync',
        meeting_url: 'https://example.microsoft.com/teams/join/abc',
        platform: 'teams',
        purpose: 'planning',
        agenda: ['Agenda', 'Slides'],
        desired_outcomes: ['Align next steps'],
      },
      profile,
      'facilitator',
      policy,
    );

    expect(environment.transport_mode).toBe('transcribe_first');
    expect(environment.items.find((item) => item.kind === 'audio')?.state).toBe('required');
    expect(environment.items.find((item) => item.kind === 'camera')?.state).toBe('recommended');
    expect(environment.questions).toContain('Will this meeting be video-on, or should Kyberion stay audio-only?');
  });

  it('honors policy signal patterns instead of hardcoding them', () => {
    const policy = loadMeetingEnvironmentPolicy();
    const customPolicy: MeetingEnvironmentPolicy = {
      ...policy,
      camera: {
        ...policy.camera,
        explicit_patterns: ['webcam'],
      },
    };

    const environment = resolveMeetingEnvironment(
      {
        meeting_title: 'General status sync',
        meeting_url: 'https://example.microsoft.com/teams/join/abc',
        platform: 'teams',
        purpose: 'status_update',
        agenda: ['Agenda'],
        desired_outcomes: ['Track status'],
      },
      profile,
      'tracker',
      customPolicy,
    );

    expect(environment.items.find((item) => item.kind === 'camera')?.state).toBe('not_needed');
  });

  it('marks speaking prerequisites when the profile allows live speech', () => {
    const policy = loadMeetingEnvironmentPolicy();
    const environment = resolveMeetingEnvironment(
      {
        meeting_title: 'Incident response call',
        meeting_url: 'https://example.microsoft.com/teams/join/abc',
        platform: 'teams',
        purpose: 'incident',
        agenda: ['Status', 'Live voice'],
        desired_outcomes: ['Speak during the meeting if needed'],
      },
      speakingProfile,
      'facilitator',
      policy,
    );

    expect(environment.transport_mode).toBe('realtime_voice');
    expect(environment.items.find((item) => item.kind === 'tts')?.state).toBe('required');
    expect(environment.items.find((item) => item.kind === 'voice_consent')?.state).toBe('required');
  });

  it('does not treat screen sharing as a camera request', () => {
    const policy = loadMeetingEnvironmentPolicy();
    const environment = resolveMeetingEnvironment(
      {
        meeting_title: 'Review call',
        meeting_url: 'https://example.microsoft.com/teams/join/abc',
        platform: 'teams',
        purpose: 'status_update',
        agenda: ['画面共有で資料を確認する'],
        desired_outcomes: ['Review the shared material'],
      },
      profile,
      'scribe',
      policy,
    );

    expect(environment.items.find((item) => item.kind === 'screen_share')?.state).toBe('required');
    expect(environment.items.find((item) => item.kind === 'camera')?.state).not.toBe('required');
  });
});
