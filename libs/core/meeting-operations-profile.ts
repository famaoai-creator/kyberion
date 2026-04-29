import type { MeetingOperationsProfile } from './src/types/meeting-operations-profile.js';
import type { MeetingOperationsBrief } from './src/types/meeting-operations-brief.js';

export type MeetingPurpose =
  | 'planning'
  | 'status_update'
  | 'decision'
  | 'facilitation'
  | 'workshop'
  | 'incident'
  | 'one_on_one'
  | 'review'
  | 'default';

export type MeetingRole =
  | 'planner'
  | 'facilitator'
  | 'scribe'
  | 'executor'
  | 'decision_maker'
  | 'tracker';

export interface MeetingBriefQuestionSet {
  label: string;
  meeting_purposes?: MeetingPurpose[];
  questions: string[];
  notes?: string;
}

export interface MeetingRoleSet {
  label: string;
  meeting_purposes?: MeetingPurpose[];
  primary_role: MeetingRole;
  support_roles?: MeetingRole[];
  notes?: string;
}

export interface MeetingBriefInput {
  meeting_title: string;
  meeting_url: string;
  platform: 'teams' | 'zoom' | 'meet' | 'auto';
  purpose?: MeetingPurpose | string | null;
  agenda?: string[];
  participants?: Array<{
    name: string;
    person_slug?: string;
    channel_handle?: string;
    role_hint?: MeetingRole;
  }>;
  desired_outcomes?: string[];
  own_tasks?: string[];
  tracking_expectations?: string[];
  notes?: string;
}

export function selectMeetingBriefQuestionSet(
  profile: MeetingOperationsProfile,
  purpose?: MeetingPurpose | string | null
): MeetingBriefQuestionSet | undefined {
  const normalizedPurpose = purpose ? String(purpose) : '';
  return profile.brief_question_sets.find(
    (set) =>
      !set.meeting_purposes?.length ||
      set.meeting_purposes.includes(normalizedPurpose as MeetingPurpose)
  );
}

export function getMeetingBriefQuestions(
  profile: MeetingOperationsProfile,
  purpose?: MeetingPurpose | string | null
): string[] {
  return selectMeetingBriefQuestionSet(profile, purpose)?.questions || [];
}

export function selectMeetingRoleSet(
  profile: MeetingOperationsProfile,
  purpose?: MeetingPurpose | string | null
): MeetingRoleSet | undefined {
  const normalizedPurpose = purpose ? String(purpose) : '';
  return profile.role_sets.find(
    (set) =>
      !set.meeting_purposes?.length ||
      set.meeting_purposes.includes(normalizedPurpose as MeetingPurpose)
  );
}

export function buildMeetingOperationsBrief(
  input: MeetingBriefInput,
  profile: MeetingOperationsProfile
): MeetingOperationsBrief {
  const roleSet = selectMeetingRoleSet(profile, input.purpose);
  const purpose = (input.purpose ? String(input.purpose) : 'default') as MeetingPurpose;
  const primaryRole = roleSet?.primary_role || 'facilitator';
  const supportRoles = roleSet?.support_roles || ['planner', 'scribe', 'tracker'];
  const desiredOutcomes = (input.desired_outcomes?.length ? input.desired_outcomes : [
    'Clarify the purpose of the meeting',
    'Track action items and owners',
  ]).map((item) => String(item));
  const exitConditions = [
    'Agenda is complete',
    'Action items are recorded',
    'Authority boundary is respected',
  ];
  return {
    kind: 'meeting-operations-brief',
    version: '1.0.0',
    intent: 'meeting_operations',
    meeting_title: input.meeting_title,
    meeting_url: input.meeting_url,
    platform: input.platform,
    purpose,
    primary_role: primaryRole,
    ...(supportRoles.length ? { support_roles: supportRoles } : {}),
    ...(input.agenda?.length ? { agenda: input.agenda.map((item) => String(item)) } : {}),
    ...(input.participants?.length ? { participants: input.participants } : {}),
    desired_outcomes: desiredOutcomes,
    authority_scope: {
      may_facilitate: primaryRole === 'facilitator' || primaryRole === 'planner',
      may_speak: profile.facilitation_policy.ask_before_speaking === false,
      may_make_shared_decisions: false,
      may_assign_action_items: true,
      may_track_action_items: true,
    },
    ...(input.own_tasks?.length ? { own_tasks: input.own_tasks.map((item) => String(item)) } : {}),
    ...(input.tracking_expectations?.length
      ? { tracking_expectations: input.tracking_expectations.map((item) => String(item)) }
      : {}),
    exit_conditions: exitConditions,
    follow_up_channel: profile.tracking_policy.default_follow_up_channel,
    ...(input.notes ? { notes: input.notes } : {}),
  };
}
