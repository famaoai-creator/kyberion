import { describe, expect, it } from 'vitest';
import {
  buildMeetingOperationsBrief,
  getMeetingBriefQuestions,
  selectMeetingRoleSet,
} from './meeting-operations-profile.js';
import type { MeetingOperationsProfile } from './src/types/meeting-operations-profile.js';

const profile: MeetingOperationsProfile = {
  kind: 'meeting-operations-profile',
  profile_id: 'kyberion-meeting-default',
  brief_question_sets: [
    {
      label: 'Planning',
      meeting_purposes: ['planning', 'decision', 'default'],
      questions: ['What is being decided?', 'Who can make the final call?'],
    },
    {
      label: 'Status',
      meeting_purposes: ['status_update', 'review'],
      questions: ['What needs tracking?', 'Which actions belong to Kyberion?'],
    },
  ],
  role_sets: [
    {
      label: 'Planner / facilitator',
      meeting_purposes: ['planning', 'decision', 'default'],
      primary_role: 'facilitator',
      support_roles: ['planner', 'scribe', 'tracker'],
    },
    {
      label: 'Scribe',
      meeting_purposes: ['status_update', 'review'],
      primary_role: 'scribe',
      support_roles: ['tracker', 'executor'],
    },
  ],
  facilitation_policy: {
    ask_before_join: true,
    ask_before_speaking: true,
    ask_before_shared_decision: true,
    prefer_written_summary: true,
    capture_transcript: true,
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
    capture_final_summary: true,
    capture_action_items: true,
  },
};

describe('meeting-operations-profile', () => {
  it('selects brief questions and role sets by purpose', () => {
    expect(getMeetingBriefQuestions(profile, 'planning')).toEqual([
      'What is being decided?',
      'Who can make the final call?',
    ]);
    expect(selectMeetingRoleSet(profile, 'status_update')?.primary_role).toBe('scribe');
  });

  it('builds a meeting brief with a role and exit boundary', () => {
    const brief = buildMeetingOperationsBrief(
      {
        meeting_title: 'Weekly planning sync',
        meeting_url: 'https://example.microsoft.com/teams/join/abc',
        platform: 'teams',
        purpose: 'planning',
        agenda: ['Goals', 'Blockers'],
        desired_outcomes: ['Align on next steps'],
      },
      profile
    );

    expect(brief.kind).toBe('meeting-operations-brief');
    expect(brief.primary_role).toBe('facilitator');
    expect(brief.follow_up_channel).toBe('task_session');
    expect(brief.exit_conditions).toContain('Agenda is complete');
    expect(brief.environment?.transport_mode).toBe('transcribe_first');
    expect(brief.environment?.items.find((item) => item.kind === 'audio')?.state).toBe('required');
    expect(brief.environment?.items.find((item) => item.kind === 'camera')?.state).toBe('recommended');
    expect(brief.environment?.questions).toContain('Will this meeting be video-on, or should Kyberion stay audio-only?');
  });

  it('marks speaking prerequisites when the profile allows live speech', () => {
    const speakingProfile: MeetingOperationsProfile = {
      ...profile,
      facilitation_policy: {
        ...profile.facilitation_policy,
        ask_before_speaking: false,
      },
    };

    const brief = buildMeetingOperationsBrief(
      {
        meeting_title: 'Incident response call',
        meeting_url: 'https://example.microsoft.com/teams/join/abc',
        platform: 'teams',
        purpose: 'incident',
        agenda: ['Status', 'Live voice'],
        desired_outcomes: ['Speak during the meeting if needed'],
      },
      speakingProfile
    );

    expect(brief.environment?.transport_mode).toBe('realtime_voice');
    expect(brief.environment?.items.find((item) => item.kind === 'tts')?.state).toBe('required');
    expect(brief.environment?.items.find((item) => item.kind === 'voice_consent')?.state).toBe('required');
  });
});
