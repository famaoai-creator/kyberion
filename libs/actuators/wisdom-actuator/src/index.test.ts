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
});
