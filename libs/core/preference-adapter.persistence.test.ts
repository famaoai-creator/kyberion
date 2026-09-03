import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFiles = vi.hoisted(() => new Map<string, string>());
const mockIsFile = vi.hoisted(() => vi.fn(() => true));

vi.mock('./secure-io.js', () => ({
  assertSafeRepositoryPath: (filePath: string) => filePath,
  safeExistsSync: (filePath: string) => mockFiles.has(filePath),
  safeLstat: () => ({ isFile: () => mockIsFile() }),
  safeWriteFile: (filePath: string, data: string) => mockFiles.set(filePath, data),
}));

vi.mock('./path-resolver.js', () => ({
  pathResolver: {
    rootDir: () => '/repo',
    rootResolve: (relativePath: string) => `/repo/${relativePath}`,
    knowledge: (relativePath: string) => `/repo/knowledge/${relativePath}`,
    shared: (relativePath: string) => `/repo/active/shared/${relativePath}`,
  },
}));

describe('preference-adapter persistence boundary', () => {
  const preferencePath = '/repo/knowledge/personal/user-preferences.json';

  beforeEach(async () => {
    mockFiles.clear();
    mockIsFile.mockReturnValue(true);
    vi.resetModules();
    const { registerFoundationIo } = await import('./foundation/io.js');
    registerFoundationIo({
      loadJson: <T>(filePath: string): T => {
        if (filePath.includes('user-preferences.schema.json')) {
          return JSON.parse(
            fs.readFileSync(
              path.resolve('knowledge/product/schemas/user-preferences.schema.json'),
              'utf8'
            )
          ) as T;
        }
        return JSON.parse(mockFiles.get(filePath) || 'null') as T;
      },
      loadJsonIfPresent: <T>(filePath: string): T | null => {
        const value = mockFiles.get(filePath);
        return value === undefined ? null : (JSON.parse(value) as T);
      },
      appendFile: () => undefined,
      exists: (filePath: string) => mockFiles.has(filePath),
      readFile: (filePath: string) => mockFiles.get(filePath) || '',
      stat: (filePath: string) => {
        const value = mockFiles.get(filePath);
        if (value === undefined) throw new Error(`missing mock file: ${filePath}`);
        return { mtimeMs: 0, size: value.length };
      },
      writeFile: (filePath: string, content: string) => mockFiles.set(filePath, content),
    });
  });

  it('loads and writes extensible nested preferences through the catalog', async () => {
    mockFiles.set(
      preferencePath,
      JSON.stringify({ voice: { backend: 'local', options: { latency_ms: 250 } } })
    );
    const { preferenceAdapter } = await import('./preference-adapter.js');

    expect(preferenceAdapter.get('voice.options.latency_ms')).toBe(250);
    expect(preferenceAdapter.set('voice.options.vad', 'silero')).toBe(true);
    expect(JSON.parse(mockFiles.get(preferencePath) || '{}')).toEqual({
      voice: {
        backend: 'local',
        options: { latency_ms: 250, vad: 'silero' },
      },
    });
  });

  it('fails closed for invalid roots and non-regular preference files', async () => {
    const { preferenceAdapter } = await import('./preference-adapter.js');

    mockFiles.set(preferencePath, JSON.stringify(['not', 'an', 'object']));
    expect(preferenceAdapter.get('voice.backend', 'fallback')).toBe('fallback');
    expect(preferenceAdapter.set('voice.backend', 'local')).toBe(false);

    mockFiles.set(preferencePath, '{}');
    mockIsFile.mockReturnValue(false);
    expect(preferenceAdapter.get('voice.backend', 'fallback')).toBe('fallback');
    expect(preferenceAdapter.set('voice.backend', 'local')).toBe(false);
  });
});
