import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  safeExistsSync: vi.fn(),
  safeReaddir: vi.fn(),
  safeReadFile: vi.fn(),
  safeWriteFile: vi.fn(),
}));

vi.mock('@agent/core', async () => {
  const actual = await vi.importActual('@agent/core') as any;
  return {
    ...actual,
    safeExistsSync: mocks.safeExistsSync,
    safeReaddir: mocks.safeReaddir,
    safeReadFile: mocks.safeReadFile,
    safeWriteFile: mocks.safeWriteFile,
  };
});

describe('sync_service_endpoints', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.safeExistsSync.mockReturnValue(true);
    mocks.safeReaddir.mockReturnValue(['slack.json', 'github.json']);
    mocks.safeReadFile.mockImplementation((filePath: string) => {
      if (filePath.includes('service-endpoints.schema.json')) {
        return JSON.stringify({
          type: 'object',
          required: ['default_pattern', 'services'],
          properties: {
            default_pattern: { type: 'string' },
            services: { type: 'object' },
          },
        });
      }
      if (filePath.includes('slack.json')) {
        return JSON.stringify({
          default_pattern: 'https://api.{service_id}.com/v1',
          services: {
            slack: { base_url: 'https://slack.com/api' },
          },
        });
      }
      if (filePath.includes('github.json')) {
        return JSON.stringify({
          default_pattern: 'https://api.{service_id}.com/v1',
          services: {
            github: { base_url: 'https://api.github.com' },
          },
        });
      }
      return '';
    });
  });

  it('writes a snapshot merged from the canonical directory', async () => {
    await import('./sync_service_endpoints.js');

    expect(mocks.safeWriteFile).toHaveBeenCalledTimes(1);
    const [snapshotPath, content] = mocks.safeWriteFile.mock.calls[0];
    expect(String(snapshotPath)).toContain('knowledge/public/orchestration/service-endpoints.json');
    const parsed = JSON.parse(String(content));
    expect(parsed.default_pattern).toBe('https://api.{service_id}.com/v1');
    expect(Object.keys(parsed.services)).toEqual(['github', 'slack']);
  });
});
