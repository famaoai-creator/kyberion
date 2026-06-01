import { describe, expect, it } from 'vitest';
import {
  loadVoiceTaskProfileCatalog,
  resolveVoiceTaskDistillTargetKind,
  resolveVoiceTaskProfile,
} from './voice-task-profile-catalog.js';

describe('voice-task-profile-catalog', () => {
  it('loads the catalog and resolves common task profiles', () => {
    const catalog = loadVoiceTaskProfileCatalog();

    expect(catalog.profiles.length).toBeGreaterThan(0);
    expect(resolveVoiceTaskDistillTargetKind({ taskType: 'presentation_deck' })).toBe('pattern');
    expect(
      resolveVoiceTaskProfile({
        taskType: 'service_operation',
        operation: 'logs',
      })?.id,
    ).toBe('service-operation-logs');
  });
});
