export interface MeetingOperationsBrief {
  kind: 'meeting-operations-brief';
  version: string;
  intent: string;
  meeting_title: string;
  meeting_url: string;
  platform: 'teams' | 'zoom' | 'meet' | 'auto';
  purpose:
    | 'planning'
    | 'status_update'
    | 'decision'
    | 'facilitation'
    | 'workshop'
    | 'incident'
    | 'one_on_one'
    | 'review'
    | 'default';
  primary_role: 'planner' | 'facilitator' | 'scribe' | 'executor' | 'decision_maker' | 'tracker';
  support_roles?: Array<'planner' | 'facilitator' | 'scribe' | 'executor' | 'decision_maker' | 'tracker'>;
  agenda?: string[];
  participants?: Array<{
    name: string;
    person_slug?: string;
    channel_handle?: string;
    role_hint?: 'planner' | 'facilitator' | 'scribe' | 'executor' | 'decision_maker' | 'tracker';
  }>;
  desired_outcomes: string[];
  authority_scope?: {
    may_facilitate?: boolean;
    may_speak?: boolean;
    may_make_shared_decisions?: boolean;
    may_assign_action_items?: boolean;
    may_track_action_items?: boolean;
  };
  own_tasks?: string[];
  tracking_expectations?: string[];
  exit_conditions: string[];
  follow_up_channel?: 'slack' | 'email' | 'teams' | 'task_session';
  notes?: string;
}
