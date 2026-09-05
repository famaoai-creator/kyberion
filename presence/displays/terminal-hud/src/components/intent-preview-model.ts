import type { IntentAuthorityLevel } from '@agent/core/intent-resolution-contract';

export type IntentAuthorityVocabularyKey =
  | 'tui:tui_cockpit_authority_approval'
  | 'tui:tui_cockpit_authority_clarification'
  | 'tui:tui_cockpit_authority_autonomous';

export type IntentShapeVocabularyKey =
  | 'tui:tui_cockpit_shape_direct_answer'
  | 'tui:tui_cockpit_shape_task_session'
  | 'tui:tui_cockpit_shape_mission'
  | 'tui:tui_cockpit_shape_project_bootstrap';

export type IntentOutcomeVocabularyKey =
  | 'tui:tui_cockpit_outcome_answer'
  | 'tui:tui_cockpit_outcome_artifact'
  | 'tui:tui_cockpit_outcome_approval_ready_plan'
  | 'tui:tui_cockpit_outcome_service_change'
  | 'tui:tui_cockpit_outcome_status_report';

export function intentAuthorityVocabularyKey(
  level: IntentAuthorityLevel
): IntentAuthorityVocabularyKey {
  if (level === 'approval_required') return 'tui:tui_cockpit_authority_approval';
  if (level === 'human_clarification_required') return 'tui:tui_cockpit_authority_clarification';
  return 'tui:tui_cockpit_authority_autonomous';
}

export function intentShapeVocabularyKey(
  shape: 'direct_answer' | 'task_session' | 'mission' | 'project_bootstrap'
): IntentShapeVocabularyKey {
  return `tui:tui_cockpit_shape_${shape}` as IntentShapeVocabularyKey;
}

export function intentOutcomeVocabularyKey(
  outcome: 'answer' | 'artifact' | 'approval_ready_plan' | 'service_change' | 'status_report'
): IntentOutcomeVocabularyKey {
  return `tui:tui_cockpit_outcome_${outcome}` as IntentOutcomeVocabularyKey;
}
