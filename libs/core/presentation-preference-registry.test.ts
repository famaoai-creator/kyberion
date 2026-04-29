import * as path from 'node:path';
import AjvModule from 'ajv';
import { afterEach, describe, expect, it } from 'vitest';
import { compileSchemaFromPath } from './schema-loader.js';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeReadFile, safeWriteFile } from './secure-io.js';
import {
  getPresentationPreferenceProfile,
  getPresentationPreferenceRegistry,
  getPresentationPreferenceRegistryPath,
  registerPresentationPreferenceProfile,
  resetPresentationPreferenceRegistryCache,
} from './presentation-preference-registry.js';

const Ajv = (AjvModule as any).default ?? AjvModule;

describe('presentation preference registry', () => {
  const tmpDir = pathResolver.sharedTmp('presentation-preference-registry-tests');
  const overridePath = `${tmpDir}/presentation-preference-registry.json`;
  const overlayPath = `${tmpDir}/presentation-preference-registry.personal.json`;
  const registrationPath = `${tmpDir}/presentation-preference-registry.registered.json`;

  afterEach(() => {
    delete process.env.KYBERION_PRESENTATION_PREFERENCE_REGISTRY_PATH;
    delete process.env.KYBERION_PERSONAL_PRESENTATION_PREFERENCE_REGISTRY_PATH;
    resetPresentationPreferenceRegistryCache();
  });

  it('validates the governed registry schema', () => {
    const ajv = new Ajv({ allErrors: true });
    const validate = compileSchemaFromPath(
      ajv,
      path.resolve(
        process.cwd(),
        'knowledge/public/schemas/presentation-preference-registry.schema.json'
      )
    );
    const registry = JSON.parse(
      safeReadFile(
        path.resolve(process.cwd(), 'knowledge/public/governance/presentation-preference-registry.json'),
        { encoding: 'utf8' }
      ) as string
    );

    expect(validate(registry)).toBe(true);
  });

  it('loads the default profile and honors the personal overlay', () => {
    safeMkdir(tmpDir, { recursive: true });
    safeWriteFile(
      overlayPath,
      JSON.stringify({
        version: 'test',
        default_profile_id: 'personal-exec-clean',
        profiles: [
          {
            kind: 'presentation-preference-profile',
            profile_id: 'personal-exec-clean',
            scope: 'proposal',
            theme_selection_policy: {
              decision_mode: 'ask_when_uncertain',
              ask_user_when: ['new_deck_category'],
              default_theme_hint: 'executive_clean',
            },
            brief_question_sets: [
              {
                label: 'Proposal deck',
                deck_purposes: ['proposal'],
                questions: ['誰に見せる資料ですか?'],
              },
            ],
            theme_sets: [
              {
                label: 'Executive clean',
                deck_purposes: ['proposal'],
                theme_hint: 'executive_clean',
              },
            ],
          },
        ],
      })
    );
    process.env.KYBERION_PERSONAL_PRESENTATION_PREFERENCE_REGISTRY_PATH = overlayPath;

    const registry = getPresentationPreferenceRegistry();
    expect(registry.default_profile_id).toBe('personal-exec-clean');
    expect(getPresentationPreferenceProfile().profile_id).toBe('personal-exec-clean');
  });

  it('registers a presentation preference profile in the personal registry', () => {
    safeMkdir(tmpDir, { recursive: true });
    safeWriteFile(
      overridePath,
      JSON.stringify({
        version: 'test',
        default_profile_id: 'business-deck-default',
        profiles: [
          {
            kind: 'presentation-preference-profile',
            profile_id: 'business-deck-default',
            scope: 'default',
            theme_selection_policy: {
              decision_mode: 'ask_when_uncertain',
              ask_user_when: ['new_deck_category'],
              default_theme_hint: 'executive_clean',
            },
            brief_question_sets: [
              {
                label: 'Proposal deck',
                deck_purposes: ['proposal'],
                questions: ['誰に見せる資料ですか?'],
              },
            ],
            theme_sets: [
              {
                label: 'Executive clean',
                deck_purposes: ['proposal'],
                theme_hint: 'executive_clean',
              },
            ],
          },
        ],
      })
    );
    process.env.KYBERION_PRESENTATION_PREFERENCE_REGISTRY_PATH = overridePath;

    const profilePath = registerPresentationPreferenceProfile(
      {
        kind: 'presentation-preference-profile',
        profile_id: 'ceo-onboarding-theme',
        scope: 'proposal',
        theme_selection_policy: {
          decision_mode: 'ask_when_uncertain',
          ask_user_when: ['user_requested_precheck'],
          default_theme_hint: 'executive_clean',
        },
        brief_question_sets: [
          {
            label: 'Proposal deck',
            deck_purposes: ['proposal'],
            questions: ['誰に見せる資料ですか?', '最終的に何を決めたいですか?'],
          },
        ],
        theme_sets: [
          {
            label: 'Executive clean',
            deck_purposes: ['proposal'],
            theme_hint: 'executive_clean',
          },
        ],
      },
      registrationPath
    );

    expect(profilePath).toBe(registrationPath);
    const registry = JSON.parse(
      safeReadFile(registrationPath, { encoding: 'utf8' }) as string
    ) as { default_profile_id: string; profiles: Array<{ profile_id: string }> };
    expect(registry.default_profile_id).toBe('ceo-onboarding-theme');
    expect(registry.profiles.some((profile) => profile.profile_id === 'ceo-onboarding-theme')).toBe(
      true
    );
  });

  it('exposes the registry path helper', () => {
    expect(getPresentationPreferenceRegistryPath()).toContain('presentation-preference-registry.json');
  });
});
