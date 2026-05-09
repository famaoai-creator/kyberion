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

describe('sync_specialist_catalog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.safeExistsSync.mockReturnValue(true);
    mocks.safeReaddir.mockReturnValue(['document-specialist.json', 'service-operator.json']);
    mocks.safeReadFile.mockImplementation((filePath: string) => {
      if (filePath.includes('specialist-catalog.schema.json')) {
        return JSON.stringify({
          type: 'object',
          required: ['version', 'specialists'],
          properties: {
            version: { type: 'string' },
            specialists: { type: 'object' },
          },
        });
      }
      if (filePath.includes('document-specialist.json')) {
        return JSON.stringify({
          version: '1.0.0',
          specialists: {
            'document-specialist': {
              label: 'Document Specialist',
              description: 'Creates decks.',
              conversation_agent: 'presence-surface-agent',
              team_roles: ['planner'],
              capabilities: ['presentation_deck'],
            },
          },
        });
      }
      if (filePath.includes('service-operator.json')) {
        return JSON.stringify({
          version: '1.0.0',
          specialists: {
            'service-operator': {
              label: 'Service Operator',
              description: 'Inspects service state.',
              conversation_agent: 'presence-surface-agent',
              team_roles: ['operator'],
              capabilities: ['service_operation'],
            },
          },
        });
      }
      return '';
    });
  });

  it('writes a snapshot merged from the canonical directory', async () => {
    await import('./sync_specialist_catalog.js');

    expect(mocks.safeWriteFile).toHaveBeenCalledTimes(1);
    const [snapshotPath, content] = mocks.safeWriteFile.mock.calls[0];
    expect(String(snapshotPath)).toContain('knowledge/public/orchestration/specialist-catalog.json');
    const parsed = JSON.parse(String(content));
    expect(parsed.version).toBe('1.0.0');
    expect(Object.keys(parsed.specialists)).toEqual(['document-specialist', 'service-operator']);
  });
});
