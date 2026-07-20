import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  indexHistoryEntry,
  registerActuatorForwardingPort,
  resetActuatorForwardingPort,
} from '@agent/core';

const mocks = vi.hoisted(() => ({
  safeReadFile: vi.fn(),
  safeWriteFile: vi.fn(),
  safeExistsSync: vi.fn(),
  safeMkdir: vi.fn(),
  retry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('@agent/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core')>();
  return {
    ...actual,
    safeReadFile: mocks.safeReadFile,
    safeWriteFile: mocks.safeWriteFile,
    safeExistsSync: mocks.safeExistsSync,
    safeMkdir: mocks.safeMkdir,
    retry: mocks.retry,
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

  it('fails closed when knowledge export has no governed origin scope', async () => {
    mocks.safeReadFile.mockReturnValue('exported knowledge');
    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'pipeline',
      steps: [
        {
          type: 'apply',
          op: 'knowledge_export',
          params: { path: 'public/example.md' },
        },
      ],
      context: { agent_id: 'agent-test' },
    });

    expect(result.status).toBe('failed');
    expect(result.results[0].error).toContain('KNOWLEDGE_ORIGIN_SCOPE_REQUIRED');
  });

  it('registers a presentation preference profile through the personal registry', async () => {
    mocks.safeExistsSync.mockImplementation((filePath: string) =>
      filePath.includes('presentation-preference-registry.json') ? false : true
    );
    mocks.safeReadFile.mockReturnValue('');

    const forward = vi.fn().mockResolvedValue({
      forwarded_to: 'media:register_presentation_preference_profile',
      status: 'succeeded',
      context: {
        presentation_preference_profile_registered: {
          profile_id: 'test-roundtrip-profile',
        },
      },
    });
    registerActuatorForwardingPort({ forward });
    try {
      const { handleAction } = await import('./index.js');
      const result = await handleAction({
        action: 'pipeline',
        steps: [
          {
            type: 'apply',
            op: 'register_presentation_preference_profile',
            params: {
              registry_path: 'active/shared/tmp/presentation-preference-registry.test.json',
              profile: { profile_id: 'test-roundtrip-profile' },
            },
          },
        ],
        context: {},
      });

      expect(result.status).toBe('succeeded');
      expect(forward).toHaveBeenCalledWith(
        expect.objectContaining({
          target_actuator: 'media',
          target_op: 'register_presentation_preference_profile',
        })
      );
    } finally {
      resetActuatorForwardingPort();
    }
  });

  it('exposes public history search through the capture pipeline op', async () => {
    process.env.KYBERION_HISTORY_SEARCH_DB = 'active/shared/tmp/wisdom-history-search.test.sqlite';
    indexHistoryEntry({
      entryId: 'wisdom-history-hit',
      sourceType: 'conversation',
      sourceId: 'test-session',
      sessionId: 'test-session',
      timestamp: '2026-07-18T00:00:00.000Z',
      content: '公開履歴の請求書を確認しました。',
      tier: 'public',
    });

    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'pipeline',
      steps: [
        {
          type: 'capture',
          op: 'history_search',
          params: { query: '請求書' },
        },
      ],
      context: {},
    });

    expect(result.status).toBe('succeeded');
    expect(result.context.history_search_results.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entryId: 'wisdom-history-hit', tier: 'public' }),
      ])
    );
    delete process.env.KYBERION_HISTORY_SEARCH_DB;
  });
});
