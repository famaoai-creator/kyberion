import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  safeReadFile: vi.fn(),
  safeWriteFile: vi.fn(),
  safeExistsSync: vi.fn(),
  safeMkdir: vi.fn(),
  withRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('@agent/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core')>();
  return {
    ...actual,
    safeReadFile: mocks.safeReadFile,
    safeWriteFile: mocks.safeWriteFile,
    safeExistsSync: mocks.safeExistsSync,
    safeMkdir: mocks.safeMkdir,
    withRetry: mocks.withRetry,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
  };
});

describe('wisdom-actuator handleAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.safeExistsSync.mockReturnValue(true);
  });

  it('rejects knowledge imports with invalid package agent ids', async () => {
    mocks.safeReadFile.mockImplementation((filePath: string) => {
      if (filePath.includes('package.kkp')) {
        return JSON.stringify({
          metadata: {
            package_id: 'KKP-1',
            origin_agent_id: '../escape',
            timestamp: '2026-05-12T00:00:00.000Z',
            hash: 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
          },
          content: {
            path: 'notes.md',
            raw_data: 'hello world',
          },
        });
      }
      return '';
    });

    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'pipeline',
      steps: [
        {
          type: 'apply',
          op: 'knowledge_import',
          params: {
            package_path: 'knowledge/public/tmp/package.kkp',
            tier: 'confidential',
          },
        },
      ],
      context: {},
    });

    expect(result.status).toBe('failed');
    expect(result.results[0].error).toContain('Invalid knowledge package origin_agent_id');
  });

  it('rejects knowledge imports with invalid tiers', async () => {
    mocks.safeReadFile.mockImplementation((filePath: string) => {
      if (filePath.includes('package.kkp')) {
        return JSON.stringify({
          metadata: {
            package_id: 'KKP-1',
            origin_agent_id: 'agent-1',
            timestamp: '2026-05-12T00:00:00.000Z',
            hash: 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
          },
          content: {
            path: 'notes.md',
            raw_data: 'hello world',
          },
        });
      }
      return '';
    });

    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'pipeline',
      steps: [
        {
          type: 'apply',
          op: 'knowledge_import',
          params: {
            package_path: 'knowledge/public/tmp/package.kkp',
            tier: '../../public',
          },
        },
      ],
      context: {},
    });

    expect(result.status).toBe('failed');
    expect(result.results[0].error).toContain('Invalid knowledge import tier');
  });

  it('registers a presentation preference profile through the personal registry', async () => {
    mocks.safeExistsSync.mockImplementation((filePath: string) => filePath.includes('presentation-preference-registry.json') ? false : true);
    mocks.safeReadFile.mockReturnValue('');

    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'pipeline',
      steps: [
        {
          type: 'apply',
          op: 'register_presentation_preference_profile',
          params: {
            registry_path: 'active/shared/tmp/presentation-preference-registry.test.json',
            profile: {
              kind: 'presentation-preference-profile',
              profile_id: 'test-roundtrip-profile',
              scope: 'briefing',
              theme_selection_policy: {
                decision_mode: 'ask_when_uncertain',
                ask_user_when: ['new_deck_category'],
                default_theme_hint: 'test-roundtrip-theme',
              },
              brief_question_sets: [
                {
                  label: 'Briefing deck',
                  deck_purposes: ['briefing'],
                  questions: ['Who is the audience?', 'What should the deck help decide?'],
                },
              ],
              theme_sets: [
                {
                  label: 'Roundtrip theme',
                  deck_purposes: ['briefing'],
                  theme_hint: 'test-roundtrip-theme',
                },
              ],
            },
          },
        },
      ],
      context: {},
    });

    expect(result.status).toBe('succeeded');
  });
});
