import type { EventScope } from './event-scope.js';

export type MissionOrchestrationEventType =
  | 'mission_issue_requested'
  | 'mission_team_prewarm_requested'
  | 'mission_kickoff_requested'
  | 'mission_followup_requested'
  | 'mission_reconciliation_requested'
  | 'mission_distillation_requested'
  | 'mission_completion_requested'
  | 'mission_control_requested'
  | 'surface_control_requested';

export const MISSION_ORCHESTRATION_EVENT_TYPES: readonly MissionOrchestrationEventType[] = [
  'mission_issue_requested',
  'mission_team_prewarm_requested',
  'mission_kickoff_requested',
  'mission_followup_requested',
  'mission_reconciliation_requested',
  'mission_distillation_requested',
  'mission_completion_requested',
  'mission_control_requested',
  'surface_control_requested',
];

export interface MissionOrchestrationEvent<TPayload = Record<string, unknown>> {
  event_id: string;
  event_type: MissionOrchestrationEventType;
  mission_id: string;
  requested_by: string;
  created_at: string;
  correlation_id?: string;
  causation_id?: string;
  scope?: EventScope;
  payload_ref?: string;
  payload: TPayload;
}
