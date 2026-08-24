import { describe, expect, it } from 'vitest';
import { intentAuthorityVocabularyKey } from './intent-preview-model.js';

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
});
