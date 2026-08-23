import { describe, expect, it } from 'vitest';
import {
  intentAuthorityVocabularyKey,
  intentOutcomeVocabularyKey,
  intentShapeVocabularyKey,
} from './intent-preview-model.js';

describe('intent preview authority mapping', () => {
  it('maps each authority boundary to its catalog key', () => {
    expect(intentAuthorityVocabularyKey('approval_required')).toBe(
      'tui:tui_cockpit_authority_approval'
    );
    expect(intentAuthorityVocabularyKey('human_clarification_required')).toBe(
      'tui:tui_cockpit_authority_clarification'
    );
    expect(intentAuthorityVocabularyKey('autonomous')).toBe('tui:tui_cockpit_authority_autonomous');
  });

  it('maps technical resolution values to catalog keys', () => {
    expect(intentShapeVocabularyKey('project_bootstrap')).toBe(
      'tui:tui_cockpit_shape_project_bootstrap'
    );
    expect(intentOutcomeVocabularyKey('approval_ready_plan')).toBe(
      'tui:tui_cockpit_outcome_approval_ready_plan'
    );
  });
});
