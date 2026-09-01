import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeMkdir, safeReadFile, safeRmSync } from '@agent/core/secure-io';
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

  it('rejects profile and registry paths outside the repository', async () => {
    const { registerPresentationPreferenceProfileOp } =
      await import('./presentation-preference-ops.js');
    const profile = {
      kind: 'presentation-preference-profile',
      profile_id: 'boundary-profile',
      scope: 'default',
      theme_selection_policy: { decision_mode: 'ask_when_uncertain', ask_user_when: [] },
      brief_question_sets: [],
      theme_sets: [],
    } as any;

    expect(() =>
      registerPresentationPreferenceProfileOp({
        profile_path: '/tmp/external-presentation-profile.json',
      })
    ).toThrow('[RESOURCE_PATH_SCOPE]');
    expect(() =>
      registerPresentationPreferenceProfileOp({
        profile,
        registry_path: '/tmp/external-presentation-registry.json',
      })
    ).toThrow('[RESOURCE_PATH_SCOPE]');
  });

  it('rejects a profile path that is not a regular file', async () => {
    const directory = pathResolver.sharedTmp('actuators/media-actuator/profile-directory');
    safeMkdir(directory, { recursive: true });

    try {
      const { registerPresentationPreferenceProfileOp } =
        await import('./presentation-preference-ops.js');
      expect(() =>
        registerPresentationPreferenceProfileOp({
          profile_path: pathResolver.toRepoRelative(directory),
        })
      ).toThrow('profile_path must be a regular file');
    } finally {
      if (safeExistsSync(directory)) safeRmSync(directory, { recursive: true, force: true });
    }
  });
});
