export interface MeetingOperationsProfile {
  kind: 'meeting-operations-profile';
  profile_id: string;
  brief_question_sets: Array<{
    label: string;
    meeting_purposes?: Array<
      | 'planning'
      | 'status_update'
      | 'decision'
      | 'facilitation'
      | 'workshop'
      | 'incident'
      | 'one_on_one'
      | 'review'
      | 'default'
    >;
    questions: string[];
    notes?: string;
  }>;
  role_sets: Array<{
    label: string;
    meeting_purposes?: Array<
      | 'planning'
      | 'status_update'
      | 'decision'
      | 'facilitation'
      | 'workshop'
      | 'incident'
      | 'one_on_one'
      | 'review'
      | 'default'
    >;
    primary_role: 'planner' | 'facilitator' | 'scribe' | 'executor' | 'decision_maker' | 'tracker';
    support_roles?: Array<'planner' | 'facilitator' | 'scribe' | 'executor' | 'decision_maker' | 'tracker'>;
    notes?: string;
  }>;
  facilitation_policy: {
    ask_before_join: boolean;
    ask_before_speaking: boolean;
    ask_before_shared_decision: boolean;
    prefer_written_summary?: boolean;
    capture_transcript?: boolean;
  };
  tracking_policy: {
    default_follow_up_channel: 'slack' | 'email' | 'teams' | 'task_session';
    default_tracking_cadence: 'immediate' | 'daily' | 'weekly' | 'ad_hoc';
    require_owner?: boolean;
    require_deadline?: boolean;
    track_until_closed?: boolean;
  };
  exit_policy: {
    stop_after_agenda_complete: boolean;
    stop_on_missing_authority: boolean;
    capture_final_summary?: boolean;
    capture_action_items?: boolean;
  };
}

