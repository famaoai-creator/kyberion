import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const pathResolverMock = vi.hoisted(() => ({ rootDir: '' }));

vi.mock('./path-resolver.js', () => ({
  pathResolver: {
    rootDir: () => pathResolverMock.rootDir || process.cwd(),
  },
  knowledge: (sub = '') => path.join(process.cwd(), 'knowledge', sub),
}));

vi.mock('./secure-io.js', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    assertSafeRepositoryPath: (filePath: string) => filePath,
    safeExistsSync: (filePath: string) => actual.existsSync(filePath),
    safeLstat: (filePath: string) => actual.lstatSync(filePath),
    safeMkdir: (filePath: string, options: { recursive?: boolean }) =>
      actual.mkdirSync(filePath, options),
    safeWriteFile: (filePath: string, content: string) => {
      actual.mkdirSync(path.dirname(filePath), { recursive: true });
      actual.writeFileSync(filePath, content);
    },
  };
});

vi.mock('./foundation/io.js', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    getFoundationIo: () => ({
      loadJson: <T>(filePath: string) => JSON.parse(actual.readFileSync(filePath, 'utf8')) as T,
      loadJsonIfPresent: <T>(filePath: string) => {
        if (!actual.existsSync(filePath)) return null;
        return JSON.parse(actual.readFileSync(filePath, 'utf8')) as T;
      },
      appendFile: (filePath: string, content: string) => actual.appendFileSync(filePath, content),
      exists: (filePath: string) => actual.existsSync(filePath),
      readFile: (filePath: string) => actual.readFileSync(filePath, 'utf8'),
      stat: (filePath: string) => actual.statSync(filePath),
      writeFile: (filePath: string, content: string) => {
        actual.mkdirSync(path.dirname(filePath), { recursive: true });
        actual.writeFileSync(filePath, content);
      },
    }),
  };
});

const { readKnowledgeScopeHealthCount, writeKnowledgeScopeHealthCount } =
  await import('./knowledge-scope-health-history.js');

describe('knowledge-scope-health-history', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyberion-scope-health-'));
    pathResolverMock.rootDir = rootDir;
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
    pathResolverMock.rootDir = '';
  });

  it('writes and reads a schema-valid history record', () => {
    const filePath = path.join(rootDir, 'active/shared/runtime/feedback-loop/history.json');
    expect(readKnowledgeScopeHealthCount(filePath)).toBeUndefined();

    writeKnowledgeScopeHealthCount(filePath, 3, '2026-09-03T08:00:00.000Z');
    expect(readKnowledgeScopeHealthCount(filePath)).toBe(3);
  });

  it('fails safe for invalid or non-file history state', () => {
    const filePath = path.join(rootDir, 'active/shared/runtime/feedback-loop/history.json');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        generated_at: '2026-09-03T08:00:00.000Z',
        legacy_unscoped_file_count: 3,
        unexpected: true,
      })
    );
    expect(readKnowledgeScopeHealthCount(filePath)).toBeUndefined();

    fs.rmSync(filePath, { force: true });
    fs.mkdirSync(filePath, { recursive: true });
    expect(readKnowledgeScopeHealthCount(filePath)).toBeUndefined();
  });

  it('rejects negative counts at the write boundary', () => {
    const filePath = path.join(rootDir, 'active/shared/runtime/feedback-loop/history.json');
    expect(() => writeKnowledgeScopeHealthCount(filePath, -1, '2026-09-03T08:00:00.000Z')).toThrow(
      /Invalid catalog knowledge-scope-health-history/
    );
  });
});
