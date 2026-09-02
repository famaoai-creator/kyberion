import { beforeEach, describe, expect, it, vi } from 'vitest';
import { indexHistoryEntry } from '@agent/core/history-search-index';
import {
  registerActuatorForwardingPort,
  resetActuatorForwardingPort,
} from '@agent/core/actuator-forwarding-port';

const mocks = vi.hoisted(() => ({
  loadJson: vi.fn((filePath: string) => JSON.parse(String(mocks.safeReadFile(filePath)))),
  safeReadFile: vi.fn(),
  safeWriteFile: vi.fn(),
  safeExistsSync: vi.fn(),
  safeMkdir: vi.fn(),
  retry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('@agent/core/foundation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/foundation')>();
  return {
    ...actual,
    loadJson: mocks.loadJson,
    readJson: mocks.loadJson,
  };
});

vi.mock('@agent/core/secure-io', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/secure-io')>();
  return {
    ...actual,
    safeReadFile: mocks.safeReadFile,
    safeWriteFile: mocks.safeWriteFile,
    safeExistsSync: mocks.safeExistsSync,
    safeMkdir: mocks.safeMkdir,
  };
});

vi.mock('@agent/core/async-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/async-utils')>();
  return {
    ...actual,
    retry: mocks.retry,
  };
});

vi.mock('@agent/core/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/core')>();
  return {
    ...actual,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
  };
});

describe('wisdom-actuator handleAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.safeExistsSync.mockReturnValue(true);
  });

  it('rejects a context path outside the repository root', async () => {
    const { handleAction } = await import('./index.js');

    await expect(
      handleAction({
        action: 'pipeline',
        context: { context_path: '../../outside-context.json' },
        steps: [
          {
            type: 'transform',
            op: 'regex_replace',
            params: { pattern: 'x', template: 'y', export_as: 'value' },
          },
        ],
      } as unknown as Parameters<typeof handleAction>[0])
    ).rejects.toThrow('[RESOURCE_PATH_SCOPE]');
  });

  it('fails closed when a persisted pipeline context is not an object', async () => {
    mocks.safeReadFile.mockReturnValue(JSON.stringify(['not-a-context-object']));

    const { handleAction } = await import('./index.js');
    await expect(
      handleAction({
        action: 'pipeline',
        context: { context_path: 'active/shared/tmp/wisdom-context.json' },
        steps: [
          {
            type: 'transform',
            op: 'regex_replace',
            params: { pattern: 'x', template: 'y', export_as: 'value' },
          },
        ],
      } as unknown as Parameters<typeof handleAction>[0])
    ).rejects.toThrow('[WISDOM_CONTEXT_SHAPE_INVALID]');
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
            tenant_slug: 'tenant-acme',
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

  it('rejects knowledge package paths outside the repository before reading', async () => {
    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'pipeline',
      steps: [
        {
          type: 'apply',
          op: 'knowledge_import',
          params: {
            package_path: '../../outside-package.kkp',
            tier: 'confidential',
          },
        },
      ],
      context: {
        tenant_slug: 'tenant-acme',
        mission_id: 'mission-1',
        security_scope: {
          tenant_slug: 'tenant-acme',
          mission_id: 'mission-1',
          purpose: 'knowledge import',
          read_tiers: ['confidential'],
          write_tier: 'confidential',
        },
      },
    });

    expect(result.status).toBe('failed');
    expect(result.results[0].error).toContain('[RESOURCE_PATH_SCOPE]');
  });

  it('fails closed when yaml_update receives non-object frontmatter', async () => {
    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'pipeline',
      steps: [
        {
          type: 'transform',
          op: 'yaml_update',
          params: {
            from: 'document',
            field: 'status',
            value: 'ready',
            export_as: 'updated',
          },
        },
      ],
      context: { document: '---\n- not-an-object\n---\nbody' },
    });

    expect(result.status).toBe('failed');
    expect(result.results[0].error).toContain('[WISDOM_YAML_SHAPE_INVALID]');
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
