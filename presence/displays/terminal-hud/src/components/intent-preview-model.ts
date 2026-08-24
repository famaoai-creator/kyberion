import type { IntentAuthorityLevel } from '@agent/core';

export type IntentAuthorityVocabularyKey =
  | 'tui:tui_cockpit_authority_approval'
  | 'tui:tui_cockpit_authority_clarification'
  | 'tui:tui_cockpit_authority_autonomous';

export function intentAuthorityVocabularyKey(
  level: IntentAuthorityLevel
): IntentAuthorityVocabularyKey {
  if (level === 'approval_required') return 'tui:tui_cockpit_authority_approval';
  if (level === 'human_clarification_required') return 'tui:tui_cockpit_authority_clarification';
  return 'tui:tui_cockpit_authority_autonomous';
}
