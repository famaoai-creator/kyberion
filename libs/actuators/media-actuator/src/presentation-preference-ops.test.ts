import { describe, expect, it } from 'vitest';
import { pathResolver, safeExistsSync, safeReadFile, safeRmSync } from '@agent/core';
import { handleAction } from './index.js';

describe('media presentation preference ownership', () => {
  it('registers the profile through the media/design policy boundary', async () => {
    const registryPath = pathResolver.sharedTmp(
      'actuators/media-actuator/presentation-preference-ownership.test.json'
    );
    if (safeExistsSync(registryPath)) safeRmSync(registryPath, { force: true });

    try {
      const result = await handleAction({
        action: 'pipeline',
        steps: [
          {
            type: 'apply',
            op: 'register_presentation_preference_profile',
            params: {
              registry_path: pathResolver.toRepoRelative(registryPath),
              profile: {
                kind: 'presentation-preference-profile',
                profile_id: 'media-ownership-test',
                scope: 'briefing',
                theme_selection_policy: {
                  decision_mode: 'ask_when_uncertain',
                  ask_user_when: ['new_deck_category'],
                  default_theme_hint: 'test-roundtrip-theme',
                },
                brief_question_sets: [
                  {
                    label: 'Briefing',
                    deck_purposes: ['briefing'],
                    questions: ['Who is the audience?'],
                  },
                ],
                theme_sets: [
                  {
                    label: 'Test theme',
                    deck_purposes: ['briefing'],
                    theme_hint: 'test-roundtrip-theme',
                  },
                ],
              },
            },
          },
        ],
      });

      expect(result.status).toBe('succeeded');
      expect(result.context.presentation_preference_profile_registered).toMatchObject({
        profile_id: 'media-ownership-test',
      });
      expect(JSON.parse(String(safeReadFile(registryPath, { encoding: 'utf8' }))).profiles).toEqual(
        expect.arrayContaining([expect.objectContaining({ profile_id: 'media-ownership-test' })])
      );
    } finally {
      if (safeExistsSync(registryPath)) safeRmSync(registryPath, { force: true });
    }
  });
});
